// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	auth_model "forgejo.org/models/auth"
	"forgejo.org/models/db"
	issues_model "forgejo.org/models/issues"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/json"
	"forgejo.org/modules/setting"
	livesync_service "forgejo.org/services/livesync"
	"forgejo.org/services/livesync/materialize"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/tests"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const livesyncWait = 15 * time.Second

func livesyncPayload[T any](t *testing.T, e livesync_model.LogEntry) T {
	t.Helper()
	var v T
	require.NoError(t, json.Unmarshal([]byte(e.Payload), &v))
	return v
}

// API v1 writes reach the sync log through capture → outbox → materializer,
// with the expected group, unit, model, op and payload; a delete is routed
// to the group recorded in the entity index.
func TestLivesyncMaterializeAPI(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncStart(t, nil)
	start := livesyncLogHead(t)

	session := loginUser(t, "user2")
	token := getTokenForLoggedInUser(t, session, auth_model.AccessTokenScopeWriteIssue)

	// Create an issue: its summary in repo:1, its body in issue:{id}.
	req := NewRequestWithJSON(t, "POST", "/api/v1/repos/user2/repo1/issues", map[string]any{
		"title": "livesync issue", "body": "Hello **world**",
	}).AddTokenAuth(token)
	var created struct {
		ID     int64 `json:"id"`
		Number int64 `json:"number"`
	}
	DecodeJSON(t, MakeRequest(t, req, http.StatusCreated), &created)

	e := livesyncWaitLog(t, start, livesyncWait, livesyncEntry(protocol.ModelIssue, created.ID, protocol.OpUpsert))
	assert.Equal(t, "repo:1", e.Grp)
	assert.Equal(t, "issues", e.Unit)
	assert.Equal(t, protocol.SchemaIssue, e.SchemaVer)
	issue := livesyncPayload[protocol.Issue](t, e)
	assert.Equal(t, created.Number, issue.Number)
	assert.Equal(t, "livesync issue", issue.Title)
	assert.Equal(t, "open", issue.State)
	assert.EqualValues(t, 1, issue.RepoID)
	assert.EqualValues(t, 2, issue.PosterID)

	e = livesyncWaitLog(t, start, livesyncWait, livesyncEntry(protocol.ModelIssueBody, created.ID, protocol.OpUpsert))
	assert.Equal(t, fmt.Sprintf("issue:%d", created.ID), e.Grp)
	assert.Equal(t, "issues", e.Unit)
	body := livesyncPayload[protocol.IssueBody](t, e)
	assert.Equal(t, "Hello **world**", body.Body)
	assert.Equal(t, "<p dir=\"auto\">Hello <strong>world</strong></p>\n", body.BodyHTML)

	// Add a label: an IssueLabel in the issue's repository group.
	cursor := livesyncLogHead(t)
	req = NewRequestWithJSON(t, "POST", fmt.Sprintf("/api/v1/repos/user2/repo1/issues/%d/labels", created.Number), map[string]any{
		"labels": []int64{1},
	}).AddTokenAuth(token)
	MakeRequest(t, req, http.StatusOK)
	var issueLabel issues_model.IssueLabel
	has, err := db.GetEngine(t.Context()).Where("issue_id = ? AND label_id = 1", created.ID).Get(&issueLabel)
	require.NoError(t, err)
	require.True(t, has)
	e = livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelIssueLabel, issueLabel.ID, protocol.OpUpsert))
	assert.Equal(t, "repo:1", e.Grp)
	assert.Equal(t, "issues", e.Unit)
	assert.Equal(t, protocol.IssueLabel{ID: issueLabel.ID, IssueID: created.ID, LabelID: 1}, livesyncPayload[protocol.IssueLabel](t, e))
	// The label's counters changed too.
	e = livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelLabel, 1, protocol.OpUpsert))
	assert.Equal(t, "issues|pulls", e.Unit)

	// Comment: a Comment in issue:{id}, rendered.
	cursor = livesyncLogHead(t)
	req = NewRequestWithJSON(t, "POST", fmt.Sprintf("/api/v1/repos/user2/repo1/issues/%d/comments", created.Number), map[string]string{
		"body": "a *comment*",
	}).AddTokenAuth(token)
	var comment struct {
		ID int64 `json:"id"`
	}
	DecodeJSON(t, MakeRequest(t, req, http.StatusCreated), &comment)
	e = livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelComment, comment.ID, protocol.OpUpsert))
	assert.Equal(t, fmt.Sprintf("issue:%d", created.ID), e.Grp)
	assert.Equal(t, "issues", e.Unit)
	c := livesyncPayload[protocol.Comment](t, e)
	assert.Equal(t, "comment", c.Type)
	assert.Equal(t, created.ID, c.IssueID)
	assert.Equal(t, "a *comment*", c.Body)
	assert.Equal(t, "<p dir=\"auto\">a <em>comment</em></p>\n", c.BodyHTML)
	e = livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelIssue, created.ID, protocol.OpUpsert))
	assert.Equal(t, 1, livesyncPayload[protocol.Issue](t, e).Comments)

	// Delete the comment: the delete goes to the group the entity index
	// remembers (the row is gone), and the index row is removed.
	cursor = livesyncLogHead(t)
	req = NewRequest(t, "DELETE", fmt.Sprintf("/api/v1/repos/user2/repo1/issues/comments/%d", comment.ID)).AddTokenAuth(token)
	MakeRequest(t, req, http.StatusNoContent)
	e = livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelComment, comment.ID, protocol.OpDelete))
	assert.Equal(t, fmt.Sprintf("issue:%d", created.ID), e.Grp)
	assert.Equal(t, "issues", e.Unit)
	assert.Empty(t, e.Payload)
	assert.Eventually(t, func() bool {
		n, err := livesyncMaster(t).Where("tbl = 'comment' AND row_id = ?", comment.ID).Count(&livesync_model.Entity{})
		require.NoError(t, err)
		return n == 0
	}, livesyncWait, 20*time.Millisecond)

	// Sync ids are gap-free and strictly increasing; the outbox is drained.
	entries := livesyncLogSince(t, start)
	for i, e := range entries {
		require.Equal(t, start+int64(i)+1, e.SyncID)
	}
	assert.Eventually(t, func() bool { return len(livesyncOutbox(t)) == 0 }, livesyncWait, 20*time.Millisecond)
}

