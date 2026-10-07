// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package perm

import (
	"container/list"
	"context"
	"fmt"
	"slices"
	"sync"
	"time"

	livesync_model "forgejo.org/models/livesync"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/json"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/services/livesync/protocol"
)

// Cache defaults.
const (
	// DefaultCacheTTL bounds how long cached grants are used without a
	// permission epoch invalidating them: a safety net for changes that
	// reach permissions without passing through a tracked table.
	DefaultCacheTTL = 10 * time.Minute
	// DefaultCacheSize bounds the number of viewers whose grants are cached
	// (least recently used ones are dropped first).
	DefaultCacheSize = 10000
)

// computeTimeout bounds one grants computation. It runs detached from the
// context of the caller that started it (other callers may be waiting for
// it, and a cancelled request must not fail them).
const computeTimeout = time.Minute

// maxCallChanges bounds the invalidations remembered per running
// computation; a computation that overlaps more is not cached.
const maxCallChanges = 64

// Cache holds the grants of recently active viewers, shared by all of a
// viewer's connections on this instance (PLAN §4.5). Every instance's
// tailer passes the permission epochs of the sync log to Invalidate, so a
// change committed on any instance drops the affected entries everywhere.
// Its methods are safe for concurrent use; callers asking for the same
// viewer at the same time share one computation, unless an invalidation
// that may concern it arrived in between (callers after it start a fresh
// one).
//
// Grants and checks read the master database in one transaction
// (readMaster): a read replica may not have replayed the change behind an
// epoch yet, and a result computed from it would be cached until the next
// epoch or the TTL. Do not call them inside a transaction of your own.
type Cache struct {
	ttl time.Duration
	max int
	now func() time.Time

	mu      sync.Mutex
	entries map[int64]*list.Element // of *cacheEntry, by viewer id
	lru     *list.List              // front = most recently used
	// byGroup indexes the cached viewers by granted group, so that an
	// epoch naming a repository or owner finds the entries to drop
	// without scanning the cache.
	byGroup map[string]map[int64]struct{}
	// inflight are the computations new callers may join, by viewer;
	// running are all running computations (also those detached from
	// inflight by an invalidation).
	inflight map[int64]*call
	running  map[*call]struct{}
	// load computes a viewer's entry (Cache.compute; tests replace it).
	load func(ctx context.Context, viewerID int64) (*cacheEntry, error)
}

type cacheEntry struct {
	grants  *Grants
	viewer  *user_model.User // nil when the viewer may not sign in
	expires time.Time
}

type call struct {
	done   chan struct{}
	entry  *cacheEntry
	err    error
	viewer int64
	// stale: an invalidation since the computation started concerns its
	// result for sure (or too many may), so it is not cached. changes are
	// the invalidations that may concern it, decided when it finishes.
	stale   bool
	changes []protocol.PermissionChange
}

// NewCache returns an empty cache; ttl and size <= 0 mean the defaults.
func NewCache(ttl time.Duration, size int) *Cache {
	if ttl <= 0 {
		ttl = DefaultCacheTTL
	}
	if size <= 0 {
		size = DefaultCacheSize
	}
	c := &Cache{
		ttl: ttl, max: size, now: time.Now,
		entries: map[int64]*list.Element{}, lru: list.New(),
		byGroup: map[string]map[int64]struct{}{}, inflight: map[int64]*call{}, running: map[*call]struct{}{},
	}
	c.load = c.compute
	return c
}

// Grants returns the viewer's grants (empty when the viewer may not sign
// in or does not exist).
func (c *Cache) Grants(ctx context.Context, viewerID int64) (*Grants, error) {
	e, err := c.get(ctx, viewerID)
	if err != nil {
		return nil, err
	}
	return e.grants, nil
}

