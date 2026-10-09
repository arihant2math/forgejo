// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	actions_model "forgejo.org/models/actions"
	auth_model "forgejo.org/models/auth"
	"forgejo.org/models/db"
	issues_model "forgejo.org/models/issues"
	livesync_model "forgejo.org/models/livesync"
	project_model "forgejo.org/models/project"
	pull_model "forgejo.org/models/pull"
	repo_model "forgejo.org/models/repo"
	unit_model "forgejo.org/models/unit"
	"forgejo.org/models/unittest"
	user_model "forgejo.org/models/user"
	webhook_model "forgejo.org/models/webhook"
	actions_module "forgejo.org/modules/actions"
	"forgejo.org/modules/gitrepo"
	"forgejo.org/modules/json"
	api "forgejo.org/modules/structs"
	webhook_module "forgejo.org/modules/webhook"
	"forgejo.org/services/livesync/protocol"

	runnerv1 "code.forgejo.org/forgejo/actions-proto/runner/v1"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// The gap endpoints (B9; contract in services/livesync/protocol/api.go and
// logs.go): for every endpoint the permission cases, the happy path, the
// delta of a write (in the log at the response, covered by
// X-Livesync-Sync-Id, and over a WebSocket), 409s, immutable headers, and
// the Idempotency-Key layer in front of the writes.

// livesyncAPI builds a gap endpoint request with a JSON body (nil: none).
func livesyncAPI(t *testing.T, method, path, token string, body any) *RequestWrapper {
	t.Helper()
	var b []byte
	if body != nil {
		var err error
		b, err = json.Marshal(body)
		require.NoError(t, err)
	}
	req := NewRequestWithBody(t, method, protocol.APIPrefix+path, bytes.NewReader(b))
	if body != nil {
		req.SetHeader("Content-Type", "application/json")
	}
	if token != "" {
		req.AddTokenAuth(token)
	}
	return req
}

// livesyncReadToken creates a token with livesync's read scopes only.
func livesyncReadToken(t *testing.T, uid int64) string {
	t.Helper()
	tok := &auth_model.AccessToken{
		UID: uid, Name: fmt.Sprintf("livesync-read-%d", time.Now().UnixNano()), ResourceAllRepos: true,
		Scope: "read:repository,read:issue,read:organization,read:user,read:notification",
	}
	require.NoError(t, auth_model.NewAccessToken(t.Context(), tok))
	return tok.Token
}

// livesyncWrite makes a gap endpoint write, checks its sync id and that
// the given entities' entries after cursor are covered by it, and returns
// the response.
func livesyncWrite(t *testing.T, req *RequestWrapper, status int, cursor int64, entities ...livesyncEntityRef) *httptest.ResponseRecorder {
	t.Helper()
	resp := MakeRequest(t, req, status)
	syncID := livesyncSyncID(t, resp)
	for _, e := range entities {
		livesyncCovered(t, cursor, syncID, e.model, e.id)
	}
	return resp
}

type livesyncEntityRef struct {
	model protocol.Model
	id    int64
}

func TestLivesyncAPI(t *testing.T) {
	livesyncSkipSQLite(t)
	livesyncServe(t)
	onApplicationRun(t, func(t *testing.T, u *url.URL) {
		t.Run("endpoints", func(t *testing.T) { livesyncAPIScenario(t, u) })
	})
}

func livesyncAPIScenario(t *testing.T, u *url.URL) {
	livesyncWaitBackfill(t)
	livesyncSettle(t)
	user2 := livesyncToken(t, &user_model.User{ID: 2})
	user5 := livesyncToken(t, &user_model.User{ID: 5})
	read2 := livesyncReadToken(t, 2)

	// A WebSocket session of user2 that watches the deltas of the
	// writes (repo:1 holds the board of project 1, issue:1 the
	// body, user:2 the viewed files).
	ws := livesyncDial(t, u, "ws")
	ws.send(livesyncHello(user2, protocol.GroupRequest{Group: "repo:1"}, protocol.GroupRequest{Group: "issue:1"}, protocol.GroupRequest{Group: "user:2"}))
	ws.waitType(protocol.MsgWelcome)
	ws.waitType(protocol.MsgCaughtUp)
	delta := func(model protocol.Model, id int64, check func(d map[string]any) bool) {
		t.Helper()
		ws.waitChange(fmt.Sprintf("%s %d", model, id), func(ch *protocol.Change) bool {
			if ch.M != model || ch.ID != id {
				return false
			}
			if check == nil {
				return true
			}
			d, _ := ch.D.(map[string]any)
			return d != nil && check(d)
		})
	}

	t.Run("boards", func(t *testing.T) { livesyncAPIBoards(t, user2, user5, read2, delta) })
	t.Run("board positions", func(t *testing.T) { livesyncAPIBoardPositions(t, user2) })
	t.Run("concurrent card moves", func(t *testing.T) { livesyncAPIConcurrentMoves(t, u, user2) })
	t.Run("body", func(t *testing.T) { livesyncAPIBody(t, user2, user5, read2, delta) })
	t.Run("viewed", func(t *testing.T) { livesyncAPIViewed(t, user2, user5, read2, delta) })
	t.Run("git", func(t *testing.T) { livesyncAPIGit(t, user2, user5) })
	t.Run("markdown", func(t *testing.T) { livesyncAPIMarkdown(t, user2, user5) })
	t.Run("markup", func(t *testing.T) { livesyncAPIMarkup(t, user2, user5) })
	t.Run("issue project", func(t *testing.T) { livesyncAPIIssueProject(t, user2, user5) })
	t.Run("resolve conversation", func(t *testing.T) { livesyncAPIResolve(t, user2, user5) })
	t.Run("auth", func(t *testing.T) {
		MakeRequest(t, livesyncAPI(t, "PATCH", "/issues/1/body", "", map[string]any{"body": "x"}), http.StatusUnauthorized)
		MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/blobs/x", "bad-token", nil), http.StatusUnauthorized)
		MakeRequest(t, livesyncAPI(t, "GET", "/nope", user2, nil), http.StatusNotFound)
	})
}

