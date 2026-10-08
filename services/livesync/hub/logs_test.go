// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package hub

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"forgejo.org/services/livesync/protocol"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeLogs is a LogSource over in-memory jobs: job id → state, task id →
// lines.
type fakeLogs struct {
	mu    sync.Mutex
	jobs  map[int64]LogJob
	lines map[int64][]string
	reads int
	// readLines counts the lines Lines returned.
	readLines int
	// gate, when set, blocks Job (ignoring the context, like a slow
	// database read) until it is closed; inJob counts the calls inside.
	gate  chan struct{}
	inJob int
	// polls counts the calls of Job.
	polls int
}

func (f *fakeLogs) Job(_ context.Context, jobID int64) (*LogJob, error) {
	f.mu.Lock()
	f.polls++
	if gate := f.gate; gate != nil {
		f.inJob++
		f.mu.Unlock()
		<-gate
		f.mu.Lock()
		f.inJob--
	}
	defer f.mu.Unlock()
	j, ok := f.jobs[jobID]
	if !ok {
		return nil, ErrLogNotFound
	}
	j.Length = int64(len(f.lines[j.TaskID]))
	j.Handle = j.TaskID
	return &j, nil
}

// Lines ignores maxBytes: the tail must cope with a source that returns
// more than one message carries.
func (f *fakeLogs) Lines(_ context.Context, job *LogJob, offset, limit, _ int64) ([]protocol.LogLine, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reads++
	all := f.lines[job.Handle.(int64)]
	var res []protocol.LogLine
	for i := offset; i < int64(len(all)) && i < offset+limit; i++ {
		res = append(res, protocol.LogLine{T: i, C: all[i]})
	}
	f.readLines += len(res)
	return res, nil
}

func (f *fakeLogs) set(jobID int64, j LogJob) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.jobs[jobID] = j
}

func (f *fakeLogs) add(taskID int64, lines ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lines[taskID] = append(f.lines[taskID], lines...)
}

func lineTexts(ls []protocol.LogLine) []string {
	res := []string{}
	for _, l := range ls {
		res = append(res, l.C)
	}
	return res
}

