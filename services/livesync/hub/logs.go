// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package hub

import (
	"context"
	"errors"
	"slices"
	"time"

	"forgejo.org/modules/log"
	"forgejo.org/services/livesync/protocol"
)

// Actions log tails (protocol/logs.go): a session asks for a job's log
// with log_tail and gets its lines in log messages, offset-based, until the
// job's task finished. The log is not in the sync log (Forgejo stores it
// in files, action_task is not tracked): each tail polls its job every
// LogInterval through the LogSource (two primary-key reads), reads only the
// lines it has not sent, and waits for room in the session's send buffer
// before queueing them (like replays, never overflowing it). Permission
// (the actions unit of the job's repository, perm.Cache.Check, i.e. the
// cached grants for the viewer's own repositories) is checked when the
// tail starts and again before every message with lines, and at least
// every logRecheck; a tail that lost it is closed (log_closed forbidden).
// Database reads take the hub's check slots like replays.

// DefaultLogInterval is the default Config.LogInterval.
const DefaultLogInterval = time.Second

const (
	// maxLogTails bounds the tails of one session.
	maxLogTails = 8
	// logBatch is the most lines one log message carries.
	logBatch = 500
	// logBatchBytes: a log message is cut after this many bytes of lines.
	logBatchBytes = 128 << 10
	// logRecheck: the permission of an idle tail is checked again at
	// least this often.
	logRecheck = 10 * time.Second
	// logFinalPolls: a finished task whose log is not marked complete
	// (LogJob.Final) is polled this many more times without new lines
	// before the tail ends (the runner may still upload the last lines
	// after the result).
	logFinalPolls = 2
)

// ErrLogNotFound is returned by a LogSource for a job that does not exist.
var ErrLogNotFound = errors.New("livesync: no such job")

// LogJob is the state of a job's log (LogSource.Job).
type LogJob struct {
	// RepoID is the job's repository (its actions unit decides who may
	// read the log).
	RepoID int64
	// TaskID is the job's current task (attempt), 0 while it waits for a
	// runner.
	TaskID int64
	// Length is the number of lines of the task's log so far.
	Length int64
	// Done: the job (its task) finished. Final: no more lines will be
	// written to the log (it was archived).
	Done, Final bool
	// Expired: the log was removed.
	Expired bool
	Steps   []protocol.LogStep
	// Handle is the LogSource's own reference to the task's log.
	Handle any
}

// LogSource reads Actions job logs (services/livesync/actionslog).
type LogSource interface {
	// Job returns the state of a job's log, or ErrLogNotFound.
	Job(ctx context.Context, jobID int64) (*LogJob, error)
	// Lines reads at most limit lines of job's task log from offset.
	Lines(ctx context.Context, job *LogJob, offset, limit int64) ([]protocol.LogLine, error)
}

// logTail is one running tail of a session.
type logTail struct {
	jobID  int64
	taskID int64 // the task the client holds lines of (resume)
	offset int64
	cancel context.CancelFunc
}

// logTailStart handles log_tail: (re)starts the tail of a job.
func (c *conn) logTailStart(m *protocol.LogTailMessage) {
	if c.h.cfg.Logs == nil || m.JobID <= 0 || m.Offset < 0 {
		c.send(&protocol.LogClosedMessage{Type: protocol.MsgLogClosed, JobID: m.JobID, Reason: protocol.LogClosedForbidden})
		return
	}
	c.tailMu.Lock()
	if old := c.tails[m.JobID]; old != nil {
		old.cancel()
		delete(c.tails, m.JobID)
	}
	if len(c.tails) >= maxLogTails {
		c.tailMu.Unlock()
		c.send(&protocol.LogClosedMessage{Type: protocol.MsgLogClosed, JobID: m.JobID, Reason: protocol.LogClosedLimit})
		return
	}
	ctx, cancel := context.WithCancel(c.ctx)
	t := &logTail{jobID: m.JobID, taskID: m.TaskID, offset: m.Offset, cancel: cancel}
	c.tails[m.JobID] = t
	c.tailWG.Add(1)
	c.tailMu.Unlock()
	go func() {
		defer c.tailWG.Done()
		defer c.logTailEnd(t)
		c.runLogTail(ctx, t)
	}()
}

// logTailStop handles log_untail.
func (c *conn) logTailStop(jobID int64) {
	c.tailMu.Lock()
	defer c.tailMu.Unlock()
	if t := c.tails[jobID]; t != nil {
		t.cancel()
		delete(c.tails, jobID)
	}
}

// logTailEnd removes a finished tail (unless it was replaced).
func (c *conn) logTailEnd(t *logTail) {
	t.cancel()
	c.tailMu.Lock()
	defer c.tailMu.Unlock()
	if c.tails[t.jobID] == t {
		delete(c.tails, t.jobID)
	}
}

// logSend queues a message of tail t, unless t was stopped or replaced
// meanwhile (a restarted tail's old goroutine must not send after the new
// one started). False when t is no longer current.
func (c *conn) logSend(ctx context.Context, t *logTail, msg any) bool {
	c.tailMu.Lock()
	defer c.tailMu.Unlock()
	if ctx.Err() != nil || c.tails[t.jobID] != t {
		return false
	}
	c.send(msg)
	return true
}

