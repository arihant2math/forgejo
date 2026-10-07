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
	"forgejo.org/modules/setting"
	"forgejo.org/modules/test"
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
		l := newLoader()
		loaded, err := specs[tbl.Name].load(ctx, l, ids, true)
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
				hash, err := e.changeHash(ctx, l)
				require.NoError(t, err)
				assert.NotEmpty(t, hash)
				payload, err := e.payload(ctx, l)
				require.NoError(t, err)
				assert.Contains(t, payload, fmt.Sprintf(`"id":%d`, id), "%s %d", tbl.Name, id)
				assert.NotContains(t, payload, `\u003c`, "no HTML escaping")
				if tbl.Tier == catalog.TierOnDemand {
					assert.NotContains(t, payload, "content_text", "on-demand tier: no text in the log")
				}
			}
		}
		l.close()
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
	// untracked table: one entry per entity, the issue gives two. The
	// comment enters a group, so the rows that hang off it (attachments 6
	// and 7, reactions 4 and 5, not emitted before) follow.
	b := consume(t, m,
		change(1, "issue", 1, "U"), change(2, "comment", 2, "I"), change(3, "label", 1, "U"),
		change(4, "label", 1, "U"), change(5, "probe", 1, "U"))
	rows, entries := takeLog(t, &cursor)
	assert.Equal(t, []logRow{
		{"repo:1", "issues", "Issue", "U", 1},
		{"issue:1", "issues", "IssueBody", "U", 1},
		{"issue:1", "issues", "Comment", "U", 2},
		{"repo:1", "issues|pulls", "Label", "U", 1},
		{"issue:1", "issues", "Attachment", "U", 6},
		{"issue:1", "issues", "Attachment", "U", 7},
		{"issue:1", "issues", "Reaction", "U", 4},
		{"issue:1", "issues", "Reaction", "U", 5},
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

	// A delete of a row that was never emitted nor indexed goes nowhere
	// (never to every client), whether the table's index backfill is
	// complete or not: bootstraps wait for the backfill.
	consume(t, m, change(10, "label", 999, "D"))
	rows, _ = takeLog(t, &cursor)
	assert.Empty(t, rows)
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
	assert.Equal(t, []logRow{{"user:1", "self", "Notification", "U", 1}}, rows)

	// Within the window (an hour here), further changes of that row are
	// deferred: the newest outbox row stays, the others are deleted.
	_, err := db.GetEngine(t.Context()).Exec("UPDATE notification SET status = 2 WHERE id = 1")
	require.NoError(t, err)
	b := consume(t, m, change(2, "notification", 1, "U"), change(3, "notification", 1, "U"), change(4, "notification", 2, "U"))
	rows, _ = takeLog(t, &cursor)
	assert.Equal(t, []logRow{{"user:2", "self", "Notification", "U", 2}}, rows, "only the other row")
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
	assert.True(t, m.repair["label"], "in repair mode")
	v, _, err := livesync_model.GetMeta(ctx, MetaBackfillPrefix+"label")
	require.NoError(t, err)
	assert.Equal(t, "repair:0", v)

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

func exec(t *testing.T, query string, args ...any) {
	t.Helper()
	_, err := db.GetEngine(t.Context()).Exec(append([]any{query}, args...)...)
	require.NoError(t, err)
}

// Entities that upstream shows to some readers of their issue, repository,
// user or organization only are not published to everyone who may read the
// group: pending reviews (and their comments and attachments), draft
// releases (and their attachments), cross-references from other
// repositories, members-only organization rows, a user's own rows.
func TestConsumePlacement(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	var cursor int64

	// Fixtures: review 4 is pending (reviewer 1, pull 2) and comment 4 is
	// its code comment; attachment 3 hangs off that comment (moved there),
	// attachment 10 off draft release 4; comment 2082 on issue 1 references
	// it from repository 32, comment 2080 from the same repository; org 3
	// has a public (1) and a concealed (2) membership.
	exec(t, "UPDATE attachment SET comment_id = 4, issue_id = 2 WHERE id = 3")
	exec(t, "UPDATE attachment SET release_id = 4, repo_id = 1 WHERE id = 10")
	consume(t, m,
		change(1, "review", 4, "U"), change(2, "comment", 4, "U"), change(3, "attachment", 3, "U"),
		change(4, "release", 4, "U"), change(5, "attachment", 10, "U"),
		change(6, "comment", 2082, "U"), change(7, "comment", 2080, "U"),
		change(8, "org_user", 1, "U"), change(9, "org_user", 2, "U"), change(10, "team", 1, "U"),
		change(11, "team_repo", 1, "U"), change(12, "label", 3, "U"),
		change(13, "star", 1, "U"), change(14, "project_issue", 1, "U"))
	rows, entries := takeLog(t, &cursor)
	assert.Equal(t, []logRow{
		{"user:1", "self", "Review", "U", 4},
		{"user:1", "self", "Comment", "U", 4},
		{"user:1", "self", "Attachment", "U", 3},
		// release 4, attachment 10 (draft) and comment 2082 (another
		// repository's reference): nowhere
		{"issue:1", "issues", "Comment", "U", 2080},
		{"org:3", "", "OrgUser", "U", 1},
		{"org:3", "members", "OrgUser", "U", 2},
		{"org:3", "members", "Team", "U", 1},
		{"org:3", "members", "TeamRepo", "U", 1},
		{"org:3", "", "Label", "U", 3},
		{"user:2", "self", "Star", "U", 1},
		{"repo:1", "issues", "ProjectIssue", "U", 1},
	}, rows)
	var review protocol.Review
	require.NoError(t, json.Unmarshal([]byte(entries[0].Payload), &review))
	assert.Equal(t, "PENDING", review.State)

	// Submitting the review changes the review row only: the review, its
	// comment and the comment's attachment move to the pull request.
	exec(t, "UPDATE review SET type = 1 WHERE id = 4")
	consume(t, m, change(20, "review", 4, "U"))
	rows, _ = takeLog(t, &cursor)
	assert.Equal(t, []logRow{
		{"user:1", "self", "Review", "D", 4},
		{"issue:2", "pulls", "Review", "U", 4},
		{"user:1", "self", "Comment", "D", 4},
		{"issue:2", "pulls", "Comment", "U", 4},
		{"user:1", "self", "Attachment", "D", 3},
		{"issue:2", "pulls", "Attachment", "U", 3},
	}, rows)

	// Publishing the draft: the release and its attachment appear.
	exec(t, "UPDATE `release` SET is_draft = ? WHERE id = 4", false)
	consume(t, m, change(21, "release", 4, "U"))
	rows, _ = takeLog(t, &cursor)
	assert.Equal(t, []logRow{
		{"repo:1", "releases", "Release", "U", 4},
		{"repo:1", "releases", "Attachment", "U", 10},
	}, rows)

	// Concealing a membership: gone for non-members, kept for members.
	exec(t, "UPDATE org_user SET is_public = ? WHERE id = 1", false)
	consume(t, m, change(22, "org_user", 1, "U"))
	rows, _ = takeLog(t, &cursor)
	assert.Equal(t, []logRow{
		{"org:3", "", "OrgUser", "D", 1},
		{"org:3", "members", "OrgUser", "U", 1},
	}, rows)
}

// An issue row change that leaves the body alone (every comment touches
// updated_unix) does not render the body again.
func TestConsumeRenderSkip(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	var cursor int64
	consume(t, m, change(1, "issue", 1, "U"))
	rows, entries := takeLog(t, &cursor)
	require.Len(t, rows, 2)
	assert.Contains(t, entries[1].Payload, `"body_html":"<p>content for the first issue</p>\n"`, "HTML is not escaped")

	before := renderCount.Load()
	exec(t, "UPDATE issue SET updated_unix = updated_unix + 10, num_comments = num_comments + 1 WHERE id = 1")
	consume(t, m, change(2, "issue", 1, "U"))
	rows, _ = takeLog(t, &cursor)
	assert.Equal(t, []logRow{{"repo:1", "issues", "Issue", "U", 1}}, rows)
	assert.Equal(t, before, renderCount.Load(), "the body was not rendered")

	exec(t, "UPDATE issue SET content = 'new *body*' WHERE id = 1")
	consume(t, m, change(3, "issue", 1, "U"))
	rows, entries = takeLog(t, &cursor)
	assert.Equal(t, []logRow{{"issue:1", "issues", "IssueBody", "U", 1}}, rows)
	assert.Equal(t, before+1, renderCount.Load())
	var body protocol.IssueBody
	require.NoError(t, json.Unmarshal([]byte(entries[0].Payload), &body))
	assert.Equal(t, "<p>new <em>body</em></p>\n", body.BodyHTML)

	// A renamed repository changes the links: rendered again.
	exec(t, "UPDATE repository SET name = 'renamed' WHERE id = 1")
	consume(t, m, change(4, "issue", 1, "U"))
	rows, _ = takeLog(t, &cursor)
	assert.Equal(t, []logRow{{"issue:1", "issues", "IssueBody", "U", 1}}, rows)
}

// After a re-bootstrap marker, the restarted backfill repairs the table's
// index: a stale group or hash (writes lost while the trigger was missing)
// must not misroute or drop later changes.
func TestEpochRepairsIndex(t *testing.T) {
	resetLivesync(t)
	ctx := t.Context()
	require.NoError(t, livesync_model.SetMeta(ctx, capture.MetaEpochPrefix+"label", "1"))
	require.NoError(t, livesync_model.SetMeta(ctx, capture.MetaEpochPrefix+"milestone", "1"))
	m, _ := testMaterializer(t)
	var cursor int64
	consume(t, m, change(1, "label", 1, "U"), change(2, "milestone", 1, "U"))
	takeLog(t, &cursor)

	// Lost while the triggers were missing: label 1 renamed, milestone 1
	// moved to repository 2.
	exec(t, "UPDATE label SET name = 'lost' WHERE id = 1")
	exec(t, "UPDATE milestone SET repo_id = 2 WHERE id = 1")
	require.NoError(t, livesync_model.SetMeta(ctx, capture.MetaEpochPrefix+"label", "2"))
	require.NoError(t, livesync_model.SetMeta(ctx, capture.MetaEpochPrefix+"milestone", "2"))
	require.NoError(t, m.HandleEpochs(ctx))
	rows, _ := takeLog(t, &cursor)
	assert.Len(t, rows, 2, "the markers")
	for {
		more, err := m.BackfillStep(ctx)
		require.NoError(t, err)
		if !more {
			break
		}
	}
	assert.Equal(t, livesync_model.Entity{Tbl: "milestone", RowID: 1, Grp: "repo:2", Unit: "issues|pulls", LastSyncID: 2}, *indexRow(t, "milestone", 1))
	assert.Empty(t, indexRow(t, "label", 1).Hash)
	v, _, err := livesync_model.GetMeta(ctx, MetaBackfillPrefix+"label")
	require.NoError(t, err)
	assert.Equal(t, "done", v)

	// The rename is undone with capture: emitted (clients re-bootstrapped
	// and hold "lost"), although the payload equals the last one emitted.
	exec(t, "UPDATE label SET name = 'label1' WHERE id = 1")
	consume(t, m, change(3, "label", 1, "U"))
	rows, _ = takeLog(t, &cursor)
	assert.Equal(t, []logRow{{"repo:1", "issues|pulls", "Label", "U", 1}}, rows)
	// The milestone is deleted: routed to its current repository.
	exec(t, "DELETE FROM milestone WHERE id = 1")
	consume(t, m, change(4, "milestone", 1, "D"))
	rows, _ = takeLog(t, &cursor)
	assert.Equal(t, []logRow{{"repo:2", "issues|pulls", "Milestone", "D", 1}}, rows)
}

// Building a User DTO has no side effects: upstream's AvatarLink generates,
// stores and records a random avatar for a user without one in
// local-avatar mode.
func TestUserAvatarWithoutSideEffects(t *testing.T) {
	resetLivesync(t)
	defer test.MockVariableValue(&setting.OfflineMode, true)()
	m, _ := testMaterializer(t)
	var cursor int64
	consume(t, m, change(1, "user", 2, "U"))
	_, entries := takeLog(t, &cursor)
	require.Len(t, entries, 1)
	var u protocol.User
	require.NoError(t, json.Unmarshal([]byte(entries[0].Payload), &u))
	assert.Equal(t, setting.AppURL+"user/avatar/user2/0", u.AvatarURL)
	var avatar string
	_, err := db.GetEngine(t.Context()).SQL("SELECT avatar FROM `user` WHERE id = 2").Get(&avatar)
	require.NoError(t, err)
	assert.Empty(t, avatar, "no avatar generated")
}
