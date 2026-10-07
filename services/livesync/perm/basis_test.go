// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package perm

import (
	"testing"
	"time"

	"forgejo.org/models/db"
	repo_model "forgejo.org/models/repo"
	"forgejo.org/models/unittest"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/structs"
	"forgejo.org/services/livesync/protocol"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBasis(t *testing.T) {
	repo := &repo_model.Repository{ID: 7, OwnerID: 3, IsPrivate: true}
	assert.Equal(t, "true,3", RepositoryState(repo))
	u := &user_model.User{ID: 3, Visibility: structs.VisibleTypeLimited, IsActive: true, IsAdmin: true, Type: user_model.UserTypeOrganization}
	assert.Equal(t, "1,true,false,true,false,1", UserState(u))

	b := Basis{}
	b.addRepo(repo)
	b.addUser(u)
	b.addUser(nil)
	touch := func(kind string, id int64, state string) []protocol.PermissionTouch {
		return []protocol.PermissionTouch{{Kind: kind, ID: id, State: state}}
	}
	assert.False(t, b.Stale(nil))
	assert.False(t, b.Stale(touch(protocol.TouchRepository, 7, "true,3")), "the recorded state")
	assert.True(t, b.Stale(touch(protocol.TouchRepository, 7, "false,3")), "another state")
	assert.False(t, b.Stale(touch(protocol.TouchRepository, 8, "false,3")), "a row it did not read")
	assert.False(t, b.Stale(touch(protocol.TouchUser, 7, "x")), "kinds differ")
	assert.True(t, b.Stale(touch(protocol.TouchUser, 3, "1,true,false,false,false,1")))

	// A row read in two states: every touch of it is stale.
	b.addRepo(&repo_model.Repository{ID: 7, OwnerID: 3})
	assert.True(t, b.Stale(touch(protocol.TouchRepository, 7, "true,3")))
	assert.True(t, b.Stale(touch(protocol.TouchRepository, 7, "false,3")))
	assert.False(t, Basis(nil).Stale(touch(protocol.TouchRepository, 7, "true,3")))
}

func exec(t *testing.T, query string, args ...any) {
	t.Helper()
	_, err := db.GetEngine(t.Context()).Exec(append([]any{query}, args...)...)
	require.NoError(t, err)
}

// A permission change undone before the materializer read the row leaves
// no trace in its state, so the materializer sends a touch with the row's
// current state (protocol.PermissionChange.Touched): the cache drops the
// grants that were computed from another state of the row — those computed
// in between — and keeps the others (a counter update costs nothing).
func TestCacheTouches(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	ctx := t.Context()
	c := NewCache(time.Minute, 100)
	repoTouch := func(id int64) protocol.PermissionChange {
		r, err := repo_model.GetRepositoryByID(ctx, id)
		require.NoError(t, err)
		return protocol.PermissionChange{Touched: []protocol.PermissionTouch{{Kind: protocol.TouchRepository, ID: id, State: RepositoryState(r)}}}
	}
	userTouch := func(id int64) protocol.PermissionChange {
		u, err := user_model.GetUserByID(ctx, id)
		require.NoError(t, err)
		return protocol.PermissionChange{Touched: []protocol.PermissionTouch{{Kind: protocol.TouchUser, ID: id, State: UserState(u)}}}
	}

	// Repository 2 (user 2's, private) belongs to user 4 for a moment:
	// user 4's grants computed then have it.
	g4, err := c.Grants(ctx, 4)
	require.NoError(t, err)
	require.NotContains(t, groupsOf(g4), "repo:2")
	c.Invalidate(protocol.PermissionChange{All: true})
	exec(t, "UPDATE repository SET owner_id = 4 WHERE id = 2")
	g4, _ = c.Grants(ctx, 4)
	require.Contains(t, groupsOf(g4), "repo:2")
	exec(t, "UPDATE repository SET owner_id = 2 WHERE id = 2")
	g2, _ := c.Grants(ctx, 2)
	require.Contains(t, groupsOf(g2), "repo:2")
	g5, _ := c.Grants(ctx, 5)

	// The materializer sees owner 2 as stored and current: a touch.
	c.Invalidate(repoTouch(2))
	assert.Nil(t, c.cached(4), "computed from the undone state")
	assert.Same(t, g2, c.cached(2).grants, "computed from the current state")
	assert.Same(t, g5, c.cached(5).grants, "did not read repository 2")
	again, _ := c.Grants(ctx, 4)
	assert.NotContains(t, groupsOf(again), "repo:2")

	// Counters: the same state, nothing is dropped.
	exec(t, "UPDATE repository SET num_stars = num_stars + 1 WHERE id = 2")
	c.Invalidate(repoTouch(2))
	assert.Same(t, g2, c.cached(2).grants)

	// User 5 restricted for a moment, and a site administrator.
	c.Invalidate(protocol.PermissionChange{All: true})
	exec(t, "UPDATE `user` SET is_restricted = ? WHERE id = 5", true)
	g5, _ = c.Grants(ctx, 5)
	require.NotContains(t, groupsOf(g5), protocol.GroupProfilesLimited)
	exec(t, "UPDATE `user` SET is_restricted = ? WHERE id = 5", false)
	g2, _ = c.Grants(ctx, 2)
	c.Invalidate(userTouch(5))
	assert.Nil(t, c.cached(5))
	assert.Same(t, g2, c.cached(2).grants)
	g5, _ = c.Grants(ctx, 5)
	assert.Contains(t, groupsOf(g5), protocol.GroupProfilesLimited)
	c.Invalidate(userTouch(5))
	assert.Same(t, g5, c.cached(5).grants, "a sign-in: same state")

	// Owners' rows count too: user 2's grants read user 2's row as the
	// owner of their repositories and as the viewer.
	exec(t, "UPDATE `user` SET visibility = ? WHERE id = 2", structs.VisibleTypePrivate)
	c.Invalidate(userTouch(2))
	assert.Nil(t, c.cached(2))
	exec(t, "UPDATE `user` SET visibility = ? WHERE id = 2", structs.VisibleTypePublic)

	// The index stays consistent.
	c.Invalidate(protocol.PermissionChange{All: true})
	for _, id := range []int64{2, 4, 5} {
		_, _ = c.Grants(ctx, id)
	}
	c.Invalidate(protocol.PermissionChange{Users: []int64{4}})
	for k, set := range c.byRow {
		assert.NotEmpty(t, set, "%v", k)
		for id := range set {
			require.Contains(t, c.entries, id, "index of %v", k)
			assert.Contains(t, c.entries[id].Value.(*cacheEntry).grants.basis, k)
		}
	}
	assert.NotContains(t, c.byRow[basisKey{protocol.TouchUser, 4}], int64(4))
}

// Decisions record the repository and user rows they were decided from,
// so the hub (B5) can re-check a subscription when a touch says that one
// of them is in another state now.
func TestDecisionBasis(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	ctx := t.Context()
	c := NewCache(time.Minute, 100)
	touch := func(kind string, id int64, state string) []protocol.PermissionTouch {
		return []protocol.PermissionTouch{{Kind: kind, ID: id, State: state}}
	}
	u2, err := user_model.GetUserByID(ctx, 2)
	require.NoError(t, err)
	u4, err := user_model.GetUserByID(ctx, 4)
	require.NoError(t, err)

	// On demand: repository 1 (public, user 2's) for user 4.
	d, ok, err := c.Check(ctx, 4, "repo:1")
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, Basis{
		{protocol.TouchRepository, 1}: "false,2",
		{protocol.TouchUser, 2}:       UserState(u2),
		{protocol.TouchUser, 4}:       UserState(u4),
	}, d.Basis)
	assert.True(t, d.Basis.Stale(touch(protocol.TouchRepository, 1, "true,2")), "made private and public again")
	assert.False(t, d.Basis.Stale(touch(protocol.TouchRepository, 1, "false,2")))

	// A denial records its basis too (repository 2 is private).
	d, ok, err = c.Check(ctx, 4, "repo:2")
	require.NoError(t, err)
	require.False(t, ok)
	assert.Equal(t, "true,2", d.Basis[basisKey{protocol.TouchRepository, 2}])

	// Issues: the repository's rows.
	d, ok, err = c.Check(ctx, 4, "issue:1")
	require.NoError(t, err)
	require.True(t, ok)
	assert.Contains(t, d.Basis, basisKey{protocol.TouchRepository, 1})

	// Profiles and organizations: the user's or organization's row.
	d, ok, err = c.Check(ctx, 4, "profile:5")
	require.NoError(t, err)
	require.True(t, ok)
	assert.Contains(t, d.Basis, basisKey{protocol.TouchUser, 5})
	d, ok, err = c.Check(ctx, 4, "org:3")
	require.NoError(t, err)
	require.True(t, ok)
	assert.Contains(t, d.Basis, basisKey{protocol.TouchUser, 3})
	d, ok, err = c.Check(ctx, 4, protocol.GroupProfilesLimited)
	require.NoError(t, err)
	require.True(t, ok)
	assert.True(t, d.Basis.Stale(touch(protocol.TouchUser, 4, "restricted now")))

	// From cached grants: the grants' basis.
	g, err := c.Grants(ctx, 2)
	require.NoError(t, err)
	d, ok, err = c.Check(ctx, 2, "repo:2")
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, g.basis, d.Basis)
	assert.Equal(t, "true,2", d.Basis[basisKey{protocol.TouchRepository, 2}])
}