// runLogTail polls the job and sends its new lines until the log is
// complete, the tail is stopped or the session ends.
func (c *conn) runLogTail(ctx context.Context, t *logTail) {
	src := c.h.cfg.Logs
	closed := func(reason string) {
		c.logSend(ctx, t, &protocol.LogClosedMessage{Type: protocol.MsgLogClosed, JobID: t.jobID, Reason: reason})
	}
	var lastCheck time.Time
	var sentSteps []protocol.LogStep
	first, quiet := true, 0
	for {
		var job *LogJob
		err := c.withSlot(func() error {
			var err error
			job, err = src.Job(ctx, t.jobID)
			return err
		})
		switch {
		case ctx.Err() != nil:
			return
		case errors.Is(err, ErrLogNotFound):
			closed(protocol.LogClosedForbidden)
			return
		case err != nil:
			log.Error("livesync: log tail of job %d: %v", t.jobID, err)
			closed(protocol.LogClosedError)
			return
		}
		if job.TaskID != t.taskID {
			// Another attempt (or the first one) of the job: its log
			// from the start.
			t.taskID, t.offset = job.TaskID, 0
		}
		newLines := t.offset < job.Length && !job.Expired
		if first || newLines || time.Since(lastCheck) >= logRecheck {
			ok, err := c.logReadable(ctx, job.RepoID)
			switch {
			case ctx.Err() != nil:
				return
			case err != nil:
				log.Error("livesync: log tail of job %d: permission: %v", t.jobID, err)
				closed(protocol.LogClosedError)
				return
			case !ok:
				closed(protocol.LogClosedForbidden)
				return
			}
			lastCheck = time.Now()
		}
		if job.Expired {
			c.logSend(ctx, t, &protocol.LogMessage{
				Type: protocol.MsgLog, JobID: t.jobID, TaskID: job.TaskID, Offset: t.offset,
				Lines: []protocol.LogLine{}, Steps: job.Steps, Done: true, Expired: true,
			})
			return
		}
		sent := false
		for t.offset < job.Length {
			var lines []protocol.LogLine
			err := c.withSlot(func() error {
				var err error
				lines, err = src.Lines(ctx, job, t.offset, min(logBatch, job.Length-t.offset))
				return err
			})
			if ctx.Err() != nil {
				return
			}
			if err != nil {
				log.Error("livesync: log tail of job %d: read: %v", t.jobID, err)
				closed(protocol.LogClosedError)
				return
			}
			if len(lines) == 0 {
				break // the index is ahead of the file: next poll
			}
			lines = cutLines(lines)
			if !c.waitRoom() {
				return
			}
			msg := &protocol.LogMessage{Type: protocol.MsgLog, JobID: t.jobID, TaskID: job.TaskID, Offset: t.offset, Lines: lines}
			if !slices.Equal(sentSteps, job.Steps) || first {
				msg.Steps, sentSteps = job.Steps, job.Steps
			}
			t.offset += int64(len(lines))
			msg.Done = job.Done && job.Final && t.offset >= job.Length
			if !c.logSend(ctx, t, msg) {
				return
			}
			first, sent = false, true
			if msg.Done {
				return
			}
		}
		if job.Done && t.offset >= job.Length && (job.Final || quiet >= logFinalPolls || job.TaskID == 0) {
			c.logSend(ctx, t, &protocol.LogMessage{
				Type: protocol.MsgLog, JobID: t.jobID, TaskID: job.TaskID, Offset: t.offset, Lines: []protocol.LogLine{},
				Steps: stepsIfChanged(first, sentSteps, job.Steps), Done: true,
			})
			return
		}
		if !sent && (first || !slices.Equal(sentSteps, job.Steps)) {
			// Nothing to send but the steps (or the first answer: the
			// client learns the task and that the tail runs).
			if !c.logSend(ctx, t, &protocol.LogMessage{
				Type: protocol.MsgLog, JobID: t.jobID, TaskID: job.TaskID, Offset: t.offset, Lines: []protocol.LogLine{}, Steps: job.Steps,
			}) {
				return
			}
			first, sentSteps = false, job.Steps
		}
		if job.Done && !sent {
			quiet++
		} else {
			quiet = 0
		}
		timer := time.NewTimer(c.h.cfg.LogInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

// stepsIfChanged returns steps when they were not sent yet.
func stepsIfChanged(first bool, sent, steps []protocol.LogStep) []protocol.LogStep {
	if first || !slices.Equal(sent, steps) {
		return steps
	}
	return nil
}

// cutLines keeps the first lines up to logBatchBytes (at least one).
func cutLines(lines []protocol.LogLine) []protocol.LogLine {
	size := 0
	for i, l := range lines {
		size += len(l.C) + 24
		if size > logBatchBytes && i > 0 {
			return lines[:i]
		}
	}
	return lines
}

// logReadable decides whether the viewer may read the logs of a
// repository's jobs (its actions unit).
func (c *conn) logReadable(ctx context.Context, repoID int64) (bool, error) {
	var ok bool
	err := c.withSlot(func() error {
		d, granted, err := c.h.cfg.Perms.Check(ctx, c.viewer, protocol.RepoGroup(repoID))
		ok = granted && d.Units.Allows(protocol.UnitActions)
		return err
	})
	return ok, err
}
