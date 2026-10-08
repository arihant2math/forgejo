// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"fmt"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/json"
	"forgejo.org/services/livesync/catalog"
	"forgejo.org/services/livesync/protocol"

	xormlog "code.forgejo.org/xorm/xorm/log"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func allUnits(protocol.Unit) bool { return true }

// snapshotKeys takes a snapshot and returns its entities as "Model id".
func snapshotKeys(t *testing.T, req SnapshotRequest) ([]string, SnapshotResult, []SnapshotEntity) {
	t.Helper()
	var got []string
	var all []SnapshotEntity
	res, err := Snapshot(t.Context(), req, func(batch []SnapshotEntity) error {
		for _, e := range batch {
			assert.Equal(t, req.Group, e.Group)
			got = append(got, fmt.Sprintf("%s %d", e.Model, e.ID))
			all = append(all, e)
		}
		return nil
	})
	require.NoError(t, err, req.Group)
	assert.Equal(t, len(got), res.Count)
	return got, res, all
}

// fullRequest is a request for everything of a group (no recency cutoff).
func fullRequest(group string) SnapshotRequest {
	tier := protocol.TierFull
	if strings.HasPrefix(group, protocol.GroupPrefixRepo+":") {
		tier = protocol.TierSummary
	}
	return SnapshotRequest{Group: group, Tier: tier, Allows: allUnits}
}

// Every entity the specs place in a group is in that group's snapshot, and
// nothing else: the snapshot sources (candidate rows per group kind) cover
// the placement rules of every tracked table, for every fixture row.
func TestSnapshotCoversPlacement(t *testing.T) {
	resetLivesync(t)
	ctx := t.Context()
	m, _ := testMaterializer(t)
	backfillAll(t, m)

	want := map[string][]string{}
	for _, tbl := range catalog.Tracked() {
		var ids []int64
		require.NoError(t, db.GetEngine(ctx).Table(tbl.Name).Cols("id").OrderBy("id").Find(&ids))
		for start := 0; start < len(ids); start += inChunk {
			loaded, err := specs[tbl.Name].load(ctx, newLoader(), ids[start:min(start+inChunk, len(ids))], false)
			require.NoError(t, err)
			for id, ents := range loaded {
				for _, e := range ents {
					if e.group != "" {
						want[e.group] = append(want[e.group], fmt.Sprintf("%s %d", e.model, id))
					}
				}
			}
		}
	}
	// Fixture team_unit rows have no org_id: placed in "org:0", a group no
	// client can name (ParseGroup refuses it), so they reach nobody.
	delete(want, "org:0")
	require.Greater(t, len(want), 50, "groups in the fixtures")
	kinds := map[string]int{}
	for group, keys := range want {
		got, _, _ := snapshotKeys(t, fullRequest(group))
		assert.ElementsMatch(t, keys, got, group)
		prefix, _, ok := protocol.ParseGroup(group)
		require.True(t, ok, group)
		kinds[prefix]++
	}
	for _, prefix := range []string{"repo", "issue", "user", "org", "profile", "profiles"} {
		assert.Positive(t, kinds[prefix], "fixture groups of kind %s", prefix)
	}
}