// Check decides whether the viewer may read group, and which units: from
// the cached grants when the group is one of them, else on demand (public
// repositories and organizations, other users' profiles, issues). ok is
// false for groups that are not readable, do not exist or are not client
// groups — callers must not tell these cases apart in answers. Without
// cached grants it does not compute them: it loads the viewer and decides
// the group alone (every implicit grant is also granted on demand).
func (c *Cache) Check(ctx context.Context, viewerID int64, group string) (d Decision, ok bool, err error) {
	if e := c.cached(viewerID); e != nil {
		if e.viewer == nil {
			return Decision{}, false, nil
		}
		if units, ok := e.grants.Units(group); ok {
			d := Decision{Units: units}
			if kind, id := parseGroup(group); kind == kindRepo {
				d.RepoID = id
			}
			return d, true, nil
		}
		err = readMaster(ctx, func(ctx context.Context) (err error) {
			d, ok, err = check(ctx, e.viewer, group)
			return err
		})
		return d, ok, err
	}
	err = readMaster(ctx, func(ctx context.Context) error {
		u, found, err := lookupUser(ctx, viewerID)
		if err != nil || !found {
			return err
		}
		d, ok, err = check(ctx, &u, group)
		return err
	})
	return d, ok, err
}

// readMaster runs fn in a read transaction on the master database (quiet:
// its COMMIT does not ring the outbox reader's doorbell on MySQL).
func readMaster(ctx context.Context, fn func(ctx context.Context) error) error {
	return capture.WithQuietTx(ctx, fn)
}

// cached returns the viewer's unexpired cache entry, or nil.
func (c *Cache) cached(viewerID int64) *cacheEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	el := c.entries[viewerID]
	if el == nil {
		return nil
	}
	e := el.Value.(*cacheEntry)
	if !c.now().Before(e.expires) {
		c.removeLocked(viewerID)
		return nil
	}
	c.lru.MoveToFront(el)
	return e
}

