// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	repo_model "forgejo.org/models/repo"
	"forgejo.org/models/unittest"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/json"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/services/livesync/catalog"
	"forgejo.org/services/livesync/perm"
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
	// The backfill recorded the permission states. Updates that leave
	// them alone may still have changed them and changed them back (the
	// triggers do not say which columns changed): a row of the busy tables
	// is a touch with its recorded state (a user row with an unknown
	// state would name its subjects), the others name their subjects.
	consume(t, m, change(1, "collaboration", 1, "U"), change(2, "user", 4, "U"), change(3, "team", 1, "U"))
	rows, entries := takeLog(t, &cursor)
	ch, rest := permChange(t, rows, entries)
	assert.Contains(t, ch.Users, int64(2), "collaboration 1's user")
	assert.NotContains(t, ch.Users, int64(4), "user 4 is a touch")
	assert.Empty(t, ch.Repos)
	assert.Empty(t, ch.Owners)
	user4 := protocol.PermissionTouch{Kind: protocol.TouchUser, ID: 4, State: touchedState(t, "user", 4)}
	assert.Equal(t, []protocol.PermissionTouch{user4}, ch.Touched)
	noEpoch(t, rest)
	require.NotEmpty(t, indexRow(t, "collaboration", 1).Perm)

	// A collaboration's mode (repo 3, user 2): epoch for user 2.
	exec(t, "UPDATE collaboration SET mode = 1 WHERE id = 1")
	consume(t, m, change(10, "collaboration", 1, "U"))
	rows, entries = takeLog(t, &cursor)
	ch, rest = permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{Users: []int64{2}}, ch)
	assert.Equal(t, []logRow{{"repo:3", "", "Collaboration", "U", 1}}, rest)

	// Deleted: the state comes from the index.
	exec(t, "DELETE FROM collaboration WHERE id = 1")
	consume(t, m, change(11, "collaboration", 1, "D"))
	rows, entries = takeLog(t, &cursor)
	ch, rest = permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{Users: []int64{2}}, ch)
	assert.Equal(t, []logRow{{"repo:3", "", "Collaboration", "D", 1}}, rest)

	// A repository's description: a touch only (no subjects); made
	// private: epoch for the repository's readers and its owner.
	exec(t, "UPDATE repository SET description = 'changed' WHERE id = 1")
	consume(t, m, change(12, "repository", 1, "U"))
	rows, entries = takeLog(t, &cursor)
	ch, rest = permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{Touched: []protocol.PermissionTouch{{Kind: protocol.TouchRepository, ID: 1, State: "false,2"}}}, ch)
	assert.Equal(t, []logRow{{"repo:1", "", "Repository", "U", 1}}, rest)
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
	assert.Empty(t, ch.Touched)
	assert.Empty(t, rest)
	consume(t, m, change(15, "user", 4, "U"))
	rows, entries = takeLog(t, &cursor)
	ch, rest = permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{Touched: []protocol.PermissionTouch{{Kind: protocol.TouchUser, ID: 4, State: touchedState(t, "user", 4)}}}, ch,
		"stored: the next update is a touch")
	assert.Empty(t, rest)

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

// touchedState is the fingerprint perm records for a repository or user row
// (the part of its permission state after "#").
func touchedState(t *testing.T, tbl string, id int64) string {
	t.Helper()
	l := newLoader()
	defer l.close()
	loaded, err := specs[tbl].load(t.Context(), l, []int64{id}, false)
	require.NoError(t, err)
	require.Contains(t, loaded, id)
	_, fp, ok := strings.Cut(loaded[id][0].perm, "#")
	require.True(t, ok)
	return fp
}

