// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"maps"
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
	project_model "forgejo.org/models/project"
	repo_model "forgejo.org/models/repo"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/json"
	"forgejo.org/modules/log"
	project_module "forgejo.org/modules/project"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/test"
	"forgejo.org/modules/translation"
	"forgejo.org/services/livesync/materialize"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/tests"

	"github.com/PuerkitoBio/goquery"
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

// objs returns the payloads of the snapshot's entities of group and model.
func (s *livesyncSnapshot) objs(group string, model protocol.Model) []map[string]any {
	var res []map[string]any
	for _, ch := range s.changes {
		if ch.G == group && ch.M == model {
			res = append(res, ch.D.(map[string]any))
		}
	}
	return res
}

// livesyncNum reads an integer field of a decoded JSON object.
func livesyncNum(d map[string]any, field string) int64 {
	v, _ := d[field].(float64)
	return int64(v)
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

// livesyncAPIObjects returns every object of a paged API v1 list (nil if
// the request is not 200).
func livesyncAPIObjects(t *testing.T, token, path string) []map[string]any {
	t.Helper()
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	res := []map[string]any{}
	for page := 1; ; page++ {
		resp := MakeRequest(t, NewRequest(t, "GET", fmt.Sprintf("%s%slimit=50&page=%d", path, sep, page)).AddTokenAuth(token), NoExpectedStatus)
		if resp.Code != http.StatusOK {
			return nil
		}
		var list []map[string]any
		DecodeJSON(t, resp, &list)
		res = append(res, list...)
		if len(list) < 50 {
			return res
		}
	}
}

// livesyncAPIIDs returns the "id" of every object of a paged API v1 list
// (nil if the request is not 200).
func livesyncAPIIDs(t *testing.T, token, path string) []int64 {
	t.Helper()
	list := livesyncAPIObjects(t, token, path)
	if list == nil {
		return nil
	}
	res := []int64{}
	for _, o := range list {
		res = append(res, livesyncNum(o, "id"))
	}
	return res
}

// livesyncAPIObject GETs one API v1 object (nil if not 200).
func livesyncAPIObject(t *testing.T, token, path string) map[string]any {
	t.Helper()
	resp := MakeRequest(t, NewRequest(t, "GET", path).AddTokenAuth(token), NoExpectedStatus)
	if resp.Code != http.StatusOK {
		return nil
	}
	var o map[string]any
	DecodeJSON(t, resp, &o)
	return o
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
		assert.Equal(t, strconv.FormatInt(*s.header.ClosedBefore, 10), page.header.Before)
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
// returns to that user, and a group the user may not read is a 404. Every
// model a bootstrap serves is compared:
//
//   - repo:{id}: 404 ⇔ /-/sync/grants?group= 404 (⇔ API v1, B4); the
//     repository ⇔ GET /repos/{o}/{r}; its units ⊆ its has_* flags;
//     collaborations ⊆ /collaborators; issues and pull requests ⊆
//     /issues?state=all, their labels and assignees ⊆ the issue's; pull
//     requests ⇒ their issue's JSON has a pull_request; labels ⊆ /labels; milestones ⊆
//     /milestones?state=all; releases ⊆ /releases (tags without a release
//     only for code readers, like /tags) and their attachments ⊆ the
//     release's assets; branches ⇒ /branches/{name} (deleted branches: see
//     below); commit statuses ⊆ /statuses/{sha}; action runs and jobs ⇒
//     /actions/runs/{id}, /actions/jobs/{id};
//   - issue:{id} (up to three issues per readable repository): the body ⇒
//     /issues/{n} is 200; comments ⊆ /issues/{n}/timeline (which applies
//     upstream's cross-reference filter), code comments ⊆ their review's
//     comments; reviews ⊆ /pulls/{n}/reviews; reactions ⊆ the issue's or
//     comment's reactions (user, content); attachments ⊆ its assets;
//     dependencies ⊆ /issues/{n}/dependencies;
//   - org:{id}: teams ⊆ /orgs/{org}/teams, members ⊆ /orgs/{org}/members
//     (public_members for non-members);
//   - owner:{id}: 404 unless the owner is visible (/orgs/{org} or
//     /users/{name} 200) or the viewer reads the issues or pull requests of
//     one of its repositories (the label page of such a repository lists
//     the organization's labels); an organization's labels ⊆
//     /orgs/{org}/labels when it is visible; and every organization label
//     and owner project that a repository's IssueLabel / ProjectIssue
//     names is in the owner group, which the repository's end.refs lists
//     (B6 review round 2: also for user4, an outside collaborator of
//     privated_org's repository 40, who may not see privated_org). The
//     owner group holds exactly what upstream shows such a reader (B6
//     follow-up): a ProjectRef (id, owner_id, title, closed, type) per
//     project and never a Project; labels without counts or updated_at. For
//     an owner the viewer may not see, the ProjectRefs (titles, open/closed)
//     = the owner projects of the repository's issue list filter and the
//     labels = the organization labels of its label page (web UI, as the
//     viewer), and each project's page /{owner}/-/projects/{id} is a 404;
//   - user:{id} (own): stars ⊆ /user/starred, tracked times ⊆ /user/times,
//     notifications ⊆ /notifications?all=true;
//   - the profile directories: every profile ⇒ /users/{name} is 200; every
//     embedded profile line of another group ⇒ /users/{name} or
//     /orgs/{name} is 200.
//
// Exceptions (no API v1 to compare with, or upstream's web UI serves more):
// projects, project columns and content history revisions (no API v1;
// checked against the unit the web UI requires: projects, the issue's);
// deleted branches (the web UI's branch list shows them to code readers,
// API v1's does not; checked against the code unit); code comments without
// a review (old data: only the web UI's files view lists them; checked
// against the pulls unit).
func TestLivesyncBootstrapDifferential(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncServeWith(t, map[string]string{"SUMMARY_RECENCY": "438000h"}) // 50 years: the whole summary
	livesyncWaitBackfill(t)
	ctx := t.Context()

	// Rows of the models the fixtures lack: revisions of an issue body and
	// of a comment, and dependencies of issue 1 (user2/repo1, public) on
	// pull request 2 (same repository) and on issue 4 (user2/repo2,
	// private).
	owner := livesyncToken(t, &user_model.User{ID: 2})
	const repo1 = "/api/v1/repos/user2/repo1"
	MakeRequest(t, NewRequestWithJSON(t, "PATCH", repo1, map[string]any{"internal_tracker": map[string]any{
		"enable_time_tracker": true, "allow_only_contributors_to_track_time": true, "enable_issue_dependencies": true,
	}}).AddTokenAuth(owner), http.StatusOK)
	MakeRequest(t, NewRequestWithJSON(t, "PATCH", repo1+"/issues/1", map[string]any{"body": "edited by the differential test"}).AddTokenAuth(owner), http.StatusCreated)
	MakeRequest(t, NewRequestWithJSON(t, "PATCH", repo1+"/issues/comments/2", map[string]any{"body": "edited too"}).AddTokenAuth(livesyncToken(t, &user_model.User{ID: 3})), NoExpectedStatus)
	for _, dep := range []map[string]any{{"owner": "user2", "repo": "repo1", "index": 2}, {"owner": "user2", "repo": "repo2", "index": 1}} {
		MakeRequest(t, NewRequestWithJSON(t, "POST", repo1+"/issues/1/dependencies", dep).AddTokenAuth(owner), http.StatusCreated)
	}
	// An organization label and an organization project on an issue of
	// privated_org's public repository 40, whose outside collaborator
	// user4 may not see privated_org (B6 review round 2).
	admin := livesyncToken(t, &user_model.User{ID: 1})
	const repo40 = "/api/v1/repos/privated_org/public_repo_on_private_org"
	var orgLabel, contract map[string]any
	DecodeJSON(t, MakeRequest(t, NewRequestWithJSON(t, "POST", "/api/v1/orgs/privated_org/labels", map[string]any{"name": "contract", "color": "#ee0701"}).AddTokenAuth(admin), http.StatusCreated), &orgLabel)
	DecodeJSON(t, MakeRequest(t, NewRequestWithJSON(t, "POST", repo40+"/issues", map[string]any{"title": "contract work"}).AddTokenAuth(admin), http.StatusCreated), &contract)
	MakeRequest(t, NewRequestWithJSON(t, "POST", fmt.Sprintf("%s/issues/%d/labels", repo40, livesyncNum(contract, "number")), map[string]any{"labels": []int64{livesyncNum(orgLabel, "id")}}).AddTokenAuth(admin), http.StatusOK)
	orgProject := &project_model.Project{Title: "roadmap", OwnerID: 23, Type: project_module.TypeOrganization, CreatorID: 1, TemplateType: project_module.TemplateTypeNone}
	require.NoError(t, db.Insert(ctx, orgProject))
	orgColumn := &project_model.Column{ProjectID: orgProject.ID, Title: "todo", CreatorID: 1}
	require.NoError(t, db.Insert(ctx, orgColumn))
	require.NoError(t, db.Insert(ctx, &project_model.ProjectIssue{IssueID: livesyncNum(contract, "id"), ProjectID: orgProject.ID, ProjectColumnID: orgColumn.ID}))
	livesyncSettle(t)
	var allLabels []*issues_model.Label
	require.NoError(t, db.GetEngine(ctx).Find(&allLabels))
	labelOrg := map[int64]int64{}
	for _, l := range allLabels {
		labelOrg[l.ID] = l.OrgID
	}
	var allProjects []*project_model.Project
	require.NoError(t, db.GetEngine(ctx).Find(&allProjects))
	projectRepo, projectOwner := map[int64]int64{}, map[int64]int64{}
	for _, p := range allProjects {
		projectRepo[p.ID], projectOwner[p.ID] = p.RepoID, p.OwnerID
	}

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
	ids := func(objs []map[string]any, field string) []int64 {
		var res []int64
		for _, o := range objs {
			res = append(res, livesyncNum(o, field))
		}
		return res
	}
	// compared counts the entities compared per model.
	compared := map[protocol.Model]int{}
	count := func(s *livesyncSnapshot) {
		for _, ch := range s.changes {
			compared[ch.M]++
		}
	}
	// embedded checks the profile lines of other groups.
	embedded := func(what, token string, s *livesyncSnapshot) {
		t.Helper()
		for _, ch := range s.changes {
			if ch.G == s.header.Group {
				continue
			}
			require.Equal(t, protocol.ModelUser, ch.M, "%s: only profiles of other groups", what)
			login := ch.D.(map[string]any)["login"].(string)
			path := "/api/v1/users/" + login
			if strings.HasPrefix(ch.G, protocol.GroupPrefixOrg+":") {
				path = "/api/v1/orgs/" + login
			}
			assert.Equal(t, http.StatusOK, livesyncStatus(t, token, path), "%s: embedded %s %s", what, ch.G, login)
		}
	}
	hasFlag := map[string]string{
		"issues": "has_issues", "ext_issues": "has_issues", "wiki": "has_wiki", "ext_wiki": "has_wiki",
		"pulls": "has_pull_requests", "projects": "has_projects", "releases": "has_releases",
		"packages": "has_packages", "actions": "has_actions",
	}

	groups := 0
	profiles := 0
	hiddenOwnerRefs, hiddenOwnerProjects := 0, 0
	// webSession signs a viewer in to the web UI (once).
	sessions := map[int64]*TestSession{}
	webSession := func(u *user_model.User) *TestSession {
		if sessions[u.ID] == nil {
			sessions[u.ID] = loginUser(t, u.Name)
		}
		return sessions[u.ID]
	}
	for _, viewer := range users {
		if viewer.IsOrganization() || !viewer.IsActive || viewer.ProhibitLogin {
			continue
		}
		token := livesyncToken(t, viewer)
		// issueReader: the owners of the repositories whose issues or
		// pull requests the viewer reads; ownerSnaps: the owner groups
		// bootstrapped.
		issueReader := map[int64]bool{}
		// issueList: per owner, the issue (or pull request) list of one
		// of those repositories, as upstream's web UI links it.
		issueList := map[int64]string{}
		ownerSnaps := map[string]*livesyncSnapshot{}
		ownerSnap := func(group string) *livesyncSnapshot {
			if ownerSnaps[group] == nil {
				ownerSnaps[group] = livesyncBootstrap(t, token, "/-/sync/bootstrap?group="+group)
			}
			return ownerSnaps[group]
		}
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
			what := fmt.Sprintf("viewer %d %s", viewer.ID, group)
			count(s)
			embedded(what, token, s)
			if _, ok := s.of(group)[fmt.Sprintf("Repository %d", repo.ID)]; ok {
				apiRepo := livesyncAPIObject(t, token, base)
				require.NotNil(t, apiRepo, what)
				for _, u := range s.objs(group, protocol.ModelRepoUnit) {
					if flag := hasFlag[u["type"].(string)]; flag != "" {
						assert.Equal(t, true, apiRepo[flag], "%s unit %s ⇒ %s", what, u["type"], flag)
					}
				}
			}
			if c := s.objs(group, protocol.ModelCollaboration); len(c) > 0 {
				subset(what+" collaborators", ids(c, "user_id"), livesyncAPIIDs(t, token, base+"/collaborators"))
			}
			apiIssues := map[int64]map[string]any{}
			for _, o := range livesyncAPIObjects(t, token, base+"/issues?state=all") {
				apiIssues[livesyncNum(o, "id")] = o
			}
			for _, id := range s.ids(group, protocol.ModelIssue, nil) {
				assert.Contains(t, apiIssues, id, "%s issue %d", what, id)
			}
			related := func(issueID int64, field string) []int64 {
				var res []int64
				if o := apiIssues[issueID]; o != nil {
					list, _ := o[field].([]any)
					for _, x := range list {
						res = append(res, livesyncNum(x.(map[string]any), "id"))
					}
				}
				return res
			}
			for _, il := range s.objs(group, protocol.ModelIssueLabel) {
				assert.Contains(t, related(livesyncNum(il, "issue_id"), "labels"), livesyncNum(il, "label_id"), "%s issue label %v", what, il)
			}
			for _, ia := range s.objs(group, protocol.ModelIssueAssignee) {
				assert.Contains(t, related(livesyncNum(ia, "issue_id"), "assignees"), livesyncNum(ia, "assignee_id"), "%s issue assignee %v", what, ia)
			}
			// What the issues name in the owner's group: organization
			// labels and owner projects, reachable through end.refs.
			// Upstream only attaches the repository owner's (NewIssueLabel,
			// Project.CanBeAccessedByOwnerRepo); a few fixture rows name
			// another owner's (label 4 of org3 on user2/repo1's issue 1,
			// user2's project 4 on org3's repository 32): left out.
			if slices.Contains(s.header.Units, protocol.UnitIssues) || slices.Contains(s.header.Units, protocol.UnitPulls) {
				issueReader[repo.OwnerID] = true
				list := "/pulls"
				if slices.Contains(s.header.Units, protocol.UnitIssues) {
					list = "/issues"
				}
				if cur := issueList[repo.OwnerID]; cur == "" || (list == "/issues" && !strings.HasSuffix(cur, list)) {
					issueList[repo.OwnerID] = "/" + repo.OwnerName + "/" + repo.Name + list
				}
			}
			var ownerLabels, ownerProjects []int64
			for _, il := range s.objs(group, protocol.ModelIssueLabel) {
				if id := livesyncNum(il, "label_id"); labelOrg[id] == repo.OwnerID {
					ownerLabels = append(ownerLabels, id)
				}
			}
			for _, pi := range s.objs(group, protocol.ModelProjectIssue) {
				if id := livesyncNum(pi, "project_id"); projectRepo[id] == 0 && projectOwner[id] == repo.OwnerID {
					ownerProjects = append(ownerProjects, id)
				}
			}
			if len(ownerLabels)+len(ownerProjects) > 0 {
				og := protocol.OwnerGroup(repo.OwnerID)
				require.Contains(t, s.end.Refs, og, "%s refers to the owner's labels/projects", what)
				os := ownerSnap(og)
				subset(what+" owner labels", ownerLabels, os.ids(og, protocol.ModelLabel, nil))
				subset(what+" owner projects", ownerProjects, os.ids(og, protocol.ModelProjectRef, nil))
				if code, _ := livesyncGrant(t, token, protocol.OrgGroup(repo.OwnerID)); code != http.StatusOK && userByID[repo.OwnerID].IsOrganization() {
					hiddenOwnerRefs++
				}
			}
			// Through the issue's JSON: API v1's pull request JSON logs
			// errors for fixture pull requests whose git refs are missing.
			for _, pr := range s.objs(group, protocol.ModelPullRequest) {
				issue := apiIssues[livesyncNum(pr, "issue_id")]
				if assert.NotNil(t, issue, "%s pull request %v: its issue", what, pr["id"]) {
					assert.NotNil(t, issue["pull_request"], "%s pull request %v", what, pr["id"])
				}
			}
			subset(what+" labels", s.ids(group, protocol.ModelLabel, nil), livesyncAPIIDs(t, token, base+"/labels"))
			subset(what+" milestones", s.ids(group, protocol.ModelMilestone, nil), livesyncAPIIDs(t, token, base+"/milestones?state=all"))
			isTag := func(d map[string]any) bool { return d["is_tag"] == true }
			subset(what+" releases", s.ids(group, protocol.ModelRelease, func(d map[string]any) bool { return !isTag(d) }), livesyncAPIIDs(t, token, base+"/releases"))
			if len(s.ids(group, protocol.ModelRelease, isTag)) > 0 {
				// A tag without a release: API v1 serves tags to code readers.
				assert.Contains(t, s.header.Units, protocol.UnitCode, what+" tags")
			}
			for _, a := range s.objs(group, protocol.ModelAttachment) {
				rel := livesyncNum(a, "release_id")
				subset(fmt.Sprintf("%s release %d assets", what, rel), []int64{livesyncNum(a, "id")}, livesyncAPIIDs(t, token, fmt.Sprintf("%s/releases/%d/assets", base, rel)))
			}
			for _, b := range s.objs(group, protocol.ModelBranch) {
				if b["is_deleted"] == true {
					assert.Contains(t, s.header.Units, protocol.UnitCode, "%s deleted branch %s", what, b["name"])
					continue
				}
				assert.Equal(t, http.StatusOK, livesyncStatus(t, token, base+"/branches/"+url.PathEscape(b["name"].(string))), "%s branch %s", what, b["name"])
			}
			bySHA := map[string][]int64{}
			for _, cs := range s.objs(group, protocol.ModelCommitStatus) {
				bySHA[cs["sha"].(string)] = append(bySHA[cs["sha"].(string)], livesyncNum(cs, "id"))
			}
			for sha, got := range bySHA {
				subset(what+" statuses of "+sha, got, livesyncAPIIDs(t, token, base+"/statuses/"+sha))
			}
			for _, id := range s.ids(group, protocol.ModelActionRun, nil) {
				assert.Equal(t, http.StatusOK, livesyncStatus(t, token, fmt.Sprintf("%s/actions/runs/%d", base, id)), "%s action run %d", what, id)
			}
			for _, id := range s.ids(group, protocol.ModelActionRunJob, nil) {
				assert.Equal(t, http.StatusOK, livesyncStatus(t, token, fmt.Sprintf("%s/actions/jobs/%d", base, id)), "%s action job %d", what, id)
			}
			if len(s.ids(group, protocol.ModelProject, nil))+len(s.ids(group, protocol.ModelProjectColumn, nil)) > 0 {
				assert.Contains(t, s.header.Units, protocol.UnitProjects, what+" projects")
			}
			for _, pi := range s.objs(group, protocol.ModelProjectIssue) {
				assert.Contains(t, apiIssues, livesyncNum(pi, "issue_id"), "%s project card %v: its issue", what, pi)
			}
			groups++

			for i, id := range s.ids(group, protocol.ModelIssue, nil) {
				if i == 3 {
					break
				}
				is := issueIndex[id]
				require.NotNil(t, is)
				lazy := livesyncBootstrap(t, token, fmt.Sprintf("/-/sync/load?group=issue:%d", id))
				ig := protocol.IssueGroup(id)
				what := fmt.Sprintf("viewer %d %s", viewer.ID, ig)
				count(lazy)
				embedded(what, token, lazy)
				ibase := fmt.Sprintf("%s/issues/%d", base, is.Index)
				if _, ok := lazy.of(ig)[fmt.Sprintf("IssueBody %d", id)]; ok {
					assert.Equal(t, http.StatusOK, livesyncStatus(t, token, ibase), what)
				}
				var timeline []int64
				for _, c := range lazy.objs(ig, protocol.ModelComment) {
					if c["type"] == "code" && livesyncNum(c, "review_id") == 0 {
						// A code comment without a review (old data): no
						// API v1 lists it; the web UI's files view shows it
						// to the pull request's readers.
						assert.Contains(t, lazy.header.Units, protocol.UnitPulls, "%s code comment %v", what, c["id"])
						continue
					}
					if c["type"] == "code" {
						path := fmt.Sprintf("%s/pulls/%d/reviews/%d/comments", base, is.Index, livesyncNum(c, "review_id"))
						subset(what+" code comments", []int64{livesyncNum(c, "id")}, livesyncAPIIDs(t, token, path))
						continue
					}
					if timeline == nil {
						timeline = livesyncAPIIDs(t, token, ibase+"/timeline")
					}
					subset(fmt.Sprintf("%s %s comments", what, c["type"]), []int64{livesyncNum(c, "id")}, timeline)
				}
				if is.IsPull {
					subset(what+" reviews", lazy.ids(ig, protocol.ModelReview, nil), livesyncAPIIDs(t, token, fmt.Sprintf("%s/pulls/%d/reviews", base, is.Index)))
				}
				for _, r := range lazy.objs(ig, protocol.ModelReaction) {
					path := ibase + "/reactions"
					if c := livesyncNum(r, "comment_id"); c != 0 {
						path = fmt.Sprintf("%s/issues/comments/%d/reactions", base, c)
					}
					var api []string
					for _, o := range livesyncAPIObjects(t, token, path) {
						api = append(api, fmt.Sprintf("%d %s", livesyncNum(o["user"].(map[string]any), "id"), o["content"]))
					}
					assert.Contains(t, api, fmt.Sprintf("%d %s", livesyncNum(r, "user_id"), r["content"]), "%s reaction %v", what, r)
				}
				for _, a := range lazy.objs(ig, protocol.ModelAttachment) {
					path := ibase + "/assets"
					if c := livesyncNum(a, "comment_id"); c != 0 {
						path = fmt.Sprintf("%s/issues/comments/%d/assets", base, c)
					}
					subset(what+" attachments", []int64{livesyncNum(a, "id")}, livesyncAPIIDs(t, token, path))
				}
				if deps := lazy.objs(ig, protocol.ModelIssueDependency); len(deps) > 0 {
					subset(what+" dependencies", ids(deps, "dependency_id"), livesyncAPIIDs(t, token, ibase+"/dependencies"))
				}
				for _, h := range lazy.objs(ig, protocol.ModelContentHistory) {
					assert.Equal(t, id, livesyncNum(h, "issue_id"), "%s revision %v", what, h)
				}
				assert.Empty(t, lazy.objs(ig, protocol.ModelTrackedTime), "tracked times are their tracker's")
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
			count(s)
			embedded(what, token, s)
			base := "/api/v1/orgs/" + org.Name
			subset(what+" teams", s.ids(group, protocol.ModelTeam, nil), livesyncAPIIDs(t, token, base+"/teams"))
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
			groups++
		}

		for _, o := range users {
			group := protocol.OwnerGroup(o.ID)
			grant, _ := livesyncGrant(t, token, group)
			if grant != http.StatusOK {
				assert.Equal(t, http.StatusNotFound, livesyncStatus(t, token, "/-/sync/bootstrap?group="+group))
				continue
			}
			what := fmt.Sprintf("viewer %d %s", viewer.ID, group)
			profile := "/api/v1/users/" + o.Name
			if o.IsOrganization() {
				profile = "/api/v1/orgs/" + o.Name
			}
			visible := livesyncStatus(t, token, profile) == http.StatusOK
			assert.True(t, visible || issueReader[o.ID], "%s: the owner is visible or the viewer reads its repositories' issues", what)
			s := ownerSnap(group)
			count(s)
			embedded(what, token, s)
			if labels := s.ids(group, protocol.ModelLabel, nil); len(labels) > 0 && visible {
				subset(what+" labels", labels, livesyncAPIIDs(t, token, "/api/v1/orgs/"+o.Name+"/labels"))
			}
			// Exactly what upstream shows every reader of the owner's
			// repositories' issues: never a Project (description,
			// creator, timestamps: the project page's), a ProjectRef's
			// fields only, labels without the organization-wide counts.
			assert.Empty(t, s.ids(group, protocol.ModelProject, nil), what+": no Project in an owner group")
			for _, p := range s.objs(group, protocol.ModelProjectRef) {
				assert.ElementsMatch(t, []string{"id", "owner_id", "title", "closed", "type"}, slices.Collect(maps.Keys(p)), "%s project ref %v", what, p)
			}
			for _, l := range s.objs(group, protocol.ModelLabel) {
				assert.NotContains(t, l, "updated_at", "%s label %v", what, l)
				assert.Zero(t, livesyncNum(l, "num_issues"), "%s label %v", what, l)
				assert.Zero(t, livesyncNum(l, "num_closed_issues"), "%s label %v", what, l)
			}
			if !visible {
				// A reader of the owner's repositories' issues who may
				// not see the owner: compare with upstream's web UI.
				session := webSession(viewer)
				projects, labels := livesyncWebOwnerShare(t, session, issueList[o.ID], projectRepo)
				refs := map[int64]livesyncWebProject{}
				for _, p := range s.objs(group, protocol.ModelProjectRef) {
					refs[livesyncNum(p, "id")] = livesyncWebProject{Title: p["title"].(string), Closed: p["closed"] == true}
				}
				assert.Equal(t, projects, refs, "%s: the project refs = the owner projects of %s", what, issueList[o.ID])
				var orgLabels []int64
				if o.IsOrganization() {
					orgLabels = s.ids(group, protocol.ModelLabel, nil)
				}
				assert.ElementsMatch(t, labels, orgLabels, "%s: the labels = the organization labels of %s/labels", what, strings.TrimSuffix(strings.TrimSuffix(issueList[o.ID], "/issues"), "/pulls"))
				for id := range refs {
					session.MakeRequest(t, NewRequest(t, "GET", fmt.Sprintf("/%s/-/projects/%d", o.Name, id)), http.StatusNotFound)
				}
				for _, g := range []string{protocol.OrgGroup(o.ID), protocol.ProfileGroup(o.ID)} {
					assert.Equal(t, http.StatusNotFound, livesyncStatus(t, token, "/-/sync/bootstrap?group="+g), "%s: %s", what, g)
				}
				if len(refs) > 0 {
					hiddenOwnerProjects++
				}
			}
			groups++
		}

		ownGroup := protocol.UserGroup(viewer.ID)
		own := livesyncBootstrap(t, token, "/-/sync/bootstrap?group="+ownGroup)
		count(own)
		embedded(fmt.Sprintf("viewer %d %s", viewer.ID, ownGroup), token, own)
		subset(fmt.Sprintf("viewer %d stars", viewer.ID), ids(own.objs(ownGroup, protocol.ModelStar), "repo_id"), livesyncAPIIDs(t, token, "/api/v1/user/starred"))
		if times := own.ids(ownGroup, protocol.ModelTrackedTime, nil); len(times) > 0 {
			subset(fmt.Sprintf("viewer %d tracked times", viewer.ID), times, livesyncAPIIDs(t, token, "/api/v1/user/times"))
		}
		if n := own.ids(ownGroup, protocol.ModelNotification, nil); len(n) > 0 {
			subset(fmt.Sprintf("viewer %d notifications", viewer.ID), n, livesyncAPIIDs(t, token, "/api/v1/notifications?all=true"))
		}

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
	assert.Greater(t, groups, 100, "readable groups compared")
	assert.Positive(t, hiddenOwnerRefs, "an organization's labels/projects reached by a viewer who may not see it")
	assert.Positive(t, hiddenOwnerProjects, "project refs compared with the web UI for a viewer who may not see their owner")
	t.Logf("entities compared per model: %v", compared)
	// Every model a bootstrap serves was compared at least once (the
	// fixtures have no auto-merge, commit status or action rows that
	// reach a bootstrap: those are checked when present).
	for _, m := range []protocol.Model{
		protocol.ModelRepository, protocol.ModelRepoUnit, protocol.ModelCollaboration, protocol.ModelLabel, protocol.ModelMilestone,
		protocol.ModelProject, protocol.ModelProjectRef, protocol.ModelProjectColumn, protocol.ModelProjectIssue, protocol.ModelIssue, protocol.ModelIssueBody,
		protocol.ModelIssueLabel, protocol.ModelIssueAssignee, protocol.ModelPullRequest, protocol.ModelBranch, protocol.ModelRelease,
		protocol.ModelComment, protocol.ModelReview, protocol.ModelReaction, protocol.ModelAttachment, protocol.ModelIssueDependency,
		protocol.ModelContentHistory, protocol.ModelTeam, protocol.ModelOrgUser, protocol.ModelStar, protocol.ModelTrackedTime,
		protocol.ModelNotification, protocol.ModelUser,
	} {
		assert.Positive(t, compared[m], "%s compared", m)
	}
}

// livesyncWebProject is a project as upstream's issue list filter shows it.
type livesyncWebProject struct {
	Title  string
	Closed bool
}

// livesyncWebOwnerShare returns what upstream's web UI shows the signed-in
// session of a repository's owner on the repository's issue (or pull
// request) list at list: the owner's projects in the project filter (the
// ones projectRepo says are not repository projects), split into open and
// closed, and the organization labels on the repository's label page.
func livesyncWebOwnerShare(t *testing.T, session *TestSession, list string, projectRepo map[int64]int64) (map[int64]livesyncWebProject, []int64) {
	t.Helper()
	require.NotEmpty(t, list)
	closedHeader := translation.NewLocale("en-US").TrString("repo.issues.new.closed_projects")
	doc := NewHTMLParser(t, session.MakeRequest(t, NewRequest(t, "GET", list), http.StatusOK).Body)
	projects := map[int64]livesyncWebProject{}
	closed := false
	doc.doc.Find(".list-header-project .menu").Children().Each(func(_ int, el *goquery.Selection) {
		if el.HasClass("header") {
			closed = strings.TrimSpace(el.Text()) == closedHeader
			return
		}
		href, ok := el.Attr("href")
		if !el.Is("a.item") || !ok {
			return
		}
		u, err := url.Parse(href)
		require.NoError(t, err)
		id, err := strconv.ParseInt(u.Query().Get("project"), 10, 64)
		if err != nil || id <= 0 || projectRepo[id] != 0 {
			return // all, none, or a repository project
		}
		projects[id] = livesyncWebProject{Title: strings.TrimSpace(el.Text()), Closed: closed}
	})
	repoLink := strings.TrimSuffix(strings.TrimSuffix(list, "/issues"), "/pulls")
	doc = NewHTMLParser(t, session.MakeRequest(t, NewRequest(t, "GET", repoLink+"/labels"), http.StatusOK).Body)
	var labels []int64
	doc.doc.Find("li.org-label a.open-issues").Each(func(_ int, el *goquery.Selection) {
		href, _ := el.Attr("href")
		u, err := url.Parse(href)
		require.NoError(t, err)
		id, err := strconv.ParseInt(u.Query().Get("labels"), 10, 64)
		require.NoError(t, err, href)
		labels = append(labels, id)
	})
	return projects, labels
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

// livesyncPauseMaterializer holds the lock of the sync log head row, so
// that the materializer's next writer transaction waits in its Append
// (after it read its batch) and nothing more is consumed: the outbox keeps
// every later change, and an entity inserted and deleted meanwhile is
// coalesced away when the materializer resumes (no entry at all). poke makes
// a change, so that a batch starts and waits; livesyncPauseMaterializer
// returns once a transaction waits for the lock. Bootstraps keep working
// (they read the head without locking). Resume (the returned function, also
// run at cleanup) releases the lock.
func livesyncPauseMaterializer(t *testing.T, poke func()) (resume func()) {
	t.Helper()
	master := livesyncMaster(t)
	sess := master.NewSession()
	require.NoError(t, sess.Begin())
	resume = sync.OnceFunc(func() {
		_ = sess.Rollback()
		sess.Close()
	})
	t.Cleanup(resume)
	var heads []string
	require.NoError(t, sess.SQL("SELECT value FROM livesync_meta WHERE name = 'log_head' FOR UPDATE").Find(&heads))
	require.Len(t, heads, 1)
	poke()
	// A writer transaction waiting in lockMeta (Append), not any other
	// lock wait (an API request's, the notification queue's).
	waiting := "SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%livesync_meta%FOR UPDATE%'"
	if setting.Database.Type.IsMySQL() {
		// (information_schema.innodb_trx does not list it as waiting.)
		waiting = "SELECT COUNT(*) FROM information_schema.processlist WHERE id <> CONNECTION_ID() AND info LIKE '%livesync_meta%FOR UPDATE%'"
	}
	require.Eventually(t, func() bool {
		var n int64
		_, err := master.SQL(waiting).Get(&n)
		require.NoError(t, err)
		return n > 0
	}, livesyncWait, 10*time.Millisecond, "the materializer waits for the log head")
	return resume
}

// TestLivesyncBootstrapConvergence (B6 acceptance): a bootstrap taken while
// writers change the group, plus the deltas after its watermark, equals a
// fresh bootstrap taken once the writes are done — for a repository's
// summary (issues created, closed, labelled, labels created and deleted)
// and an issue's lazy tier (comments created, edited, deleted; the body
// edited), with bootstraps taken at several moments.
//
// It starts with bootstraps taken while the materializer is paused, so that
// the outbox holds a comment and a label that are then deleted before it
// resumes: their inserts and deletes are coalesced (no log entry), so a
// bootstrap that sent them (they are in the tables when it reads them)
// would leave them in its replica for good. That is the case the
// bootstrap's index-presence filter exists for (materialize/snapshot.go);
// the concurrent writers create and delete such entities too.
func TestLivesyncBootstrapConvergence(t *testing.T) {
	livesyncSkipSQLite(t)
	livesyncServeWith(t, map[string]string{"SUMMARY_RECENCY": "438000h"}) // the whole summary
	onApplicationRun(t, func(t *testing.T, u *url.URL) {
		livesyncWaitBackfill(t)
		livesyncSettle(t)
		token := livesyncToken(t, &user_model.User{ID: 2})
		const repo = "/api/v1/repos/user2/repo1"

		type client struct {
			replica *livesyncReplica
			cl      *livesyncSyncClient
		}
		var clients []client
		// subscribe follows a bootstrap's group from its watermark.
		subscribe := func(s *livesyncSnapshot) {
			cl := livesyncDial(t, u, "ws")
			cl.send(livesyncHello(token, protocol.GroupRequest{Group: s.header.Group, Since: livesyncSince(s.header.Watermark)}))
			welcome := cl.waitType(protocol.MsgWelcome)
			require.Len(t, welcome.Granted, 1)
			assert.Equal(t, s.header.Units, welcome.Granted[0].Units, "the bootstrap's units are the grant's")
			clients = append(clients, client{newLivesyncReplica(s), cl})
		}
		bootstrap := func(group string) *livesyncSnapshot {
			path := "/-/sync/bootstrap?group=" + group
			if strings.HasPrefix(group, protocol.GroupPrefixIssue+":") {
				path = "/-/sync/load?group=" + group
			}
			return livesyncBootstrap(t, token, path)
		}

		// Pending outbox rows: the materializer paused, a comment and a
		// label created, bootstraps taken, the two deleted, resumed.
		var obj struct {
			ID int64 `json:"id"`
		}
		// Ids are reused after a fixture reload (the reload's own deletes
		// are in the log): only the entries from here on count.
		cursor := livesyncLogHead(t)
		resume := livesyncPauseMaterializer(t, func() {
			livesyncHTTP(t, u, token, "PATCH", repo+"/labels/1", map[string]any{"description": "paused"}, nil)
		})
		require.Equal(t, http.StatusCreated, livesyncHTTP(t, u, token, "POST", repo+"/issues/1/comments", map[string]any{"body": "short-lived"}, &obj))
		comment := obj.ID
		require.Equal(t, http.StatusCreated, livesyncHTTP(t, u, token, "POST", repo+"/labels", map[string]any{"name": "short-lived", "color": "#aabbcc"}, &obj))
		label := obj.ID
		pending := map[string]bool{}
		for _, ch := range livesyncOutbox(t) {
			pending[fmt.Sprintf("%s:%d", ch.Tbl, ch.RowID)] = true
		}
		require.True(t, pending[fmt.Sprintf("comment:%d", comment)], "the comment's insert is pending")
		require.True(t, pending[fmt.Sprintf("label:%d", label)], "the label's insert is pending")
		issueSnap, repoSnap := bootstrap("issue:1"), bootstrap("repo:1")
		assert.NotContains(t, issueSnap.of("issue:1"), fmt.Sprintf("Comment %d", comment), "not materialized: left out")
		assert.NotContains(t, repoSnap.of("repo:1"), fmt.Sprintf("Label %d", label), "not materialized: left out")
		subscribe(issueSnap)
		subscribe(repoSnap)
		require.Equal(t, http.StatusNoContent, livesyncHTTP(t, u, token, "DELETE", fmt.Sprintf("%s/issues/comments/%d", repo, comment), nil, nil))
		require.Equal(t, http.StatusNoContent, livesyncHTTP(t, u, token, "DELETE", fmt.Sprintf("%s/labels/%d", repo, label), nil, nil))
		resume()
		livesyncSettle(t)
		for _, e := range livesyncLogSince(t, cursor) {
			assert.False(t, e.Model == string(protocol.ModelComment) && e.EntityID == comment, "the comment is in no log entry (coalesced)")
			assert.False(t, e.Model == string(protocol.ModelLabel) && e.EntityID == label, "the label is in no log entry (coalesced)")
		}

		stop := make(chan struct{})
		var wg sync.WaitGroup
		// The writers stop when the test ends, whatever way: a failed
		// require in this goroutine must not leave them calling t.Errorf
		// after the test completed (which panics the test binary).
		stopWriters := sync.OnceFunc(func() {
			close(stop)
			wg.Wait()
		})
		defer stopWriters()
		writes := atomic.Int64{}
		// Each writer has its own kinds of writes: upstream deadlocks on
		// MySQL when two comments are created on one issue concurrently
		// (CreateComment's num_comments subquery), with or without
		// livesync. Ops 10 and 11 create an entity and delete it at once.
		ops := [][]int{{1, 2, 3, 4, 8, 10}, {0, 7, 0}, {0, 5, 6, 6, 9, 11}}
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
					case 10:
						if livesyncHTTP(t, u, token, "POST", repo+"/issues/1/comments", map[string]any{"body": fmt.Sprintf("short %d-%d", w, i)}, &obj) == http.StatusCreated {
							livesyncHTTP(t, u, token, "DELETE", fmt.Sprintf("%s/issues/comments/%d", repo, obj.ID), nil, nil)
						}
					case 11:
						if livesyncHTTP(t, u, token, "POST", repo+"/labels", map[string]any{"name": fmt.Sprintf("short-%d-%d", w, i), "color": "#aabbcc"}, &obj) == http.StatusCreated {
							livesyncHTTP(t, u, token, "DELETE", fmt.Sprintf("%s/labels/%d", repo, obj.ID), nil, nil)
						}
					}
					writes.Add(1)
				}
			})
		}

		for round := range 3 {
			time.Sleep(time.Duration(150+100*round) * time.Millisecond)
			for _, group := range []string{"repo:1", "issue:1"} {
				subscribe(bootstrap(group))
			}
		}
		stopWriters()
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
			fresh := bootstrap(c.replica.group)
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
// client reads a bootstrap of ≈ 25 MB (40 000 issues), grows by a fraction
// of the response (2–4 MB measured; the bound is half the response, see
// below). On MySQL the run writes ≈ 0.7 GB of binary log.
func TestLivesyncBootstrapLarge(t *testing.T) {
	livesyncSkipSQLite(t)
	livesyncServe(t)
	onApplicationRun(t, func(t *testing.T, u *url.URL) {
		livesyncWaitBackfill(t)
		livesyncSettle(t)
		n := 40000
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
		assert.Greater(t, total, 20<<20, "a large response")
		// A buffered response would need more than the response itself;
		// the bound leaves room for the rest of the server (materializer,
		// queues) allocating meanwhile in this process (≈ 3–9 MB seen).
		assert.Less(t, growth, int64(total/2), "memory is bounded by a chunk, not the response")
	})
}

// TestLivesyncBootstrapCancelled: clients that go away during a bootstrap (a
// page closed or navigated) are not server errors. Each request is cut at a
// different moment; nothing may be logged at error level: neither the
// bootstrap's own error nor the failed COMMIT/ROLLBACK of a transaction that
// database/sql had already rolled back because its context was canceled
// (QA 2026-10-09: "[Error SQL Query] ROLLBACK - sql: transaction has already
// been committed or rolled back").
func TestLivesyncBootstrapCancelled(t *testing.T) {
	livesyncSkipSQLite(t)
	livesyncServe(t)
	onApplicationRun(t, func(t *testing.T, u *url.URL) {
		livesyncWaitBackfill(t)
		// Enough rows for several chunks, so that a cut lands inside the stream.
		batch := make([]*issues_model.Issue, 0, 2000)
		for i := range 2000 {
			batch = append(batch, &issues_model.Issue{RepoID: 1, Index: int64(200000 + i), PosterID: 2, Title: fmt.Sprintf("cancelled bootstrap %d", i), Content: "x"})
		}
		_, err := db.GetEngine(t.Context()).Insert(&batch)
		require.NoError(t, err)
		livesyncSettle(t)

		// Info and above: the stop mark below is an Info (cancelled bootstraps are logged at Debug).
		lc, cleanup := test.NewLogChecker(log.DEFAULT, log.INFO)
		defer cleanup()
		lc.Filter("livesync: bootstrap of", "[Error SQL Query]").StopMark("livesync cancelled bootstraps: done")

		token := livesyncToken(t, &user_model.User{ID: 2})
		for i := range 24 {
			ctx, cancel := context.WithCancel(t.Context())
			req, err := http.NewRequestWithContext(ctx, "GET", u.String()+"-/sync/bootstrap?group=repo:1", nil)
			require.NoError(t, err)
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Accept-Encoding", "identity")
			// Cut before the answer (in Prepare), right after the header, or a few chunks in.
			if i%3 == 0 {
				time.AfterFunc(time.Duration(i)*time.Millisecond/4, cancel)
			}
			resp, err := http.DefaultClient.Do(req)
			if err == nil {
				br := bufio.NewReader(resp.Body)
				for range i * 40 {
					if _, err := br.ReadSlice('\n'); err != nil {
						break
					}
				}
				cancel()
				resp.Body.Close()
			}
			cancel()
		}
		// The server notices a cut connection on its next write or statement.
		time.Sleep(500 * time.Millisecond)
		log.Info("livesync cancelled bootstraps: done")
		filtered, stopped := lc.Check(10 * time.Second)
		require.True(t, stopped)
		assert.False(t, filtered[0], "a cancelled bootstrap was logged as an error")
		assert.False(t, filtered[1], "a cancelled bootstrap's transaction was logged as a failed query")
		// And a whole one still works.
		s := livesyncBootstrap(t, token, "/-/sync/bootstrap?group=repo:1")
		mine := s.ids("repo:1", protocol.ModelIssue, func(d map[string]any) bool {
			title, _ := d["title"].(string)
			return strings.HasPrefix(title, "cancelled bootstrap ")
		})
		assert.Len(t, mine, 2000)
	})
}