// Many concurrent writers: every change reaches the log once per visible
// change, with gap-free, strictly increasing sync ids.
func TestLivesyncMaterializeConcurrentWriters(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncStart(t, nil)
	start := livesyncLogHead(t)
	ctx := t.Context()

	const writers, perWriter = 8, 15
	ids := make(chan int64, writers*perWriter)
	errs := make(chan error, writers)
	for w := range writers {
		go func() {
			for i := range perWriter {
				l := newProbeLabel(fmt.Sprintf("concurrent-%d-%d", w, i))
				var err error
				if i%3 == 0 {
					// Some in transactions with other writes.
					err = db.WithTx(ctx, func(ctx context.Context) error {
						if err := db.Insert(ctx, l); err != nil {
							return err
						}
						_, err := db.GetEngine(ctx).ID(l.ID).Cols("description").Update(&issues_model.Label{Description: "updated in the same tx"})
						return err
					})
				} else {
					err = db.Insert(ctx, l)
				}
				if err != nil {
					errs <- err
					return
				}
				ids <- l.ID
			}
			errs <- nil
		}()
	}
	for range writers {
		require.NoError(t, <-errs)
	}
	close(ids)
	want := map[int64]bool{}
	for id := range ids {
		want[id] = true
	}
	require.Len(t, want, writers*perWriter)

	require.Eventually(t, func() bool {
		seen := 0
		for _, e := range livesyncLogSince(t, start) {
			if e.Model == string(protocol.ModelLabel) && want[e.EntityID] {
				seen++
			}
		}
		return seen >= len(want)
	}, livesyncWait, 50*time.Millisecond)

	entries := livesyncLogSince(t, start)
	labels := map[int64]int{}
	for i, e := range entries {
		require.Equal(t, start+int64(i)+1, e.SyncID, "gap-free, strictly increasing")
		if e.Model == string(protocol.ModelLabel) && want[e.EntityID] {
			labels[e.EntityID]++
			assert.Equal(t, "repo:1", e.Grp)
			assert.Contains(t, livesyncPayload[protocol.Label](t, e).Name, "concurrent-")
		}
	}
	for id := range want {
		assert.Equal(t, 1, labels[id], "label %d: one entry (an insert and an update in one transaction are coalesced, or deduplicated by the payload hash)", id)
	}
}

