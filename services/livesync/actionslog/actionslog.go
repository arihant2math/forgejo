// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Package actionslog reads Forgejo Actions job logs for the sync hub's log
// tails (hub.LogSource; protocol/logs.go): the job's current task, its
// steps (as the classic job page shows them, modules/actions.FullSteps) and
// its log lines (modules/actions.ReadLogs over the task's line index).
package actionslog

import (
	"context"
	"errors"
	"fmt"

	actions_model "forgejo.org/models/actions"
	actions_module "forgejo.org/modules/actions"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/util"
	"forgejo.org/services/livesync/hub"
	"forgejo.org/services/livesync/protocol"
)

// Source is the hub.LogSource of Forgejo Actions.
type Source struct{}

var _ hub.LogSource = Source{}

// Job implements hub.LogSource.
func (Source) Job(ctx context.Context, jobID int64) (*hub.LogJob, error) {
	if !setting.Actions.Enabled {
		return nil, hub.ErrLogNotFound // as the classic MustEnableActions
	}
	job, err := actions_model.GetRunJobByID(ctx, jobID)
	if err != nil {
		if errors.Is(err, util.ErrNotExist) {
			return nil, hub.ErrLogNotFound
		}
		return nil, fmt.Errorf("load job %d: %w", jobID, err)
	}
	res := &hub.LogJob{RepoID: job.RepoID, TaskID: job.TaskID, Done: job.Status.IsDone()}
	if job.TaskID == 0 {
		return res, nil
	}
	task, err := actions_model.GetTaskByID(ctx, job.TaskID)
	if err != nil {
		if errors.Is(err, util.ErrNotExist) {
			// The task row is gone (cleaned up): nothing to read.
			res.TaskID, res.Done, res.Expired = 0, true, true
			return res, nil
		}
		return nil, fmt.Errorf("load task %d: %w", job.TaskID, err)
	}
	if task.Steps, err = actions_model.GetTaskStepsByTaskID(ctx, task.ID); err != nil {
		return nil, fmt.Errorf("load the steps of task %d: %w", task.ID, err)
	}
	res.Done = res.Done && task.Status.IsDone()
	res.Final = task.LogInStorage
	res.Expired = task.LogExpired
	res.Length = min(task.LogLength, int64(len(task.LogIndexes)))
	for _, s := range actions_module.FullSteps(task) {
		res.Steps = append(res.Steps, protocol.LogStep{
			Name: s.Name, Status: s.Status.String(), LogIndex: s.LogIndex, LogLength: s.LogLength,
			Started: int64(s.Started), Stopped: int64(s.Stopped),
		})
	}
	res.Handle = task
	return res, nil
}

// Lines implements hub.LogSource. The line index (the byte offset of each
// line in the log) bounds the read to about maxBytes bytes of stored lines
// (time stamp and content) before the file is opened, so long lines are
// not read only to be dropped.
func (Source) Lines(ctx context.Context, job *hub.LogJob, offset, limit, maxBytes int64) ([]protocol.LogLine, error) {
	task, ok := job.Handle.(*actions_model.ActionTask)
	if !ok || offset < 0 || offset >= int64(len(task.LogIndexes)) || limit <= 0 {
		return nil, nil
	}
	limit = linesWithin(task.LogIndexes, task.LogSize, offset, limit, maxBytes)
	rows, err := actions_module.ReadLogs(ctx, task.LogInStorage, task.LogFilename, task.LogIndexes[offset], limit)
	if err != nil {
		return nil, fmt.Errorf("read the log of task %d: %w", task.ID, err)
	}
	lines := make([]protocol.LogLine, 0, len(rows))
	for _, r := range rows {
		lines = append(lines, protocol.LogLine{T: r.GetTime().AsTime().UnixMilli(), C: r.GetContent()})
	}
	return lines, nil
}

// linesWithin is how many of at most limit lines from offset fit in
// maxBytes (at least one) by the line index: line i spans
// [indexes[i], indexes[i+1]), the last one ends at size.
func linesWithin(indexes []int64, size, offset, limit, maxBytes int64) int64 {
	end := func(i int64) int64 {
		if i+1 < int64(len(indexes)) {
			return indexes[i+1]
		}
		return size
	}
	n := int64(1)
	for n < limit && offset+n < int64(len(indexes)) && end(offset+n)-indexes[offset] <= maxBytes {
		n++
	}
	return n
}