func livesyncAPIBoards(t *testing.T, user2, user5, read2 string, delta func(protocol.Model, int64, func(map[string]any) bool)) {
	ctx := t.Context()
	columns := func(projectID int64) []*project_model.Column {
		cs, err := db.Find[project_model.Column](ctx, project_model.FindColumnOptions{ListOptions: db.ListOptionsAll, ProjectID: projectID})
		require.NoError(t, err)
		return cs
	}
	card := func(issueID int64) project_model.ProjectIssue {
		return *unittest.AssertExistsAndLoadBean(t, &project_model.ProjectIssue{ProjectID: 1, IssueID: issueID})
	}

	// Create (project 1 of user2/repo1).
	cursor := livesyncLogHead(t)
	var created protocol.APICreated
	resp := MakeRequest(t, livesyncAPI(t, "POST", "/projects/1/columns", user2, protocol.APIColumnCreate{Title: "Review", Color: "#aabbcc"}), http.StatusCreated)
	DecodeJSON(t, resp, &created)
	syncID := livesyncSyncID(t, resp)
	livesyncCovered(t, cursor, syncID, protocol.ModelProjectColumn, created.ID)
	delta(protocol.ModelProjectColumn, created.ID, func(d map[string]any) bool { return d["title"] == "Review" && d["color"] == "#aabbcc" })
	col := unittest.AssertExistsAndLoadBean(t, &project_model.Column{ID: created.ID, ProjectID: 1, Title: "Review"})
	assert.False(t, col.Default)
	for _, bad := range []protocol.APIColumnCreate{{Title: " "}, {Title: strings.Repeat("x", 101)}, {Title: "c", Color: "red"}} {
		MakeRequest(t, livesyncAPI(t, "POST", "/projects/1/columns", user2, bad), http.StatusBadRequest)
	}
	MakeRequest(t, livesyncAPI(t, "POST", "/projects/1/columns", user2, nil), http.StatusBadRequest)

	// Edit: title, colour removed, made the default (column 1 loses it).
	cursor = livesyncLogHead(t)
	title, color, yes := "Reviewing", "", true
	livesyncWrite(t, livesyncAPI(t, "PATCH", fmt.Sprintf("/projects/1/columns/%d", created.ID), user2, protocol.APIColumnEdit{Title: &title, Color: &color, Default: &yes}), http.StatusOK,
		cursor, livesyncEntityRef{protocol.ModelProjectColumn, created.ID}, livesyncEntityRef{protocol.ModelProjectColumn, 1})
	col = unittest.AssertExistsAndLoadBean(t, &project_model.Column{ID: created.ID})
	assert.Equal(t, "Reviewing", col.Title)
	assert.Empty(t, col.Color)
	assert.True(t, col.Default)
	assert.False(t, unittest.AssertExistsAndLoadBean(t, &project_model.Column{ID: 1}).Default)
	delta(protocol.ModelProjectColumn, created.ID, func(d map[string]any) bool { return d["default"] == true })
	MakeRequest(t, livesyncAPI(t, "PATCH", "/projects/1/columns/5", user2, protocol.APIColumnEdit{Title: &title}), http.StatusNotFound) // project 2's
	MakeRequest(t, livesyncAPI(t, "PATCH", "/projects/1/columns/999", user2, protocol.APIColumnEdit{Title: &title}), http.StatusNotFound)

	// Order: every column, reversed; one missing is a conflict.
	ids := []int64{}
	for _, c := range columns(1) {
		ids = append(ids, c.ID)
	}
	slices.Reverse(ids)
	cursor = livesyncLogHead(t)
	livesyncWrite(t, livesyncAPI(t, "PUT", "/projects/1/column-order", user2, protocol.APIColumnOrder{ColumnIDs: ids}), http.StatusNoContent,
		cursor, livesyncEntityRef{protocol.ModelProjectColumn, ids[0]})
	got := []int64{}
	for _, c := range columns(1) {
		got = append(got, c.ID)
	}
	assert.Equal(t, ids, got)
	MakeRequest(t, livesyncAPI(t, "PUT", "/projects/1/column-order", user2, protocol.APIColumnOrder{ColumnIDs: ids[1:]}), http.StatusConflict)

	// Move a card: issue 1 (column 1) to the top of column 2 (issue 3
	// there goes after it).
	cursor = livesyncLogHead(t)
	pi1 := card(1)
	livesyncWrite(t, livesyncAPI(t, "POST", "/projects/1/columns/2/cards", user2, protocol.APICardMove{IssueID: 1, Position: new(0)}), http.StatusNoContent,
		cursor, livesyncEntityRef{protocol.ModelProjectIssue, pi1.ID})
	assert.EqualValues(t, 2, card(1).ProjectColumnID)
	assert.EqualValues(t, 0, card(1).Sorting)
	assert.EqualValues(t, 2, card(3).ProjectColumnID)
	assert.EqualValues(t, 1, card(3).Sorting)
	delta(protocol.ModelProjectIssue, pi1.ID, func(d map[string]any) bool { return d["column_id"] == float64(2) })
	// Without a position: last.
	MakeRequest(t, livesyncAPI(t, "POST", "/projects/1/columns/2/cards", user2, protocol.APICardMove{IssueID: 1}), http.StatusNoContent)
	assert.EqualValues(t, 0, card(3).Sorting)
	assert.EqualValues(t, 1, card(1).Sorting)
	// The full order of the target column.
	MakeRequest(t, livesyncAPI(t, "POST", "/projects/1/columns/3/cards", user2, protocol.APICardMove{Cards: []protocol.APICard{{IssueID: 1, Sorting: 0}, {IssueID: 5, Sorting: 1}}}), http.StatusNoContent)
	assert.EqualValues(t, 3, card(1).ProjectColumnID)
	assert.EqualValues(t, 1, card(5).Sorting)
	for _, bad := range []protocol.APICardMove{{}, {IssueID: 1, Cards: []protocol.APICard{{IssueID: 5}}}, {IssueID: 1, Position: new(-1)}, {Cards: []protocol.APICard{{IssueID: 1}, {IssueID: 5}}}} {
		MakeRequest(t, livesyncAPI(t, "POST", "/projects/1/columns/3/cards", user2, bad), http.StatusBadRequest)
	}
	// Issue 11 (repo1) is not on the board; issue 7 is another
	// repository's; issue 9999 does not exist.
	MakeRequest(t, livesyncAPI(t, "POST", "/projects/1/columns/3/cards", user2, protocol.APICardMove{IssueID: 11}), http.StatusConflict)
	MakeRequest(t, livesyncAPI(t, "POST", "/projects/1/columns/3/cards", user2, protocol.APICardMove{IssueID: 7}), http.StatusNotFound)
	MakeRequest(t, livesyncAPI(t, "POST", "/projects/1/columns/3/cards", user2, protocol.APICardMove{IssueID: 9999}), http.StatusNotFound)

	// Delete: the default column refuses; another one moves its cards to
	// the default column.
	MakeRequest(t, livesyncAPI(t, "DELETE", fmt.Sprintf("/projects/1/columns/%d", created.ID), user2, nil), http.StatusUnprocessableEntity)
	cursor = livesyncLogHead(t)
	livesyncWrite(t, livesyncAPI(t, "DELETE", "/projects/1/columns/3", user2, nil), http.StatusNoContent, cursor)
	unittest.AssertNotExistsBean(t, &project_model.Column{ID: 3})
	assert.Equal(t, created.ID, card(1).ProjectColumnID)
	assert.Equal(t, created.ID, card(5).ProjectColumnID)
	livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelProjectColumn, 3, protocol.OpDelete))
	delta(protocol.ModelProjectIssue, pi1.ID, func(d map[string]any) bool { return d["column_id"] == float64(created.ID) })

	// Organization project 7 of org3 (user2 owns org3); user project 4
	// of user2.
	MakeRequest(t, livesyncAPI(t, "POST", "/projects/7/columns", user2, protocol.APIColumnCreate{Title: "org"}), http.StatusCreated)
	MakeRequest(t, livesyncAPI(t, "POST", "/projects/4/columns", user2, protocol.APIColumnCreate{Title: "mine"}), http.StatusCreated)

	// Permissions: user5 may read repo1's and user2's projects but not
	// change them; project 2 (private org3/repo3) and an unknown project
	// are 404; a token without write:issue is 403.
	MakeRequest(t, livesyncAPI(t, "POST", "/projects/1/columns", user5, protocol.APIColumnCreate{Title: "x"}), http.StatusForbidden)
	MakeRequest(t, livesyncAPI(t, "POST", "/projects/1/columns/2/cards", user5, protocol.APICardMove{IssueID: 1}), http.StatusForbidden)
	MakeRequest(t, livesyncAPI(t, "DELETE", "/projects/1/columns/2", user5, nil), http.StatusForbidden)
	MakeRequest(t, livesyncAPI(t, "POST", "/projects/4/columns", user5, protocol.APIColumnCreate{Title: "x"}), http.StatusForbidden)
	MakeRequest(t, livesyncAPI(t, "POST", "/projects/2/columns", user5, protocol.APIColumnCreate{Title: "x"}), http.StatusNotFound)
	MakeRequest(t, livesyncAPI(t, "POST", "/projects/999/columns", user2, protocol.APIColumnCreate{Title: "x"}), http.StatusNotFound)
	MakeRequest(t, livesyncAPI(t, "POST", "/projects/1/columns", read2, protocol.APIColumnCreate{Title: "x"}), http.StatusForbidden)
	unittest.AssertNotExistsBean(t, &project_model.Column{ProjectID: 1, Title: "x"})

	// Idempotency-Key: the same create twice is one column, the second
	// answer a replay with the same body and sync id.
	keyed := func() *RequestWrapper {
		return livesyncAPI(t, "POST", "/projects/1/columns", user2, protocol.APIColumnCreate{Title: "keyed"}).SetHeader(protocol.HeaderIdempotencyKey, "board-keyed")
	}
	first := MakeRequest(t, keyed(), http.StatusCreated)
	second := MakeRequest(t, keyed(), http.StatusCreated)
	assert.Equal(t, "true", second.Header().Get(protocol.HeaderIdempotentReplay))
	assert.Equal(t, first.Body.String(), second.Body.String())
	assert.Equal(t, livesyncSyncID(t, first), livesyncSyncID(t, second))
	assert.Len(t, slices.DeleteFunc(columns(1), func(c *project_model.Column) bool { return c.Title != "keyed" }), 1)
	// Another request with the key: 422.
	MakeRequest(t, livesyncAPI(t, "POST", "/projects/1/columns", user2, protocol.APIColumnCreate{Title: "other"}).SetHeader(protocol.HeaderIdempotencyKey, "board-keyed"), http.StatusUnprocessableEntity)
}

