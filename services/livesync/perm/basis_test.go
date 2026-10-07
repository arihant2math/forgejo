// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package perm

import (
	"context"
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

	// From cached grants: the part of the grants' basis that decided the
	// group (the repository, its owner, the viewer).
	g, err := c.Grants(ctx, 2)
	require.NoError(t, err)
	d, ok, err = c.Check(ctx, 2, "repo:2")
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, Basis{{protocol.TouchRepository, 2}: "true,2", {protocol.TouchUser, 2}: UserState(u2)}, d.Basis)
	assert.Greater(t, len(g.basis), len(d.Basis), "the grants read more rows")
	g, err = c.Grants(ctx, 4)
	require.NoError(t, err)
	d, ok, err = c.Check(ctx, 4, "repo:3") // org3's, through a team
	require.NoError(t, err)
	require.True(t, ok)
	u3, err := user_model.GetUserByID(ctx, 3)
	require.NoError(t, err)
	assert.Equal(t, Basis{{protocol.TouchRepository, 3}: g.basis[basisKey{protocol.TouchRepository, 3}], {protocol.TouchUser, 3}: UserState(u3), {protocol.TouchUser, 4}: UserState(u4)}, d.Basis)
	d, ok, err = c.Check(ctx, 4, protocol.UserGroup(4))
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, Basis{{protocol.TouchUser, 4}: UserState(u4)}, d.Basis, "the viewer's row only")
}