func TestLogTail(t *testing.T) {
	logs := &fakeLogs{jobs: map[int64]LogJob{}, lines: map[int64][]string{}}
	steps := []protocol.LogStep{{Name: "Set up job", Status: "success", LogIndex: 0, LogLength: 1}, {Name: "build", Status: "running", LogIndex: 1}}
	// Job 1 in repo1 (public, actions unit), job 2 in repo2 (private, no
	// actions unit).
	logs.set(1, LogJob{RepoID: 1, TaskID: 10, Steps: steps})
	logs.add(10, "a", "b", "c")
	logs.set(2, LogJob{RepoID: 2, TaskID: 20})
	logs.add(20, "secret")
	x := newHarness(t, Config{Logs: logs, LogInterval: 5 * time.Millisecond})
	cl := x.connect(nil)
	cl.hello(5)
	cl.expect(protocol.MsgCaughtUp)

	cl.send(&protocol.LogTailMessage{Type: protocol.MsgLogTail, JobID: 1})
	m := cl.expect(protocol.MsgLog)
	assert.EqualValues(t, 1, m.JobID)
	assert.EqualValues(t, 10, m.TaskID)
	assert.EqualValues(t, 0, m.Offset)
	assert.Equal(t, []string{"a", "b", "c"}, lineTexts(m.Lines))
	assert.Equal(t, steps, m.Steps)
	assert.False(t, m.Done)

	// New lines: only those are sent, without the unchanged steps.
	logs.add(10, "d", "e")
	m = cl.expect(protocol.MsgLog)
	assert.EqualValues(t, 3, m.Offset)
	assert.Equal(t, []string{"d", "e"}, lineTexts(m.Lines))
	assert.Nil(t, m.Steps)
	// Changed steps alone are sent.
	steps2 := []protocol.LogStep{steps[0], {Name: "build", Status: "success", LogIndex: 1, LogLength: 4}}
	logs.set(1, LogJob{RepoID: 1, TaskID: 10, Steps: steps2})
	m = cl.expect(protocol.MsgLog)
	assert.Empty(t, m.Lines)
	assert.Equal(t, steps2, m.Steps)
	assert.EqualValues(t, 5, m.Offset)
	// Done with an archived log: the tail ends.
	logs.mu.Lock() // the line and the end together
	logs.lines[10] = append(logs.lines[10], "f")
	logs.jobs[1] = LogJob{RepoID: 1, TaskID: 10, Steps: steps2, Done: true, Final: true}
	logs.mu.Unlock()
	m = cl.expect(protocol.MsgLog)
	assert.Equal(t, []string{"f"}, lineTexts(m.Lines))
	assert.EqualValues(t, 5, m.Offset)
	assert.True(t, m.Done)
	cl.quiet(30 * time.Millisecond)
	assert.Eventually(t, func() bool {
		cl.c.tailMu.Lock()
		defer cl.c.tailMu.Unlock()
		return len(cl.c.tails) == 0
	}, 5*time.Second, time.Millisecond)

	// Resume from an offset of the same task.
	cl.send(&protocol.LogTailMessage{Type: protocol.MsgLogTail, JobID: 1, TaskID: 10, Offset: 4})
	m = cl.expect(protocol.MsgLog)
	assert.EqualValues(t, 4, m.Offset)
	assert.Equal(t, []string{"e", "f"}, lineTexts(m.Lines))
	assert.True(t, m.Done)
	assert.Equal(t, steps2, m.Steps, "the first message has the steps")

	// A re-run (another task): its log from the start.
	logs.set(1, LogJob{RepoID: 1, TaskID: 11})
	cl.send(&protocol.LogTailMessage{Type: protocol.MsgLogTail, JobID: 1, TaskID: 10, Offset: 6})
	m = cl.expect(protocol.MsgLog)
	assert.EqualValues(t, 11, m.TaskID)
	assert.EqualValues(t, 0, m.Offset)
	assert.Empty(t, m.Lines, "nothing yet: the first answer tells the task")
	logs.add(11, "x")
	m = cl.expect(protocol.MsgLog)
	assert.Equal(t, []string{"x"}, lineTexts(m.Lines))
	// A finished task whose log is not archived ends after quiet polls.
	logs.set(1, LogJob{RepoID: 1, TaskID: 11, Done: true})
	m = cl.expect(protocol.MsgLog)
	assert.True(t, m.Done)
	assert.EqualValues(t, 1, m.Offset)

	// Not readable, or missing: forbidden either way.
	cl.send(&protocol.LogTailMessage{Type: protocol.MsgLogTail, JobID: 2})
	m = cl.expect(protocol.MsgLogClosed)
	assert.EqualValues(t, 2, m.JobID)
	assert.Equal(t, protocol.LogClosedForbidden, m.Reason)
	cl.send(&protocol.LogTailMessage{Type: protocol.MsgLogTail, JobID: 99})
	m = cl.expect(protocol.MsgLogClosed)
	assert.Equal(t, protocol.LogClosedForbidden, m.Reason)
	// The owner of repo2 may not read it either: no actions unit.
	owner := x.connect(nil)
	owner.hello(2)
	owner.expect(protocol.MsgCaughtUp)
	owner.send(&protocol.LogTailMessage{Type: protocol.MsgLogTail, JobID: 2})
	assert.Equal(t, protocol.LogClosedForbidden, owner.expect(protocol.MsgLogClosed).Reason)

	// Losing the permission while tailing closes the tail.
	logs.set(3, LogJob{RepoID: 1, TaskID: 30})
	logs.add(30, "1")
	cl.send(&protocol.LogTailMessage{Type: protocol.MsgLogTail, JobID: 3})
	assert.Equal(t, []string{"1"}, lineTexts(cl.expect(protocol.MsgLog).Lines))
	logs.set(3, LogJob{RepoID: 2, TaskID: 30})
	logs.add(30, "2")
	m = cl.expect(protocol.MsgLogClosed)
	assert.EqualValues(t, 3, m.JobID)
	assert.Equal(t, protocol.LogClosedForbidden, m.Reason)

	// At most maxLogTails per session; untail frees a slot and stops.
	for i := range maxLogTails {
		id := int64(100 + i)
		logs.set(id, LogJob{RepoID: 1, TaskID: id})
		cl.send(&protocol.LogTailMessage{Type: protocol.MsgLogTail, JobID: id})
		require.Equal(t, protocol.MsgLog, cl.next().Type, strconv.Itoa(i))
	}
	logs.set(200, LogJob{RepoID: 1, TaskID: 200})
	cl.send(&protocol.LogTailMessage{Type: protocol.MsgLogTail, JobID: 200})
	m = cl.expect(protocol.MsgLogClosed)
	assert.Equal(t, protocol.LogClosedLimit, m.Reason)
	cl.send(&protocol.LogUntailMessage{Type: protocol.MsgLogUntail, JobID: 100})
	logs.add(100, "not sent")
	cl.send(&protocol.LogTailMessage{Type: protocol.MsgLogTail, JobID: 200})
	m = cl.expect(protocol.MsgLog)
	assert.EqualValues(t, 200, m.JobID)
	cl.quiet(50 * time.Millisecond)

	// The session's end stops every tail.
	cl.c.stop()
	cl.c.tailMu.Lock()
	n := len(cl.c.tails)
	cl.c.tailMu.Unlock()
	assert.Zero(t, n)
}

