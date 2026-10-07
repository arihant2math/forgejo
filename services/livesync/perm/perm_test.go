// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package perm

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"forgejo.org/models/db"
	issues_model "forgejo.org/models/issues"
	livesync_model "forgejo.org/models/livesync"
	org_model "forgejo.org/models/organization"
	access_model "forgejo.org/models/perm/access"
	repo_model "forgejo.org/models/repo"
	unit_model "forgejo.org/models/unit"
	"forgejo.org/models/unittest"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/structs"
	"forgejo.org/services/livesync/protocol"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUnitSet(t *testing.T) {
	none := UnitSet(0)
	assert.False(t, none.Allows(protocol.UnitNone), "a group that is not granted allows nothing")

	base := unitBase
	assert.True(t, base.Allows(protocol.UnitNone))
	assert.False(t, base.Allows(protocol.UnitIssues))

	s := unitBase | Mask(protocol.UnitIssues) | Mask(protocol.UnitCode)
	assert.True(t, s.Allows(protocol.UnitNone))
	assert.True(t, s.Allows(protocol.UnitIssues))
	assert.True(t, s.Allows(protocol.UnitIssuesOrPulls), "any alternative")
	assert.True(t, s.Allows("pulls|code"))
	assert.False(t, s.Allows(protocol.UnitPulls))
	assert.False(t, s.Allows(protocol.UnitSelf))
	assert.False(t, s.Allows("no_such_unit"), "unknown units are never granted")
	assert.False(t, s.Allows("no_such_unit|pulls"))
	assert.True(t, s.Allows("no_such_unit|issues"), "a known alternative")
	assert.Equal(t, []protocol.Unit{protocol.UnitCode, protocol.UnitIssues}, s.Units())
	assert.Equal(t, []protocol.Unit{}, base.Units())
	assert.Equal(t, unitIssues|unitPulls, Mask("pulls|issues"))

	for _, ut := range unit_model.AllRepoUnitTypes {
		u := UnitOf(ut)
		assert.NotEqual(t, unitUnknown, Mask(u), "unit %v has a bit", ut)
	}
	assert.Equal(t, protocol.Unit("unknown_99"), UnitOf(99))
}

func TestParseGroup(t *testing.T) {
	cases := map[string]struct {
		kind groupKind
		id   int64
	}{
		"user:1":            {kindUser, 1},
		"profile:31":        {kindProfile, 31},
		"profiles:public":   {kindProfilesPublic, 0},
		"profiles:limited":  {kindProfilesLimited, 0},
		"org:3":             {kindOrg, 3},
		"repo:12":           {kindRepo, 12},
		"issue:7":           {kindIssue, 7},
		"*":                 {kindInvalid, 0},
		"!perm":             {kindInvalid, 0},
		"repo:":             {kindInvalid, 0},
		"repo:0":            {kindInvalid, 0},
		"repo:-1":           {kindInvalid, 0},
		"repo:01":           {kindInvalid, 0},
		"repo:1x":           {kindInvalid, 0},
		"repos:1":           {kindInvalid, 0},
		"profiles:private":  {kindInvalid, 0},
		"repo:1:2":          {kindInvalid, 0},
		"repo:+1":           {kindInvalid, 0},
		"repo: 1":           {kindInvalid, 0},
		"issue:99999999999": {kindIssue, 99999999999},
	}
	for group, want := range cases {
		kind, id := parseGroup(group)
		assert.Equal(t, want.kind, kind, group)
		assert.Equal(t, want.id, id, group)
	}
}