// A touch that arrives while a computation runs is decided when it
// finishes: cached only if the computation read the touched row in the
// touch's state (or not at all). Touches come with almost every write
// batch, so they do not detach the computation: callers after a touch join
// it, and compute again only if its result is stale against the touch.
func TestCacheTouchedWhileComputing(t *testing.T) {
	ctx := t.Context()
	c := NewCache(time.Minute, 10)
	requests := stubLoader(c)
	withBasis := func(g *Grants, repoState string) *Grants {
		g.basis = Basis{{protocol.TouchRepository, 1}: repoState}
		return g
	}
	touchOf := func(id int64, state string) protocol.PermissionChange {
		return protocol.PermissionChange{Touched: []protocol.PermissionTouch{{Kind: protocol.TouchRepository, ID: id, State: state}}}
	}
	touch := touchOf(1, "true,2")
	noMore := func() {
		t.Helper()
		settled()
		select {
		case req := <-requests:
			t.Fatalf("unexpected computation for viewer %d", req.viewer)
		default:
		}
	}
	next := func() stubLoad {
		t.Helper()
		select {
		case req := <-requests:
			return req
		case <-time.After(10 * time.Second):
			t.Fatal("no computation started")
			return stubLoad{}
		}
	}
	reset := func() {
		c.Invalidate(protocol.PermissionChange{All: true})
		c.mu.Lock()
		defer c.mu.Unlock()
		assert.Empty(t, c.running)
		assert.Empty(t, c.inflight)
		assert.Zero(t, c.tracking.Len())
		assert.Empty(t, c.touches.rows, "touches kept with no computation running")
	}

	// Stale against the touch: the caller before it gets the result, the
	// one after it computes again; only the fresh result is cached.
	a := asyncGrants(ctx, c, 6)
	req := next()
	c.Invalidate(touch)
	later := asyncGrants(ctx, c, 6)
	noMore() // joined
	req.answer <- withBasis(grantsOf(6, "repo:1"), "false,2")
	assert.Contains(t, groupsOf(<-a), "repo:1")
	req2 := next() // the later caller computes again
	assert.Nil(t, c.cached(6), "read another state: not cached")
	req2.answer <- withBasis(grantsOf(6), "true,2")
	assert.NotContains(t, groupsOf(<-later), "repo:1", "got a result from before the touch")
	assert.NotNil(t, c.cached(6), "read the touched state: cached")
	noMore()

	// Did not read the row: cached, joined.
	reset()
	a = asyncGrants(ctx, c, 6)
	req = next()
	c.Invalidate(touch)
	later = asyncGrants(ctx, c, 6)
	noMore()
	req.answer <- grantsOf(6, "repo:3")
	assert.Same(t, <-a, <-later)
	assert.NotNil(t, c.cached(6), "did not read the row: cached")

	// Read the touched state: cached, joined.
	reset()
	a = asyncGrants(ctx, c, 6)
	req = next()
	c.Invalidate(touch)
	later = asyncGrants(ctx, c, 6)
	noMore()
	req.answer <- withBasis(grantsOf(6, "repo:1"), "true,2")
	assert.Same(t, <-a, <-later)
	assert.NotNil(t, c.cached(6))

	// Regression (review round 4): touches of rows it did not read, any
	// number of them, neither detach the computation nor keep it from
	// being cached (they used to count toward maxCallChanges).
	reset()
	a = asyncGrants(ctx, c, 6)
	req = next()
	c.Invalidate(touchOf(1000, "false,1"))
	later = asyncGrants(ctx, c, 6)
	for i := range 2 * maxCallChanges {
		c.Invalidate(touchOf(int64(1000+i), "false,1"))
	}
	alsoLater := asyncGrants(ctx, c, 6)
	noMore() // both joined
	req.answer <- withBasis(grantsOf(6, "repo:1"), "false,2")
	ga := <-a
	assert.Same(t, ga, <-later, "unrelated touch detached the computation")
	assert.Same(t, ga, <-alsoLater)
	assert.Same(t, ga, c.cachedGrants(6), "not cached after unrelated touches")

	// Touches are recorded once per row, however often it is touched.
	reset()
	a = asyncGrants(ctx, c, 6)
	req = next()
	for range 3 {
		c.Invalidate(protocol.PermissionChange{Touched: []protocol.PermissionTouch{
			{Kind: protocol.TouchRepository, ID: 5, State: "false,1"},
			{Kind: protocol.TouchUser, ID: 5, State: "u"},
		}})
	}
	c.mu.Lock()
	assert.Len(t, c.touches.rows, 2)
	for cl := range c.running {
		assert.Equal(t, uint64(3), c.touches.seq-cl.since)
		assert.False(t, cl.stale)
	}
	c.mu.Unlock()
	req.answer <- grantsOf(6)
	<-a
	assert.NotNil(t, c.cached(6))

	// A row touched in two states (an epoch changed it in between) is
	// stale for any state the computation read.
	reset()
	a = asyncGrants(ctx, c, 6)
	req = next()
	c.Invalidate(touch)
	c.Invalidate(touchOf(1, "false,2"))
	later = asyncGrants(ctx, c, 6)
	noMore()
	req.answer <- withBasis(grantsOf(6, "repo:1"), "false,2")
	<-a
	req2 = next()
	assert.Nil(t, c.cached(6))
	req2.answer <- withBasis(grantsOf(6, "repo:1"), "false,2")
	<-later
	assert.NotNil(t, c.cached(6))

	// An epoch that also carries touches: the epoch part detaches as
	// before, the touches are recorded (not kept on the change).
	reset()
	a = asyncGrants(ctx, c, 6)
	req = next()
	mixed := touch
	mixed.Repos = []int64{3}
	c.Invalidate(mixed)
	c.mu.Lock()
	for cl := range c.running {
		require.Len(t, cl.changes, 1)
		assert.Empty(t, cl.changes[0].Touched)
	}
	assert.Len(t, c.touches.rows, 1)
	c.mu.Unlock()
	later = asyncGrants(ctx, c, 6)
	req2 = next() // detached by the epoch
	req.answer <- withBasis(grantsOf(6), "false,2")
	<-a
	assert.Nil(t, c.cached(6), "stale against the touch")
	req2.answer <- withBasis(grantsOf(6), "true,2")
	<-later
	assert.NotNil(t, c.cached(6))

	// The touched rows remembered are bounded: beyond the bound, the
	// running computations lose their touches (not cached, detached, and
	// the callers that joined after a touch compute again).
	reset()
	a = asyncGrants(ctx, c, 6)
	req = next()
	c.Invalidate(touchOf(1, "false,2"))
	joined := asyncGrants(ctx, c, 6)
	noMore()
	many := protocol.PermissionChange{}
	for i := range maxTouchedRows + 1 {
		many.Touched = append(many.Touched, protocol.PermissionTouch{Kind: protocol.TouchUser, ID: int64(1 + i), State: "u"})
	}
	c.Invalidate(many)
	c.mu.Lock()
	for cl := range c.running {
		assert.True(t, cl.stale)
		assert.True(t, cl.touchLost)
	}
	assert.Empty(t, c.touches.rows)
	assert.Zero(t, c.tracking.Len())
	c.mu.Unlock()
	later = asyncGrants(ctx, c, 6)
	req2 = next() // detached
	req.answer <- grantsOf(6, "repo:9")
	assert.Contains(t, groupsOf(<-a), "repo:9", "asked before the touches")
	assert.Nil(t, c.cached(6))
	noMore() // the caller that joined after a touch joins the fresh computation
	req2.answer <- grantsOf(6)
	gl := <-later
	assert.Same(t, gl, <-joined, "joined after a touch: took a result read before it")
	assert.Same(t, gl, c.cachedGrants(6))
	noMore()
}

