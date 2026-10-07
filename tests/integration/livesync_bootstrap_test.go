// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"forgejo.org/models/db"
	issues_model "forgejo.org/models/issues"
	repo_model "forgejo.org/models/repo"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/json"
	"forgejo.org/services/livesync/materialize"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/tests"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/gzip"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// livesyncSnapshot is a parsed bootstrap / load response.
type livesyncSnapshot struct {
	header  protocol.BootstrapHeader
	changes []protocol.Change
	end     *protocol.BootstrapEnd
}

// of returns the snapshot's entities of group by "Model id".
func (s *livesyncSnapshot) of(group string) map[string]protocol.Change {
	res := map[string]protocol.Change{}
	for _, ch := range s.changes {
		if ch.G == group {
			res[fmt.Sprintf("%s %d", ch.M, ch.ID)] = ch
		}
	}
	return res
}

// ids returns the ids of the snapshot's entities of group and model.
func (s *livesyncSnapshot) ids(group string, model protocol.Model, keep func(d map[string]any) bool) []int64 {
	var res []int64
	for _, ch := range s.changes {
		if ch.G == group && ch.M == model && (keep == nil || keep(ch.D.(map[string]any))) {
			res = append(res, ch.ID)
		}
	}
	return res
}

func livesyncParseSnapshot(t *testing.T, body io.Reader) *livesyncSnapshot {
	t.Helper()
	s := &livesyncSnapshot{}
	sc := bufio.NewScanner(body)
	sc.Buffer(nil, 64<<20)
	require.True(t, sc.Scan(), "header line")
	require.NoError(t, json.Unmarshal(sc.Bytes(), &s.header), "%s", sc.Bytes())
	require.Equal(t, "header", s.header.Type)
	for sc.Scan() {
		require.Nil(t, s.end, "a line after the end line")
		var probe struct {
			Type string `json:"type"`
		}
		require.NoError(t, json.Unmarshal(sc.Bytes(), &probe), "%s", sc.Bytes())
		if probe.Type == "end" {
			s.end = &protocol.BootstrapEnd{}
			require.NoError(t, json.Unmarshal(sc.Bytes(), s.end))
			continue
		}
		var ch protocol.Change
		require.NoError(t, json.Unmarshal(sc.Bytes(), &ch))
		require.Equal(t, s.header.Watermark, ch.V)
		require.Equal(t, protocol.OpUpsert, ch.Op)
		s.changes = append(s.changes, ch)
	}
	require.NoError(t, sc.Err())
	require.NotNil(t, s.end, "the end line")
	assert.Len(t, s.of(s.header.Group), s.end.Count)
	return s
}

// livesyncBootstrap GETs a bootstrap / load path (in-process) and parses
// it; a 503 (backfill not done) is retried.
func livesyncBootstrap(t *testing.T, token, path string) *livesyncSnapshot {
	t.Helper()
	deadline := time.Now().Add(livesyncWait)
	for {
		resp := MakeRequest(t, NewRequest(t, "GET", path).AddTokenAuth(token), NoExpectedStatus)
		if resp.Code == http.StatusServiceUnavailable && time.Now().Before(deadline) {
			time.Sleep(50 * time.Millisecond)
			continue
		}
		require.Equal(t, http.StatusOK, resp.Code, "%s: %s", path, resp.Body.String())
		assert.Equal(t, "application/x-ndjson; charset=utf-8", resp.Header().Get("Content-Type"))
		return livesyncParseSnapshot(t, resp.Body)
	}
}

// livesyncAPIIDs returns the "id" of every object of a paged API v1 list
// (nil if the request is not 200).
func livesyncAPIIDs(t *testing.T, token, path string) []int64 {
	t.Helper()
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	var res []int64
	for page := 1; ; page++ {
		resp := MakeRequest(t, NewRequest(t, "GET", fmt.Sprintf("%s%slimit=50&page=%d", path, sep, page)).AddTokenAuth(token), NoExpectedStatus)
		if resp.Code != http.StatusOK {
			return nil
		}
		var list []struct {
			ID int64 `json:"id"`
		}
		DecodeJSON(t, resp, &list)
		for _, o := range list {
			res = append(res, o.ID)
		}
		if len(list) < 50 {
			return res
		}
	}
}