// TestLogTailLongLines: lines read but not sent in one message (128 KiB)
// are sent next, not read again (each line is read once).
func TestLogTailLongLines(t *testing.T) {
	logs := &fakeLogs{jobs: map[int64]LogJob{}, lines: map[int64][]string{}}
	const n = 40
	long := strings.Repeat("x", 64<<10)
	for i := range n {
		logs.add(10, strconv.Itoa(i)+long)
	}
	logs.set(1, LogJob{RepoID: 1, TaskID: 10, Done: true, Final: true})
	x := newHarness(t, Config{Logs: logs, LogInterval: 5 * time.Millisecond})
	cl := x.connect(nil)
	cl.hello(5)
	cl.expect(protocol.MsgCaughtUp)

	cl.send(&protocol.LogTailMessage{Type: protocol.MsgLogTail, JobID: 1})
	var got int64
	for messages := 0; ; messages++ {
		m := cl.expect(protocol.MsgLog)
		require.Equal(t, got, m.Offset)
		require.LessOrEqual(t, len(m.Lines), 1, "two 64 KiB lines exceed a message")
		for _, l := range m.Lines {
			require.True(t, strings.HasPrefix(l.C, strconv.FormatInt(got, 10)+"x"))
			got++
		}
		if m.Done {
			require.Equal(t, n, messages+1)
			break
		}
	}
	assert.EqualValues(t, n, got)
	logs.mu.Lock()
	defer logs.mu.Unlock()
	assert.Equal(t, n, logs.readLines, "every line is read once")
	assert.Equal(t, 1, logs.reads)
}

// TestLogTailRestarts: log_tail / log_untail frames in a loop while the
// job's read hangs start no goroutines beyond the limits, and stopped
// tails stop waiting for the hub's check slots.
func TestLogTailRestarts(t *testing.T) {
	logs := &fakeLogs{jobs: map[int64]LogJob{}, lines: map[int64][]string{}, gate: make(chan struct{})}
	for id := int64(1); id <= 3*maxLogTailRunners; id++ {
		logs.set(id, LogJob{RepoID: 1, TaskID: id})
		logs.add(id, "line")
	}
	x := newHarness(t, Config{Logs: logs, LogInterval: 5 * time.Millisecond})
	cl := x.connect(nil)
	cl.hello(5)
	cl.expect(protocol.MsgCaughtUp)
	runners := func() int {
		cl.c.tailMu.Lock()
		defer cl.c.tailMu.Unlock()
		return len(cl.c.tailRunners)
	}

	// Job 1's first read hangs; restarts are handed to its goroutine.
	for range 50 {
		cl.send(&protocol.LogTailMessage{Type: protocol.MsgLogTail, JobID: 1})
	}
	assert.Eventually(t, func() bool {
		logs.mu.Lock()
		defer logs.mu.Unlock()
		return logs.inJob == 1
	}, 5*time.Second, time.Millisecond)
	assert.Equal(t, 1, runners())
	// Tails of other jobs started and stopped at once: they wait for the
	// session's read (job 1's) and end when stopped; at most
	// maxLogTailRunners goroutines at any time, the rest is refused.
	for id := int64(2); id <= 3*maxLogTailRunners; id++ {
		cl.send(&protocol.LogTailMessage{Type: protocol.MsgLogTail, JobID: id})
		cl.send(&protocol.LogUntailMessage{Type: protocol.MsgLogUntail, JobID: id})
		require.LessOrEqual(t, runners(), maxLogTailRunners)
	}
	assert.Eventually(t, func() bool { return runners() == 1 }, 5*time.Second, time.Millisecond, "stopped tails end while job 1's read hangs")
	assert.LessOrEqual(t, len(x.h.checks), 1, "one check slot for the session's tails")
	for {
		select {
		case m := <-cl.tr.msgs:
			require.Equal(t, protocol.MsgLogClosed, m.Type, "%+v", m)
			require.Equal(t, protocol.LogClosedLimit, m.Reason)
			continue
		default:
		}
		break
	}

	// Released: job 1's newest tail runs (once).
	close(logs.gate)
	m := cl.expect(protocol.MsgLog)
	assert.EqualValues(t, 1, m.JobID)
	assert.Equal(t, []string{"line"}, lineTexts(m.Lines))
	cl.quiet(30 * time.Millisecond)
}

func TestCutLines(t *testing.T) {
	big := make([]protocol.LogLine, 3)
	for i := range big {
		big[i] = protocol.LogLine{C: string(make([]byte, logBatchBytes/2))}
	}
	assert.Len(t, cutLines(big), 1)
	huge := []protocol.LogLine{{C: string(make([]byte, 2*logBatchBytes))}}
	assert.Len(t, cutLines(huge), 1, "one line is always sent")
	assert.Len(t, cutLines(big[:1]), 1)
}