func TestTouchJournal(t *testing.T) {
	j := newTouchJournal()
	read := Basis{{protocol.TouchRepository, 7}: "true,3", {protocol.TouchUser, 3}: "u"}
	touch := func(kind string, id int64, state string) protocol.PermissionTouch {
		return protocol.PermissionTouch{Kind: kind, ID: id, State: state}
	}
	assert.False(t, j.stale(read, 0), "no touches")
	assert.False(t, j.stale(nil, 0))

	// Touches of rows it did not read.
	s1 := j.next()
	var unrelated []protocol.PermissionTouch
	for i := range 10 {
		unrelated = append(unrelated, touch(protocol.TouchRepository, int64(100+i), "false,1"))
	}
	j.record(s1, unrelated)
	assert.False(t, j.stale(read, 0))
	assert.False(t, j.stale(nil, 0))

	// The state it read, once or more.
	s2 := j.next()
	j.record(s2, []protocol.PermissionTouch{touch(protocol.TouchRepository, 7, "true,3")})
	assert.False(t, j.stale(read, 0), "the state it read")
	s3 := j.next()
	j.record(s3, []protocol.PermissionTouch{touch(protocol.TouchRepository, 7, "true,3")})
	assert.False(t, j.stale(read, 0), "touched twice in the state it read")
	assert.Len(t, j.rows, 11, "one record per row")
	assert.True(t, j.stale(Basis{{protocol.TouchRepository, 7}: basisConflict}, 0), "read in two states: any touch")
	assert.False(t, j.stale(Basis{{protocol.TouchRepository, 7}: basisConflict}, s3), "no touch since")

	// Another state, then back: stale for computations that started
	// before the other state's touch, not for those after it.
	s4 := j.next()
	j.record(s4, []protocol.PermissionTouch{touch(protocol.TouchRepository, 7, "false,3")})
	assert.True(t, j.stale(read, 0))
	assert.True(t, j.stale(read, s3))
	s5 := j.next()
	j.record(s5, []protocol.PermissionTouch{touch(protocol.TouchRepository, 7, "true,3")})
	assert.True(t, j.stale(read, 0), "touched in two states since: one is not the state it read")
	assert.True(t, j.stale(read, s3))
	assert.False(t, j.stale(read, s4), "only the state it read since")
	assert.True(t, j.stale(Basis{{protocol.TouchRepository, 7}: "false,3"}, s4), "another state since")
	assert.False(t, j.stale(read, s5), "nothing since")

	// Two states in one invalidation.
	s6 := j.next()
	j.record(s6, []protocol.PermissionTouch{touch(protocol.TouchUser, 3, "v"), touch(protocol.TouchUser, 3, "u")})
	assert.True(t, j.stale(read, s5))
	assert.False(t, j.stale(read, s6))

	// The journal is iterated when it is the smaller side.
	big := Basis{}
	for i := range 100 {
		big.add(protocol.TouchUser, int64(1000+i), "x")
	}
	big.add(protocol.TouchUser, 3, "u")
	assert.True(t, j.stale(big, s5))
	assert.False(t, j.stale(big, s6))

	// Trimming keeps the rows touched after the floor, in order.
	j.trim(s3)
	assert.Len(t, j.rows, 2, "rows 7 (s5) and user 3 (s6)")
	assert.True(t, j.stale(read, s3))
	j.trim(s5)
	assert.Len(t, j.rows, 1)
	assert.Equal(t, basisKey{protocol.TouchUser, 3}, j.order.Front().Value.(*touchRecord).key)
	assert.True(t, j.stale(read, s5))
	j.clear()
	assert.Empty(t, j.rows)
	assert.Zero(t, j.order.Len())
	assert.Equal(t, s6, j.seq, "the seq goes on")
}

