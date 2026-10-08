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

	lines, err := src.Lines(ctx, job, 1, 5)
	require.NoError(t, err)
	require.Len(t, lines, 2)
	assert.Equal(t, "two", lines[0].C)
	assert.Equal(t, "three", lines[1].C)
	assert.Positive(t, lines[0].T)
	lines, err = src.Lines(ctx, job, 3, 5)
	require.NoError(t, err)
	assert.Empty(t, lines, "past the index")

	// Actions disabled: as if the job did not exist.
	defer test.MockVariableValue(&setting.Actions.Enabled, false)()
	_, err = src.Job(ctx, 192)
	require.ErrorIs(t, err, hub.ErrLogNotFound)
}
