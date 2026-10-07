// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/models/unittest"
	"forgejo.org/modules/json"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/services/livesync/catalog"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/services/livesync/synclog"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// DB-free logic first, then the materializer on SQLite with Forgejo's
// fixtures (unit tests only: livesync never runs on SQLite; the real
// pipeline is covered by the TestLivesyncMaterialize* integration tests).

func change(id int64, tbl string, row int64, op string) livesync_model.Change {
	return livesync_model.Change{ID: id, Tbl: tbl, RowID: row, Op: op}
}

func TestCoalesce(t *testing.T) {
	got := coalesce([]livesync_model.Change{
		change(1, "issue", 7, "I"),
		change(2, "comment", 3, "I"),
		change(3, "issue", 7, "U"),
		change(4, "label", 7, "U"),
		change(5, "issue", 7, "D"),
		change(6, "comment", 4, "I"),
	})
	assert.Equal(t, []rowChanges{
		{key: rowKey{"issue", 7}, changeIDs: []int64{1, 3, 5}},
		{key: rowKey{"comment", 3}, changeIDs: []int64{2}},
		{key: rowKey{"label", 7}, changeIDs: []int64{4}},
		{key: rowKey{"comment", 4}, changeIDs: []int64{6}},
	}, got)
	assert.EqualValues(t, 5, got[0].last())
	assert.Empty(t, coalesce(nil))
}

func TestHotLimiter(t *testing.T) {
	now := time.Unix(1000, 0)
	k1, k2 := rowKey{"notification", 1}, rowKey{"notification", 2}

	h := newHotLimiter(time.Second)
	ok, _ := h.admit(k1, now)
	assert.True(t, ok, "first change: at once")
	h.done(k1, now)
	ok, until := h.admit(k1, now.Add(300*time.Millisecond))
	assert.False(t, ok, "within the window: deferred")
	assert.Equal(t, now.Add(time.Second), until)
	ok, _ = h.admit(k2, now.Add(300*time.Millisecond))
	assert.True(t, ok, "other rows are independent")
	ok, _ = h.admit(k1, now.Add(time.Second))
	assert.True(t, ok, "window passed")

	off := newHotLimiter(0)
	off.done(k1, now)
	ok, _ = off.admit(k1, now)
	assert.True(t, ok, "disabled")

	for i := range maxHotRows + 1 {
		h.done(rowKey{"notification", int64(100 + i)}, now)
	}
	h.done(k2, now.Add(2*time.Second))
	h.prune(now.Add(2 * time.Second))
	assert.Equal(t, map[rowKey]time.Time{k2: now.Add(2 * time.Second)}, h.last)
}

func TestSpecsCoverCatalog(t *testing.T) {
	tracked := catalog.Tracked()
	assert.Len(t, specs, len(tracked))
	for _, tbl := range tracked {
		s := specs[tbl.Name]
		require.NotNil(t, s, tbl.Name)
		assert.Equal(t, tbl.Name, s.table)
		assert.Equal(t, tbl.Name, s.keys[0], "the main entity is keyed by the table")
		assert.Equal(t, tbl.Model, string(s.models[0]), "catalog and protocol model names agree")
		assert.Len(t, s.models, len(s.keys))
		assert.Len(t, s.schemas, len(s.keys))
		for i, key := range s.keys[1:] {
			assert.True(t, strings.HasPrefix(key, tbl.Name+"#"), "derived key %q", key)
			assert.Positive(t, s.schemas[i+1])
		}
		assert.Equal(t, tbl.Hot, hotTables[tbl.Name])
	}
}

func resetLivesync(t *testing.T) {
	t.Helper()
	require.NoError(t, unittest.PrepareTestDatabase())
	require.NoError(t, livesync_model.SyncTables(t.Context()))
	for _, table := range []string{"livesync_change", "livesync_log", "livesync_entity", "livesync_meta"} {
		_, err := db.GetEngine(t.Context()).Exec("DELETE FROM " + table)
		require.NoError(t, err)
	}
}