// Every decision equals upstream's own check, for every fixture user and
// repository, organization and user: GetUserRepoPermission (HasAccess,
// CanRead per unit), HasOrgOrUserVisible + IsOrganizationMember,
// API v1's private-user rule + IsUserVisibleToViewer. (The HTTP
// differential against API v1 is
// TestLivesyncPermDifferential.)
func TestCheckMatchesUpstream(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	ctx := t.Context()
	c := NewCache(0, 0)
	var users []*user_model.User
	require.NoError(t, db.GetEngine(ctx).OrderBy("id").Find(&users))
	var repos []*repo_model.Repository
	require.NoError(t, db.GetEngine(ctx).OrderBy("id").Find(&repos))
	for _, viewer := range users {
		for _, repo := range repos {
			d, ok, err := c.Check(ctx, viewer.ID, protocol.RepoGroup(repo.ID))
			require.NoError(t, err)
			if !usable(viewer) {
				assert.False(t, ok, "viewer %d may not sign in", viewer.ID)
				continue
			}
			p, err := access_model.GetUserRepoPermission(ctx, repo, viewer)
			require.NoError(t, err)
			require.Equal(t, p.HasAccess(), ok, "viewer %d repo %d", viewer.ID, repo.ID)
			if !ok {
				continue
			}
			assert.Equal(t, repo.ID, d.RepoID)
			for _, ut := range unit_model.AllRepoUnitTypes {
				assert.Equal(t, p.CanRead(ut), d.Units.Allows(UnitOf(ut)), "viewer %d repo %d unit %v", viewer.ID, repo.ID, ut)
			}
		}
		for _, target := range users {
			if !usable(viewer) {
				continue
			}
			if target.IsOrganization() {
				d, ok, err := c.Check(ctx, viewer.ID, protocol.OrgGroup(target.ID))
				require.NoError(t, err)
				require.Equal(t, org_model.HasOrgOrUserVisible(ctx, target, viewer), ok, "viewer %d org %d", viewer.ID, target.ID)
				member, err := org_model.IsOrganizationMember(ctx, target.ID, viewer.ID)
				require.NoError(t, err)
				assert.Equal(t, ok && (member || viewer.IsAdmin), d.Units.Allows(protocol.UnitMembers), "viewer %d org %d", viewer.ID, target.ID)
				_, ok, err = c.Check(ctx, viewer.ID, protocol.ProfileGroup(target.ID))
				require.NoError(t, err)
				assert.False(t, ok, "organizations have no profile group")
				continue
			}
			_, ok, err := c.Check(ctx, viewer.ID, protocol.ProfileGroup(target.ID))
			require.NoError(t, err)
			want := user_model.IsUserVisibleToViewer(ctx, target, viewer) &&
				(target.Visibility != structs.VisibleTypePrivate || viewer.ID == target.ID || viewer.IsAdmin)
			assert.Equal(t, want, ok, "viewer %d profile %d", viewer.ID, target.ID)
			_, ok, err = c.Check(ctx, viewer.ID, protocol.UserGroup(target.ID))
			require.NoError(t, err)
			assert.Equal(t, viewer.ID == target.ID, ok, "user:%d only for that user", target.ID)
		}
	}
}

// The grant computation decides repositories from batched inputs
// (viewerInputs.repoPermission) instead of calling GetUserRepoPermission per
// repository: for every fixture user and every repository (related or not),
// the two agree on access and on every unit, and the implicit grants are
// exactly the related repositories upstream gives access to.
func TestGrantsMatchUpstream(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	ctx := t.Context()
	var users []*user_model.User
	require.NoError(t, db.GetEngine(ctx).OrderBy("id").Find(&users))
	var repos []*repo_model.Repository
	require.NoError(t, db.GetEngine(ctx).OrderBy("id").Find(&repos))
	require.NoError(t, loadOwners(ctx, repos))
	ids := make([]int64, 0, len(repos))
	for _, r := range repos {
		ids = append(ids, r.ID)
	}
	units, err := loadRepoUnits(ctx, ids)
	require.NoError(t, err)
	compared := 0
	for _, viewer := range users {
		if !usable(viewer) {
			continue
		}
		in, err := loadViewerInputs(ctx, viewer.ID)
		require.NoError(t, err)
		related, err := in.relatedRepos(ctx, viewer.ID)
		require.NoError(t, err)
		g, err := compute(ctx, viewer, viewer.ID)
		require.NoError(t, err)
		for _, repo := range repos {
			if repo.Owner == nil {
				continue
			}
			got := in.repoPermission(viewer, repo, units[repo.ID])
			fresh := *repo
			fresh.Owner, fresh.Units = nil, nil
			want, err := access_model.GetUserRepoPermission(ctx, &fresh, viewer)
			require.NoError(t, err)
			require.Equal(t, want.HasAccess(), got.HasAccess(), "viewer %d repo %d", viewer.ID, repo.ID)
			assert.Equal(t, repoUnits(&want), repoUnits(&got), "viewer %d repo %d", viewer.ID, repo.ID)
			_, granted := g.Units(protocol.RepoGroup(repo.ID))
			assert.Equal(t, want.HasAccess() && slices.Contains(related, repo.ID), granted, "viewer %d repo %d implicit", viewer.ID, repo.ID)
			compared++
		}
	}
	assert.Greater(t, compared, 1000)
}

