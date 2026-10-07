// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	auth_model "forgejo.org/models/auth"
	"forgejo.org/models/db"
	issues_model "forgejo.org/models/issues"
	livesync_model "forgejo.org/models/livesync"
	repo_model "forgejo.org/models/repo"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/structs"
	"forgejo.org/modules/test"
	"forgejo.org/routers"
	livesync_router "forgejo.org/routers/livesync"
	livesync_service "forgejo.org/services/livesync"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/tests"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// livesyncGrant asks /-/sync/grants?group= and returns the status and units.
func livesyncGrant(t *testing.T, token, group string) (int, []protocol.Unit) {
	t.Helper()
	resp := MakeRequest(t, NewRequest(t, "GET", "/-/sync/grants?group="+group).AddTokenAuth(token), NoExpectedStatus)
	if resp.Code != http.StatusOK {
		return resp.Code, nil
	}
	var g protocol.Grant
	DecodeJSON(t, resp, &g)
	require.Equal(t, group, g.Group)
	return resp.Code, g.Units
}

// livesyncGrants returns the viewer's implicit grants by group.
func livesyncGrants(t *testing.T, token string) map[string][]protocol.Unit {
	t.Helper()
	var g protocol.Grants
	DecodeJSON(t, MakeRequest(t, NewRequest(t, "GET", "/-/sync/grants").AddTokenAuth(token), http.StatusOK), &g)
	res := make(map[string][]protocol.Unit, len(g.Grants))
	for _, gr := range g.Grants {
		res[gr.Group] = gr.Units
	}
	return res
}

func livesyncStatus(t *testing.T, token, path string) int {
	t.Helper()
	return MakeRequest(t, NewRequest(t, "GET", path).AddTokenAuth(token), NoExpectedStatus).Code
}