// A permission column changed and changed back before the materializer
// read the row: the stored and the current state are equal, but a grant
// computed in between may have seen the other one. The capture triggers
// reference only id (PLAN §4.3), so the materializer does not know which
// columns an update changed: an update of a repository or user row that
// leaves the state as stored is a touch carrying the current state (grant
// caches drop what was computed from another state; also when the two
// updates fall into different batches and the first batch already reads
// the restored row), an update of a row of another permission table names
// its subjects.
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
	consume(t, m, change(1, "repository", 2, "U"), change(2, "repository", 2, "U"), change(3, "repository", 2, "U"))
	rows, entries := takeLog(t, &cursor)
	ch, rest := permChange(t, rows, entries)
	assert.Equal(t, "true,2", touchedState(t, "repository", 2))
	assert.Equal(t, protocol.PermissionChange{Touched: []protocol.PermissionTouch{{Kind: protocol.TouchRepository, ID: 2, State: "true,2"}}}, ch,
		"a touch, not the repository's readers")
	assert.Equal(t, []logRow{{"repo:2", "", "Repository", "U", 2}}, rest, "the counter changed the DTO")

	// User 4 made site administrator and back, split across two batches.
	exec(t, "UPDATE `user` SET is_admin = ? WHERE id = 4", true)
	exec(t, "UPDATE `user` SET is_admin = ? WHERE id = 4", false)
	user4 := protocol.PermissionTouch{Kind: protocol.TouchUser, ID: 4, State: touchedState(t, "user", 4)}
	assert.Contains(t, user4.State, ",false,false,") // not an administrator, not restricted
	for _, id := range []int64{4, 5} {
		consume(t, m, change(id, "user", 4, "U"))
		rows, entries = takeLog(t, &cursor)
		ch, rest = permChange(t, rows, entries)
		assert.Equal(t, protocol.PermissionChange{Touched: []protocol.PermissionTouch{user4}}, ch)
		noEpoch(t, rest)
	}

	// A collaboration's mode up and down (collaboration 1: user 2 on
	// repository 3), in a batch that also replaces an access row with an
	// identical one (netted): the updated row is named all the same.
	exec(t, "UPDATE collaboration SET mode = 3 WHERE id = 1")
	exec(t, "UPDATE collaboration SET mode = 2 WHERE id = 1")
	exec(t, "DELETE FROM access WHERE id = 5")
	exec(t, "INSERT INTO access (id, user_id, repo_id, mode) VALUES (500, 4, 3, 2)")
	consume(t, m, change(6, "collaboration", 1, "U"), change(7, "collaboration", 1, "U"), change(8, "access", 5, "D"), change(9, "access", 500, "I"))
	rows, entries = takeLog(t, &cursor)
	ch, _ = permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{Users: []int64{2}}, ch)

	// A real change of a busy row is an epoch for its subjects (no touch),
	// and a touch of another row goes into the same epoch.
	exec(t, "UPDATE repository SET is_private = ? WHERE id = 2", false)
	consume(t, m, change(10, "repository", 2, "U"), change(11, "user", 4, "U"))
	rows, entries = takeLog(t, &cursor)
	ch, _ = permChange(t, rows, entries)
	assert.Equal(t, protocol.PermissionChange{Users: []int64{2}, Repos: []int64{2}, Touched: []protocol.PermissionTouch{user4}}, ch)

	// Inserts and deletes are never touches; rows of other tables never
	// produce one.
	consume(t, m, change(12, "issue", 1, "U"), change(13, "label", 1, "U"))
	rows, _ = takeLog(t, &cursor)
	noEpoch(t, rows)
}

// permStateColumns are the columns each permission table's state (spec
// perm) depends on — documentation for reviewers, checked by
// TestPermStateColumns. The capture triggers do not reference them (PLAN
// §4.3); for repository and user they are the columns of
// perm.RepositoryState and perm.UserState, which grants record (perm.Basis).
var permStateColumns = map[string][]string{
	"repository":           {"owner_id", "is_private"},
	"user":                 {"type", "visibility", "is_active", "prohibit_login", "is_admin", "is_restricted"},
	"org_user":             {"uid", "org_id"},
	"team":                 {"authorize", "includes_all_repositories"},
	"team_user":            {"uid", "team_id"},
	"team_repo":            {"team_id", "repo_id"},
	"team_unit":            {"team_id", "type", "access_mode"},
	"collaboration":        {"user_id", "repo_id", "mode"},
	"access":               {"user_id", "repo_id", "mode"},
	"repo_unit":            {"repo_id", "type", "default_permissions"},
	"forgejo_blocked_user": {"user_id", "block_id"},
}