// Payloads are those the materializer writes; markdown unchanged since the
// last log entry is not rendered again.
func TestSnapshotPayloads(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	backfillAll(t, m)
	var cursor int64
	consume(t, m, change(1, "issue", 1, "U"), change(2, "comment", 2, "U"), change(3, "label", 1, "U"))
	_, entries := takeLog(t, &cursor)
	logged := map[string]string{}
	for _, e := range entries {
		logged[fmt.Sprintf("%s %d", e.Model, e.EntityID)] = e.Payload
	}
	require.Contains(t, logged, "Comment 2")
	require.Contains(t, logged, "IssueBody 1")

	before := renderCount.Load()
	_, _, ents := snapshotKeys(t, fullRequest("issue:1"))
	byKey := map[string]SnapshotEntity{}
	for _, e := range ents {
		byKey[fmt.Sprintf("%s %d", e.Model, e.ID)] = e
	}
	assert.Equal(t, logged["Comment 2"], byKey["Comment 2"].Payload, "reused from the log")
	assert.Equal(t, logged["IssueBody 1"], byKey["IssueBody 1"].Payload)
	rendered := renderCount.Load() - before
	withBody := 0
	for _, e := range ents {
		if strings.Contains(e.Payload, `"body":"`) && !strings.Contains(e.Payload, `"body":""`) {
			withBody++
		}
	}
	assert.Equal(t, int64(withBody-2), rendered, "only the entities without a log entry were rendered")

	// A backfilled (never emitted) entity is rendered, the same way.
	_, _, again := snapshotKeys(t, fullRequest("issue:1"))
	for i := range again {
		assert.JSONEq(t, ents[i].Payload, again[i].Payload)
	}
	labels, _, ents := snapshotKeys(t, SnapshotRequest{Group: "repo:1", Tier: protocol.TierSummary, Allows: allUnits, Models: []protocol.Model{protocol.ModelLabel}})
	assert.ElementsMatch(t, []string{"Label 1", "Label 2"}, labels)
	for _, e := range ents {
		if e.ID == 1 {
			assert.Equal(t, logged["Label 1"], e.Payload)
		}
	}

	// User references: the comment's poster, the issue's poster.
	for _, e := range snapshotEntities(t, fullRequest("issue:1")) {
		if e.Model == protocol.ModelComment && e.ID == 2 {
			assert.Equal(t, []int64{3}, e.UserRefs)
		}
	}
	for _, e := range snapshotEntities(t, fullRequest("repo:1")) {
		if e.Model == protocol.ModelIssue && e.ID == 1 {
			assert.Equal(t, []int64{1}, e.UserRefs)
		}
		if e.Model == protocol.ModelRepository {
			assert.Equal(t, []int64{2}, e.UserRefs, "owner")
		}
	}
}

func snapshotEntities(t *testing.T, req SnapshotRequest) []SnapshotEntity {
	t.Helper()
	_, _, ents := snapshotKeys(t, req)
	return ents
}

// An entity the materializer has not indexed is left out: its insert is
// still in the outbox (it arrives as a delta above the watermark), or it
// was coalesced with its delete (no delete is ever emitted for it).
func TestSnapshotIndexFilter(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	backfillAll(t, m)
	labels := func() []string {
		got, _, _ := snapshotKeys(t, SnapshotRequest{Group: "repo:1", Tier: protocol.TierSummary, Allows: allUnits, Models: []protocol.Model{protocol.ModelLabel}})
		return got
	}
	require.Equal(t, []string{"Label 1", "Label 2"}, labels())

	exec(t, "INSERT INTO label (id, repo_id, name, color) VALUES (1001, 1, 'pending', '#000000')")
	assert.Equal(t, []string{"Label 1", "Label 2"}, labels(), "insert not materialized yet")
	consume(t, m, change(1, "label", 1001, "I"))
	assert.Equal(t, []string{"Label 1", "Label 2", "Label 1001"}, labels(), "materialized")

	exec(t, "INSERT INTO label (id, repo_id, name, color) VALUES (1002, 1, 'short-lived', '#000000')")
	assert.NotContains(t, labels(), "Label 1002")
	exec(t, "DELETE FROM label WHERE id = 1002")
	var cursor int64 = 1_000_000
	consume(t, m, change(2, "label", 1002, "I"), change(3, "label", 1002, "D"))
	rows, _ := takeLog(t, &cursor)
	assert.Empty(t, rows, "coalesced away: no delete in the log")
	assert.NotContains(t, labels(), "Label 1002")
}