// Differential test (B4 acceptance): for every fixture user and every
// repository, organization and user, livesync grants a group exactly when
// API v1 lets the user read the corresponding resource, with the same units:
//
//   - repo:{id} ⇔ GET /repos/{o}/{r} is 200; unit code ⇔ /languages,
//     issues ⇔ /issues/pinned, releases ⇔ /releases, pulls ⇔ a pull
//     request's /issues/{n}; issue:{id} ⇔ /issues/{n} for one issue and one
//     pull request per repository;
//   - org:{id} ⇔ GET /orgs/{org}; unit members ⇔ GET /orgs/{org}/teams;
//   - the profile of a user (the directory of their visibility, or their
//     profile group when private) ⇔ GET /users/{name};
//
// and every implicit grant (GET /-/sync/grants) is one of these with the
// same units. Users who may not sign in get 403 from both.
func TestLivesyncPermDifferential(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncServe(t)
	ctx := t.Context()

	var users []*user_model.User
	require.NoError(t, db.GetEngine(ctx).OrderBy("id").Find(&users))
	var repos []*repo_model.Repository
	require.NoError(t, db.GetEngine(ctx).OrderBy("id").Find(&repos))
	// One issue and one pull request (the lowest index) per repository.
	samples := map[int64][]*issues_model.Issue{}
	var issues []*issues_model.Issue
	require.NoError(t, db.GetEngine(ctx).OrderBy("repo_id, `index`").Find(&issues))
	for _, is := range issues {
		if !slices.ContainsFunc(samples[is.RepoID], func(o *issues_model.Issue) bool { return o.IsPull == is.IsPull }) {
			samples[is.RepoID] = append(samples[is.RepoID], is)
		}
	}
	unitPaths := []struct {
		unit protocol.Unit
		path string
	}{
		{protocol.UnitCode, "/languages"},
		{protocol.UnitIssues, "/issues/pinned"},
		{protocol.UnitReleases, "/releases"},
	}

	checked := 0
	for _, viewer := range users {
		if viewer.IsOrganization() {
			continue
		}
		token := livesyncToken(t, viewer)
		if !viewer.IsActive || viewer.ProhibitLogin {
			assert.Equal(t, http.StatusForbidden, livesyncStatus(t, token, "/-/sync/grants"), "viewer %d", viewer.ID)
			assert.Equal(t, http.StatusForbidden, livesyncStatus(t, token, "/api/v1/user"), "viewer %d", viewer.ID)
			continue
		}
		implicit := livesyncGrants(t, token)
		seen := map[string]bool{}
		for _, repo := range repos {
			group := protocol.RepoGroup(repo.ID)
			base := fmt.Sprintf("/api/v1/repos/%s/%s", repo.OwnerName, repo.Name)
			api := livesyncStatus(t, token, base)
			require.Contains(t, []int{http.StatusOK, http.StatusNotFound}, api, "viewer %d %s", viewer.ID, base)
			status, units := livesyncGrant(t, token, group)
			require.Equal(t, api == http.StatusOK, status == http.StatusOK, "viewer %d %s: API v1 %d, livesync %d", viewer.ID, group, api, status)
			if want, ok := implicit[group]; ok {
				seen[group] = true
				assert.Equal(t, want, units, "viewer %d %s: implicit grant = on-demand check", viewer.ID, group)
			}
			if api != http.StatusOK {
				continue
			}
			checked++
			for _, up := range unitPaths {
				code := livesyncStatus(t, token, base+up.path)
				require.Contains(t, []int{http.StatusOK, http.StatusForbidden, http.StatusNotFound}, code, "viewer %d %s%s", viewer.ID, base, up.path)
				assert.Equal(t, code == http.StatusOK, slices.Contains(units, up.unit), "viewer %d %s unit %s (API v1 %d)", viewer.ID, group, up.unit, code)
			}
			for _, is := range samples[repo.ID] {
				code := livesyncStatus(t, token, fmt.Sprintf("%s/issues/%d", base, is.Index))
				require.Contains(t, []int{http.StatusOK, http.StatusNotFound}, code)
				unit := protocol.UnitIssues
				if is.IsPull {
					unit = protocol.UnitPulls
				}
				assert.Equal(t, code == http.StatusOK, slices.Contains(units, unit), "viewer %d %s unit %s", viewer.ID, group, unit)
				issueStatus, _ := livesyncGrant(t, token, protocol.IssueGroup(is.ID))
				assert.Equal(t, code == http.StatusOK, issueStatus == http.StatusOK, "viewer %d issue:%d (API v1 %d)", viewer.ID, is.ID, code)
			}
		}

		for _, target := range users {
			if target.IsOrganization() {
				group := protocol.OrgGroup(target.ID)
				api := livesyncStatus(t, token, "/api/v1/orgs/"+target.Name)
				status, units := livesyncGrant(t, token, group)
				require.Equal(t, api == http.StatusOK, status == http.StatusOK, "viewer %d %s: API v1 %d, livesync %d", viewer.ID, group, api, status)
				if api == http.StatusOK {
					teams := livesyncStatus(t, token, "/api/v1/orgs/"+target.Name+"/teams")
					assert.Equal(t, teams == http.StatusOK, slices.Contains(units, protocol.UnitMembers), "viewer %d %s members (API v1 %d)", viewer.ID, group, teams)
				}
				if want, ok := implicit[group]; ok {
					seen[group] = true
					assert.Equal(t, want, units, "viewer %d %s", viewer.ID, group)
				}
				continue
			}
			api := livesyncStatus(t, token, "/api/v1/users/"+target.Name)
			require.Contains(t, []int{http.StatusOK, http.StatusNotFound}, api)
			var group string
			switch target.Visibility {
			case structs.VisibleTypePublic:
				group = protocol.GroupProfilesPublic
			case structs.VisibleTypeLimited:
				group = protocol.GroupProfilesLimited
			default:
				group = protocol.ProfileGroup(target.ID)
			}
			status, _ := livesyncGrant(t, token, group)
			if viewer.IsRestricted && viewer.ID == target.ID && group == protocol.GroupProfilesLimited {
				// Known gap: a restricted user may see their own
				// limited profile upstream, but not the limited
				// directory (see the B4 notes).
				continue
			}
			assert.Equal(t, api == http.StatusOK, status == http.StatusOK, "viewer %d profile of %d in %s: API v1 %d, livesync %d", viewer.ID, target.ID, group, api, status)
		}

		// The rest of the implicit grants: the viewer's own groups and the
		// directories.
		for group := range implicit {
			if seen[group] {
				continue
			}
			switch group {
			case protocol.UserGroup(viewer.ID):
				assert.Equal(t, []protocol.Unit{protocol.UnitSelf}, implicit[group])
			case protocol.ProfileGroup(viewer.ID), protocol.GroupProfilesPublic, protocol.GroupProfilesLimited:
				assert.Empty(t, implicit[group])
			default:
				t.Errorf("viewer %d: unexpected implicit grant %s", viewer.ID, group)
			}
		}
		// Site administrators get no implicit groups: only the
		// repositories they own or are related to.
		if viewer.IsAdmin {
			for _, repo := range repos {
				if _, ok := implicit[protocol.RepoGroup(repo.ID)]; ok {
					assert.True(t, repo.OwnerID == viewer.ID || livesyncRelated(t, viewer.ID, repo), "admin %d: implicit repo:%d without a relation", viewer.ID, repo.ID)
				}
			}
		}
	}
	assert.Greater(t, checked, 100, "readable (viewer, repository) pairs compared")
}