func groupsOf(g *Grants) map[string][]protocol.Unit {
	res := map[string][]protocol.Unit{}
	for _, gr := range g.Wire().Grants {
		res[gr.Group] = gr.Units
	}
	return res
}

func TestGrants(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	ctx := t.Context()
	c := NewCache(0, 0)

	// user2 owns repositories, collaborates on repo 3 (org3) and is a
	// member of org3 (owners team) and org17.
	g, err := c.Grants(ctx, 2)
	require.NoError(t, err)
	groups := groupsOf(g)
	assert.Equal(t, []protocol.Unit{protocol.UnitSelf}, groups["user:2"])
	assert.Equal(t, []protocol.Unit{}, groups["profile:2"])
	assert.Contains(t, groups, protocol.GroupProfilesPublic)
	assert.Contains(t, groups, protocol.GroupProfilesLimited)
	assert.Equal(t, []protocol.Unit{protocol.UnitMembers}, groups["org:3"])
	assert.Contains(t, groups["repo:1"], protocol.UnitIssues)
	assert.Contains(t, groups["repo:1"], protocol.UnitCode)
	assert.Contains(t, groups, "repo:2", "own private repository")
	assert.Contains(t, groups, "repo:3", "org3's repository")
	assert.NotContains(t, groups, "user:1")
	assert.NotContains(t, groups, "repo:4", "user5's public repository: on demand only")
	_, ok, err := c.Check(ctx, 2, "repo:4")
	require.NoError(t, err)
	assert.True(t, ok, "but readable")

	// Every implicit grant is what an on-demand check of a fresh cache
	// says, units included.
	fresh := NewCache(0, 0)
	for _, viewer := range []int64{1, 2, 4, 5, 15, 20, 28, 29, 31, 38, 40} {
		g, err := c.Grants(ctx, viewer)
		require.NoError(t, err)
		u, _, err := lookupUser(ctx, viewer)
		require.NoError(t, err)
		for group, units := range g.groups {
			d, ok, err := check(ctx, &u, group)
			require.NoError(t, err)
			require.True(t, ok, "viewer %d group %s", viewer, group)
			assert.Equal(t, d.Units, units, "viewer %d group %s", viewer, group)
		}
		_, err = fresh.Grants(ctx, viewer)
		require.NoError(t, err)
	}

	// The site administrator gets no implicit groups beyond their own
	// relations, but may read anything on demand, like upstream.
	g, err = c.Grants(ctx, 1)
	require.NoError(t, err)
	groups = groupsOf(g)
	assert.NotContains(t, groups, "repo:2")
	assert.NotContains(t, groups, "org:3")
	d, ok, err := c.Check(ctx, 1, "repo:2")
	require.NoError(t, err)
	assert.True(t, ok)
	assert.True(t, d.Units.Allows(protocol.UnitCode))
	d, ok, err = c.Check(ctx, 1, "org:3")
	require.NoError(t, err)
	assert.True(t, ok)
	assert.True(t, d.Units.Allows(protocol.UnitMembers), "API v1 lets site administrators read teams")

	// A restricted user does not see limited profiles.
	g, err = c.Grants(ctx, 29)
	require.NoError(t, err)
	assert.NotContains(t, groupsOf(g), protocol.GroupProfilesLimited)
	_, ok, err = c.Check(ctx, 29, protocol.GroupProfilesLimited)
	require.NoError(t, err)
	assert.False(t, ok)

	// Viewers who may not sign in, organizations and unknown users get
	// nothing.
	for _, id := range []int64{9 /* inactive */, 37 /* prohibited */, 3 /* org */, 999999} {
		g, err := c.Grants(ctx, id)
		require.NoError(t, err)
		assert.Empty(t, g.groups, "viewer %d", id)
		_, ok, err := c.Check(ctx, id, protocol.GroupProfilesPublic)
		require.NoError(t, err)
		assert.False(t, ok, "viewer %d", id)
	}

	// Private profiles: like API v1, only the user and site administrators
	// — not user33, whom user31 follows, nor user20, who shares a team
	// with user31 (the web profile page would show it to both).
	for viewer, want := range map[int64]bool{33: false, 20: false, 31: true, 4: false, 1: true} {
		_, ok, err := c.Check(ctx, viewer, "profile:31")
		require.NoError(t, err)
		assert.Equal(t, want, ok, "viewer %d", viewer)
	}

	// Pseudo groups are never granted.
	for _, group := range []string{protocol.GroupAll, protocol.GroupPermission, "", "repo:abc"} {
		_, ok, err := c.Check(ctx, 2, group)
		require.NoError(t, err)
		assert.False(t, ok, group)
	}
}