// TestLivesyncBootstrapAPI covers the HTTP surface of the bootstrap, load
// and workspace endpoints: authentication, validation, 404 without an
// existence leak, the backfill gate (503 + Retry-After), the header
// (watermark, units = the grant's, tier), content encodings, the closed
// tier, the workspace.
func TestLivesyncBootstrapAPI(t *testing.T) {
	livesyncSkipSQLite(t)
	livesyncServe(t)
	onApplicationRun(t, func(t *testing.T, u *url.URL) {
		livesyncWaitBackfill(t)
		livesyncSettle(t)
		user2 := livesyncToken(t, &user_model.User{ID: 2})
		user5 := livesyncToken(t, &user_model.User{ID: 5})

		status := func(token, path string) (int, string) {
			req := NewRequest(t, "GET", path)
			if token != "" {
				req.AddTokenAuth(token)
			}
			resp := MakeRequest(t, req, NoExpectedStatus)
			return resp.Code, resp.Body.String()
		}
		code, _ := status("", "/-/sync/bootstrap?group=repo:1")
		assert.Equal(t, http.StatusUnauthorized, code)
		code, _ = status("", "/-/sync/workspace")
		assert.Equal(t, http.StatusUnauthorized, code)
		for path, want := range map[string]int{
			"/-/sync/bootstrap":                                  http.StatusBadRequest,
			"/-/sync/bootstrap?group=repo:1&model=Nope":          http.StatusBadRequest,
			"/-/sync/bootstrap?group=repo:1&closedBefore=1":      http.StatusBadRequest,
			"/-/sync/load?group=repo:1":                          http.StatusBadRequest,
			"/-/sync/load?group=user:2":                          http.StatusBadRequest,
			"/-/sync/load?group=repo:1&closedBefore=x":           http.StatusBadRequest,
			"/-/sync/load?group=repo:1&closedBefore=1&limit=0":   http.StatusBadRequest,
			"/-/sync/load?group=repo:1&closedBefore=1&limit=9e9": http.StatusBadRequest,
		} {
			code, _ := status(user2, path)
			assert.Equal(t, want, code, path)
		}
		// Not readable and not existing: the same 404.
		_, notFound := status(user5, "/-/sync/bootstrap?group=repo:999999")
		for _, group := range []string{"repo:2", "user:2", "issue:999999", "*", "!perm", "org:999999", "profile:31", "repo:0"} {
			code, body := status(user5, "/-/sync/bootstrap?group="+url.QueryEscape(group))
			assert.Equal(t, http.StatusNotFound, code, group)
			assert.Equal(t, notFound, body, group)
		}
		code, _ = status(user5, "/-/sync/load?group=repo:2&closedBefore=1")
		assert.Equal(t, http.StatusNotFound, code)

		// The backfill gate.
		livesyncExec(t, "UPDATE livesync_meta SET value = 'repair:0' WHERE name = ?", materialize.MetaBackfillPrefix+"label")
		resp := MakeRequest(t, NewRequest(t, "GET", "/-/sync/bootstrap?group=repo:1").AddTokenAuth(user2), http.StatusServiceUnavailable)
		assert.NotEmpty(t, resp.Header().Get("Retry-After"))
		assert.Contains(t, resp.Body.String(), "label")
		MakeRequest(t, NewRequest(t, "GET", "/-/sync/load?group=issue:1").AddTokenAuth(user2), http.StatusOK) // no labels there
		livesyncExec(t, "UPDATE livesync_meta SET value = 'done' WHERE name = ?", materialize.MetaBackfillPrefix+"label")

		// Header: watermark, units of the grant, tier.
		head := livesyncLogHead(t)
		s := livesyncBootstrap(t, user5, "/-/sync/bootstrap?group=repo:1")
		_, units := livesyncGrant(t, user5, "repo:1")
		assert.Equal(t, units, s.header.Units)
		assert.GreaterOrEqual(t, s.header.Watermark, head)
		assert.Equal(t, protocol.TierSummary, s.header.Tier)
		require.NotNil(t, s.header.ClosedBefore)
		assert.InDelta(t, time.Now().Add(-90*24*time.Hour).Unix(), *s.header.ClosedBefore, 60)
		assert.Contains(t, s.of("repo:1"), "Repository 1")
		assert.Contains(t, s.end.Refs, protocol.GroupProfilesPublic)
		// The fixtures' closed issues are older than 90 days: not in the
		// summary, but in the closed pages.
		closedIssue := s.ids("repo:1", protocol.ModelIssue, func(d map[string]any) bool { return d["state"] == "closed" })
		assert.Empty(t, closedIssue)
		page := livesyncBootstrap(t, user5, fmt.Sprintf("/-/sync/load?group=repo:1&closedBefore=%d&limit=1", *s.header.ClosedBefore))
		assert.Equal(t, protocol.TierClosed, page.header.Tier)
		assert.Len(t, page.ids("repo:1", protocol.ModelIssue, nil), 1)
		lazy := livesyncBootstrap(t, user5, "/-/sync/load?group=issue:1")
		assert.Equal(t, protocol.TierFull, lazy.header.Tier)
		assert.Contains(t, lazy.of("issue:1"), "IssueBody 1")
		assert.Contains(t, lazy.of("issue:1"), "Comment 2")
		filtered := livesyncBootstrap(t, user5, "/-/sync/bootstrap?group=repo:1&model=Label,Milestone")
		assert.Equal(t, []protocol.Model{protocol.ModelLabel, protocol.ModelMilestone}, filtered.header.Models)
		for k := range filtered.of("repo:1") {
			assert.True(t, strings.HasPrefix(k, "Label ") || strings.HasPrefix(k, "Milestone "), k)
		}

		// Content encodings over a real listener: the client gets what it
		// asked for and the same entities.
		for _, enc := range []string{"br", "gzip", ""} {
			req, err := http.NewRequest("GET", u.String()+"-/sync/bootstrap?group=repo:1", nil)
			require.NoError(t, err)
			req.Header.Set("Authorization", "Bearer "+user2)
			req.Header.Set("Accept-Encoding", enc)
			if enc == "" {
				req.Header.Set("Accept-Encoding", "identity")
			}
			resp, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			require.Equal(t, http.StatusOK, resp.StatusCode)
			assert.Equal(t, enc, resp.Header.Get("Content-Encoding"))
			assert.Empty(t, resp.Header.Get("Content-Length"), "streamed")
			assert.Equal(t, "no-store", resp.Header.Get("Cache-Control"))
			var body io.Reader = resp.Body
			switch enc {
			case "br":
				body = brotli.NewReader(resp.Body)
			case "gzip":
				body, err = gzip.NewReader(resp.Body)
				require.NoError(t, err)
			}
			got := livesyncParseSnapshot(t, body)
			resp.Body.Close()
			assert.Equal(t, livesyncKeys(s.of("repo:1")), livesyncKeys(got.of("repo:1")), enc)
		}

		// The workspace.
		var ws protocol.Workspace
		DecodeJSON(t, MakeRequest(t, NewRequest(t, "GET", "/-/sync/workspace").AddTokenAuth(user2), http.StatusOK), &ws)
		reasons := map[string]string{}
		for _, g := range ws.Groups {
			reasons[g.Group] = g.Reason
			code, gotUnits := livesyncGrant(t, user2, g.Group)
			assert.Equal(t, http.StatusOK, code, g.Group)
			assert.Equal(t, gotUnits, g.Units, g.Group)
		}
		assert.Equal(t, protocol.WorkspaceSelf, reasons["user:2"])
		assert.Equal(t, protocol.WorkspaceOwner, reasons["repo:1"])
		assert.Equal(t, protocol.WorkspaceMember, reasons["org:3"])
		assert.Equal(t, protocol.WorkspaceAccess, reasons["repo:3"])
		assert.Equal(t, 200, ws.MaxRepos)
	})
}

func livesyncKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

func livesyncExec(t *testing.T, query string, args ...any) {
	t.Helper()
	_, err := db.GetEngine(t.Context()).Exec(append([]any{query}, args...)...)
	require.NoError(t, err)
}

// TestLivesyncBootstrapDifferential (B6 acceptance): for every fixture user
// who may sign in, what a bootstrap returns is a subset of what API v1
// returns to that user, and a group the user may not read is a 404:
//
//   - repo:{id}: 404 ⇔ /-/sync/grants?group= 404 (⇔ API v1, B4); the
//     repository ⇔ GET /repos/{o}/{r}; issues and pull requests ⊆
//     /issues?state=all; labels ⊆ /labels; milestones ⊆
//     /milestones?state=all; releases ⊆ /releases (tags without a release
//     only for code readers, like /tags);
//   - issue:{id} (up to three issues per readable repository): the body ⇒
//     /issues/{n} is 200; comments of type "comment" ⊆ /issues/{n}/comments;
//     reviews ⊆ /pulls/{n}/reviews;
//   - org:{id}: teams ⊆ /orgs/{org}/teams, members ⊆ /orgs/{org}/members
//     (public_members for non-members), labels ⊆ /orgs/{org}/labels;
//   - user:{id} (own): stars ⊆ /user/starred;
//   - the profile directories: every profile ⇒ /users/{name} is 200.
func TestLivesyncBootstrapDifferential(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncServeWith(t, map[string]string{"SUMMARY_RECENCY": "438000h"}) // 50 years: the whole summary
	livesyncWaitBackfill(t)
	ctx := t.Context()

	var users []*user_model.User
	require.NoError(t, db.GetEngine(ctx).OrderBy("id").Find(&users))
	var repos []*repo_model.Repository
	require.NoError(t, db.GetEngine(ctx).OrderBy("id").Find(&repos))
	issueIndex := map[int64]*issues_model.Issue{}
	var issues []*issues_model.Issue
	require.NoError(t, db.GetEngine(ctx).Find(&issues))
	for _, is := range issues {
		issueIndex[is.ID] = is
	}
	repoByID := map[int64]*repo_model.Repository{}
	for _, r := range repos {
		repoByID[r.ID] = r
	}
	userByID := map[int64]*user_model.User{}
	for _, u := range users {
		userByID[u.ID] = u
	}
	subset := func(what string, got, api []int64) {
		t.Helper()
		for _, id := range got {
			assert.Contains(t, api, id, "%s: %d is not in API v1's answer %v", what, id, api)
		}
	}

	compared := 0
	profiles := 0
	for _, viewer := range users {
		if viewer.IsOrganization() || !viewer.IsActive || viewer.ProhibitLogin {
			continue
		}
		token := livesyncToken(t, viewer)
		for _, repo := range repos {
			group := protocol.RepoGroup(repo.ID)
			grant, _ := livesyncGrant(t, token, group)
			path := "/-/sync/bootstrap?group=" + group
			if grant != http.StatusOK {
				assert.Equal(t, http.StatusNotFound, livesyncStatus(t, token, path), "viewer %d %s", viewer.ID, group)
				continue
			}
			base := fmt.Sprintf("/api/v1/repos/%s/%s", repo.OwnerName, repo.Name)
			s := livesyncBootstrap(t, token, path)
			if _, ok := s.of(group)[fmt.Sprintf("Repository %d", repo.ID)]; ok {
				assert.Equal(t, http.StatusOK, livesyncStatus(t, token, base))
			}
			what := fmt.Sprintf("viewer %d %s", viewer.ID, group)
			subset(what+" issues", s.ids(group, protocol.ModelIssue, nil), livesyncAPIIDs(t, token, base+"/issues?state=all"))
			subset(what+" labels", s.ids(group, protocol.ModelLabel, nil), livesyncAPIIDs(t, token, base+"/labels"))
			subset(what+" milestones", s.ids(group, protocol.ModelMilestone, nil), livesyncAPIIDs(t, token, base+"/milestones?state=all"))
			isTag := func(d map[string]any) bool { return d["is_tag"] == true }
			subset(what+" releases", s.ids(group, protocol.ModelRelease, func(d map[string]any) bool { return !isTag(d) }), livesyncAPIIDs(t, token, base+"/releases"))
			if len(s.ids(group, protocol.ModelRelease, isTag)) > 0 {
				// A tag without a release: API v1 serves tags to code readers.
				assert.Contains(t, s.header.Units, protocol.UnitCode, what+" tags")
			}
			compared++

			for i, id := range s.ids(group, protocol.ModelIssue, nil) {
				if i == 3 {
					break
				}
				is := issueIndex[id]
				require.NotNil(t, is)
				lazy := livesyncBootstrap(t, token, fmt.Sprintf("/-/sync/load?group=issue:%d", id))
				ig := protocol.IssueGroup(id)
				what := fmt.Sprintf("viewer %d %s", viewer.ID, ig)
				if _, ok := lazy.of(ig)[fmt.Sprintf("IssueBody %d", id)]; ok {
					assert.Equal(t, http.StatusOK, livesyncStatus(t, token, fmt.Sprintf("%s/issues/%d", base, is.Index)), what)
				}
				comments := lazy.ids(ig, protocol.ModelComment, func(d map[string]any) bool { return d["type"] == "comment" })
				subset(what+" comments", comments, livesyncAPIIDs(t, token, fmt.Sprintf("%s/issues/%d/comments", base, is.Index)))
				if is.IsPull {
					subset(what+" reviews", lazy.ids(ig, protocol.ModelReview, nil), livesyncAPIIDs(t, token, fmt.Sprintf("%s/pulls/%d/reviews", base, is.Index)))
				}
			}
		}

		for _, org := range users {
			if !org.IsOrganization() {
				continue
			}
			group := protocol.OrgGroup(org.ID)
			grant, units := livesyncGrant(t, token, group)
			if grant != http.StatusOK {
				assert.Equal(t, http.StatusNotFound, livesyncStatus(t, token, "/-/sync/bootstrap?group="+group))
				continue
			}
			s := livesyncBootstrap(t, token, "/-/sync/bootstrap?group="+group)
			what := fmt.Sprintf("viewer %d %s", viewer.ID, group)
			base := "/api/v1/orgs/" + org.Name
			subset(what+" teams", s.ids(group, protocol.ModelTeam, nil), livesyncAPIIDs(t, token, base+"/teams"))
			subset(what+" labels", s.ids(group, protocol.ModelLabel, nil), livesyncAPIIDs(t, token, base+"/labels"))
			members := base + "/public_members"
			if slices.Contains(units, protocol.UnitMembers) {
				members = base + "/members"
			}
			apiMembers := livesyncAPIIDs(t, token, members)
			for _, ch := range s.of(group) {
				if ch.M == protocol.ModelOrgUser {
					uid := int64(ch.D.(map[string]any)["user_id"].(float64))
					if !userByID[uid].IsActive {
						continue // API v1 lists active members only
					}
					assert.Contains(t, apiMembers, uid, "%s member %d", what, uid)
				}
			}
			compared++
		}

		own := livesyncBootstrap(t, token, "/-/sync/bootstrap?group="+protocol.UserGroup(viewer.ID))
		var starred []int64
		for _, ch := range own.of(protocol.UserGroup(viewer.ID)) {
			if ch.M == protocol.ModelStar {
				starred = append(starred, int64(ch.D.(map[string]any)["repo_id"].(float64)))
			}
		}
		subset(fmt.Sprintf("viewer %d stars", viewer.ID), starred, livesyncAPIIDs(t, token, "/api/v1/user/starred"))

		if profiles < 4 { // every directory entry checked for a few viewers
			profiles++
			for _, dir := range []string{protocol.GroupProfilesPublic, protocol.GroupProfilesLimited} {
				if code, _ := livesyncGrant(t, token, dir); code != http.StatusOK {
					continue
				}
				for _, ch := range livesyncBootstrap(t, token, "/-/sync/bootstrap?group="+dir).of(dir) {
					login := ch.D.(map[string]any)["login"].(string)
					assert.Equal(t, http.StatusOK, livesyncStatus(t, token, "/api/v1/users/"+login), "viewer %d %s %s", viewer.ID, dir, login)
				}
			}
		}
	}
	assert.Greater(t, compared, 100, "readable groups compared")
}

