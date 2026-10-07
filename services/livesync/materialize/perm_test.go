// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"context"
	"errors"
	"slices"
	"testing"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/models/unittest"
	"forgejo.org/modules/json"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/services/livesync/catalog"
	"forgejo.org/services/livesync/protocol"

	"code.forgejo.org/xorm/xorm/schemas"
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
	p.add(permUnverified + permState("", subject('u', 6)))
	assert.Equal(t, []int64{5, 6}, p.list('u'))
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
// backfill is complete, a delete of an unindexed row that was not inserted
// in the same batch is not a row anyone could have read (rows that were are
// TestConsumeVanishedPermissionRow).
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

// backfillAll runs the index backfill to its end.
func backfillAll(t *testing.T, m *Materializer) {
	t.Helper()
	for {
		more, err := m.BackfillStep(t.Context())
		require.NoError(t, err)
		if !more {
			return
		}
	}
}

// noEpoch asserts that rows hold no permission epoch.
func noEpoch(t *testing.T, rows []logRow) {
	t.Helper()
	for _, r := range rows {
		assert.NotEqual(t, "P", r.Op, "no permission epoch")
	}
}

// A permission row inserted and deleted again between two materializations
// (one batch) existed in between: a grant computed meanwhile may have seen
// it, and its subjects are unknown, so the epoch names everyone — except
// for access rows, which are derived from the other permission tables in
// the same transaction (their changes are the epochs).
func TestConsumeVanishedPermissionRow(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	backfillAll(t, m)
	var cursor int64
	takeLog(t, &cursor)

	exec(t, "INSERT INTO collaboration (id, repo_id, user_id, mode) VALUES (100, 2, 5, 2)")
	exec(t, "DELETE FROM collaboration WHERE id = 100")
	consume(t, m, change(1, "collaboration", 100, "I"), change(2, "collaboration", 100, "D"))
	rows, entries := takeLog(t, &cursor)
	ch, rest := permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{All: true}, ch)
	assert.Empty(t, rest)

	exec(t, "INSERT INTO access (id, user_id, repo_id, mode) VALUES (100, 5, 2, 2)")
	exec(t, "DELETE FROM access WHERE id = 100")
	consume(t, m, change(3, "access", 100, "I"), change(4, "access", 100, "D"))
	rows, _ = takeLog(t, &cursor)
	assert.Empty(t, rows)

	// Inserted, kept: an epoch for its subjects, as before.
	exec(t, "INSERT INTO collaboration (id, repo_id, user_id, mode) VALUES (101, 2, 5, 2)")
	consume(t, m, change(5, "collaboration", 101, "I"))
	rows, entries = takeLog(t, &cursor)
	ch, _ = permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{Users: []int64{5}}, ch)
}

// Forgejo replaces access rows (and team/repository units) with new ids
// on every recalculation: identical states that went and came back in one
// transaction change nobody's access and are netted out; a state that
// really changed is still an epoch.
func TestConsumePermissionNetting(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	backfillAll(t, m)
	var cursor int64
	takeLog(t, &cursor)

	// access 5: user 4 on repository 3, mode 2.
	exec(t, "DELETE FROM access WHERE id = 5")
	exec(t, "INSERT INTO access (id, user_id, repo_id, mode) VALUES (500, 4, 3, 2)")
	consume(t, m, change(1, "access", 5, "D"), change(2, "access", 500, "I"))
	rows, _ := takeLog(t, &cursor)
	noEpoch(t, rows)
	assert.Equal(t, []logRow{{"user:4", "self", "Access", "D", 5}, {"user:4", "self", "Access", "U", 500}}, rows)
	assert.Equal(t, permState(fingerprint(3, 2), "u4"), indexRow(t, "access", 500).Perm)

	// The same with another mode: an epoch for the user.
	exec(t, "DELETE FROM access WHERE id = 500")
	exec(t, "INSERT INTO access (id, user_id, repo_id, mode) VALUES (501, 4, 3, 1)")
	consume(t, m, change(3, "access", 500, "D"), change(4, "access", 501, "I"))
	rows, entries := takeLog(t, &cursor)
	ch, _ := permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{Users: []int64{4}}, ch)

	// A collaboration and an access row with the same state string are
	// different grants: never netted against each other.
	exec(t, "INSERT INTO collaboration (id, repo_id, user_id, mode) VALUES (100, 2, 5, 2)")
	consume(t, m, change(5, "collaboration", 100, "I"))
	takeLog(t, &cursor)
	exec(t, "DELETE FROM collaboration WHERE id = 100")
	exec(t, "INSERT INTO access (id, user_id, repo_id, mode) VALUES (502, 5, 2, 2)")
	require.Equal(t, indexRow(t, "collaboration", 100).Perm, permState(fingerprint(2, 2), "u5"))
	consume(t, m, change(6, "collaboration", 100, "D"), change(7, "access", 502, "I"))
	rows, entries = takeLog(t, &cursor)
	ch, _ = permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{Users: []int64{5}}, ch)
}