func TestCheckIssue(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	ctx := t.Context()
	c := NewCache(0, 0)
	pull := unittest.AssertExistsAndLoadBean(t, &issues_model.Issue{ID: 2})
	require.True(t, pull.IsPull)
	d, ok, err := c.Check(ctx, 2, "issue:2")
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, pull.RepoID, d.RepoID)

	// Without the pulls unit, the pull request's issue group is refused
	// but the repository's issues stay readable.
	_, err = db.GetEngine(ctx).Exec("DELETE FROM repo_unit WHERE repo_id = ? AND `type` = ?", pull.RepoID, unit_model.TypePullRequests)
	require.NoError(t, err)
	_, ok, err = c.Check(ctx, 4, "issue:2")
	require.NoError(t, err)
	assert.False(t, ok)
	_, ok, err = c.Check(ctx, 4, "issue:1")
	require.NoError(t, err)
	assert.True(t, ok)

	// A private repository's issue: not for strangers.
	private := unittest.AssertExistsAndLoadBean(t, &repo_model.Repository{ID: 2})
	require.True(t, private.IsPrivate)
	issue := unittest.AssertExistsAndLoadBean(t, &issues_model.Issue{RepoID: 2, Index: 1})
	_, ok, err = c.Check(ctx, 4, fmt.Sprintf("issue:%d", issue.ID))
	require.NoError(t, err)
	assert.False(t, ok)
	_, ok, err = c.Check(ctx, 2, "issue:999999")
	require.NoError(t, err)
	assert.False(t, ok, "missing issue")
}