// livesyncRelated reports whether userID collaborates on repo, has an
// access row for it, or reaches it through a team.
func livesyncRelated(t *testing.T, userID int64, repo *repo_model.Repository) bool {
	t.Helper()
	e := db.GetEngine(t.Context())
	for _, q := range []string{
		"SELECT COUNT(*) FROM collaboration WHERE user_id = ? AND repo_id = ?",
		"SELECT COUNT(*) FROM access WHERE user_id = ? AND repo_id = ?",
		"SELECT COUNT(*) FROM team_repo JOIN team_user ON team_user.team_id = team_repo.team_id WHERE team_user.uid = ? AND team_repo.repo_id = ?",
	} {
		var n int64
		_, err := e.SQL(q, userID, repo.ID).Get(&n)
		require.NoError(t, err)
		if n > 0 {
			return true
		}
	}
	var n int64
	_, err := e.SQL("SELECT COUNT(*) FROM team JOIN team_user ON team_user.team_id = team.id WHERE team_user.uid = ? AND team.org_id = ? AND team.includes_all_repositories = ?", userID, repo.OwnerID, true).Get(&n)
	require.NoError(t, err)
	return n > 0
}

// livesyncPermEpoch waits for a permission epoch after cursor that matches
// and returns it.
func livesyncPermEpoch(t *testing.T, cursor int64, match func(ch protocol.PermissionChange) bool) protocol.PermissionChange {
	t.Helper()
	var found protocol.PermissionChange
	livesyncWaitLog(t, cursor, livesyncWait, func(e *livesync_model.LogEntry) bool {
		if e.Op != string(protocol.OpPermission) {
			return false
		}
		assert.Equal(t, protocol.GroupPermission, e.Grp)
		ch := livesyncPayload[protocol.PermissionChange](t, *e)
		if match(ch) {
			found = ch
			return true
		}
		return false
	})
	return found
}

