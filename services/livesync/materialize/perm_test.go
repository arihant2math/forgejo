// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"testing"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/json"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/services/livesync/catalog"
	"forgejo.org/services/livesync/protocol"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPermSubjects(t *testing.T) {
	var p permSubjects
	p.add("")
	assert.Empty(t, p.ids)
	p.add(permState(fingerprint(1, true), subject('u', 5), subject('r', 3)))
	p.add(permState("", subject('u', 5), subject('O', 7), subject('t', 2)))
	p.add("u0 x #u9") // nothing after the fingerprint marker, no id 0
	assert.Equal(t, []int64{5}, p.list('u'))
	assert.Equal(t, []int64{3}, p.list('r'))
	assert.Equal(t, []int64{7}, p.list('O'))
	assert.Equal(t, []int64{2}, p.list('t'))
	assert.Equal(t, "u5 r3 #1,true", permState(fingerprint(1, true), "u5", "r3"))
}

// permChange decodes the permission epoch at the front of rows/entries and
// returns the remaining rows.
func permChange(t *testing.T, rows []logRow, entries []livesync_model.LogEntry) (protocol.PermissionChange, []logRow) {
	t.Helper()
	require.NotEmpty(t, rows)
	require.Equal(t, logRow{protocol.GroupPermission, "", "", "P", 0}, rows[0], "the epoch goes first")
	var ch protocol.PermissionChange
	require.NoError(t, json.Unmarshal([]byte(entries[0].Payload), &ch))
	for _, r := range rows[1:] {
		require.NotEqual(t, "P", r.Op, "one epoch per transaction")
	}
	return ch, rows[1:]
}