func TestCache(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	ctx := t.Context()
	now := time.Unix(1000, 0)
	c := NewCache(time.Minute, 3)
	c.now = func() time.Time { return now }

	g2, err := c.Grants(ctx, 2)
	require.NoError(t, err)
	again, err := c.Grants(ctx, 2)
	require.NoError(t, err)
	assert.Same(t, g2, again, "cached")

	// A change of the database is not seen until invalidated.
	_, err = db.GetEngine(ctx).Exec("DELETE FROM org_user WHERE uid = 2 AND org_id = 3")
	require.NoError(t, err)
	again, _ = c.Grants(ctx, 2)
	assert.Contains(t, groupsOf(again), "org:3")
	c.Invalidate(protocol.PermissionChange{Users: []int64{5}})
	again, _ = c.Grants(ctx, 2)
	assert.Same(t, g2, again, "another user's epoch")
	c.Invalidate(protocol.PermissionChange{Users: []int64{2}})
	again, _ = c.Grants(ctx, 2)
	assert.NotSame(t, g2, again)
	assert.NotContains(t, groupsOf(again), "org:3")

	// Repositories and owners invalidate the viewers granted their
	// groups (and only them).
	g4, _ := c.Grants(ctx, 4)
	require.Contains(t, groupsOf(g4), "repo:4", "collaborator")
	g2, _ = c.Grants(ctx, 2)
	require.NotContains(t, groupsOf(g2), "repo:4")
	c.Invalidate(protocol.PermissionChange{Repos: []int64{4}})
	again, _ = c.Grants(ctx, 4)
	assert.NotSame(t, g4, again)
	g4 = again
	again, _ = c.Grants(ctx, 2)
	assert.Same(t, g2, again)
	c.Invalidate(protocol.PermissionChange{Owners: []int64{17}})
	again, _ = c.Grants(ctx, 2)
	assert.NotSame(t, g2, again, "user2 is a member of org17")
	g2 = again
	again, _ = c.Grants(ctx, 4)
	assert.Same(t, g4, again)
	c.Invalidate(protocol.PermissionChange{Owners: []int64{4}})
	again, _ = c.Grants(ctx, 4)
	assert.NotSame(t, g4, again, "own profile group")

	// All drops everything.
	c.Invalidate(protocol.PermissionChange{All: true})
	again, _ = c.Grants(ctx, 2)
	assert.NotSame(t, g2, again)
	g2 = again

	// TTL.
	now = now.Add(2 * time.Minute)
	again, _ = c.Grants(ctx, 2)
	assert.NotSame(t, g2, again, "expired")

	// Size: the least recently used entry goes first.
	_, _ = c.Grants(ctx, 4)
	_, _ = c.Grants(ctx, 5)
	_, _ = c.Grants(ctx, 2) // most recent
	_, _ = c.Grants(ctx, 15)
	assert.Equal(t, 3, c.lru.Len())
	assert.Contains(t, c.entries, int64(2))
	assert.NotContains(t, c.entries, int64(4))
	for group, set := range c.byGroup {
		for id := range set {
			assert.Contains(t, c.entries, id, "index of %s", group)
		}
	}
}

// stubLoader makes a cache's computations wait for the test: every
// computation sends its request and blocks until the test answers it.
type stubLoad struct {
	viewer int64
	answer chan *Grants
}