// The summary tier holds open issues and those updated since the cutoff;
// the closed tier pages through the others, newest first, with their
// labels, assignees, project cards and pull requests.
func TestSnapshotTiers(t *testing.T) {
	resetLivesync(t)
	ctx := t.Context()
	m, _ := testMaterializer(t)
	backfillAll(t, m)
	// Pull request 2 (issue 2) closed: the closed tier holds it and issue 5,
	// the pull request first (newer).
	exec(t, "UPDATE issue SET is_closed = ?, updated_unix = 978307250 WHERE id = 2", true)
	cutoff := time.Unix(978307300, 0)

	var all []struct {
		ID          int64 `xorm:"id"`
		IsClosed    bool  `xorm:"is_closed"`
		UpdatedUnix int64 `xorm:"updated_unix"`
	}
	require.NoError(t, db.GetEngine(ctx).Table("issue").Cols("id", "is_closed", "updated_unix").Where("repo_id = 1").Find(&all))
	var open, closed []string
	var closedIDs []int64
	for _, i := range all {
		if !i.IsClosed || i.UpdatedUnix >= cutoff.Unix() {
			open = append(open, fmt.Sprintf("Issue %d", i.ID))
		} else {
			closed = append(closed, fmt.Sprintf("Issue %d", i.ID))
			closedIDs = append(closedIDs, i.ID)
		}
	}
	require.NotEmpty(t, open)
	require.ElementsMatch(t, []string{"Issue 2", "Issue 5"}, closed)

	issuesOf := func(keys []string) []string {
		var res []string
		for _, k := range keys {
			if strings.HasPrefix(k, "Issue ") {
				res = append(res, k)
			}
		}
		return res
	}
	summary, _, _ := snapshotKeys(t, SnapshotRequest{Group: "repo:1", Tier: protocol.TierSummary, Recent: cutoff, Allows: allUnits})
	assert.ElementsMatch(t, open, issuesOf(summary))
	assert.Contains(t, summary, "Repository 1")

	// pages reads every page of the closed tier with one issue per page.
	pages := func(allows func(protocol.Unit) bool) (paged, keys, cursors []string) {
		cur := ClosedCursor{Updated: cutoff.Unix()}
		var lastUpdated int64 = 1 << 62
		for n := 0; ; n++ {
			require.Less(t, n, 100)
			got, res, ents := snapshotKeys(t, SnapshotRequest{Group: "repo:1", Tier: protocol.TierClosed, ClosedBefore: cur, Limit: 1, Allows: allows})
			issues := issuesOf(got)
			require.Len(t, issues, 1, "a page of one, never empty")
			// The documented range of a page (protocol.BootstrapHeader):
			// (updated_at, id) below its cursor, at or above its next.
			below := func(updated, id int64, c ClosedCursor) bool {
				return updated < c.Updated || (updated == c.Updated && c.ID != 0 && id < c.ID)
			}
			for _, e := range ents {
				if e.Model == protocol.ModelIssue {
					var dto protocol.Issue
					require.NoError(t, json.Unmarshal([]byte(e.Payload), &dto))
					assert.Equal(t, "closed", dto.State)
					assert.Less(t, dto.UpdatedAt.Unix(), cutoff.Unix(), "older than the summary's cutoff")
					assert.True(t, below(dto.UpdatedAt.Unix(), dto.ID, cur), "below the page's cursor")
					if res.Next != nil {
						assert.False(t, below(dto.UpdatedAt.Unix(), dto.ID, *res.Next), "at or above the next page's")
					}
					assert.LessOrEqual(t, dto.UpdatedAt.Unix(), lastUpdated, "newest first")
					lastUpdated = dto.UpdatedAt.Unix()
				}
				assert.NotEqual(t, protocol.ModelLabel, e.Model, "only issue entities in the closed tier")
			}
			paged = append(paged, issues...)
			keys = append(keys, got...)
			if res.Next == nil {
				return paged, keys, cursors
			}
			cursors = append(cursors, res.Next.String())
			next, err := ParseClosedCursor(res.Next.String())
			require.NoError(t, err)
			require.Equal(t, *res.Next, next)
			cur = next
		}
	}
	paged, pageKeys, _ := pages(allUnits)
	assert.Equal(t, []string{"Issue 2", "Issue 5"}, paged, "newest first")

	// The children of the closed issues are in their pages, not in the
	// summary.
	var children []string
	for table, model := range map[string]protocol.Model{
		"issue_label": protocol.ModelIssueLabel, "issue_assignees": protocol.ModelIssueAssignee,
		"project_issue": protocol.ModelProjectIssue, "pull_request": protocol.ModelPullRequest,
	} {
		var ids []int64
		require.NoError(t, db.GetEngine(ctx).Table(table).Cols("id").In("issue_id", closedIDs).Find(&ids))
		for _, id := range ids {
			children = append(children, fmt.Sprintf("%s %d", model, id))
		}
	}
	for _, want := range []string{"IssueLabel", "ProjectIssue", "PullRequest"} {
		assert.True(t, slices.ContainsFunc(children, func(k string) bool { return strings.HasPrefix(k, want+" ") }), "fixture %s of a closed issue", want)
	}
	for _, k := range children {
		assert.Contains(t, pageKeys, k, "in its issue's page")
		assert.NotContains(t, summary, k, "not in the summary")
	}

	// A viewer who may read the issues but not the pull requests (or the
	// reverse) pages through what they may read only: no empty page, and no
	// cursor taken from an entity they may not read.
	issuesOnly := func(u protocol.Unit) bool { return u != protocol.UnitPulls }
	pullsOnly := func(u protocol.Unit) bool { return u != protocol.UnitIssues }
	paged, _, cursors := pages(issuesOnly)
	assert.Equal(t, []string{"Issue 5"}, paged)
	assert.Empty(t, cursors, "pull request 2 gives no cursor")
	paged, _, cursors = pages(pullsOnly)
	assert.Equal(t, []string{"Issue 2"}, paged)
	assert.Empty(t, cursors)
	keys, res, _ := snapshotKeys(t, SnapshotRequest{
		Group: "repo:1", Tier: protocol.TierClosed, ClosedBefore: ClosedCursor{Updated: cutoff.Unix()}, Limit: 10,
		Allows: func(u protocol.Unit) bool { return u == protocol.UnitNone || u == protocol.UnitCode },
	})
	assert.Empty(t, keys, "neither issues nor pull requests")
	assert.Nil(t, res.Next)
}