// Every tracked table's fixture rows can be materialized: loaders, groups
// and DTOs of all 39 tables.
func TestLoadFixtures(t *testing.T) {
	resetLivesync(t)
	ctx := t.Context()
	for _, tbl := range catalog.Tracked() {
		var ids []int64
		require.NoError(t, db.GetEngine(ctx).Table(tbl.Name).Cols("id").OrderBy("id").Limit(20).Find(&ids))
		if len(ids) == 0 {
			continue // no fixtures (e.g. pull_auto_merge)
		}
		loaded, err := specs[tbl.Name].load(ctx, newLoader(), ids, true)
		require.NoError(t, err, tbl.Name)
		assert.Len(t, loaded, len(ids), tbl.Name)
		for id, ents := range loaded {
			require.Len(t, ents, len(specs[tbl.Name].keys))
			for _, e := range ents {
				if e.group == "" {
					assert.Nil(t, e.dto)
					continue
				}
				assert.Regexp(t, `^(user|org|repo|issue):\d+$`, e.group, "%s %d", tbl.Name, id)
				payload, hash, err := e.payload()
				require.NoError(t, err)
				assert.Contains(t, payload, fmt.Sprintf(`"id":%d`, id), "%s %d", tbl.Name, id)
				assert.NotEmpty(t, hash)
			}
		}
		// Without DTOs (backfill): same groups.
		bare, err := specs[tbl.Name].load(ctx, newLoader(), ids, false)
		require.NoError(t, err)
		for id, ents := range bare {
			for i, e := range ents {
				assert.Nil(t, e.dto)
				assert.Equal(t, loaded[id][i].group, e.group)
				assert.Equal(t, loaded[id][i].unit, e.unit)
			}
		}
	}
}

// testMaterializer returns a materializer with its own writer.
func testMaterializer(t *testing.T) (*Materializer, *bool) {
	t.Helper()
	w, err := synclog.AcquireWriter(t.Context(), nil)
	require.NoError(t, err)
	t.Cleanup(w.Release)
	stopped := new(bool)
	m := New(Config{HotWindow: time.Hour}, w, func() { *stopped = true })
	require.NoError(t, m.Prepare(t.Context()))
	return m, stopped
}

func consume(t *testing.T, m *Materializer, changes ...livesync_model.Change) *capture.Batch {
	t.Helper()
	for _, c := range changes {
		require.NoError(t, db.Insert(t.Context(), &c))
	}
	b := &capture.Batch{Changes: changes, Cursor: changes[len(changes)-1].ID}
	require.NoError(t, m.Consume(t.Context(), b))
	return b
}

type logRow struct {
	Grp, Unit, Model, Op string
	EntityID             int64
}

// takeLog returns the log entries after cursor.
func takeLog(t *testing.T, cursor *int64) ([]logRow, []livesync_model.LogEntry) {
	t.Helper()
	entries, err := synclog.ReadSince(t.Context(), "", *cursor, 1000)
	require.NoError(t, err)
	var rows []logRow
	for i, e := range entries {
		require.Equal(t, *cursor+int64(i)+1, e.SyncID, "gap-free")
		rows = append(rows, logRow{e.Grp, e.Unit, e.Model, e.Op, e.EntityID})
	}
	if len(entries) > 0 {
		*cursor = entries[len(entries)-1].SyncID
	}
	return rows, entries
}

func indexRow(t *testing.T, key string, id int64) *livesync_model.Entity {
	t.Helper()
	e := &livesync_model.Entity{}
	has, err := db.GetEngine(t.Context()).Where("tbl = ? AND row_id = ?", key, id).Get(e)
	require.NoError(t, err)
	if !has {
		return nil
	}
	return e
}