// A permission column changed and changed back before the materializer
// read the row: the stored and the current state are equal, but a grant
// computed in between may have seen the other one. The capture triggers
// flag such updates (OpPermUpdate), so they are epochs anyway — also when
// the two updates fall into different batches and the first batch already
// reads the restored row. Updates of other columns of the same rows are
// not (OpUpdate).
func TestConsumePermissionFlipFlop(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	backfillAll(t, m)
	var cursor int64
	takeLog(t, &cursor)

	// Repository 2 (user 2's, private) made public and private again.
	exec(t, "UPDATE repository SET is_private = ? WHERE id = 2", false)
	exec(t, "UPDATE repository SET is_private = ? WHERE id = 2", true)
	exec(t, "UPDATE repository SET num_stars = num_stars + 1 WHERE id = 2")
	consume(t, m, change(1, "repository", 2, "P"), change(2, "repository", 2, "P"), change(3, "repository", 2, "U"))
	rows, entries := takeLog(t, &cursor)
	ch, rest := permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{Users: []int64{2}, Repos: []int64{2}}, ch)
	assert.Equal(t, []logRow{{"repo:2", "", "Repository", "U", 2}}, rest, "the counter changed the DTO")

	// User 4 made site administrator and back, split across two batches.
	exec(t, "UPDATE `user` SET is_admin = ? WHERE id = 4", true)
	exec(t, "UPDATE `user` SET is_admin = ? WHERE id = 4", false)
	for _, id := range []int64{4, 5} {
		consume(t, m, change(id, "user", 4, "P"))
		rows, entries = takeLog(t, &cursor)
		ch, rest = permChange(t, rows, entries)
		assert.Equal(t, []int64{4}, ch.Users)
		assert.Equal(t, []int64{4}, ch.Owners)
		assert.False(t, ch.All)
		noEpoch(t, rest)
	}

	// A collaboration's mode up and down (collaboration 1: user 2 on
	// repository 3), in a batch that also replaces an access row with an
	// identical one (netted): the flagged row is named all the same.
	exec(t, "UPDATE collaboration SET mode = 3 WHERE id = 1")
	exec(t, "UPDATE collaboration SET mode = 2 WHERE id = 1")
	exec(t, "DELETE FROM access WHERE id = 5")
	exec(t, "INSERT INTO access (id, user_id, repo_id, mode) VALUES (500, 4, 3, 2)")
	consume(t, m, change(6, "collaboration", 1, "P"), change(7, "collaboration", 1, "P"), change(8, "access", 5, "D"), change(9, "access", 500, "I"))
	rows, entries = takeLog(t, &cursor)
	ch, _ = permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{Users: []int64{2}}, ch)

	// Plain updates of the same rows: no epoch.
	consume(t, m, change(10, "repository", 2, "U"), change(11, "user", 4, "U"), change(12, "collaboration", 1, "U"))
	rows, _ = takeLog(t, &cursor)
	noEpoch(t, rows)
}