// sqlRecorder is an xorm logger that records the statements run on the
// engine while it is installed.
type sqlRecorder struct {
	xormlog.ContextLogger
	mu  *sync.Mutex
	sql *[]string
}

func (r sqlRecorder) IsShowSQL() bool { return true }

func (r sqlRecorder) BeforeSQL(xormlog.LogContext) {}

func (r sqlRecorder) AfterSQL(c xormlog.LogContext) {
	r.mu.Lock()
	defer r.mu.Unlock()
	*r.sql = append(*r.sql, c.SQL)
}

// recordSQL returns the statements fn runs.
func recordSQL(t *testing.T, fn func()) []string {
	t.Helper()
	e, err := livesync_model.MasterXORMEngine()
	require.NoError(t, err)
	var sql []string
	old := e.Logger()
	e.SetLogger(sqlRecorder{ContextLogger: old, mu: &sync.Mutex{}, sql: &sql})
	defer e.SetLogger(old)
	fn()
	return sql
}

// The candidate rows are read through the conditions' indexes (B6 review):
// no keyset paging ("ORDER BY id LIMIT n", which PostgreSQL plans as a walk
// of the primary key), no OR of an issue's and its comments' rows (which
// defeats both indexes); and the rows that hang off a chunk of issues are
// placed with the chunk's issues, not by loading them again per child table.
func TestSnapshotQueries(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	backfillAll(t, m)
	var sql []string
	for _, req := range []SnapshotRequest{
		{Group: "issue:1", Tier: protocol.TierFull, Allows: allUnits},
		{Group: "user:1", Tier: protocol.TierFull, Allows: allUnits, Recent: time.Now()},
		{Group: "org:3", Tier: protocol.TierFull, Allows: allUnits},
	} {
		sql = append(sql, recordSQL(t, func() { snapshotKeys(t, req) })...)
	}
	summary := recordSQL(t, func() {
		keys, _, _ := snapshotKeys(t, SnapshotRequest{Group: "repo:1", Tier: protocol.TierSummary, Allows: allUnits})
		require.Contains(t, keys, "IssueLabel 1")
		require.Contains(t, keys, "PullRequest 2")
	})
	sql = append(sql, summary...)
	paging := regexp.MustCompile(`(?i)\bORDER BY\b.*\bLIMIT\b`)
	or := regexp.MustCompile(`(?i)\bOR\b`)
	fromTable := regexp.MustCompile("(?i)\\bFROM [`\"]?(\\w+)")
	table := func(q string) string {
		if m := fromTable.FindStringSubmatch(q); m != nil {
			return m[1]
		}
		return ""
	}
	for _, q := range sql {
		assert.False(t, paging.MatchString(q), "no paging: %s", q)
		switch table(q) {
		case "reaction", "attachment", "issue_content_history":
			assert.False(t, or.MatchString(q), "one condition per query: %s", q)
		}
	}
	// repo:1's summary issues fit in one chunk: their full rows are read
	// once (their labels, assignees, project cards and pull requests are
	// placed with them), and the pull requests once (their auto-merges).
	full := map[string]int{}
	for _, q := range summary {
		if strings.HasPrefix(q, "SELECT `id`, `") {
			full[table(q)]++
		}
	}
	assert.Equal(t, 1, full["issue"], "full issue rows read")
	assert.Equal(t, 1, full["pull_request"], "full pull request rows read")
}