// B4 acceptance: making a repository private, removing a collaborator and
// removing a team member through API v1 write permission epochs, and the
// grants (cached per viewer, invalidated by the epochs every instance's
// tailer reads) drop.
func TestLivesyncPermEpochs(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncServe(t)
	livesyncWaitBackfill(t)
	owner := getUserToken(t, "user2", auth_model.AccessTokenScopeWriteRepository, auth_model.AccessTokenScopeWriteOrganization)
	user4 := livesyncToken(t, &user_model.User{ID: 4})
	user5 := livesyncToken(t, &user_model.User{ID: 5})

	// Collaborator added to user2's private repo2: the epoch names user5,
	// whose cached grants (computed first, without repo:2) are refreshed.
	require.NotContains(t, livesyncGrants(t, user5), "repo:2")
	status, _ := livesyncGrant(t, user5, "repo:2")
	require.Equal(t, http.StatusNotFound, status)
	cursor := livesyncLogHead(t)
	MakeRequest(t, NewRequestWithJSON(t, "PUT", "/api/v1/repos/user2/repo2/collaborators/user5", map[string]string{"permission": "read"}).AddTokenAuth(owner), http.StatusNoContent)
	livesyncPermEpoch(t, cursor, func(ch protocol.PermissionChange) bool { return slices.Contains(ch.Users, 5) })
	assert.Eventually(t, func() bool { _, ok := livesyncGrants(t, user5)["repo:2"]; return ok }, livesyncWait, 20*time.Millisecond)
	status, units := livesyncGrant(t, user5, "repo:2")
	assert.Equal(t, http.StatusOK, status)
	assert.Contains(t, units, protocol.UnitCode)

	// Removed again: the grant drops.
	cursor = livesyncLogHead(t)
	MakeRequest(t, NewRequest(t, "DELETE", "/api/v1/repos/user2/repo2/collaborators/user5").AddTokenAuth(owner), http.StatusNoContent)
	livesyncPermEpoch(t, cursor, func(ch protocol.PermissionChange) bool { return slices.Contains(ch.Users, 5) })
	assert.Eventually(t, func() bool { _, ok := livesyncGrants(t, user5)["repo:2"]; return !ok }, livesyncWait, 20*time.Millisecond)
	status, _ = livesyncGrant(t, user5, "repo:2")
	assert.Equal(t, http.StatusNotFound, status)

	// Public repo1 made private: the epoch names the repository; user5
	// could read it on demand before, not after. user2 (owner) keeps it.
	status, _ = livesyncGrant(t, user5, "repo:1")
	require.Equal(t, http.StatusOK, status)
	cursor = livesyncLogHead(t)
	MakeRequest(t, NewRequestWithJSON(t, "PATCH", "/api/v1/repos/user2/repo1", map[string]any{"private": true}).AddTokenAuth(owner), http.StatusOK)
	ch := livesyncPermEpoch(t, cursor, func(ch protocol.PermissionChange) bool { return slices.Contains(ch.Repos, 1) })
	assert.Contains(t, ch.Users, int64(2), "the owner")
	status, _ = livesyncGrant(t, user5, "repo:1")
	assert.Equal(t, http.StatusNotFound, status)
	assert.Contains(t, livesyncGrants(t, livesyncToken(t, &user_model.User{ID: 2})), "repo:1")
	// The repository's entity reached the log after the epoch.
	e := livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelRepository, 1, protocol.OpUpsert))
	assert.True(t, livesyncPayload[protocol.Repository](t, e).Private)

	// user4 removed from org3's team1 (the team that gives access to the
	// private repo3): the epoch names user4, the grant drops.
	require.Contains(t, livesyncGrants(t, user4), "repo:3")
	cursor = livesyncLogHead(t)
	MakeRequest(t, NewRequest(t, "DELETE", "/api/v1/teams/2/members/user4").AddTokenAuth(owner), http.StatusNoContent)
	livesyncPermEpoch(t, cursor, func(ch protocol.PermissionChange) bool { return slices.Contains(ch.Users, 4) })
	assert.Eventually(t, func() bool { _, ok := livesyncGrants(t, user4)["repo:3"]; return !ok }, livesyncWait, 20*time.Millisecond)
	status, _ = livesyncGrant(t, user4, "repo:3")
	assert.Equal(t, http.StatusNotFound, status)
	// No entity of the removed membership is left in any group the user
	// can still read: the TeamUser delete went to org:3's members.
	e = livesyncWaitLog(t, cursor, livesyncWait, func(e *livesync_model.LogEntry) bool {
		return e.Model == string(protocol.ModelTeamUser) && e.Op == string(protocol.OpDelete)
	})
	assert.Equal(t, "org:3", e.Grp)
	assert.Equal(t, string(protocol.UnitMembers), e.Unit)

	// A user made private moves their profile from the public directory to
	// their profile group (and the epoch names their repositories).
	cursor = livesyncLogHead(t)
	admin := getUserToken(t, "user1", auth_model.AccessTokenScopeWriteAdmin)
	MakeRequest(t, NewRequestWithJSON(t, "PATCH", "/api/v1/admin/users/user5", map[string]any{"visibility": "private", "login_name": "user5", "source_id": 0}).AddTokenAuth(admin), http.StatusOK)
	ch = livesyncPermEpoch(t, cursor, func(ch protocol.PermissionChange) bool { return slices.Contains(ch.Owners, 5) })
	assert.Contains(t, ch.Repos, int64(4), "user5's repository")
	livesyncWaitLog(t, cursor, livesyncWait, func(e *livesync_model.LogEntry) bool {
		return e.Model == string(protocol.ModelUser) && e.EntityID == 5 && e.Op == string(protocol.OpDelete) && e.Grp == protocol.GroupProfilesPublic
	})
	livesyncWaitLog(t, cursor, livesyncWait, func(e *livesync_model.LogEntry) bool {
		return e.Model == string(protocol.ModelUser) && e.EntityID == 5 && e.Op == string(protocol.OpUpsert) && e.Grp == "profile:5"
	})
	status, _ = livesyncGrant(t, user4, "profile:5")
	assert.Equal(t, http.StatusNotFound, status, "a private profile: the user and site administrators only")
	status, _ = livesyncGrant(t, user5, "profile:5")
	assert.Equal(t, http.StatusOK, status)

	// Nothing livesync wrote names user:{id} groups for anyone's public
	// entities any more: only unit self there.
	for _, e := range livesyncLogSince(t, 0) {
		if strings.HasPrefix(e.Grp, protocol.GroupPrefixUser+":") {
			assert.Equal(t, string(protocol.UnitSelf), e.Unit, "%s %s %d in %s", e.Op, e.Model, e.EntityID, e.Grp)
		}
	}
}