// Changes to the rows that decide who may read what are permission epochs,
// in front of the transaction's entries; other changes of those rows are
// not.
func TestConsumePermissionEpochs(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	var cursor int64
	for {
		more, err := m.BackfillStep(t.Context())
		require.NoError(t, err)
		if !more {
			break
		}
	}
	// The backfill recorded the permission states: an unchanged row is
	// not an epoch.
	consume(t, m, change(1, "collaboration", 1, "U"), change(2, "user", 4, "U"), change(3, "team", 1, "U"))
	rows, _ := takeLog(t, &cursor)
	for _, r := range rows {
		assert.NotEqual(t, "P", r.Op)
	}
	require.NotEmpty(t, indexRow(t, "collaboration", 1).Perm)

	// A collaboration's mode (repo 3, user 2): epoch for user 2.
	exec(t, "UPDATE collaboration SET mode = 1 WHERE id = 1")
	consume(t, m, change(10, "collaboration", 1, "U"))
	rows, entries := takeLog(t, &cursor)
	ch, rest := permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{Users: []int64{2}}, ch)
	assert.Equal(t, []logRow{{"repo:3", "", "Collaboration", "U", 1}}, rest)

	// Deleted: the state comes from the index.
	exec(t, "DELETE FROM collaboration WHERE id = 1")
	consume(t, m, change(11, "collaboration", 1, "D"))
	rows, entries = takeLog(t, &cursor)
	ch, rest = permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{Users: []int64{2}}, ch)
	assert.Equal(t, []logRow{{"repo:3", "", "Collaboration", "D", 1}}, rest)

	// A repository's description: no epoch; made private: epoch for the
	// repository's readers and its owner.
	exec(t, "UPDATE repository SET description = 'changed' WHERE id = 1")
	consume(t, m, change(12, "repository", 1, "U"))
	rows, _ = takeLog(t, &cursor)
	assert.Equal(t, []logRow{{"repo:1", "", "Repository", "U", 1}}, rows)
	exec(t, "UPDATE repository SET is_private = ? WHERE id = 1", true)
	consume(t, m, change(13, "repository", 1, "U"))
	rows, entries = takeLog(t, &cursor)
	ch, rest = permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{Users: []int64{2}, Repos: []int64{1}}, ch)
	assert.Equal(t, []logRow{{"repo:1", "", "Repository", "U", 1}}, rest)

	// A user made site administrator: the profile does not change, the
	// epoch is written alone and the state is stored (no second epoch).
	exec(t, "UPDATE `user` SET is_admin = ? WHERE id = 4", true)
	consume(t, m, change(14, "user", 4, "U"))
	rows, entries = takeLog(t, &cursor)
	ch, rest = permChange(t, rows, entries)
	assert.Equal(t, []int64{4}, ch.Users)
	assert.Equal(t, []int64{4}, ch.Owners)
	assert.Empty(t, rest)
	consume(t, m, change(15, "user", 4, "U"))
	rows, _ = takeLog(t, &cursor)
	assert.Empty(t, rows)

	// A user made private: their profile moves from the public directory
	// to their own profile group; the epoch names the readers of
	// everything they own.
	exec(t, "UPDATE `user` SET visibility = 2 WHERE id = 2")
	consume(t, m, change(16, "user", 2, "U"))
	rows, entries = takeLog(t, &cursor)
	ch, rest = permChange(t, rows, entries)
	assert.Equal(t, []int64{2}, ch.Users)
	assert.Equal(t, []int64{2}, ch.Owners)
	assert.Contains(t, ch.Repos, int64(1), "user2's repositories")
	assert.Contains(t, ch.Repos, int64(2))
	assert.Equal(t, []logRow{
		{protocol.GroupProfilesPublic, "", "User", "D", 2},
		{"profile:2", "", "User", "U", 2},
	}, rest)

	// Team membership (user 4 in team 2 of org 3): the member's grants.
	exec(t, "DELETE FROM team_user WHERE team_id = 2 AND uid = 4")
	var teamUser int64
	for _, r := range indexRows(t, "team_user") {
		if r.Perm == permState(fingerprint(2), "u4") {
			teamUser = r.RowID
		}
	}
	require.NotZero(t, teamUser)
	consume(t, m, change(17, "team_user", teamUser, "D"))
	rows, entries = takeLog(t, &cursor)
	ch, _ = permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{Users: []int64{4}}, ch)

	// A team's access mode: every member of the team.
	exec(t, "UPDATE team SET authorize = 1 WHERE id = 2")
	consume(t, m, change(18, "team", 2, "U"))
	rows, entries = takeLog(t, &cursor)
	ch, _ = permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{Users: []int64{2}}, ch, "user 4 left the team above")

	// A repository added to a team: its members and the repository.
	exec(t, "INSERT INTO team_repo (id, org_id, team_id, repo_id) VALUES (100, 3, 1, 41)")
	consume(t, m, change(19, "team_repo", 100, "I"))
	rows, entries = takeLog(t, &cursor)
	ch, _ = permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{Users: []int64{2}, Repos: []int64{41}}, ch)

	// Several changes in one transaction: one epoch, first.
	exec(t, "UPDATE access SET mode = 1 WHERE id = 1") // user 2 on repo 3
	exec(t, "UPDATE repo_unit SET default_permissions = 2 WHERE id = 1")
	consume(t, m, change(21, "label", 2, "U"), change(22, "access", 1, "U"), change(23, "repo_unit", 1, "U"))
	rows, entries = takeLog(t, &cursor)
	ch, _ = permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{Users: []int64{2}, Repos: []int64{1}}, ch, "repo_unit 1 belongs to repository 1")
}

// A permission row deleted before the index backfill recorded its state:
// its subjects are unknown, so the epoch names everything. Once the table's
// backfill is complete, an unindexed delete cannot have been visible.
func TestConsumeUnindexedPermissionDelete(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	var cursor int64
	exec(t, "DELETE FROM collaboration WHERE id = 2")
	consume(t, m, change(1, "collaboration", 2, "D"), change(2, "label", 999, "D"))
	rows, entries := takeLog(t, &cursor)
	ch, rest := permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{All: true}, ch)
	assert.Empty(t, rest)

	m.backfill["collaboration"] = backfillDone
	exec(t, "DELETE FROM collaboration WHERE id = 3")
	consume(t, m, change(3, "collaboration", 3, "D"))
	rows, _ = takeLog(t, &cursor)
	assert.Empty(t, rows)
}