// The viewer's units filter the entities; models restrict them.
func TestSnapshotFilters(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	backfillAll(t, m)
	codeOnly := func(u protocol.Unit) bool { return u == protocol.UnitNone || u == protocol.UnitCode }
	got, _, _ := snapshotKeys(t, SnapshotRequest{Group: "repo:1", Tier: protocol.TierSummary, Allows: codeOnly})
	require.Contains(t, got, "Repository 1")
	for _, k := range got {
		assert.False(t, strings.HasPrefix(k, "Issue ") || strings.HasPrefix(k, "Label "), "%s needs issues/pulls", k)
	}
	got, _, _ = snapshotKeys(t, SnapshotRequest{Group: "repo:1", Tier: protocol.TierSummary, Allows: allUnits, Models: []protocol.Model{protocol.ModelMilestone, protocol.ModelRepository}})
	for _, k := range got {
		assert.True(t, strings.HasPrefix(k, "Milestone ") || k == "Repository 1", k)
	}

	tables, err := SnapshotTables(SnapshotRequest{Group: "issue:1", Tier: protocol.TierFull, Models: []protocol.Model{protocol.ModelIssueBody}})
	require.NoError(t, err)
	assert.Equal(t, []string{"user", "issue"}, tables)
	models, err := SnapshotModels(SnapshotRequest{Group: "org:3", Tier: protocol.TierFull})
	require.NoError(t, err)
	assert.Equal(t, []protocol.Model{"User", "OrgUser", "Team", "TeamUser", "TeamRepo", "TeamUnit", "ProjectColumn"}, models)
	models, err = SnapshotModels(SnapshotRequest{Group: "owner:3", Tier: protocol.TierFull})
	require.NoError(t, err)
	assert.Equal(t, []protocol.Model{"Label", "Project"}, models)
	_, err = SnapshotTables(SnapshotRequest{Group: "*"})
	require.Error(t, err)
}

