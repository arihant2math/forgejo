// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package actionslog

import (
	"testing"

	actions_model "forgejo.org/models/actions"
	"forgejo.org/models/db"
	"forgejo.org/models/unittest"
	actions_module "forgejo.org/modules/actions"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/test"
	"forgejo.org/services/livesync/hub"

	runnerv1 "code.forgejo.org/forgejo/actions-proto/runner/v1"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func TestMain(m *testing.M) {
	unittest.MainTest(m)
}

func TestLinesWithin(t *testing.T) {
	// Lines of 10, 20, 30 and 40 bytes.
	idx := []int64{0, 10, 30, 60}
	const size = 100
	assert.EqualValues(t, 1, linesWithin(idx, size, 0, 4, 0), "at least one")
	assert.EqualValues(t, 1, linesWithin(idx, size, 0, 4, 29))
	assert.EqualValues(t, 2, linesWithin(idx, size, 0, 4, 30))
	assert.EqualValues(t, 3, linesWithin(idx, size, 0, 4, 60))
	assert.EqualValues(t, 4, linesWithin(idx, size, 0, 4, 100))
	assert.EqualValues(t, 3, linesWithin(idx, size, 0, 3, 1000), "limit")
	assert.EqualValues(t, 2, linesWithin(idx, size, 2, 4, 70), "the last line ends at size")
	assert.EqualValues(t, 1, linesWithin(idx, size, 2, 4, 69))
}

func TestSource(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	defer test.MockVariableValue(&setting.Actions.Enabled, true)()
	ctx := t.Context()
	var src Source

	_, err := src.Job(ctx, 999999)
	require.ErrorIs(t, err, hub.ErrLogNotFound)

	// Job 192's task 47, its log moved to DBFS with three lines.
	task := unittest.AssertExistsAndLoadBean(t, &actions_model.ActionTask{ID: 47})
	task.LogFilename, task.LogInStorage, task.LogLength, task.LogSize, task.LogIndexes = "livesync-test/47.log", false, 0, 0, nil
	var rows []*runnerv1.LogRow
	for _, c := range []string{"one", "two", "three"} {
		rows = append(rows, &runnerv1.LogRow{Time: timestamppb.Now(), Content: c})
	}
	ns, err := actions_module.WriteLogs(ctx, task.LogFilename, 0, rows)
	require.NoError(t, err)
	for _, n := range ns {
		task.LogIndexes = append(task.LogIndexes, task.LogSize)
		task.LogSize += int64(n)
	}
	task.LogLength = int64(len(rows))
	_, err = db.GetEngine(ctx).ID(task.ID).Cols("log_filename", "log_in_storage", "log_length", "log_size", "log_indexes").Update(task)
	require.NoError(t, err)

	job, err := src.Job(ctx, 192)
	require.NoError(t, err)
	assert.EqualValues(t, 4, job.RepoID)
	assert.EqualValues(t, 47, job.TaskID)
	assert.EqualValues(t, 3, job.Length)
	assert.False(t, job.Final)
	assert.False(t, job.Expired)
	assert.NotEmpty(t, job.Steps, "FullSteps adds Set up job / Complete job")

	lines, err := src.Lines(ctx, job, 1, 5, 1<<20)
	require.NoError(t, err)
	require.Len(t, lines, 2)
	assert.Equal(t, "two", lines[0].C)
	assert.Equal(t, "three", lines[1].C)
	assert.Positive(t, lines[0].T)
	lines, err = src.Lines(ctx, job, 3, 5, 1<<20)
	require.NoError(t, err)
	assert.Empty(t, lines, "past the index")
	// The byte budget, by the line index: one stored line is the time
	// stamp, a space, the content and a newline.
	lineSize := task.LogIndexes[1] - task.LogIndexes[0]
	lines, err = src.Lines(ctx, job, 0, 5, lineSize)
	require.NoError(t, err)
	require.Len(t, lines, 1)
	assert.Equal(t, "one", lines[0].C)
	lines, err = src.Lines(ctx, job, 0, 5, 1)
	require.NoError(t, err)
	assert.Len(t, lines, 1, "at least one line")

	// A task whose row is gone (cleaned up): the log expired.
	_, err = db.GetEngine(ctx).ID(task.ID).Delete(&actions_model.ActionTask{})
	require.NoError(t, err)
	job, err = src.Job(ctx, 192)
	require.NoError(t, err)
	assert.True(t, job.Expired)
	assert.True(t, job.Done)
	assert.Zero(t, job.TaskID)

	// Actions disabled: as if the job did not exist.
	defer test.MockVariableValue(&setting.Actions.Enabled, false)()
	_, err = src.Job(ctx, 192)
	require.ErrorIs(t, err, hub.ErrLogNotFound)
}