// Regression (review round 5): recording touches costs the same whatever
// the number of running computations (it used to copy every touched row
// into each running computation, O(running × touched rows) under the
// cache mutex), and the journal keeps a row once, for all of them, and
// only while a computation that started before its touch runs.
func TestCacheTouchCostIndependentOfRunning(t *testing.T) {
	ctx := t.Context()
	measure := func(running int) float64 {
		c := NewCache(time.Minute, running+10)
		gate := make(chan struct{})
		c.load = func(ctx context.Context, viewerID int64) (*cacheEntry, error) {
			<-gate
			g := grantsOf(viewerID)
			g.basis = Basis{{protocol.TouchRepository, viewerID}: "false,1"}
			return &cacheEntry{grants: g, viewer: &user_model.User{ID: viewerID}, expires: c.now().Add(c.ttl)}, nil
		}
		results := make([]chan *Grants, running)
		for i := range running {
			results[i] = asyncGrants(ctx, c, int64(1+i))
		}
		require.Eventually(t, func() bool {
			c.mu.Lock()
			defer c.mu.Unlock()
			return len(c.running) == running
		}, 10*time.Second, time.Millisecond)

		next := int64(1 << 20)
		const rows = 1000
		allocs := testing.AllocsPerRun(20, func() {
			ch := protocol.PermissionChange{Touched: make([]protocol.PermissionTouch, 0, rows)}
			for range rows {
				next++
				ch.Touched = append(ch.Touched, protocol.PermissionTouch{Kind: protocol.TouchRepository, ID: next, State: "true,1"})
			}
			c.Invalidate(ch)
		})
		c.mu.Lock()
		assert.Len(t, c.touches.rows, 21*rows, "one record per touched row for all computations")
		c.mu.Unlock()

		// Viewer 1 read a row touched in another state: not cached; the
		// others are; the journal is empty once nothing runs.
		c.Invalidate(protocol.PermissionChange{Touched: []protocol.PermissionTouch{{Kind: protocol.TouchRepository, ID: 1, State: "true,1"}}})
		close(gate)
		for _, res := range results {
			<-res
		}
		assert.Nil(t, c.cached(1))
		for i := 2; i <= running; i++ {
			assert.NotNil(t, c.cached(int64(i)))
		}
		c.mu.Lock()
		assert.Empty(t, c.touches.rows)
		assert.Zero(t, c.tracking.Len())
		c.mu.Unlock()
		return allocs
	}
	one, many := measure(1), measure(500)
	assert.LessOrEqual(t, many, one+1, "allocations of Invalidate grow with the running computations")
}

// cachedGrants returns the viewer's cached grants, or nil.
func (c *Cache) cachedGrants(viewerID int64) *Grants {
	if e := c.cached(viewerID); e != nil {
		return e.grants
	}
	return nil
}