func stubLoader(c *Cache) chan stubLoad {
	requests := make(chan stubLoad)
	c.load = func(ctx context.Context, viewerID int64) (*cacheEntry, error) {
		req := stubLoad{viewer: viewerID, answer: make(chan *Grants)}
		requests <- req
		select {
		case g := <-req.answer:
			return &cacheEntry{grants: g, viewer: &user_model.User{ID: viewerID}, expires: c.now().Add(c.ttl)}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return requests
}

func grantsOf(viewer int64, groups ...string) *Grants {
	g := &Grants{ViewerID: viewer, groups: map[string]UnitSet{}}
	for _, group := range groups {
		g.groups[group] = unitBase
	}
	return g
}

// asyncGrants calls Grants in a goroutine.
func asyncGrants(ctx context.Context, c *Cache, viewer int64) chan *Grants {
	res := make(chan *Grants, 1)
	go func() {
		g, err := c.Grants(ctx, viewer)
		if err != nil {
			g = nil
		}
		res <- g
	}()
	return res
}

// settled gives callers started just before time to reach their wait
// (joining a computation or starting one).
func settled() {
	time.Sleep(50 * time.Millisecond)
}

// A computation that overlapped an invalidation concerning it is neither
// cached nor joined by callers that came after the invalidation (they would
// get a result read before the change, e.g. a hub re-checking a viewer
// right after a revocation).
func TestCacheInvalidatedWhileComputing(t *testing.T) {
	ctx := t.Context()
	c := NewCache(time.Minute, 10)
	requests := stubLoader(c)

	// An epoch naming the viewer: later callers start afresh, the old
	// result goes to its own waiters only and is not cached.
	old := asyncGrants(ctx, c, 5)
	first := <-requests
	c.Invalidate(protocol.PermissionChange{Users: []int64{5}})
	fresh := asyncGrants(ctx, c, 5)
	second := <-requests
	first.answer <- grantsOf(5, "repo:2")
	assert.Contains(t, groupsOf(<-old), "repo:2")
	second.answer <- grantsOf(5)
	assert.NotContains(t, groupsOf(<-fresh), "repo:2", "joined a computation from before the invalidation")
	g, err := c.Grants(ctx, 5)
	require.NoError(t, err)
	assert.NotContains(t, groupsOf(g), "repo:2", "the newer result is cached, not the stale one")
	assert.Empty(t, c.running)
	assert.Empty(t, c.inflight)

	// An unrelated epoch: later callers join, the result is cached.
	a := asyncGrants(ctx, c, 6)
	req := <-requests
	c.Invalidate(protocol.PermissionChange{Users: []int64{7}})
	b := asyncGrants(ctx, c, 6)
	settled()
	req.answer <- grantsOf(6, "repo:1")
	ga, gb := <-a, <-b
	assert.Same(t, ga, gb, "joined")
	g, _ = c.Grants(ctx, 6)
	assert.Same(t, ga, g, "cached")

	// A repository's epoch: decided when the computation finishes.
	c.Invalidate(protocol.PermissionChange{All: true})
	a = asyncGrants(ctx, c, 6)
	req = <-requests
	c.Invalidate(protocol.PermissionChange{Repos: []int64{3}})
	req.answer <- grantsOf(6, "repo:1")
	ga = <-a
	g, _ = c.Grants(ctx, 6)
	assert.Same(t, ga, g, "repo:3 is not granted: cached")
	c.Invalidate(protocol.PermissionChange{All: true})
	a = asyncGrants(ctx, c, 6)
	req = <-requests
	c.Invalidate(protocol.PermissionChange{Repos: []int64{1}})
	req.answer <- grantsOf(6, "repo:1")
	<-a
	assert.Nil(t, c.cached(6), "repo:1 is granted: not cached")

	// Invalidations remembered per computation are bounded.
	a = asyncGrants(ctx, c, 6)
	req = <-requests
	for i := range 3 * maxCallChanges {
		c.Invalidate(protocol.PermissionChange{Repos: []int64{int64(1000 + i)}})
	}
	c.mu.Lock()
	for cl := range c.running {
		assert.LessOrEqual(t, len(cl.changes), maxCallChanges)
		assert.True(t, cl.stale)
	}
	c.mu.Unlock()
	req.answer <- grantsOf(6)
	<-a
	assert.Nil(t, c.cached(6))
}

// A caller whose context ends stops waiting; the computation it started
// goes on for the others and is cached.
func TestCacheCancelledCaller(t *testing.T) {
	ctx := t.Context()
	c := NewCache(time.Minute, 10)
	requests := stubLoader(c)
	cancelled, cancel := context.WithCancel(ctx)
	leader := make(chan error, 1)
	go func() {
		_, err := c.Grants(cancelled, 5)
		leader <- err
	}()
	req := <-requests
	waiter := asyncGrants(ctx, c, 5)
	settled()
	cancel()
	require.ErrorIs(t, <-leader, context.Canceled)
	req.answer <- grantsOf(5, "repo:2")
	assert.Contains(t, groupsOf(<-waiter), "repo:2")
	assert.NotNil(t, c.cached(5))
}

func TestCacheConcurrent(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	ctx := t.Context()
	c := NewCache(0, 0)
	done := make(chan *Grants, 8)
	for range 8 {
		go func() {
			g, err := c.Grants(ctx, 2)
			assert.NoError(t, err)
			done <- g
		}()
	}
	first := <-done
	for range 7 {
		g := <-done
		assert.Equal(t, first.Wire(), g.Wire())
	}
	assert.Empty(t, c.inflight)
	assert.Empty(t, c.running)
}

func TestDecodeChange(t *testing.T) {
	_, ok, err := DecodeChange(&livesync_model.LogEntry{Op: "U", Payload: "{}"})
	require.NoError(t, err)
	assert.False(t, ok)
	ch, ok, err := DecodeChange(&livesync_model.LogEntry{Op: "P", Payload: `{"users":[1,2],"repos":[3],"owners":[4]}`})
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, protocol.PermissionChange{Users: []int64{1, 2}, Repos: []int64{3}, Owners: []int64{4}}, ch)
	_, ok, err = DecodeChange(&livesync_model.LogEntry{Op: "P", Payload: `nope`})
	assert.True(t, ok)
	assert.Error(t, err)
}