// The permission columns the capture triggers compare
// (catalog.Table.PermColumns) are exactly the columns a row's permission
// state depends on: changing any other column of a fixture row leaves the
// state alone, changing one of them changes it.
func TestPermColumns(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	ctx := t.Context()
	errRollback := errors.New("rollback")
	beans, err := db.NamesToBean()
	require.NoError(t, err)
	tables := map[string]*schemas.Table{}
	for _, bean := range beans {
		info, err := db.TableInfo(bean)
		require.NoError(t, err)
		tables[info.Name] = info
	}
	state := func(tbl string, id int64) string {
		t.Helper()
		l := newLoader()
		defer l.close()
		loaded, err := specs[tbl].load(ctx, l, []int64{id}, false)
		require.NoError(t, err)
		require.Contains(t, loaded, id)
		return loaded[id][0].perm
	}
	n := 0
	for _, tbl := range catalog.Tracked() {
		if !specs[tbl.Name].perm {
			assert.Empty(t, tbl.PermColumns, tbl.Name)
			continue
		}
		require.NotEmpty(t, tbl.PermColumns, tbl.Name)
		info := tables[tbl.Name]
		require.NotNil(t, info, tbl.Name)
		var id int64
		has, err := db.GetEngine(ctx).Table(tbl.Name).Cols("id").OrderBy("id").Get(&id)
		require.NoError(t, err)
		require.True(t, has, "%s has fixtures", tbl.Name)
		before := state(tbl.Name, id)
		require.NotEmpty(t, before)
		checked := map[string]bool{}
		quoted := "`" + tbl.Name + "`"
		for _, col := range info.Columns() {
			if col.Name == "id" {
				continue
			}
			var set string
			switch {
			case col.SQLType.IsBool():
				set = "CASE WHEN `" + col.Name + "` THEN 0 ELSE 1 END"
			case col.SQLType.IsNumeric():
				set = "COALESCE(`" + col.Name + "`, 0) + 1000003"
			case col.SQLType.IsText():
				set = "COALESCE(`" + col.Name + "`, '') || 'x'"
			default:
				continue
			}
			err := db.WithTx(ctx, func(ctx context.Context) error {
				// Rolled back: foreign keys are never checked.
				if _, err := db.GetEngine(ctx).Exec("PRAGMA defer_foreign_keys = ON"); err != nil {
					return err
				}
				if _, err := db.GetEngine(ctx).Exec("UPDATE "+quoted+" SET `"+col.Name+"` = "+set+" WHERE id = ?", id); err != nil {
					return err
				}
				l := newLoader()
				defer l.close()
				loaded, err := specs[tbl.Name].load(ctx, l, []int64{id}, false)
				if err != nil && !slices.Contains(tbl.PermColumns, col.Name) {
					// Not a valid value of a structured column (JSON):
					// the row cannot be read, so it has no state.
					t.Logf("%s.%s: %v", tbl.Name, col.Name, err)
					return errRollback
				} else if err != nil {
					return err
				}
				after := loaded[id][0].perm
				if slices.Contains(tbl.PermColumns, col.Name) {
					assert.NotEqual(t, before, after, "%s.%s is a permission column: the state must depend on it", tbl.Name, col.Name)
				} else {
					assert.Equal(t, before, after, "%s.%s changes the permission state: add it to catalog.Table.PermColumns", tbl.Name, col.Name)
				}
				checked[col.Name] = true
				n++
				return errRollback
			})
			require.ErrorIs(t, err, errRollback, tbl.Name+"."+col.Name)
		}
		assert.Equal(t, before, state(tbl.Name, id), "rolled back")
		for _, col := range tbl.PermColumns {
			assert.True(t, checked[col], "%s.%s checked", tbl.Name, col)
		}
	}
	assert.Greater(t, n, 50)
}