func TestConsume(t *testing.T) {
	resetLivesync(t)
	ctx := t.Context()
	m, stopped := testMaterializer(t)
	var cursor int64

	// Issue 1 (repo 1), comment 2 (on issue 1), label 1 twice, an
	// untracked table: one entry per entity, the issue gives two.
	b := consume(t, m,
		change(1, "issue", 1, "U"), change(2, "comment", 2, "I"), change(3, "label", 1, "U"),
		change(4, "label", 1, "U"), change(5, "probe", 1, "U"))
	rows, entries := takeLog(t, &cursor)
	assert.Equal(t, []logRow{
		{"repo:1", "issues", "Issue", "U", 1},
		{"issue:1", "issues", "IssueBody", "U", 1},
		{"issue:1", "issues", "Comment", "U", 2},
		{"repo:1", "issues|pulls", "Label", "U", 1},
	}, rows)
	var issue protocol.Issue
	require.NoError(t, json.Unmarshal([]byte(entries[0].Payload), &issue))
	assert.EqualValues(t, 1, issue.Number)
	assert.Equal(t, "issue1", issue.Title)
	assert.Equal(t, "open", issue.State)
	assert.Equal(t, protocol.SchemaIssue, entries[0].SchemaVer)
	var body protocol.IssueBody
	require.NoError(t, json.Unmarshal([]byte(entries[1].Payload), &body))
	assert.Equal(t, "content for the first issue", body.Body)
	assert.Equal(t, "<p>content for the first issue</p>\n", body.BodyHTML)
	var comment protocol.Comment
	require.NoError(t, json.Unmarshal([]byte(entries[2].Payload), &comment))
	assert.Equal(t, "comment", comment.Type)
	assert.Equal(t, "<p>good work!</p>\n", comment.BodyHTML)

	// The batch was acknowledged in the same transaction.
	var left int64
	_, err := db.GetEngine(ctx).SQL("SELECT COUNT(*) FROM livesync_change").Get(&left)
	require.NoError(t, err)
	assert.Zero(t, left)
	v, _, err := livesync_model.GetMeta(ctx, capture.MetaCursor)
	require.NoError(t, err)
	assert.Equal(t, "5", v)
	_ = b

	// The index knows where each entity went.
	label := indexRow(t, "label", 1)
	require.NotNil(t, label)
	assert.Equal(t, "repo:1", label.Grp)
	assert.Equal(t, "issues|pulls", label.Unit)
	assert.EqualValues(t, 4, label.LastSyncID)
	require.NotNil(t, indexRow(t, issueBodyKey, 1))

	// Nothing visible changed: nothing emitted.
	consume(t, m, change(6, "label", 1, "U"), change(7, "issue", 1, "U"))
	rows, _ = takeLog(t, &cursor)
	assert.Empty(t, rows)

	// A visible change: emitted.
	_, err = db.GetEngine(ctx).Exec("UPDATE label SET name = 'renamed' WHERE id = 1")
	require.NoError(t, err)
	consume(t, m, change(8, "label", 1, "U"))
	rows, _ = takeLog(t, &cursor)
	assert.Equal(t, []logRow{{"repo:1", "issues|pulls", "Label", "U", 1}}, rows)

	// A delete is routed by the index (the row is gone) and unindexed.
	_, err = db.GetEngine(ctx).Exec("DELETE FROM label WHERE id = 1")
	require.NoError(t, err)
	consume(t, m, change(9, "label", 1, "D"))
	rows, _ = takeLog(t, &cursor)
	assert.Equal(t, []logRow{{"repo:1", "issues|pulls", "Label", "D", 1}}, rows)
	assert.Nil(t, indexRow(t, "label", 1))

	// A delete of a row that was never emitted nor indexed goes to
	// everyone while the table's index backfill is incomplete...
	consume(t, m, change(10, "label", 999, "D"))
	rows, _ = takeLog(t, &cursor)
	assert.Equal(t, []logRow{{"*", "", "Label", "D", 999}}, rows)
	// ...and nowhere once it is complete.
	m.backfill["label"] = backfillDone
	consume(t, m, change(11, "label", 998, "D"))
	rows, _ = takeLog(t, &cursor)
	assert.Empty(t, rows)

	// An entity that moves to another group: delete there, upsert here.
	consume(t, m, change(12, "milestone", 1, "U"))
	takeLog(t, &cursor)
	_, err = db.GetEngine(ctx).Exec("UPDATE milestone SET repo_id = 2 WHERE id = 1")
	require.NoError(t, err)
	consume(t, m, change(13, "milestone", 1, "U"))
	rows, _ = takeLog(t, &cursor)
	assert.Equal(t, []logRow{
		{"repo:1", "issues|pulls", "Milestone", "D", 1},
		{"repo:2", "issues|pulls", "Milestone", "U", 1},
	}, rows)
	assert.False(t, *stopped)
}

func TestConsumeHot(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	var cursor int64

	consume(t, m, change(1, "notification", 1, "U"))
	rows, _ := takeLog(t, &cursor)
	assert.Equal(t, []logRow{{"user:1", "", "Notification", "U", 1}}, rows)

	// Within the window (an hour here), further changes of that row are
	// deferred: the newest outbox row stays, the others are deleted.
	_, err := db.GetEngine(t.Context()).Exec("UPDATE notification SET status = 2 WHERE id = 1")
	require.NoError(t, err)
	b := consume(t, m, change(2, "notification", 1, "U"), change(3, "notification", 1, "U"), change(4, "notification", 2, "U"))
	rows, _ = takeLog(t, &cursor)
	assert.Equal(t, []logRow{{"user:2", "", "Notification", "U", 2}}, rows, "only the other row")
	var left []int64
	require.NoError(t, db.GetEngine(t.Context()).Table("livesync_change").Cols("id").Find(&left))
	assert.Equal(t, []int64{3}, left)
	_ = b
}

func TestConsumeFencing(t *testing.T) {
	resetLivesync(t)
	m, stopped := testMaterializer(t)
	// Another writer takes over (possible after a lost lease connection;
	// on SQLite the lease is not exclusive).
	other, err := synclog.AcquireWriter(t.Context(), nil)
	require.NoError(t, err)
	defer other.Release()

	c := change(1, "label", 1, "U")
	require.NoError(t, db.Insert(t.Context(), &c))
	err = m.Consume(t.Context(), &capture.Batch{Changes: []livesync_model.Change{c}, Cursor: 1})
	require.ErrorIs(t, err, synclog.ErrNotWriter)
	assert.True(t, *stopped)
	var left int64
	_, err = db.GetEngine(t.Context()).SQL("SELECT COUNT(*) FROM livesync_change").Get(&left)
	require.NoError(t, err)
	assert.EqualValues(t, 1, left, "not acknowledged")
}