// livesyncAPIBoardPositions: a card's position counts the cards the viewer
// may read (as the board shows them); the others keep their places.
func livesyncAPIBoardPositions(t *testing.T, user2 string) {
	ctx := t.Context()
	// User project 4 of user2, column 4: issue 18 (repo55: user2's, but
	// without an issues unit, so user2 does not see it on the board),
	// issue 10 (glob), issue 19 (commitsonpr); issue 24 (repo256) in the
	// default column 6.
	_, err := db.GetEngine(ctx).Where("project_id = 4").Delete(&project_model.ProjectIssue{})
	require.NoError(t, err)
	for i, id := range []int64{18, 10, 19} {
		require.NoError(t, db.Insert(ctx, &project_model.ProjectIssue{IssueID: id, ProjectID: 4, ProjectColumnID: 4, Sorting: int64(i)}))
	}
	require.NoError(t, db.Insert(ctx, &project_model.ProjectIssue{IssueID: 24, ProjectID: 4, ProjectColumnID: 6}))
	order := func() []int64 {
		cards, err := db.Find[project_model.ProjectIssue](ctx, project_model.FindProjectIssueOptions{ListOptions: db.ListOptionsAll, ProjectID: 4, ProjectColumnID: 4})
		require.NoError(t, err)
		res := []int64{}
		for _, c := range cards {
			res = append(res, c.IssueID)
		}
		return res
	}
	// user2 sees [10, 19] and drops 24 between them (position 1).
	MakeRequest(t, livesyncAPI(t, "POST", "/projects/4/columns/4/cards", user2, protocol.APICardMove{IssueID: 24, Position: new(1)}), http.StatusNoContent)
	assert.Equal(t, []int64{18, 10, 24, 19}, order())
	// At the top of what user2 sees: before 10 (18 stays first).
	MakeRequest(t, livesyncAPI(t, "POST", "/projects/4/columns/4/cards", user2, protocol.APICardMove{IssueID: 24, Position: new(0)}), http.StatusNoContent)
	assert.Equal(t, []int64{18, 24, 10, 19}, order())
	// Past the readable cards: last.
	MakeRequest(t, livesyncAPI(t, "POST", "/projects/4/columns/4/cards", user2, protocol.APICardMove{IssueID: 24, Position: new(2)}), http.StatusNoContent)
	assert.Equal(t, []int64{18, 10, 19, 24}, order())
}

// livesyncAPIConcurrentMoves: a card moved by position while another
// request moves a card out of the same column is not written back into it
// (the column is read in the move's transaction, locked), and concurrent
// moves never answer 500.
func livesyncAPIConcurrentMoves(t *testing.T, u *url.URL, user2 string) {
	card := func(issueID int64) project_model.ProjectIssue {
		return *unittest.AssertExistsAndLoadBean(t, &project_model.ProjectIssue{ProjectID: 1, IssueID: issueID})
	}
	move := func(column, issueID int64, position *int) int {
		return livesyncHTTP(t, u, user2, "POST", fmt.Sprintf("%s/projects/1/columns/%d/cards", protocol.APIPrefix, column), protocol.APICardMove{IssueID: issueID, Position: position}, nil)
	}
	for i := range 12 {
		// Issue 3 in column 1, issue 1 in column 2.
		MakeRequest(t, livesyncAPI(t, "POST", "/projects/1/columns/1/cards", user2, protocol.APICardMove{IssueID: 3}), http.StatusNoContent)
		MakeRequest(t, livesyncAPI(t, "POST", "/projects/1/columns/2/cards", user2, protocol.APICardMove{IssueID: 1}), http.StatusNoContent)
		// A: issue 1 to the top of column 1; B: issue 3 to column 2.
		var wg sync.WaitGroup
		var statusA, statusB int
		wg.Go(func() { statusA = move(1, 1, new(0)) })
		wg.Go(func() { statusB = move(2, 3, nil) })
		wg.Wait()
		for _, status := range []int{statusA, statusB} {
			require.Contains(t, []int{http.StatusNoContent, http.StatusServiceUnavailable}, status, "iteration %d", i)
		}
		if statusB == http.StatusNoContent {
			require.EqualValues(t, 2, card(3).ProjectColumnID, "iteration %d: issue 3 moved back into column 1", i)
		}
		if statusA == http.StatusNoContent {
			require.EqualValues(t, 1, card(1).ProjectColumnID, "iteration %d", i)
		}
	}
}