// Index rows written before permission states existed (B3) have none: a
// permission walk records them without touching groups or hashes; until it
// has, the state of such a row is unknown (a delete names everyone, a
// change the row's current subjects).
func TestConsumeLegacyPermissionStates(t *testing.T) {
	resetLivesync(t)
	ctx := t.Context()
	m, _ := testMaterializer(t)
	backfillAll(t, m)
	var cursor int64
	takeLog(t, &cursor)
	// The index as B3 left it, plus a hash a materialized row would have.
	exec(t, "UPDATE livesync_entity SET perm = '' WHERE tbl IN ('collaboration', 'repository')")
	exec(t, "UPDATE livesync_entity SET hash = 'h' WHERE tbl = 'collaboration' AND row_id = 3")
	_, err := db.GetEngine(ctx).Exec("DELETE FROM livesync_meta WHERE name LIKE ?", MetaPermPrefix+"%")
	require.NoError(t, err)

	exec(t, "DELETE FROM collaboration WHERE id = 1")
	consume(t, m, change(1, "collaboration", 1, "D"))
	rows, entries := takeLog(t, &cursor)
	ch, rest := permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{All: true}, ch)
	assert.Equal(t, []logRow{{"repo:3", "", "Collaboration", "D", 1}}, rest)

	exec(t, "UPDATE repository SET description = 'changed' WHERE id = 1")
	consume(t, m, change(2, "repository", 1, "U"))
	rows, entries = takeLog(t, &cursor)
	ch, _ = permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{Users: []int64{2}, Repos: []int64{1}}, ch, "the current subjects")
	assert.NotEmpty(t, indexRow(t, "repository", 1).Perm, "recorded")

	// The permission walk: started by HandleEpochs, no log entries.
	require.NoError(t, m.HandleEpochs(ctx))
	rows, _ = takeLog(t, &cursor)
	assert.Empty(t, rows)
	assert.Equal(t, indexPerm, m.walk["collaboration"])
	assert.Equal(t, indexPerm, m.walk["access"])
	assert.True(t, m.backfillComplete("label"), "not a permission table")
	v, _, err := livesync_model.GetMeta(ctx, MetaBackfillPrefix+"collaboration")
	require.NoError(t, err)
	assert.Equal(t, "perm:0", v)
	backfillAll(t, m)
	row := indexRow(t, "collaboration", 3)
	assert.Equal(t, livesync_model.Entity{Tbl: "collaboration", RowID: 3, Grp: "repo:40", Hash: "h", Perm: permState(fingerprint(40, 2), "u4")}, *row,
		"only the permission state is written")
	require.NoError(t, m.HandleEpochs(ctx))
	assert.True(t, m.backfillComplete("collaboration"), "recorded as done")

	exec(t, "DELETE FROM collaboration WHERE id = 3")
	consume(t, m, change(3, "collaboration", 3, "D"))
	rows, entries = takeLog(t, &cursor)
	ch, _ = permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{Users: []int64{4}}, ch)
}

// An index walk that passes a row whose change is still in the outbox may
// already see the changed state: it records it as unverified, so consuming
// the change is still an epoch.
func TestBackfillPendingPermissionChange(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	var cursor int64
	exec(t, "UPDATE repository SET is_private = ? WHERE id = 1", true)
	require.NoError(t, db.Insert(t.Context(), &livesync_model.Change{ID: 1, Tbl: "repository", RowID: 1, Op: "U"}))
	backfillAll(t, m)
	assert.Equal(t, permUnverified+permState(fingerprint(true, 2), "r1", "u2"), indexRow(t, "repository", 1).Perm)
	assert.Equal(t, permState(fingerprint(true, 2), "r2", "u2"), indexRow(t, "repository", 2).Perm, "nothing pending")
	takeLog(t, &cursor)

	_, err := db.GetEngine(t.Context()).Exec("DELETE FROM livesync_change")
	require.NoError(t, err)
	consume(t, m, change(1, "repository", 1, "U"))
	rows, entries := takeLog(t, &cursor)
	ch, rest := permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{Users: []int64{2}, Repos: []int64{1}}, ch)
	assert.Equal(t, []logRow{{"repo:1", "", "Repository", "U", 1}}, rest)
	assert.Equal(t, permState(fingerprint(true, 2), "r1", "u2"), indexRow(t, "repository", 1).Perm, "verified now")
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
	assert.Equal(t, indexRepair, m.walk["user"])
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