func (c *Cache) get(ctx context.Context, viewerID int64) (*cacheEntry, error) {
	if e := c.cached(viewerID); e != nil {
		return e, nil
	}
	c.mu.Lock()
	cl := c.inflight[viewerID]
	if cl == nil {
		cl = &call{done: make(chan struct{}), viewer: viewerID}
		c.inflight[viewerID] = cl
		c.running[cl] = struct{}{}
		go c.run(context.WithoutCancel(ctx), cl)
	}
	c.mu.Unlock()
	select {
	case <-cl.done:
		return cl.entry, cl.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// run computes cl's grants and caches them unless an invalidation since it
// started concerns them.
func (c *Cache) run(ctx context.Context, cl *call) {
	ctx, cancel := context.WithTimeout(ctx, computeTimeout)
	defer cancel()
	entry, err := c.load(ctx, cl.viewer)

	c.mu.Lock()
	cl.entry, cl.err = entry, err
	delete(c.running, cl)
	if c.inflight[cl.viewer] == cl {
		delete(c.inflight, cl.viewer)
	}
	if err == nil && !cl.stale && c.entries[cl.viewer] == nil && !anyAffects(cl.changes, cl.viewer, entry.grants) {
		c.storeLocked(cl.viewer, entry)
	}
	c.mu.Unlock()
	close(cl.done)
}

func (c *Cache) compute(ctx context.Context, viewerID int64) (e *cacheEntry, err error) {
	err = readMaster(ctx, func(ctx context.Context) error {
		u, found, err := lookupUser(ctx, viewerID)
		if err != nil {
			return err
		}
		var viewer *user_model.User // nil when missing: no grants
		if found {
			viewer = &u
		}
		g, err := compute(ctx, viewer, viewerID)
		if err != nil {
			return err
		}
		e = &cacheEntry{grants: g, expires: c.now().Add(c.ttl)}
		if usable(viewer) {
			e.viewer = viewer
		}
		return nil
	})
	return e, err
}

// anyAffects reports whether one of changes may change the grants g of
// viewer.
func anyAffects(changes []protocol.PermissionChange, viewer int64, g *Grants) bool {
	for _, ch := range changes {
		if affects(ch, viewer, g) {
			return true
		}
	}
	return false
}

// affects reports whether ch may change the grants g of viewer.
func affects(ch protocol.PermissionChange, viewer int64, g *Grants) bool {
	if ch.All {
		return true
	}
	if slices.Contains(ch.Users, viewer) {
		return true
	}
	for _, group := range changedGroups(ch) {
		if _, ok := g.groups[group]; ok {
			return true
		}
	}
	return false
}

// changedGroups are the groups whose readers ch names (besides its users).
func changedGroups(ch protocol.PermissionChange) []string {
	groups := make([]string, 0, len(ch.Repos)+2*len(ch.Owners))
	for _, id := range ch.Repos {
		groups = append(groups, protocol.RepoGroup(id))
	}
	for _, id := range ch.Owners {
		groups = append(groups, protocol.OrgGroup(id), protocol.ProfileGroup(id))
	}
	return groups
}

func (c *Cache) storeLocked(viewerID int64, e *cacheEntry) {
	c.removeLocked(viewerID)
	c.entries[viewerID] = c.lru.PushFront(e)
	for group := range e.grants.groups {
		set := c.byGroup[group]
		if set == nil {
			set = map[int64]struct{}{}
			c.byGroup[group] = set
		}
		set[viewerID] = struct{}{}
	}
	for c.lru.Len() > c.max {
		oldest := c.lru.Back().Value.(*cacheEntry)
		c.removeLocked(oldest.grants.ViewerID)
	}
}

func (c *Cache) removeLocked(viewerID int64) {
	el := c.entries[viewerID]
	if el == nil {
		return
	}
	e := el.Value.(*cacheEntry)
	c.lru.Remove(el)
	delete(c.entries, viewerID)
	for group := range e.grants.groups {
		if set := c.byGroup[group]; set != nil {
			delete(set, viewerID)
			if len(set) == 0 {
				delete(c.byGroup, group)
			}
		}
	}
}

// Invalidate drops the cached grants a permission epoch may have changed:
// those of its users and of every viewer granted one of its repositories'
// or owners' groups (all of them for ch.All). Running computations it may
// concern are detached, so later callers do not get a result read before
// the change, and are not cached if it does concern them. Cost:
// O(affected entries + running computations).
func (c *Cache) Invalidate(ch protocol.PermissionChange) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for cl := range c.running {
		switch {
		case ch.All || slices.Contains(ch.Users, cl.viewer):
			cl.stale = true
		case len(ch.Repos) > 0 || len(ch.Owners) > 0:
			// Whether it grants one of the groups is known only when it
			// finishes.
			if len(cl.changes) == maxCallChanges {
				cl.stale = true
			} else {
				cl.changes = append(cl.changes, ch)
			}
		default:
			continue
		}
		if c.inflight[cl.viewer] == cl {
			delete(c.inflight, cl.viewer)
		}
	}
	if ch.All {
		c.entries = map[int64]*list.Element{}
		c.lru.Init()
		c.byGroup = map[string]map[int64]struct{}{}
		return
	}
	for _, id := range ch.Users {
		c.removeLocked(id)
	}
	for _, group := range changedGroups(ch) {
		for id := range c.byGroup[group] {
			c.removeLocked(id)
		}
	}
}

// DecodeChange returns the PermissionChange of a sync log entry; ok is false
// for entries that are not permission epochs.
func DecodeChange(e *livesync_model.LogEntry) (protocol.PermissionChange, bool, error) {
	var ch protocol.PermissionChange
	if protocol.Op(e.Op) != protocol.OpPermission {
		return ch, false, nil
	}
	if err := json.Unmarshal([]byte(e.Payload), &ch); err != nil {
		return ch, true, fmt.Errorf("livesync: permission epoch %d: %w", e.SyncID, err)
	}
	return ch, true, nil
}