func livesyncAPIBody(t *testing.T, user2, user5, read2 string, delta func(protocol.Model, int64, func(map[string]any) bool)) {
	issue := unittest.AssertExistsAndLoadBean(t, &issues_model.Issue{ID: 1})
	version := issue.ContentVersion
	// Webhook 1 of repo1, for every event.
	hook := unittest.AssertExistsAndLoadBean(t, &webhook_model.Webhook{ID: 1})
	hook.HookEvent = &webhook_module.HookEvent{SendEverything: true}
	require.NoError(t, hook.UpdateEvent())
	require.NoError(t, webhook_model.UpdateWebhook(t.Context(), hook))
	retrieveHookTasks(t, hook.ID, true)

	cursor := livesyncLogHead(t)
	var edited protocol.APIBodyEdited
	resp := livesyncWrite(t, livesyncAPI(t, "PATCH", "/issues/1/body", user2, protocol.APIBodyEdit{Body: "edited **body**", ExpectedVersion: version}), http.StatusOK,
		cursor, livesyncEntityRef{protocol.ModelIssueBody, 1})
	DecodeJSON(t, resp, &edited)
	assert.Equal(t, version+1, edited.ContentVersion)
	delta(protocol.ModelIssueBody, 1, func(d map[string]any) bool {
		return d["body"] == "edited **body**" && d["content_version"] == float64(version+1) && strings.Contains(d["body_html"].(string), "<strong>body</strong>")
	})

	// The notifiers get the issue as the classic UI's edit gives it: the
	// webhook payload carries the poster's (user1, a site admin)
	// permission in the repository.
	tasks := retrieveHookTasks(t, hook.ID, false)
	require.NotEmpty(t, tasks)
	assert.Equal(t, webhook_module.HookEventIssues, tasks[0].EventType)
	var payload api.IssuePayload
	require.NoError(t, json.Unmarshal([]byte(tasks[0].PayloadContent), &payload))
	assert.Equal(t, api.HookIssueEdited, payload.Action)
	assert.Equal(t, "edited **body**", payload.Issue.Body)
	assert.True(t, payload.Repository.Permissions.Admin, "the poster's permission, not an anonymous one")
	// Off again once delivered (its receiver ends with this test).
	_, err := db.GetEngine(t.Context()).ID(hook.ID).Cols("is_active").Update(&webhook_model.Webhook{IsActive: false})
	require.NoError(t, err)
	assert.Eventually(t, func() bool {
		return unittest.AssertExistsAndLoadBean(t, &webhook_model.HookTask{ID: tasks[0].ID}).IsDelivered
	}, livesyncWait, 10*time.Millisecond)

	// A stale version: 409 with the current text and version, nothing
	// changed.
	var conflict protocol.APIBodyConflict
	DecodeJSON(t, MakeRequest(t, livesyncAPI(t, "PATCH", "/issues/1/body", user2, protocol.APIBodyEdit{Body: "lost", ExpectedVersion: version}), http.StatusConflict), &conflict)
	assert.Equal(t, "edited **body**", conflict.Body)
	assert.Equal(t, version+1, conflict.ContentVersion)
	assert.Equal(t, "edited **body**", unittest.AssertExistsAndLoadBean(t, &issues_model.Issue{ID: 1}).Content)

	// Permissions: user5 neither posted issue 1 nor writes repo1's
	// issues; issue 4 is in private repo2; a read-only token.
	MakeRequest(t, livesyncAPI(t, "PATCH", "/issues/1/body", user5, protocol.APIBodyEdit{Body: "x", ExpectedVersion: version + 1}), http.StatusForbidden)
	MakeRequest(t, livesyncAPI(t, "PATCH", "/issues/4/body", user5, protocol.APIBodyEdit{Body: "x"}), http.StatusNotFound)
	MakeRequest(t, livesyncAPI(t, "PATCH", "/issues/99999/body", user2, protocol.APIBodyEdit{Body: "x"}), http.StatusNotFound)
	MakeRequest(t, livesyncAPI(t, "PATCH", "/issues/1/body", read2, protocol.APIBodyEdit{Body: "x", ExpectedVersion: version + 1}), http.StatusForbidden)

	// A comment user5 posts on public repo1's issue 1 (any reader may
	// comment there): its poster may edit it, a reader may not.
	var comment struct{ ID int64 }
	DecodeJSON(t, MakeRequest(t, NewRequestWithJSON(t, "POST", "/api/v1/repos/user2/repo1/issues/1/comments", map[string]string{"body": "first"}).AddTokenAuth(user5), http.StatusCreated), &comment)
	path := fmt.Sprintf("/comments/%d/body", comment.ID)
	cursor = livesyncLogHead(t)
	resp = livesyncWrite(t, livesyncAPI(t, "PATCH", path, user5, protocol.APIBodyEdit{Body: "second", ExpectedVersion: 0}), http.StatusOK,
		cursor, livesyncEntityRef{protocol.ModelComment, comment.ID})
	DecodeJSON(t, resp, &edited)
	assert.Equal(t, 1, edited.ContentVersion)
	delta(protocol.ModelComment, comment.ID, func(d map[string]any) bool { return d["body"] == "second" })
	DecodeJSON(t, MakeRequest(t, livesyncAPI(t, "PATCH", path, user5, protocol.APIBodyEdit{Body: "third", ExpectedVersion: 0}), http.StatusConflict), &conflict)
	assert.Equal(t, protocol.APIBodyConflict{Message: conflict.Message, Body: "second", ContentVersion: 1}, conflict)
	// The repository's owner writes the issues unit: allowed.
	MakeRequest(t, livesyncAPI(t, "PATCH", path, user2, protocol.APIBodyEdit{Body: "by owner", ExpectedVersion: 1}), http.StatusOK)
	other := livesyncToken(t, &user_model.User{ID: 4})
	MakeRequest(t, livesyncAPI(t, "PATCH", path, other, protocol.APIBodyEdit{Body: "x", ExpectedVersion: 2}), http.StatusForbidden)
	// A label event has no content to edit.
	MakeRequest(t, livesyncAPI(t, "PATCH", "/comments/2021/body", user2, protocol.APIBodyEdit{Body: "x"}), http.StatusUnprocessableEntity)
	MakeRequest(t, livesyncAPI(t, "PATCH", "/comments/999999/body", user2, protocol.APIBodyEdit{Body: "x"}), http.StatusNotFound)
	// Comment 4 is user1's in a pending review (a draft) on public repo1's
	// pull request: 404 for a reader (user5), as for a missing comment —
	// not 403, which would tell that it exists —, and for the owner.
	MakeRequest(t, livesyncAPI(t, "PATCH", "/comments/4/body", user5, protocol.APIBodyEdit{Body: "x", ExpectedVersion: 1}), http.StatusNotFound)
	MakeRequest(t, livesyncAPI(t, "PATCH", "/comments/4/body", user2, protocol.APIBodyEdit{Body: "x", ExpectedVersion: 1}), http.StatusNotFound)

	// With an Idempotency-Key: a retry after the edit replays the success
	// instead of answering 409.
	keyed := func() *RequestWrapper {
		return livesyncAPI(t, "PATCH", path, user2, protocol.APIBodyEdit{Body: "keyed", ExpectedVersion: 2}).SetHeader(protocol.HeaderIdempotencyKey, "body-keyed")
	}
	first := MakeRequest(t, keyed(), http.StatusOK)
	second := MakeRequest(t, keyed(), http.StatusOK)
	assert.Equal(t, "true", second.Header().Get(protocol.HeaderIdempotentReplay))
	assert.Equal(t, first.Body.String(), second.Body.String())
}