// The gate: tables whose backfill is not done.
func TestBackfillPending(t *testing.T) {
	resetLivesync(t)
	ctx := t.Context()
	pending, err := BackfillPending(ctx, []string{"issue", "label"})
	require.NoError(t, err)
	assert.Equal(t, []string{"issue", "label"}, pending, "never started")
	m, _ := testMaterializer(t)
	backfillAll(t, m)
	pending, err = BackfillPending(ctx, []string{"issue", "label"})
	require.NoError(t, err)
	assert.Empty(t, pending)
	exec(t, "UPDATE livesync_meta SET value = 'repair:0' WHERE name = ?", MetaBackfillPrefix+"label")
	pending, err = BackfillPending(ctx, []string{"issue", "label"})
	require.NoError(t, err)
	assert.Equal(t, []string{"label"}, pending)
	exec(t, "UPDATE livesync_meta SET value = '1000' WHERE name = ?", MetaBackfillPrefix+"label")
	pending, err = BackfillPending(ctx, []string{"issue", "label"})
	require.NoError(t, err)
	assert.Equal(t, []string{"label"}, pending, "initial walk")

	// A permission walk (only ever started on a complete index) writes
	// nothing a snapshot reads: no waiting. Before this, every bootstrap
	// answered 503 while the user table's walk ran after an upgrade.
	exec(t, "UPDATE livesync_meta SET value = 'perm:0' WHERE name = ?", MetaBackfillPrefix+"user")
	exec(t, "UPDATE livesync_meta SET value = 'perm:1234' WHERE name = ?", MetaBackfillPrefix+"collaboration")
	pending, err = BackfillPending(ctx, []string{"user", "collaboration", "issue"})
	require.NoError(t, err)
	assert.Empty(t, pending)
}

// A permission table whose permission states are stale while its initial
// index walk has not finished gets a repair walk (indexes every row and
// records the states), not a permission walk, which bootstraps would take
// for a complete index; no markers.
func TestHandleEpochsIncompleteWalk(t *testing.T) {
	resetLivesync(t)
	ctx := t.Context()
	m, _ := testMaterializer(t)
	backfillAll(t, m)
	var cursor int64
	takeLog(t, &cursor)
	// collaboration: initial walk half way; team: done.
	require.NoError(t, livesync_model.SetMeta(ctx, MetaBackfillPrefix+"collaboration", "2"))
	_, err := db.GetEngine(ctx).Exec("DELETE FROM livesync_entity WHERE tbl = 'collaboration' AND row_id > 2")
	require.NoError(t, err)
	_, err = db.GetEngine(ctx).Exec("DELETE FROM livesync_meta WHERE name IN (?, ?)", MetaPermPrefix+"collaboration", MetaPermPrefix+"team")
	require.NoError(t, err)
	require.NoError(t, m.loadBackfill(ctx))

	require.NoError(t, m.HandleEpochs(ctx))
	rows, _ := takeLog(t, &cursor)
	assert.Empty(t, rows, "no markers")
	for table, want := range map[string]string{"collaboration": "repair:0", "team": "perm:0"} {
		v, _, err := livesync_model.GetMeta(ctx, MetaBackfillPrefix+table)
		require.NoError(t, err)
		assert.Equal(t, want, v, table)
	}
	pending, err := BackfillPending(ctx, []string{"collaboration", "team"})
	require.NoError(t, err)
	assert.Equal(t, []string{"collaboration"}, pending)
	backfillAll(t, m)
	var n int64
	n, err = db.GetEngine(ctx).Table("livesync_entity").Where("tbl = 'collaboration'").Count()
	require.NoError(t, err)
	total, err := db.GetEngine(ctx).Table("collaboration").Count()
	require.NoError(t, err)
	assert.Equal(t, total, n, "every row indexed")
}

// Profiles and their groups.
func TestProfiles(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	backfillAll(t, m)
	groups, err := ProfileGroups(t.Context(), []int64{2, 3, 31, 33, 999999})
	require.NoError(t, err)
	assert.Equal(t, map[int64]string{2: "profiles:public", 3: "org:3", 31: "profile:31", 33: "profiles:limited"}, groups)
	ents, err := Profiles(t.Context(), []int64{3, 31})
	require.NoError(t, err)
	require.Len(t, ents, 2)
	for _, e := range ents {
		assert.Equal(t, protocol.ModelUser, e.Model)
		assert.Equal(t, groups[e.ID], e.Group)
		assert.Contains(t, e.Payload, fmt.Sprintf(`"id":%d`, e.ID))
	}
}