// A touch that arrives while a computation runs is decided when it
// finishes: cached only if the computation read the touched row in the
// touch's state (or not at all).
func TestCacheTouchedWhileComputing(t *testing.T) {
	ctx := t.Context()
	c := NewCache(time.Minute, 10)
	requests := stubLoader(c)
	withBasis := func(g *Grants, repoState string) *Grants {
		g.basis = Basis{{protocol.TouchRepository, 1}: repoState}
		return g
	}
	touch := protocol.PermissionChange{Touched: []protocol.PermissionTouch{{Kind: protocol.TouchRepository, ID: 1, State: "true,2"}}}

	a := asyncGrants(ctx, c, 6)
	req := <-requests
	c.Invalidate(touch)
	later := asyncGrants(ctx, c, 6)
	req2 := <-requests // a caller after the touch does not join
	req.answer <- withBasis(grantsOf(6, "repo:1"), "false,2")
	assert.Contains(t, groupsOf(<-a), "repo:1")
	assert.Nil(t, c.cached(6), "read another state: not cached")
	req2.answer <- withBasis(grantsOf(6), "true,2")
	<-later
	assert.NotNil(t, c.cached(6), "read the touched state: cached")

	c.Invalidate(protocol.PermissionChange{All: true})
	a = asyncGrants(ctx, c, 6)
	req = <-requests
	c.Invalidate(touch)
	req.answer <- grantsOf(6, "repo:3")
	<-a
	assert.NotNil(t, c.cached(6), "did not read the row: cached")
}