func livesyncAPIViewed(t *testing.T, user2, user5, read2 string, delta func(protocol.Model, int64, func(map[string]any) bool)) {
	const head = "65f1bf27bc3bf70f64657658635e66094edbcb4d" // user2/repo1's master
	// Issue 2 is pull request 1 of repo1.
	var files protocol.APIViewedFiles
	DecodeJSON(t, MakeRequest(t, livesyncAPI(t, "GET", "/issues/2/viewed", user2, nil), http.StatusOK), &files)
	assert.Equal(t, protocol.APIViewedFiles{PullID: 1, Files: map[string]string{}}, files)

	cursor := livesyncLogHead(t)
	resp := MakeRequest(t, livesyncAPI(t, "PUT", "/issues/2/viewed", user2, protocol.APIViewedUpdate{CommitSHA: head, Files: map[string]bool{"README.md": true, "other.txt": false}}), http.StatusOK)
	syncID := livesyncSyncID(t, resp)
	DecodeJSON(t, resp, &files)
	assert.Equal(t, protocol.APIViewedFiles{PullID: 1, CommitSHA: head, Files: map[string]string{"README.md": protocol.ViewedViewed, "other.txt": protocol.ViewedUnviewed}}, files)
	state := unittest.AssertExistsAndLoadBean(t, &pull_model.ReviewState{UserID: 2, PullID: 1, CommitSHA: head})
	assert.Equal(t, pull_model.Viewed, state.UpdatedFiles["README.md"])
	livesyncCovered(t, cursor, syncID, protocol.ModelReviewState, state.ID)
	delta(protocol.ModelReviewState, state.ID, func(d map[string]any) bool { return d["commit_sha"] == head })

	// Merged with the stored state.
	MakeRequest(t, livesyncAPI(t, "PUT", "/issues/2/viewed", user2, protocol.APIViewedUpdate{CommitSHA: head, Files: map[string]bool{"other.txt": true}}), http.StatusOK)
	DecodeJSON(t, MakeRequest(t, livesyncAPI(t, "GET", "/issues/2/viewed", user2, nil), http.StatusOK), &files)
	assert.Equal(t, map[string]string{"README.md": protocol.ViewedViewed, "other.txt": protocol.ViewedViewed}, files.Files)
	// Against the same head nothing changed; a malformed head is 400.
	DecodeJSON(t, MakeRequest(t, livesyncAPI(t, "GET", "/issues/2/viewed?head="+head, user2, nil), http.StatusOK), &files)
	assert.Equal(t, protocol.ViewedViewed, files.Files["README.md"])
	MakeRequest(t, livesyncAPI(t, "GET", "/issues/2/viewed?head=master", user2, nil), http.StatusBadRequest)
	// A commit after the state's that changes README.md: README.md has
	// changed since it was viewed, other.txt has not; nothing is stored.
	var readme struct{ SHA string }
	DecodeJSON(t, MakeRequest(t, NewRequest(t, "GET", "/api/v1/repos/user2/repo1/contents/README.md").AddTokenAuth(user2), http.StatusOK), &readme)
	var change struct {
		Commit struct{ SHA string } `json:"commit"`
	}
	DecodeJSON(t, MakeRequest(t, NewRequestWithJSON(t, "PUT", "/api/v1/repos/user2/repo1/contents/README.md", map[string]string{
		"content": base64.StdEncoding.EncodeToString([]byte("changed\n")), "message": "change README", "sha": readme.SHA,
	}).AddTokenAuth(user2), http.StatusOK), &change)
	DecodeJSON(t, MakeRequest(t, livesyncAPI(t, "GET", "/issues/2/viewed?head="+change.Commit.SHA, user2, nil), http.StatusOK), &files)
	assert.Equal(t, protocol.APIViewedFiles{PullID: 1, CommitSHA: head, Files: map[string]string{"README.md": protocol.ViewedHasChanged, "other.txt": protocol.ViewedViewed}}, files)
	assert.Equal(t, pull_model.Viewed, unittest.AssertExistsAndLoadBean(t, &pull_model.ReviewState{UserID: 2, PullID: 1, CommitSHA: head}).UpdatedFiles["README.md"])
	MakeRequest(t, livesyncAPI(t, "PUT", "/issues/2/viewed", user2, protocol.APIViewedUpdate{CommitSHA: "master", Files: map[string]bool{"a": true}}), http.StatusBadRequest)

	// Each viewer has their own state; a reader of the pull request may
	// write theirs (user5 reads public repo1), not with a read-only
	// token; an issue is no pull request; private repo3's pull request
	// is 404 for user5.
	files = protocol.APIViewedFiles{}
	DecodeJSON(t, MakeRequest(t, livesyncAPI(t, "GET", "/issues/2/viewed", user5, nil), http.StatusOK), &files)
	assert.Empty(t, files.Files)
	MakeRequest(t, livesyncAPI(t, "PUT", "/issues/2/viewed", user5, protocol.APIViewedUpdate{CommitSHA: head, Files: map[string]bool{"README.md": true}}), http.StatusOK)
	MakeRequest(t, livesyncAPI(t, "PUT", "/issues/2/viewed", read2, protocol.APIViewedUpdate{CommitSHA: head, Files: map[string]bool{"README.md": true}}), http.StatusForbidden)
	MakeRequest(t, livesyncAPI(t, "GET", "/issues/1/viewed", user2, nil), http.StatusNotFound)
	// Issue 12 is a pull request of org3's private repo3.
	MakeRequest(t, livesyncAPI(t, "GET", "/issues/12/viewed", user5, nil), http.StatusNotFound)
	MakeRequest(t, livesyncAPI(t, "GET", "/issues/12/viewed", user2, nil), http.StatusOK)
}

// livesyncGit runs git in a fixture repository.
func livesyncGit(t *testing.T, repo *repo_model.Repository, args ...string) string {
	t.Helper()
	out, err := exec.Command("git", append([]string{"-C", repo.RepoPath()}, args...)...).Output()
	require.NoError(t, err, "git %v", args)
	return string(out)
}