func TestClosedCursor(t *testing.T) {
	for s, want := range map[string]ClosedCursor{"1700000000": {Updated: 1700000000}, "1700000000.42": {1700000000, 42}} {
		c, err := ParseClosedCursor(s)
		require.NoError(t, err)
		assert.Equal(t, want, c)
		assert.Equal(t, s, c.String())
	}
	for _, s := range []string{"", "x", "0", "-1", "1.", "1.0", "1.x", "1.2.3"} {
		_, err := ParseClosedCursor(s)
		assert.Error(t, err, s)
	}
}

// Every integer *_id field of every DTO is classified as a user reference
// or not, so a new field cannot silently miss its profile.
func TestUserRefFields(t *testing.T) {
	otherIDFields := map[string]bool{
		"assignee_team_id": true, "base_repo_id": true, "column_id": true, "comment_id": true,
		"dependency_id": true, "dependent_issue_id": true, "head_repo_id": true, "id": true,
		"issue_id": true, "label_id": true, "milestone_id": true, "old_milestone_id": true,
		"old_project_id": true, "org_id": true, "original_author_id": true, "parent_id": true,
		"project_id": true, "pull_id": true, "pull_request_id": true, "ref_comment_id": true,
		"ref_issue_id": true, "ref_repo_id": true, "release_id": true, "repo_id": true,
		"review_id": true, "reviewer_team_id": true, "run_id": true, "task_id": true,
		"team_id": true, "time_id": true,
	}
	dtos := []any{
		protocol.Repository{},
		protocol.User{},
		protocol.OrgUser{},
		protocol.Team{},
		protocol.TeamUser{},
		protocol.TeamRepo{},
		protocol.TeamUnit{},
		protocol.Collaboration{},
		protocol.Access{},
		protocol.RepoUnit{},
		protocol.Label{},
		protocol.Milestone{},
		protocol.Project{},
		protocol.ProjectColumn{},
		protocol.ProjectIssue{},
		protocol.Issue{},
		protocol.IssueBody{},
		protocol.IssueLabel{},
		protocol.IssueAssignee{},
		protocol.PullRequest{},
		protocol.AutoMerge{},
		protocol.Branch{},
		protocol.Release{},
		protocol.CommitStatus{},
		protocol.ActionRun{},
		protocol.ActionRunJob{},
		protocol.Notification{},
		protocol.Stopwatch{},
		protocol.IssueWatch{},
		protocol.Watch{},
		protocol.Star{},
		protocol.BlockedUser{},
		protocol.Comment{},
		protocol.Reaction{},
		protocol.Review{},
		protocol.ReviewState{},
		protocol.Attachment{},
		protocol.IssueDependency{},
		protocol.TrackedTime{},
		protocol.ContentHistory{},
	}
	require.Len(t, dtos, len(Schemas()), "one DTO per model")
	for _, dto := range dtos {
		typ := reflect.TypeOf(dto)
		for f := range typ.Fields() {
			name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
			if f.Type.Kind() != reflect.Int64 || (!strings.HasSuffix(name, "_id") && !strings.HasSuffix(name, "_by") && name != "id") {
				continue
			}
			assert.NotEqual(t, userRefFields[name], otherIDFields[name], "%s.%s (%s) must be classified exactly once", typ.Name(), f.Name, name)
		}
	}
	assert.Equal(t, []int64{5}, userRefs(&protocol.Issue{ID: 1, RepoID: 2, PosterID: 5, MilestoneID: 3}), "poster only")
	assert.Equal(t, []int64{7}, userRefs(protocol.Comment{PosterID: 7, AssigneeID: -1}), "no ghost")
	assert.Nil(t, userRefs((*protocol.Issue)(nil)))
}