func indexRows(t *testing.T, key string) []livesync_model.Entity {
	t.Helper()
	var rows []livesync_model.Entity
	require.NoError(t, db.GetEngine(t.Context()).Where("tbl = ?", key).Find(&rows))
	return rows
}

// Profiles are placed by visibility, never in user:{id}: a public user's in
// the public directory, a limited one's in the limited directory, a private
// one's in their profile group, an organization's in its group; a user's
// projects in their profile group.
func TestProfilePlacement(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	var cursor int64
	consume(t, m,
		change(1, "user", 2, "U"), change(2, "user", 33, "U"), change(3, "user", 31, "U"), change(4, "user", 3, "U"),
		change(5, "project", 4, "U"))
	rows, entries := takeLog(t, &cursor)
	_, rest := permChange(t, rows, entries) // first time the user rows are seen
	assert.Equal(t, []logRow{
		{protocol.GroupProfilesPublic, "", "User", "U", 2},
		{protocol.GroupProfilesLimited, "", "User", "U", 33},
		{"profile:31", "", "User", "U", 31},
		{"org:3", "", "User", "U", 3},
		{"profile:2", "", "Project", "U", 4},
	}, rest)
}

// Placement rules that changed since a table was materialized are handled
// like a repaired trigger (markers, repair backfill); a repaired trigger of
// a permission table also means lost permission changes: an epoch for
// everything goes first.
func TestHandleEpochsPlacementAndPermissions(t *testing.T) {
	resetLivesync(t)
	ctx := t.Context()
	// A database materialized by a livesync without placement versions
	// (B3): handled epochs, no placement entries.
	for _, tbl := range catalog.Tracked() {
		require.NoError(t, livesync_model.SetMeta(ctx, capture.MetaEpochPrefix+tbl.Name, "1"))
		require.NoError(t, livesync_model.SetMeta(ctx, MetaHandledEpochPrefix+tbl.Name, "1"))
	}
	m, _ := testMaterializer(t)
	var cursor int64
	rows, entries := takeLog(t, &cursor)
	assert.Equal(t, []logRow{
		{"*", "", "User", "B", 0},
		{"*", "", "Project", "B", 0},
		{"*", "", "ProjectColumn", "B", 0},
	}, sortRows(rows, []string{"User", "Project", "ProjectColumn"}))
	var marker protocol.RebootstrapMarker
	require.NoError(t, json.Unmarshal([]byte(entries[0].Payload), &marker))
	assert.Equal(t, protocol.RebootstrapPlacementChanged, marker.Reason)
	assert.True(t, m.repair["user"])
	placed, err := readMetaInts(ctx, MetaPlacementPrefix)
	require.NoError(t, err)
	assert.EqualValues(t, 1, placed["user"])
	assert.EqualValues(t, 0, placed["label"])
	require.NoError(t, m.HandleEpochs(ctx))
	rows, _ = takeLog(t, &cursor)
	assert.Empty(t, rows, "handled")

	// A repaired trigger of a permission table.
	require.NoError(t, livesync_model.SetMeta(ctx, capture.MetaEpochPrefix+"collaboration", "2"))
	require.NoError(t, m.HandleEpochs(ctx))
	rows, entries = takeLog(t, &cursor)
	assert.Equal(t, []logRow{
		{protocol.GroupPermission, "", "", "P", 0},
		{"*", "", "Collaboration", "B", 0},
	}, rows)
	var ch protocol.PermissionChange
	require.NoError(t, json.Unmarshal([]byte(entries[0].Payload), &ch))
	assert.Equal(t, protocol.PermissionChange{All: true}, ch)
}

// sortRows orders rows by the position of their model in order.
func sortRows(rows []logRow, order []string) []logRow {
	res := make([]logRow, 0, len(rows))
	for _, model := range order {
		for _, r := range rows {
			if r.Model == model {
				res = append(res, r)
			}
		}
	}
	return res
}