func livesyncAPIGit(t *testing.T, user2, user5 string) {
	repo1 := unittest.AssertExistsAndLoadBean(t, &repo_model.Repository{ID: 1})
	const root = "65f1bf27bc3bf70f64657658635e66094edbcb4d"
	immutable := func(t *testing.T, resp *httptest.ResponseRecorder, etag string) {
		t.Helper()
		assert.Equal(t, protocol.CacheImmutable, resp.Header().Get("Cache-Control"))
		assert.Equal(t, "Authorization", resp.Header().Get("Vary"))
		assert.Equal(t, `"`+etag+`"`, resp.Header().Get("ETag"))
	}

	// Tree.
	var tree protocol.APITree
	resp := MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/tree/"+root, user2, nil), http.StatusOK)
	DecodeJSON(t, resp, &tree)
	treeSHA := strings.TrimSpace(livesyncGit(t, repo1, "rev-parse", root+"^{tree}"))
	immutable(t, resp, treeSHA)
	assert.Equal(t, treeSHA, tree.SHA)
	readmeSHA := strings.TrimSpace(livesyncGit(t, repo1, "rev-parse", root+":README.md"))
	readme := livesyncGit(t, repo1, "show", root+":README.md")
	require.NotEmpty(t, tree.Entries)
	i := slices.IndexFunc(tree.Entries, func(e protocol.APITreeEntry) bool { return e.Name == "README.md" })
	require.GreaterOrEqual(t, i, 0)
	size := int64(len(readme))
	assert.Equal(t, protocol.APITreeEntry{Name: "README.md", Type: "blob", Mode: "100644", SHA: readmeSHA, Size: &size}, tree.Entries[i])
	MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/tree/"+root, user2, nil).SetHeader("If-None-Match", `"`+treeSHA+`"`), http.StatusNotModified)
	MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/tree/"+root+"/nope", user2, nil), http.StatusNotFound)
	MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/tree/"+root+"/README.md", user2, nil), http.StatusNotFound)
	// Only full SHAs: branch names, tags and abbreviations are 404, as
	// is a SHA the repository does not have.
	for _, ref := range []string{"master", root[:7], strings.ToUpper(root), strings.Repeat("0", 39) + "1"} {
		MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/tree/"+ref, user2, nil), http.StatusNotFound)
	}

	// Raw file and blob: the same bytes, ETag = the blob SHA.
	resp = MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/raw/"+root+"/README.md", user2, nil), http.StatusOK)
	assert.Equal(t, readme, resp.Body.String())
	immutable(t, resp, readmeSHA)
	assert.Equal(t, "application/octet-stream", resp.Header().Get("Content-Type"))
	assert.Equal(t, "nosniff", resp.Header().Get("X-Content-Type-Options"))
	assert.Equal(t, strconv.Itoa(len(readme)), resp.Header().Get("Content-Length"))
	MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/raw/"+root+"/README.md", user2, nil).SetHeader("If-None-Match", `"`+readmeSHA+`"`), http.StatusNotModified)
	MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/raw/master/README.md", user2, nil), http.StatusNotFound)
	MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/raw/"+root+"/nope.md", user2, nil), http.StatusNotFound)
	resp = MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/blobs/"+readmeSHA, user2, nil), http.StatusOK)
	assert.Equal(t, readme, resp.Body.String())
	immutable(t, resp, readmeSHA)
	MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/blobs/"+treeSHA, user2, nil), http.StatusNotFound) // a tree
	MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/blobs/"+strings.Repeat("1", 40), user2, nil), http.StatusNotFound)

	// Diff of the root commit (against the empty tree) and between two
	// commits of commitsonpr (repository 58).
	resp = MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/diff/"+root, user2, nil), http.StatusOK)
	immutable(t, resp, root)
	assert.True(t, strings.HasPrefix(resp.Body.String(), "diff --git a/README.md b/README.md"), resp.Body.String())
	repo58 := unittest.AssertExistsAndLoadBean(t, &repo_model.Repository{ID: 58})
	commits := strings.Fields(livesyncGit(t, repo58, "rev-list", "--reverse", "branch1"))
	require.Greater(t, len(commits), 3)
	base, head := commits[1], commits[3]
	resp = MakeRequest(t, livesyncAPI(t, "GET", fmt.Sprintf("/repos/58/diff/%s/%s", base, head), user2, nil), http.StatusOK)
	immutable(t, resp, base+".."+head)
	assert.Equal(t, livesyncGit(t, repo58, "diff", "-M", base, head), resp.Body.String())
	resp = MakeRequest(t, livesyncAPI(t, "GET", "/repos/58/diff/"+head, user2, nil), http.StatusOK)
	assert.Equal(t, livesyncGit(t, repo58, "diff", "-M", commits[2], head), resp.Body.String())
	MakeRequest(t, livesyncAPI(t, "GET", fmt.Sprintf("/repos/58/diff/%s/master", base), user2, nil), http.StatusNotFound)
	MakeRequest(t, livesyncAPI(t, "GET", "/repos/58/diff/"+base, user2, nil).SetHeader("If-None-Match", `"`+base+`"`), http.StatusNotModified)

	// Blame of a file written by two commits (through API v1): one part
	// per run of lines, as git blame says, with the commits described.
	var file struct {
		Content struct{ SHA string } `json:"content"`
		Commit  struct{ SHA string } `json:"commit"`
	}
	DecodeJSON(t, MakeRequest(t, NewRequestWithJSON(t, "POST", "/api/v1/repos/user2/repo1/contents/blame.txt", map[string]string{
		"content": base64.StdEncoding.EncodeToString([]byte("one\ntwo\nthree\n")), "message": "blame 1",
	}).AddTokenAuth(user2), http.StatusCreated), &file)
	firstCommit := file.Commit.SHA
	DecodeJSON(t, MakeRequest(t, NewRequestWithJSON(t, "PUT", "/api/v1/repos/user2/repo1/contents/blame.txt", map[string]string{
		"content": base64.StdEncoding.EncodeToString([]byte("one\nTWO\nthree\nfour\n")), "message": "blame 2", "sha": file.Content.SHA,
	}).AddTokenAuth(user2), http.StatusOK), &file)
	last := file.Commit.SHA
	var blame protocol.APIBlame
	resp = MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/blame/"+last+"/blame.txt", user2, nil), http.StatusOK)
	DecodeJSON(t, resp, &blame)
	etag := resp.Header().Get("ETag")
	assert.Regexp(t, `^"[0-9a-f]{64}"$`, etag, "a hash of the address")
	immutable(t, resp, strings.Trim(etag, `"`))
	MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/blame/"+last+"/blame.txt", user2, nil).SetHeader("If-None-Match", `"other", `+etag), http.StatusNotModified)
	bypass := MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/blame/"+last+"/blame.txt?bypass_ignore=1", user2, nil), http.StatusOK)
	assert.NotEqual(t, etag, bypass.Header().Get("ETag"))
	assert.Equal(t, last, blame.Commit)
	assert.Equal(t, []protocol.APIBlamePart{
		{SHA: firstCommit, StartLine: 1, Lines: 1},
		{SHA: last, StartLine: 2, Lines: 1, PreviousSHA: firstCommit, PreviousPath: "blame.txt"},
		{SHA: firstCommit, StartLine: 3, Lines: 1},
		{SHA: last, StartLine: 4, Lines: 1, PreviousSHA: firstCommit, PreviousPath: "blame.txt"},
	}, blame.Parts)
	require.Len(t, blame.Commits, 2)
	assert.Equal(t, "blame 2", blame.Commits[last].Summary)
	assert.EqualValues(t, 2, blame.Commits[last].AuthorID, "the token's user is the author")
	assert.NotEmpty(t, blame.Commits[firstCommit].AuthoredAt)
	MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/blame/"+last+"/nope", user2, nil), http.StatusNotFound)
	MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/blame/"+last, user2, nil), http.StatusNotFound)

	// Permissions: private repo2 is 404 for user5 and readable by its
	// owner; an unknown repository is 404.
	repo2 := unittest.AssertExistsAndLoadBean(t, &repo_model.Repository{ID: 2})
	head2 := strings.TrimSpace(livesyncGit(t, repo2, "rev-parse", "HEAD"))
	home2 := strings.TrimSpace(livesyncGit(t, repo2, "rev-parse", head2+":Home.md"))
	for _, path := range []string{"/tree/" + head2, "/raw/" + head2 + "/Home.md", "/blobs/" + home2, "/blame/" + head2 + "/Home.md", "/diff/" + head2} {
		MakeRequest(t, livesyncAPI(t, "GET", "/repos/2"+path, user5, nil), http.StatusNotFound)
		MakeRequest(t, livesyncAPI(t, "GET", "/repos/2"+path, user2, nil), http.StatusOK)
	}
	MakeRequest(t, livesyncAPI(t, "GET", "/repos/999999/tree/"+head2, user2, nil), http.StatusNotFound)

	// A repository the viewer reads without its code unit: commitsonpr
	// without the code unit is 404 for every immutable read, also for its
	// owner (once the permission change reached livesync's cache).
	_, err := db.GetEngine(t.Context()).Where("repo_id = 58 AND type = ?", unit_model.TypeCode).Delete(&repo_model.RepoUnit{})
	require.NoError(t, err)
	readme58 := strings.TrimSpace(livesyncGit(t, repo58, "rev-parse", head+":README.md"))
	assert.Eventually(t, func() bool {
		return MakeRequest(t, livesyncAPI(t, "GET", "/repos/58/tree/"+head, user2, nil), NoExpectedStatus).Code == http.StatusNotFound
	}, livesyncWait, 50*time.Millisecond)
	for _, path := range []string{"/raw/" + head + "/README.md", "/blobs/" + readme58, "/blame/" + head + "/README.md", "/diff/" + head, "/diff/" + base + "/" + head} {
		MakeRequest(t, livesyncAPI(t, "GET", "/repos/58"+path, user2, nil), http.StatusNotFound)
	}
}