// A row's permission state depends exactly on permStateColumns: changing
// any other column of a fixture row leaves the state alone, changing one
// of them changes it. For the busy tables (spec permTouch) the state's
// fingerprint is the one the perm package records for the row.
func TestPermStateColumns(t *testing.T) {
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
		cols := permStateColumns[tbl.Name]
		if !specs[tbl.Name].perm {
			assert.Empty(t, cols, tbl.Name)
			assert.Empty(t, specs[tbl.Name].permTouch, tbl.Name)
			continue
		}
		require.NotEmpty(t, cols, tbl.Name)
		info := tables[tbl.Name]
		require.NotNil(t, info, tbl.Name)
		var id int64
		has, err := db.GetEngine(ctx).Table(tbl.Name).Cols("id").OrderBy("id").Get(&id)
		require.NoError(t, err)
		require.True(t, has, "%s has fixtures", tbl.Name)
		before := state(tbl.Name, id)
		require.NotEmpty(t, before)
		switch tbl.Name {
		case "repository":
			r := &repo_model.Repository{}
			_, err := db.GetEngine(ctx).ID(id).Get(r)
			require.NoError(t, err)
			assert.True(t, strings.HasSuffix(before, "#"+perm.RepositoryState(r)), before)
			assert.Equal(t, protocol.TouchRepository, specs[tbl.Name].permTouch)
		case "user":
			u := &user_model.User{}
			_, err := db.GetEngine(ctx).ID(id).Get(u)
			require.NoError(t, err)
			assert.True(t, strings.HasSuffix(before, "#"+perm.UserState(u)), before)
			assert.Equal(t, protocol.TouchUser, specs[tbl.Name].permTouch)
		default:
			assert.Empty(t, specs[tbl.Name].permTouch, tbl.Name)
		}
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
				if err != nil && !slices.Contains(cols, col.Name) {
					// Not a valid value of a structured column (JSON):
					// the row cannot be read, so it has no state.
					t.Logf("%s.%s: %v", tbl.Name, col.Name, err)
					return errRollback
				} else if err != nil {
					return err
				}
				after := loaded[id][0].perm
				if slices.Contains(cols, col.Name) {
					assert.NotEqual(t, before, after, "%s.%s is listed: the state must depend on it", tbl.Name, col.Name)
				} else {
					assert.Equal(t, before, after, "%s.%s changes the permission state: list it in permStateColumns", tbl.Name, col.Name)
				}
				checked[col.Name] = true
				n++
				return errRollback
			})
			require.ErrorIs(t, err, errRollback, tbl.Name+"."+col.Name)
		}
		assert.Equal(t, before, state(tbl.Name, id), "rolled back")
		for _, col := range cols {
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
// or organization's projects and their columns in the owner's own group,
// the projects' ProjectRefs in the owner group (readers of the owner's
// repositories' issues see them).
func TestProfilePlacement(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	var cursor int64
	consume(t, m,
		change(1, "user", 2, "U"), change(2, "user", 33, "U"), change(3, "user", 31, "U"), change(4, "user", 3, "U"),
		change(5, "project", 4, "U"), change(6, "project_board", 4, "U"))
	rows, entries := takeLog(t, &cursor)
	_, rest := permChange(t, rows, entries) // first time the user rows are seen
	assert.Equal(t, []logRow{
		{protocol.GroupProfilesPublic, "", "User", "U", 2},
		{protocol.GroupProfilesLimited, "", "User", "U", 33},
		{"profile:31", "", "User", "U", 31},
		{"org:3", "", "User", "U", 3},
		{"profile:2", "", "Project", "U", 4},
		{"owner:2", "", "ProjectRef", "U", 4},
		{"profile:2", "", "ProjectColumn", "U", 4},
	}, rest)
}

// An organization's or user's project is two entities (B6 follow-up): the
// Project, with what its page shows, in the group of those who may see the
// owner (org:{id} / profile:{id}), and a ProjectRef with only what
// upstream's issue list filter and issue sidebar show (id, owner, title,
// open/closed, type) in owner:{id}, which collaborators who may not see the
// owner read too. A repository project has no ProjectRef. Changes that
// upstream does not show those readers reach only the Project's group; a
// Project indexed in owner:{id} by placement version 2 moves out of it.
func TestProjectRefPlacement(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	var cursor int64
	// Fixtures: project 7 is org3's, project 1 repository 1's.
	consume(t, m, change(1, "project", 7, "U"), change(2, "project", 1, "U"))
	rows, entries := takeLog(t, &cursor)
	assert.Equal(t, []logRow{
		{"org:3", "", "Project", "U", 7},
		{"owner:3", "", "ProjectRef", "U", 7},
		{"repo:1", "projects", "Project", "U", 1},
	}, rows)
	var ref map[string]any
	require.NoError(t, json.Unmarshal([]byte(entries[1].Payload), &ref))
	assert.Equal(t, map[string]any{"id": float64(7), "owner_id": float64(3), "title": "project on org3", "closed": false, "type": float64(3)}, ref,
		"exactly what upstream shows readers of the owner's repositories")
	var project protocol.Project
	require.NoError(t, json.Unmarshal([]byte(entries[0].Payload), &project))
	assert.EqualValues(t, 2, project.CreatorID)

	// The description, creator or timestamps change: the Project only.
	exec(t, "UPDATE project SET description = 'secret plans', updated_unix = updated_unix + 10 WHERE id = 7")
	consume(t, m, change(3, "project", 7, "U"))
	rows, _ = takeLog(t, &cursor)
	assert.Equal(t, []logRow{{"org:3", "", "Project", "U", 7}}, rows)
	// Closing it: both.
	exec(t, "UPDATE project SET is_closed = ? WHERE id = 7", true)
	consume(t, m, change(4, "project", 7, "U"))
	rows, entries = takeLog(t, &cursor)
	assert.Equal(t, []logRow{{"org:3", "", "Project", "U", 7}, {"owner:3", "", "ProjectRef", "U", 7}}, rows)
	require.NoError(t, json.Unmarshal([]byte(entries[1].Payload), &ref))
	assert.Equal(t, true, ref["closed"])

	// An index written by placement version 2 (the Project in owner:3, no
	// ProjectRef): the next change moves the Project out of owner:3.
	exec(t, "UPDATE livesync_entity SET grp = 'owner:3' WHERE tbl = 'project' AND row_id = 7")
	exec(t, "DELETE FROM livesync_entity WHERE tbl = ? AND row_id = 7", projectRefKey)
	exec(t, "UPDATE project SET title = 'renamed' WHERE id = 7")
	consume(t, m, change(5, "project", 7, "U"))
	rows, _ = takeLog(t, &cursor)
	assert.Equal(t, []logRow{
		{"owner:3", "", "Project", "D", 7},
		{"org:3", "", "Project", "U", 7},
		{"owner:3", "", "ProjectRef", "U", 7},
	}, rows)

	// Deleted: gone from both groups.
	exec(t, "DELETE FROM project WHERE id = 7")
	consume(t, m, change(6, "project", 7, "D"))
	rows, _ = takeLog(t, &cursor)
	assert.Equal(t, []logRow{{"org:3", "", "Project", "D", 7}, {"owner:3", "", "ProjectRef", "D", 7}}, rows)
	assert.Empty(t, indexRows(t, projectRefKey))
}

// An organization label (owner:{id}) carries no issue counts and no
// updated_at (B6 follow-up): its counters span the organization's private
// repositories, and upstream shows them to its owners only, so a counter
// recalculation is no change; a repository label keeps them.
func TestOrgLabelPayload(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	var cursor int64
	// Fixtures: label 3 is org3's, label 1 repository 1's.
	consume(t, m, change(1, "label", 3, "U"), change(2, "label", 1, "U"))
	rows, entries := takeLog(t, &cursor)
	assert.Equal(t, []logRow{{"owner:3", "", "Label", "U", 3}, {"repo:1", "issues|pulls", "Label", "U", 1}}, rows)
	var org, repo map[string]any
	require.NoError(t, json.Unmarshal([]byte(entries[0].Payload), &org))
	require.NoError(t, json.Unmarshal([]byte(entries[1].Payload), &repo))
	assert.NotContains(t, org, "updated_at")
	assert.Zero(t, org["num_issues"])
	assert.Zero(t, org["num_closed_issues"])
	assert.Contains(t, repo, "updated_at")
	assert.Positive(t, repo["num_issues"])

	exec(t, "UPDATE label SET num_issues = num_issues + 5, num_closed_issues = num_closed_issues + 1, updated_unix = updated_unix + 60 WHERE id IN (1, 3)")
	consume(t, m, change(3, "label", 3, "U"), change(4, "label", 1, "U"))
	rows, _ = takeLog(t, &cursor)
	assert.Equal(t, []logRow{{"repo:1", "issues|pulls", "Label", "U", 1}}, rows, "the organization label did not change for its readers")
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
		{"*", "", "Label", "B", 0},
		{"*", "", "Project", "B", 0},
		{"*", "", "ProjectRef", "B", 0},
		{"*", "", "ProjectColumn", "B", 0},
	}, sortRows(rows, []string{"User", "Label", "Project", "ProjectRef", "ProjectColumn"}))
	var marker protocol.RebootstrapMarker
	require.NoError(t, json.Unmarshal([]byte(entries[0].Payload), &marker))
	assert.Equal(t, protocol.RebootstrapPlacementChanged, marker.Reason)
	assert.Equal(t, indexRepair, m.walk["user"])
	placed, err := readMetaInts(ctx, MetaPlacementPrefix)
	require.NoError(t, err)
	assert.EqualValues(t, 1, placed["user"])
	assert.EqualValues(t, 1, placed["label"])
	assert.EqualValues(t, 3, placed["project"])
	assert.EqualValues(t, 0, placed["milestone"])
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