// livesyncHTTP does an API v1 request as token over the real listener (safe
// in goroutines: it never calls t.FailNow) and decodes the JSON answer into
// out (if not nil). It returns the status, 0 on a transport error.
func livesyncHTTP(t *testing.T, u *url.URL, token, method, path string, body, out any) int {
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Errorf("encode %s %s: %v", method, path, err)
			return 0
		}
		r = strings.NewReader(string(b))
	}
	req, err := http.NewRequest(method, u.String()+strings.TrimPrefix(path, "/"), r)
	if err != nil {
		t.Errorf("%s %s: %v", method, path, err)
		return 0
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Errorf("%s %s: %v", method, path, err)
		return 0
	}
	defer resp.Body.Close()
	if out != nil && resp.StatusCode < 300 {
		assert.NoError(t, json.NewDecoder(resp.Body).Decode(out))
	}
	return resp.StatusCode
}

// livesyncReplica is a client's copy of one group: a bootstrap, then the
// deltas since its watermark, applied by version (an entity is replaced
// only by a newer v, a delete with a newer v removes it).
type livesyncReplica struct {
	group    string
	versions map[string]int64
	present  map[string]any
}

func newLivesyncReplica(s *livesyncSnapshot) *livesyncReplica {
	r := &livesyncReplica{group: s.header.Group, versions: map[string]int64{}, present: map[string]any{}}
	for k, ch := range s.of(s.header.Group) {
		r.versions[k], r.present[k] = ch.V, ch.D
	}
	return r
}