func livesyncAPIMarkdown(t *testing.T, user2, user5 string) {
	text := "Fixes #1, **bold** by @user2"
	var preview protocol.APIMarkdownResponse
	DecodeJSON(t, MakeRequest(t, livesyncAPI(t, "POST", "/markdown", user2, protocol.APIMarkdownRequest{RepoID: 1, Items: []string{text, "", "*b*"}}), http.StatusOK), &preview)
	require.Len(t, preview.HTML, 3)
	assert.Contains(t, preview.HTML[0], "<strong>bold</strong>")
	assert.Contains(t, preview.HTML[0], "/user2/repo1/issues/1")
	assert.Empty(t, preview.HTML[1])
	assert.Contains(t, preview.HTML[2], "<em>b</em></p>")

	// The preview is the body_html the sync log carries for an issue
	// with that body.
	cursor := livesyncLogHead(t)
	var created livesyncIssueRef
	DecodeJSON(t, MakeRequest(t, NewRequestWithJSON(t, "POST", "/api/v1/repos/user2/repo1/issues", map[string]string{"title": "preview", "body": text}).AddTokenAuth(user2), http.StatusCreated), &created)
	e := livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelIssueBody, created.ID, protocol.OpUpsert))
	var body protocol.IssueBody
	require.NoError(t, json.Unmarshal([]byte(e.Payload), &body))
	assert.Equal(t, body.BodyHTML, preview.HTML[0])

	// Without a repository: plain markdown; no write, so no sync id and
	// an Idempotency-Key is ignored.
	resp := MakeRequest(t, livesyncAPI(t, "POST", "/markdown", user5, protocol.APIMarkdownRequest{Items: []string{"#1"}}).SetHeader(protocol.HeaderIdempotencyKey, "md"), http.StatusOK)
	assert.Empty(t, resp.Header().Get(protocol.HeaderSyncID))
	DecodeJSON(t, resp, &preview)
	assert.NotContains(t, preview.HTML[0], "/issues/1")
	unittest.AssertNotExistsBean(t, &livesync_model.Idempotency{Key: "md"})
	// A repository the viewer may not read; too much.
	MakeRequest(t, livesyncAPI(t, "POST", "/markdown", user5, protocol.APIMarkdownRequest{RepoID: 2, Items: []string{"x"}}), http.StatusNotFound)
	MakeRequest(t, livesyncAPI(t, "POST", "/markdown", user2, protocol.APIMarkdownRequest{Items: make([]string, 65)}), http.StatusRequestEntityTooLarge)
	MakeRequest(t, livesyncAPI(t, "POST", "/markdown", user2, protocol.APIMarkdownRequest{Items: []string{strings.Repeat("x", 1<<20+1)}}), http.StatusRequestEntityTooLarge)
}

func livesyncAPIMarkup(t *testing.T, user2, user5 string) {
	// A file below the root: relative links and images resolve from its directory at the ref (as its classic page
	// does), root-relative ones from the repository's root.
	text := "[a](more.md) [b](../x.go) [r](/README.md) ![i](../logo.svg)"
	var out protocol.APIMarkupResponse
	DecodeJSON(t, MakeRequest(t, livesyncAPI(t, "POST", "/markup", user2, protocol.APIMarkupRequest{RepoID: 1, Ref: "branch/master", Path: "docs/guide.md", Text: text}), http.StatusOK), &out)
	assert.Contains(t, out.HTML, `href="/user2/repo1/src/branch/master/docs/more.md"`)
	assert.Contains(t, out.HTML, `href="/user2/repo1/src/branch/master/x.go"`)
	assert.Contains(t, out.HTML, `href="/user2/repo1/src/branch/master/README.md"`)
	assert.Contains(t, out.HTML, `src="/user2/repo1/media/branch/master/logo.svg"`)
	// The file read by the server at a commit (a README in one round trip); no such file (an answer); no such commit.
	repo1 := unittest.AssertExistsAndLoadBean(t, &repo_model.Repository{ID: 1})
	gitRepo, err := gitrepo.OpenRepository(t.Context(), repo1)
	require.NoError(t, err)
	head, err := gitRepo.GetBranchCommitID("master")
	require.NoError(t, err)
	commit, err := gitRepo.GetCommit(head)
	require.NoError(t, err)
	readme, err := commit.GetFileContent("README.md", 1024)
	gitRepo.Close()
	require.NoError(t, err)
	DecodeJSON(t, MakeRequest(t, livesyncAPI(t, "POST", "/markup", user2, protocol.APIMarkupRequest{RepoID: 1, Ref: "branch/master", Path: "README.md", Commit: head}), http.StatusOK), &out)
	assert.False(t, out.Missing)
	assert.Contains(t, out.HTML, strings.TrimSpace(strings.SplitN(strings.TrimLeft(readme, "# "), "\n", 2)[0]))
	DecodeJSON(t, MakeRequest(t, livesyncAPI(t, "POST", "/markup", user2, protocol.APIMarkupRequest{RepoID: 1, Ref: "branch/master", Path: "NOPE.md", Commit: head}), http.StatusOK), &out)
	assert.True(t, out.Missing)
	MakeRequest(t, livesyncAPI(t, "POST", "/markup", user2, protocol.APIMarkupRequest{RepoID: 1, Ref: "branch/master", Path: "README.md", Commit: "abc"}), http.StatusNotFound)
	// A private repository the viewer may not read; a malformed ref or path.
	MakeRequest(t, livesyncAPI(t, "POST", "/markup", user5, protocol.APIMarkupRequest{RepoID: 2, Ref: "branch/master", Path: "a.md", Text: "x"}), http.StatusNotFound)
	MakeRequest(t, livesyncAPI(t, "POST", "/markup", user2, protocol.APIMarkupRequest{RepoID: 1, Ref: "master", Path: "a.md", Text: "x"}), http.StatusBadRequest)
	MakeRequest(t, livesyncAPI(t, "POST", "/markup", user2, protocol.APIMarkupRequest{RepoID: 1, Ref: "branch/master", Path: "/a.md", Text: "x"}), http.StatusBadRequest)
}

func livesyncAPIIssueProject(t *testing.T, user2, user5 string) {
	// Issue 11 of user2/repo1 on the repository's project 1 (its default column), then in column 2, then off it.
	MakeRequest(t, livesyncAPI(t, "PUT", "/issues/11/project", user2, protocol.APIIssueProject{ProjectID: 1}), http.StatusNoContent)
	unittest.AssertExistsAndLoadBean(t, &project_model.ProjectIssue{ProjectID: 1, IssueID: 11})
	MakeRequest(t, livesyncAPI(t, "PUT", "/issues/11/project", user2, protocol.APIIssueProject{ProjectID: 1, ColumnID: 2}), http.StatusNoContent)
	unittest.AssertExistsAndLoadBean(t, &project_model.ProjectIssue{ProjectID: 1, IssueID: 11, ProjectColumnID: 2})
	MakeRequest(t, livesyncAPI(t, "PUT", "/issues/11/project", user2, protocol.APIIssueProject{}), http.StatusNoContent)
	unittest.AssertNotExistsBean(t, &project_model.ProjectIssue{IssueID: 11})
	// Another repository's project, a column of another project, a reader, nonsense.
	MakeRequest(t, livesyncAPI(t, "PUT", "/issues/11/project", user2, protocol.APIIssueProject{ProjectID: 2}), http.StatusNotFound)
	MakeRequest(t, livesyncAPI(t, "PUT", "/issues/11/project", user2, protocol.APIIssueProject{ProjectID: 1, ColumnID: 5}), http.StatusNotFound)
	MakeRequest(t, livesyncAPI(t, "PUT", "/issues/11/project", user5, protocol.APIIssueProject{ProjectID: 1}), http.StatusForbidden)
	MakeRequest(t, livesyncAPI(t, "PUT", "/issues/11/project", user2, protocol.APIIssueProject{ColumnID: 2}), http.StatusBadRequest)
	unittest.AssertNotExistsBean(t, &project_model.ProjectIssue{IssueID: 11})
}

