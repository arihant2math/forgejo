// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package protocol

// Actions log tail over the sync session (PLAN §4.8, §5.7). A client that
// shows a job's log sends LogTailMessage; the server streams the log's
// lines in LogMessage frames, offset-based, until the job's task finished
// and every line was sent (LogMessage.Done), the client sends
// LogUntailMessage, or the server ends the tail (LogClosedMessage). The
// job's status itself (ActionRunJob) comes through the repo:{id} group as
// usual; the log is not in the sync log.
//
// Offsets count lines of one task (an attempt of the job): line Offset of
// LogMessage is the line with that 0-based index in the task's log. A job
// re-run gets a new task: the server then sends the new task's log from
// offset 0 (LogMessage.TaskID changes; the client drops the old lines).
// To resume after a reconnect, tail again with TaskID and Offset = the
// number of lines held.
//
// Permission: the actions unit of the job's repository (as the classic
// job page), checked when the tail starts and again while it runs; a tail
// whose permission is gone, or of a job that does not exist, is closed
// with LogClosedForbidden (never told apart). A session tails at most 8
// jobs at once (LogClosedLimit beyond).

// LogTailMessage starts (or restarts) tailing a job's log.
type LogTailMessage struct {
	Type  MessageType `json:"type" tstype:"'log_tail'"`
	JobID int64       `json:"job_id"`
	// TaskID and Offset resume a tail: when TaskID is still the job's
	// current task, lines are sent from Offset; otherwise from 0 of the
	// current task.
	TaskID int64 `json:"task_id,omitempty"`
	Offset int64 `json:"offset,omitempty"`
}

// LogUntailMessage stops tailing a job's log (no answer; LogMessages
// already on their way may still arrive).
type LogUntailMessage struct {
	Type  MessageType `json:"type" tstype:"'log_untail'"`
	JobID int64       `json:"job_id"`
}

// LogMessage carries lines of a job's log. Lines[i] is line Offset+i of
// task TaskID. TaskID is 0 while the job waits for a runner (no lines
// yet). Steps is set when the steps changed since the previous LogMessage
// of the tail (always in the first one). Done: the task finished and every
// line was sent; the tail ends. Expired: the log was removed (log
// retention); no lines are sent, the tail ends (Done is set too).
type LogMessage struct {
	Type    MessageType `json:"type" tstype:"'log'"`
	JobID   int64       `json:"job_id"`
	TaskID  int64       `json:"task_id"`
	Offset  int64       `json:"offset"`
	Lines   []LogLine   `json:"lines"`
	Steps   []LogStep   `json:"steps,omitempty"`
	Done    bool        `json:"done,omitempty"`
	Expired bool        `json:"expired,omitempty"`
}

// LogLine is one log line: its time in Unix milliseconds and its text.
type LogLine struct {
	T int64  `json:"t"`
	C string `json:"c"`
}

// LogStep is a step of the task (the classic job page's steps, including
// "Set up job" and "Complete job"): its lines are [LogIndex, LogIndex +
// LogLength) of the task's log. Status is the step's status ("success",
// "failure", "running", "waiting", "skipped", "cancelled", …), Started and
// Stopped Unix seconds (0: not yet).
type LogStep struct {
	Name      string `json:"name"`
	Status    string `json:"status"`
	LogIndex  int64  `json:"log_index"`
	LogLength int64  `json:"log_length"`
	Started   int64  `json:"started"`
	Stopped   int64  `json:"stopped"`
}

// LogClosedMessage says that the server ended a tail.
type LogClosedMessage struct {
	Type   MessageType `json:"type" tstype:"'log_closed'"`
	JobID  int64       `json:"job_id"`
	Reason string      `json:"reason" tstype:"LogClosedReason"`
}

// Reasons of a LogClosedMessage (the TypeScript union LogClosedReason).

const (
	// LogClosedForbidden: the job does not exist or its log may not (any
	// more) be read.
	LogClosedForbidden = "forbidden"
	// LogClosedLimit: the session tails too many jobs.
	LogClosedLimit = "limit"
	// LogClosedError: the log could not be read; tail again later.
	LogClosedError = "error"
)