func (r *livesyncReplica) apply(ch protocol.Change) {
	if ch.G != r.group {
		return
	}
	k := fmt.Sprintf("%s %d", ch.M, ch.ID)
	if ch.V <= r.versions[k] {
		return
	}
	r.versions[k] = ch.V
	if ch.Op == protocol.OpDelete {
		delete(r.present, k)
	} else {
		r.present[k] = ch.D
	}
}

// TestLivesyncBootstrapConvergence (B6 acceptance): a bootstrap taken while
// writers change the group, plus the deltas after its watermark, equals a
// fresh bootstrap taken once the writes are done — for a repository's
// summary (issues created, closed, labelled, labels created and deleted)
// and an issue's lazy tier (comments created, edited, deleted; the body
// edited), with bootstraps taken at several moments.
func TestLivesyncBootstrapConvergence(t *testing.T) {
	livesyncSkipSQLite(t)
	livesyncServeWith(t, map[string]string{"SUMMARY_RECENCY": "438000h"}) // the whole summary
	onApplicationRun(t, func(t *testing.T, u *url.URL) {
		livesyncWaitBackfill(t)
		livesyncSettle(t)
		token := livesyncToken(t, &user_model.User{ID: 2})
		const repo = "/api/v1/repos/user2/repo1"

		stop := make(chan struct{})
		var wg sync.WaitGroup
		writes := atomic.Int64{}
		// Each writer has its own kinds of writes: upstream deadlocks on
		// MySQL when two comments are created on one issue concurrently
		// (CreateComment's num_comments subquery), with or without
		// livesync.
		ops := [][]int{{1, 2, 3, 4, 8}, {0, 7, 0}, {0, 5, 6, 6, 9}}
		for w := range 3 {
			wg.Go(func() {
				var comments, labels, issues []int64
				for i := 0; ; i++ {
					select {
					case <-stop:
						return
					default:
					}
					var obj struct {
						ID     int64 `json:"id"`
						Number int64 `json:"number"`
					}
					op := ops[w][i%len(ops[w])]
					if w == 2 && op == 0 && len(issues) > 0 {
						continue // writer 2 labels one issue of its own
					}
					switch op {
					case 0:
						if livesyncHTTP(t, u, token, "POST", repo+"/issues", map[string]any{"title": fmt.Sprintf("conv %d-%d", w, i), "body": "*b*"}, &obj) == http.StatusCreated {
							issues = append(issues, obj.Number)
						}
					case 1, 2:
						if livesyncHTTP(t, u, token, "POST", repo+"/issues/1/comments", map[string]any{"body": fmt.Sprintf("comment %d-%d", w, i)}, &obj) == http.StatusCreated {
							comments = append(comments, obj.ID)
						}
					case 3:
						if len(comments) > 0 {
							livesyncHTTP(t, u, token, "PATCH", fmt.Sprintf("%s/issues/comments/%d", repo, comments[len(comments)-1]), map[string]any{"body": fmt.Sprintf("edited %d", i)}, nil)
						}
					case 4:
						if len(comments) > 1 {
							livesyncHTTP(t, u, token, "DELETE", fmt.Sprintf("%s/issues/comments/%d", repo, comments[0]), nil, nil)
							comments = comments[1:]
						}
					case 5:
						if livesyncHTTP(t, u, token, "POST", repo+"/labels", map[string]any{"name": fmt.Sprintf("conv-%d-%d", w, i), "color": "#aabbcc"}, &obj) == http.StatusCreated {
							labels = append(labels, obj.ID)
						}
					case 6:
						if len(labels) > 0 && len(issues) > 0 {
							livesyncHTTP(t, u, token, "POST", fmt.Sprintf("%s/issues/%d/labels", repo, issues[len(issues)-1]), map[string]any{"labels": []int64{labels[len(labels)-1]}}, nil)
						}
					case 7:
						if len(issues) > 0 {
							livesyncHTTP(t, u, token, "PATCH", fmt.Sprintf("%s/issues/%d", repo, issues[0]), map[string]any{"state": []string{"closed", "open"}[i%2]}, nil)
						}
					case 8:
						livesyncHTTP(t, u, token, "PATCH", repo+"/issues/1", map[string]any{"body": fmt.Sprintf("body **%d-%d**", w, i)}, nil)
					case 9:
						if len(labels) > 2 {
							livesyncHTTP(t, u, token, "DELETE", fmt.Sprintf("%s/labels/%d", repo, labels[0]), nil, nil)
							labels = labels[1:]
						}
					}
					writes.Add(1)
				}
			})
		}

		type client struct {
			replica *livesyncReplica
			cl      *livesyncSyncClient
		}
		var clients []client
		for round := range 3 {
			time.Sleep(time.Duration(150+100*round) * time.Millisecond)
			for _, group := range []string{"repo:1", "issue:1"} {
				path := "/-/sync/bootstrap?group=" + group
				if group == "issue:1" {
					path = "/-/sync/load?group=" + group
				}
				s := livesyncBootstrap(t, token, path)
				cl := livesyncDial(t, u, "ws")
				cl.send(livesyncHello(token, protocol.GroupRequest{Group: group, Since: livesyncSince(s.header.Watermark)}))
				welcome := cl.waitType(protocol.MsgWelcome)
				require.Len(t, welcome.Granted, 1)
				assert.Equal(t, s.header.Units, welcome.Granted[0].Units, "the bootstrap's units are the grant's")
				clients = append(clients, client{newLivesyncReplica(s), cl})
			}
		}
		close(stop)
		wg.Wait()
		require.Greater(t, writes.Load(), int64(30), "concurrent writes")
		livesyncSettle(t)

		for i, c := range clients {
			c.cl.send(&protocol.BarrierMessage{Type: protocol.MsgBarrier, ID: "done"})
			c.cl.waitFor("barrier_ok", func(m *livesyncMsg) bool {
				assert.NotEqual(t, protocol.MsgBootstrapRequired, m.Type)
				assert.NotEqual(t, protocol.MsgGroupRevoked, m.Type)
				for _, ch := range m.Changes {
					c.replica.apply(ch)
				}
				return m.Type == protocol.MsgBarrierOK
			})
			path := "/-/sync/bootstrap?group=" + c.replica.group
			fresh := livesyncBootstrap(t, token, path)
			want := map[string]any{}
			for k, ch := range fresh.of(c.replica.group) {
				want[k] = ch.D
			}
			assert.Equal(t, livesyncKeys(want), livesyncKeys(c.replica.present), "client %d (%s): entities", i, c.replica.group)
			for k, d := range want {
				assert.Equal(t, d, c.replica.present[k], "client %d (%s): %s", i, c.replica.group, k)
			}
		}
	})
}