func livesyncAPIResolve(t *testing.T, user2, user5 string) {
	// Code comment 5 on pull request 2 of user2/repo1: resolved by user2 (a writer), again (idempotent), then unresolved.
	for range 2 {
		MakeRequest(t, livesyncAPI(t, "PUT", "/comments/5/resolved", user2, protocol.APICommentResolved{Resolved: true}), http.StatusNoContent)
		unittest.AssertExistsAndLoadBean(t, &issues_model.Comment{ID: 5, ResolveDoerID: 2})
	}
	MakeRequest(t, livesyncAPI(t, "PUT", "/comments/5/resolved", user2, protocol.APICommentResolved{}), http.StatusNoContent)
	unittest.AssertExistsAndLoadBean(t, &issues_model.Comment{ID: 5, ResolveDoerID: 0})
	// Not the poster, a writer or an official reviewer; not a code comment; no such comment.
	MakeRequest(t, livesyncAPI(t, "PUT", "/comments/5/resolved", user5, protocol.APICommentResolved{Resolved: true}), http.StatusForbidden)
	MakeRequest(t, livesyncAPI(t, "PUT", "/comments/2/resolved", user2, protocol.APICommentResolved{Resolved: true}), http.StatusUnprocessableEntity)
	MakeRequest(t, livesyncAPI(t, "PUT", "/comments/99999/resolved", user2, protocol.APICommentResolved{Resolved: true}), http.StatusNotFound)
	unittest.AssertExistsAndLoadBean(t, &issues_model.Comment{ID: 5, ResolveDoerID: 0})
}

// livesyncTaskLog makes task's log the DBFS file name with lines, as the
// runner protocol (UpdateLog) writes it.
func livesyncTaskLog(t *testing.T, task *actions_model.ActionTask, lines ...string) {
	t.Helper()
	rows := make([]*runnerv1.LogRow, 0, len(lines))
	for _, l := range lines {
		rows = append(rows, &runnerv1.LogRow{Time: timestamppb.Now(), Content: l})
	}
	ns, err := actions_module.WriteLogs(t.Context(), task.LogFilename, task.LogSize, rows)
	require.NoError(t, err)
	task.LogLength += int64(len(rows))
	for _, n := range ns {
		task.LogIndexes = append(task.LogIndexes, task.LogSize)
		task.LogSize += int64(n)
	}
	_, err = db.GetEngine(t.Context()).ID(task.ID).Cols("log_filename", "log_in_storage", "log_length", "log_size", "log_indexes", "log_expired", "status").Update(task)
	require.NoError(t, err)
}

// TestLivesyncAPILogTail streams an Actions job's log over the sync
// session (log_tail): lines as the runner appends them, a re-run's task
// from the start, the end of a finished job, and the permission cases.
func TestLivesyncAPILogTail(t *testing.T) {
	livesyncSkipSQLite(t)
	livesyncServeWith(t, map[string]string{"LOG_TAIL_INTERVAL": "50ms"})
	onApplicationRun(t, func(t *testing.T, u *url.URL) {
		// In a subtest: its sessions are closed (cleanup) before the
		// server shuts down.
		t.Run("tail", func(t *testing.T) { livesyncLogTailScenario(t, u) })
	})
}

func livesyncLogTailScenario(t *testing.T, u *url.URL) {
	livesyncWaitBackfill(t)
	ctx := t.Context()
	// Job 192 of public repo4 (actions unit) with task 47: running,
	// its log in DBFS.
	job := unittest.AssertExistsAndLoadBean(t, &actions_model.ActionRunJob{ID: 192})
	task := unittest.AssertExistsAndLoadBean(t, &actions_model.ActionTask{ID: job.TaskID})
	task.LogFilename = fmt.Sprintf("livesync-test/%d-%d.log", task.ID, time.Now().UnixNano())
	task.LogInStorage, task.LogLength, task.LogSize, task.LogIndexes, task.LogExpired = false, 0, 0, nil, false
	task.Status = actions_model.StatusRunning
	livesyncTaskLog(t, task, "line 1", "line 2")
	job.Status = actions_model.StatusRunning
	_, err := db.GetEngine(ctx).ID(job.ID).Cols("status").Update(job)
	require.NoError(t, err)

	cl := livesyncDial(t, u, "ws")
	cl.send(livesyncHello(livesyncToken(t, &user_model.User{ID: 2})))
	cl.waitType(protocol.MsgWelcome)
	cl.send(&protocol.LogTailMessage{Type: protocol.MsgLogTail, JobID: job.ID})
	m := cl.waitType(protocol.MsgLog)
	assert.Equal(t, job.ID, m.JobID)
	assert.Equal(t, task.ID, m.TaskID)
	assert.EqualValues(t, 0, m.Offset)
	require.Len(t, m.Lines, 2)
	assert.Equal(t, "line 2", m.Lines[1].C)
	assert.Positive(t, m.Lines[0].T)
	assert.NotEmpty(t, m.Steps, "the job's steps (Set up job, …)")
	assert.False(t, m.Done)

	// The runner appends lines, then the job finishes.
	livesyncTaskLog(t, task, "line 3")
	m = cl.waitType(protocol.MsgLog)
	assert.EqualValues(t, 2, m.Offset)
	require.Len(t, m.Lines, 1)
	assert.Equal(t, "line 3", m.Lines[0].C)
	task.Status = actions_model.StatusSuccess
	livesyncTaskLog(t, task, "line 4")
	job.Status = actions_model.StatusSuccess
	_, err = db.GetEngine(ctx).ID(job.ID).Cols("status").Update(job)
	require.NoError(t, err)
	lines := []string{}
	for {
		m = cl.waitType(protocol.MsgLog)
		for _, l := range m.Lines {
			lines = append(lines, l.C)
		}
		if m.Done {
			break
		}
	}
	assert.Equal(t, []string{"line 4"}, lines)
	assert.EqualValues(t, 4, m.Offset+int64(len(m.Lines)))

	// A resume from an offset of the finished task.
	cl.send(&protocol.LogTailMessage{Type: protocol.MsgLogTail, JobID: job.ID, TaskID: task.ID, Offset: 3})
	m = cl.waitType(protocol.MsgLog)
	assert.EqualValues(t, 3, m.Offset)
	require.Len(t, m.Lines, 1)
	assert.Equal(t, "line 4", m.Lines[0].C)

	// Not readable: job 193 moved to private repo2 (no actions unit
	// there); a job that does not exist. Both "forbidden".
	_, err = db.GetEngine(ctx).Exec("UPDATE action_run_job SET repo_id = 2 WHERE id = 193")
	require.NoError(t, err)
	for _, id := range []int64{193, 999999} {
		cl.send(&protocol.LogTailMessage{Type: protocol.MsgLogTail, JobID: id})
		m = cl.waitType(protocol.MsgLogClosed)
		assert.Equal(t, id, m.JobID)
		assert.Equal(t, protocol.LogClosedForbidden, m.Reason)
	}
	// user5 may read public repo4's logs too (as the classic page).
	other := livesyncDial(t, u, "sse")
	other.send(livesyncHello(livesyncToken(t, &user_model.User{ID: 5})))
	other.waitType(protocol.MsgWelcome)
	other.send(&protocol.LogTailMessage{Type: protocol.MsgLogTail, JobID: job.ID})
	m = other.waitType(protocol.MsgLog)
	assert.Len(t, m.Lines, 4)

	// An expired log (removed by the cleanup): log{expired, done}, no
	// lines.
	_, err = db.GetEngine(ctx).Exec("UPDATE action_task SET log_expired = ? WHERE id = ?", true, task.ID)
	require.NoError(t, err)
	cl.send(&protocol.LogTailMessage{Type: protocol.MsgLogTail, JobID: job.ID})
	m = cl.waitType(protocol.MsgLog)
	assert.True(t, m.Expired)
	assert.True(t, m.Done)
	assert.Empty(t, m.Lines)
	assert.Equal(t, task.ID, m.TaskID)
}