// A bumped schema epoch (a trigger was missing, its changes are lost) is
// surfaced as a re-bootstrap marker for the table's models, and recorded as
// handled.
func TestLivesyncMaterializeEpoch(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncStart(t, nil)
	ctx := t.Context()
	master := livesyncMaster(t)

	handled := func(table string) string {
		v, _, err := livesync_model.GetMeta(ctx, materialize.MetaHandledEpochPrefix+table)
		require.NoError(t, err)
		return v
	}
	require.Eventually(t, func() bool { return handled("label") == "1" }, livesyncWait, 20*time.Millisecond,
		"the first start records the epochs without markers")
	for _, e := range livesyncLogSince(t, 0) {
		require.NotEqual(t, string(protocol.OpRebootstrap), e.Op)
	}

	// Livesync stops, an upstream migration recreates the label table (its
	// trigger is gone) and a label is written meanwhile: not captured.
	livesync_service.Shutdown()
	if setting.Database.Type.IsPostgreSQL() {
		_, err := master.Exec(`DROP TRIGGER livesync_capture ON label`)
		require.NoError(t, err)
	} else {
		for _, ev := range []string{"ai", "au", "ad"} {
			_, err := master.Exec("DROP TRIGGER livesync_label_" + ev)
			require.NoError(t, err)
		}
	}
	lost := newProbeLabel("written while the trigger was missing")
	require.NoError(t, db.Insert(ctx, lost))
	assert.Empty(t, livesyncOutbox(t))
	cursor := livesyncLogHead(t)

	// The next start repairs the trigger and bumps the epoch; the writer
	// appends the marker and records the epoch as handled.
	require.NoError(t, livesync_service.Init(context.Background()))
	assert.EqualValues(t, 2, livesyncEpochs(t)["label"])
	e := livesyncWaitLog(t, cursor, livesyncWait, func(e *livesync_model.LogEntry) bool {
		return e.Op == string(protocol.OpRebootstrap)
	})
	assert.Equal(t, protocol.GroupAll, e.Grp)
	assert.Equal(t, string(protocol.ModelLabel), e.Model)
	assert.Equal(t, protocol.RebootstrapMarker{Table: "label", Epoch: 2, Reason: protocol.RebootstrapTriggerRepaired}, livesyncPayload[protocol.RebootstrapMarker](t, e))
	assert.Equal(t, "2", handled("label"))
	for _, e := range livesyncLogSince(t, cursor) {
		if e.Op == string(protocol.OpRebootstrap) {
			assert.Equal(t, string(protocol.ModelLabel), e.Model, "only the repaired table's models")
		}
		assert.False(t, e.Model == string(protocol.ModelLabel) && e.EntityID == lost.ID, "the lost write is not in the log")
	}
	v, _, err := livesync_model.GetMeta(ctx, materialize.MetaBackfillPrefix+"label")
	require.NoError(t, err)
	assert.NotEmpty(t, v, "the label index backfill restarted")

	// Changes after the repair are captured again.
	cursor = livesyncLogHead(t)
	after := newProbeLabel("after the repair")
	require.NoError(t, db.Insert(ctx, after))
	livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelLabel, after.ID, protocol.OpUpsert))
}

// livesyncBarrier writes a probe row and waits for its entry: every change
// committed before it has been materialized by then.
func livesyncBarrier(t *testing.T) {
	t.Helper()
	cursor := livesyncLogHead(t)
	probe := newProbeLabel("barrier")
	require.NoError(t, db.Insert(t.Context(), probe))
	livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelLabel, probe.ID, protocol.OpUpsert))
}

// livesyncEntriesOf returns the entries of one entity after cursor.
func livesyncEntriesOf(t *testing.T, cursor int64, model protocol.Model, id int64) []string {
	t.Helper()
	var res []string
	for _, e := range livesyncLogSince(t, cursor) {
		if e.Model == string(model) && e.EntityID == id {
			res = append(res, e.Op+" "+e.Grp+" "+e.Unit)
		}
	}
	return res
}

// livesyncAssertPlaces checks an entity's entries ("<op> <group> <unit>"):
// the given ones in order, the last of them possibly repeated (an entity can
// be updated more than once by one API call).
func livesyncAssertPlaces(t *testing.T, got []string, want ...string) {
	t.Helper()
	require.GreaterOrEqual(t, len(got), len(want), "%v", got)
	assert.Equal(t, want, got[:len(want)])
	for _, g := range got[len(want):] {
		assert.Equal(t, want[len(want)-1], g)
	}
}