// TestLivesyncBootstrapLarge (B6 acceptance): a large group streams with
// bounded memory: the server's live heap, sampled (after a GC) while the
// client reads a bootstrap of ≈ 38 MB (60 000 issues), grows by a fraction
// of the response (≈ 3.5 MB measured).
func TestLivesyncBootstrapLarge(t *testing.T) {
	livesyncSkipSQLite(t)
	livesyncServe(t)
	onApplicationRun(t, func(t *testing.T, u *url.URL) {
		livesyncWaitBackfill(t)
		livesyncSettle(t)
		n := 60000
		if s := os.Getenv("LIVESYNC_BOOTSTRAP_LARGE"); s != "" {
			var err error
			n, err = strconv.Atoi(s)
			require.NoError(t, err)
		}
		title := strings.Repeat("a long title for a large bootstrap ", 7) // ≤ 255 characters
		start := time.Now()
		for done := 0; done < n; done += 500 {
			batch := make([]*issues_model.Issue, 0, 500)
			for i := done; i < min(done+500, n); i++ {
				batch = append(batch, &issues_model.Issue{RepoID: 1, Index: int64(100000 + i), PosterID: 2, Title: fmt.Sprintf("%d %s", i, title), Content: "x"})
			}
			_, err := db.GetEngine(t.Context()).Insert(&batch)
			require.NoError(t, err)
		}
		assert.Eventually(t, func() bool { return len(livesyncOutbox(t)) == 0 }, 5*time.Minute, 100*time.Millisecond, "materialized")
		t.Logf("%d issues inserted and materialized in %s", n, time.Since(start))

		token := livesyncToken(t, &user_model.User{ID: 2})
		req, err := http.NewRequest("GET", u.String()+"-/sync/bootstrap?group=repo:1", nil)
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Accept-Encoding", "identity")
		var ms runtime.MemStats
		runtime.GC()
		runtime.ReadMemStats(&ms)
		base := ms.HeapAlloc
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode)
		br := bufio.NewReaderSize(resp.Body, 1<<20)
		var peak uint64
		total, lines, issues := 0, 0, 0
		var last []byte
		for {
			line, err := br.ReadSlice('\n')
			if err == io.EOF {
				break
			}
			require.NoError(t, err)
			total += len(line)
			lines++
			if bytes.Contains(line, []byte(`"m":"Issue"`)) {
				issues++
			}
			last = append(last[:0], line...)
			if lines%2000 == 0 {
				runtime.GC()
				runtime.ReadMemStats(&ms)
				peak = max(peak, ms.HeapAlloc)
			}
		}
		var end protocol.BootstrapEnd
		require.NoError(t, json.Unmarshal(last, &end))
		assert.Equal(t, "end", end.Type)
		assert.GreaterOrEqual(t, issues, n)
		growth := int64(peak) - int64(base)
		t.Logf("response %d bytes, %d lines; live heap %d before, peak growth %d bytes while streaming", total, lines, base, growth)
		assert.Greater(t, total, 32<<20, "a large response")
		// A buffered response would need more than the response itself;
		// the bound leaves room for the rest of the server (materializer,
		// queues) allocating meanwhile in this process (≈ 3–9 MB seen).
		assert.Less(t, growth, int64(total/2), "memory is bounded by a chunk, not the response")
	})
}