func TestHandleEpochs(t *testing.T) {
	resetLivesync(t)
	ctx := t.Context()
	require.NoError(t, livesync_model.SetMeta(ctx, capture.MetaEpochPrefix+"label", "1"))
	require.NoError(t, livesync_model.SetMeta(ctx, capture.MetaEpochPrefix+"issue", "1"))
	m, _ := testMaterializer(t) // Prepare handles the epochs
	var cursor int64

	// First start: recorded without markers.
	rows, _ := takeLog(t, &cursor)
	assert.Empty(t, rows)
	handled, err := readMetaInts(ctx, MetaHandledEpochPrefix)
	require.NoError(t, err)
	assert.EqualValues(t, 1, handled["label"])
	assert.EqualValues(t, 0, handled["comment"])
	assert.Len(t, handled, len(catalog.Tracked()))

	// Unchanged: nothing.
	require.NoError(t, m.HandleEpochs(ctx))
	rows, _ = takeLog(t, &cursor)
	assert.Empty(t, rows)

	// Repaired triggers bump epochs: one marker per model.
	m.backfill["label"] = backfillDone
	require.NoError(t, livesync_model.SetMeta(ctx, capture.MetaEpochPrefix+"label", "2"))
	require.NoError(t, livesync_model.SetMeta(ctx, capture.MetaEpochPrefix+"issue", "2"))
	require.NoError(t, m.HandleEpochs(ctx))
	rows, entries := takeLog(t, &cursor)
	assert.Equal(t, []logRow{
		{"*", "", "Issue", "B", 0},
		{"*", "", "IssueBody", "B", 0},
		{"*", "", "Label", "B", 0},
	}, rows)
	var marker protocol.RebootstrapMarker
	require.NoError(t, json.Unmarshal([]byte(entries[2].Payload), &marker))
	assert.Equal(t, protocol.RebootstrapMarker{Table: "label", Epoch: 2}, marker)
	handled, err = readMetaInts(ctx, MetaHandledEpochPrefix)
	require.NoError(t, err)
	assert.EqualValues(t, 2, handled["label"])
	assert.False(t, m.backfillComplete("label"), "the backfill restarts")
	v, _, err := livesync_model.GetMeta(ctx, MetaBackfillPrefix+"label")
	require.NoError(t, err)
	assert.Equal(t, "0", v)

	require.NoError(t, m.HandleEpochs(ctx))
	rows, _ = takeLog(t, &cursor)
	assert.Empty(t, rows, "handled")
}

func TestBackfill(t *testing.T) {
	resetLivesync(t)
	ctx := t.Context()
	m, _ := testMaterializer(t)
	steps := 0
	for {
		more, err := m.BackfillStep(ctx)
		require.NoError(t, err)
		if !more {
			break
		}
		steps++
	}
	assert.GreaterOrEqual(t, steps, len(catalog.Tracked()))
	for _, tbl := range catalog.Tracked() {
		assert.True(t, m.backfillComplete(tbl.Name), tbl.Name)
	}
	issue := indexRow(t, "issue", 5)
	require.NotNil(t, issue)
	assert.Equal(t, livesync_model.Entity{Tbl: "issue", RowID: 5, Grp: "repo:1", Unit: "issues"}, *issue)
	require.NotNil(t, indexRow(t, issueBodyKey, 5))
	pull := indexRow(t, "issue", 2) // a pull request
	require.NotNil(t, pull)
	assert.Equal(t, "pulls", pull.Unit)

	// Progress survives a restart.
	m2, _ := testMaterializer(t)
	more, err := m2.BackfillStep(ctx)
	require.NoError(t, err)
	assert.False(t, more)

	// A backfilled row has no hash: its next change is emitted, and an
	// unchanged delete is routed by the backfilled index.
	var cursor int64
	consume(t, m2, change(1, "issue", 5, "U"))
	rows, _ := takeLog(t, &cursor)
	assert.Len(t, rows, 2)
	require.NoError(t, db.WithTx(ctx, func(ctx context.Context) error {
		_, err := db.GetEngine(ctx).Exec("DELETE FROM label WHERE id = 2")
		return err
	}))
	consume(t, m2, change(2, "label", 2, "D"))
	rows, _ = takeLog(t, &cursor)
	assert.Equal(t, []logRow{{"repo:1", "issues|pulls", "Label", "D", 2}}, rows)
}