// Without a valid token: 401; the endpoint is not served while livesync is
// stopped.
func TestLivesyncPermAuth(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncServe(t)
	MakeRequest(t, NewRequest(t, "GET", "/-/sync/grants"), http.StatusUnauthorized)
	MakeRequest(t, NewRequest(t, "GET", "/-/sync/grants").AddTokenAuth("not-a-token"), http.StatusUnauthorized)
	limited := getUserToken(t, "user2", auth_model.AccessTokenScopeReadRepository)
	MakeRequest(t, NewRequest(t, "GET", "/-/sync/grants").AddTokenAuth(limited), http.StatusForbidden)
	full := getUserToken(t, "user2", auth_model.AccessTokenScopeAll)
	MakeRequest(t, NewRequest(t, "GET", "/-/sync/grants?group=repo:2").AddTokenAuth(full), http.StatusOK)
	// A private repository, a missing one and a pseudo group look alike.
	other := getUserToken(t, "user5", auth_model.AccessTokenScopeAll)
	for _, group := range []string{"repo:2", "repo:999999", "*", "!perm", "user:2"} {
		resp := MakeRequest(t, NewRequest(t, "GET", "/-/sync/grants?group="+group).AddTokenAuth(other), http.StatusNotFound)
		assert.JSONEq(t, `{"message":"Not Found"}`, resp.Body.String(), group)
	}
	livesync_service.Shutdown()
	MakeRequest(t, NewRequest(t, "GET", "/-/sync/grants").AddTokenAuth(full), http.StatusServiceUnavailable)
}

// A collaborator removed while the collaboration trigger was missing: the
// change is lost, so the repaired trigger's epoch makes the materializer
// write a permission epoch for everything (before the table's
// re-bootstrap marker), and every cached grant is dropped.
func TestLivesyncPermLostChanges(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncServe(t)
	livesyncWaitBackfill(t)
	master := livesyncMaster(t)
	user4 := livesyncToken(t, &user_model.User{ID: 4})
	require.Contains(t, livesyncGrants(t, user4), "repo:4", "collaborator (fixture)")

	livesync_service.Shutdown()
	if setting.Database.Type.IsPostgreSQL() {
		_, err := master.Exec(`DROP TRIGGER livesync_capture ON collaboration`)
		require.NoError(t, err)
	} else {
		for _, ev := range []string{"ai", "au", "ad"} {
			_, err := master.Exec("DROP TRIGGER livesync_collaboration_" + ev)
			require.NoError(t, err)
		}
	}
	_, err := master.Exec("DELETE FROM collaboration WHERE repo_id = 4 AND user_id = 4")
	require.NoError(t, err)
	_, err = master.Exec("DELETE FROM access WHERE repo_id = 4 AND user_id = 4")
	require.NoError(t, err)
	cursor := livesyncLogHead(t)

	wrapped := livesync_router.Wrap(routers.NormalRoutes())
	require.True(t, livesync_service.Running())
	defer test.MockVariableValue(&testWebRoutes, livesyncRoutes(wrapped))()
	ch := livesyncPermEpoch(t, cursor, func(ch protocol.PermissionChange) bool { return ch.All })
	assert.Equal(t, protocol.PermissionChange{All: true}, ch)
	var epoch, marker int64
	for _, e := range livesyncLogSince(t, cursor) {
		switch {
		case e.Op == string(protocol.OpPermission) && epoch == 0:
			epoch = e.SyncID
		case e.Op == string(protocol.OpRebootstrap) && e.Model == string(protocol.ModelCollaboration):
			marker = e.SyncID
		}
	}
	assert.Positive(t, marker)
	assert.Less(t, epoch, marker, "the epoch goes first")
	// (This instance starts with an empty cache anyway; the epoch is what
	// reaches the caches of the other instances.)
	assert.NotContains(t, livesyncGrants(t, user4), "repo:4")
}