// Drafts only some readers may see are not published to the shared groups:
// a pending review and its code comments stay with the reviewer until
// submitted, a draft release is nowhere until published (API v1 flows).
func TestLivesyncMaterializeDrafts(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncStart(t, nil)
	// user1 has no pending review on pull request 3 (user2/repo1#3) yet, so
	// the review is created now.
	token := getTokenForLoggedInUser(t, loginUser(t, "user1"), auth_model.AccessTokenScopeWriteRepository)

	// A pending review with a code comment.
	cursor := livesyncLogHead(t)
	req := NewRequestWithJSON(t, http.MethodPost, "/api/v1/repos/user2/repo1/pulls/3/reviews", map[string]any{
		"body": "draft", "event": "PENDING",
		"comments": []map[string]any{{"path": "README.md", "body": "secret draft remark", "new_position": 1}},
	}).AddTokenAuth(token)
	var review struct {
		ID    int64  `json:"id"`
		State string `json:"state"`
	}
	DecodeJSON(t, MakeRequest(t, req, http.StatusOK), &review)
	require.Equal(t, "PENDING", review.State)
	var comment issues_model.Comment
	has, err := db.GetEngine(t.Context()).Where("review_id = ?", review.ID).Get(&comment)
	require.NoError(t, err)
	require.True(t, has)
	livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelComment, comment.ID, protocol.OpUpsert))
	livesyncAssertPlaces(t, livesyncEntriesOf(t, cursor, protocol.ModelReview, review.ID), "U user:1 self")
	livesyncAssertPlaces(t, livesyncEntriesOf(t, cursor, protocol.ModelComment, comment.ID), "U user:1 self")
	for _, e := range livesyncLogSince(t, cursor) {
		if e.Grp != "user:1" {
			assert.NotContains(t, e.Payload, "secret draft remark", "%s %d in %s", e.Model, e.EntityID, e.Grp)
		}
	}

	// Submitting moves the review and its comment to the pull request.
	// (The review row may still have a pending update from the request
	// above: start after everything it wrote is in the log.)
	livesyncSettle(t)
	cursor = livesyncLogHead(t)
	req = NewRequestWithJSON(t, http.MethodPost, fmt.Sprintf("/api/v1/repos/user2/repo1/pulls/3/reviews/%d", review.ID), map[string]any{
		"body": "done", "event": "COMMENT",
	}).AddTokenAuth(token)
	MakeRequest(t, req, http.StatusOK)
	livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelComment, comment.ID, protocol.OpUpsert))
	livesyncAssertPlaces(t, livesyncEntriesOf(t, cursor, protocol.ModelReview, review.ID), "D user:1 self", "U issue:3 pulls")
	livesyncAssertPlaces(t, livesyncEntriesOf(t, cursor, protocol.ModelComment, comment.ID), "D user:1 self", "U issue:3 pulls")

	// A draft release is not published; publishing it is.
	token = getTokenForLoggedInUser(t, loginUser(t, "user2"), auth_model.AccessTokenScopeWriteRepository)
	cursor = livesyncLogHead(t)
	req = NewRequestWithJSON(t, http.MethodPost, "/api/v1/repos/user2/repo1/releases", map[string]any{
		"tag_name": "livesync-draft", "target_commitish": "master", "name": "unannounced", "body": "draft notes", "draft": true,
	}).AddTokenAuth(token)
	var release struct {
		ID int64 `json:"id"`
	}
	DecodeJSON(t, MakeRequest(t, req, http.StatusCreated), &release)
	livesyncBarrier(t)
	assert.Empty(t, livesyncEntriesOf(t, cursor, protocol.ModelRelease, release.ID))
	for _, e := range livesyncLogSince(t, cursor) {
		assert.NotContains(t, e.Payload, "unannounced", "%s %d", e.Model, e.EntityID)
	}
	req = NewRequestWithJSON(t, http.MethodPatch, fmt.Sprintf("/api/v1/repos/user2/repo1/releases/%d", release.ID), map[string]any{
		"draft": false,
	}).AddTokenAuth(token)
	MakeRequest(t, req, http.StatusOK)
	e := livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelRelease, release.ID, protocol.OpUpsert))
	assert.Equal(t, "repo:1", e.Grp)
	assert.Equal(t, "releases", e.Unit)
	assert.Equal(t, "unannounced", livesyncPayload[protocol.Release](t, e).Name)
}
