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

// Cache holds the grants of recently active viewers, shared by all of a
// viewer's connections on this instance (PLAN §4.5). Every instance's
// tailer passes the permission epochs of the sync log to Invalidate, so a
// change committed on any instance drops the affected entries everywhere.
// Its methods are safe for concurrent use; a viewer's grants are computed
// at most once at a time.
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
	byGroup  map[string]map[int64]struct{}
	inflight map[int64]*call
	// seq counts invalidations; recent keeps those that happened while a
	// computation was running (cleared when none is), so that grants
	// computed from data read before an invalidation are not cached.
	seq    uint64
	recent []recentChange
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
	start  uint64
	viewer int64
}

type recentChange struct {
	seq    uint64
	change protocol.PermissionChange
}

// NewCache returns an empty cache; ttl and size <= 0 mean the defaults.
func NewCache(ttl time.Duration, size int) *Cache {
	if ttl <= 0 {
		ttl = DefaultCacheTTL
	}
	if size <= 0 {
		size = DefaultCacheSize
	}
	return &Cache{
		ttl: ttl, max: size, now: time.Now,
		entries: map[int64]*list.Element{}, lru: list.New(),
		byGroup: map[string]map[int64]struct{}{}, inflight: map[int64]*call{},
	}
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
// groups — callers must not tell these cases apart in answers.
func (c *Cache) Check(ctx context.Context, viewerID int64, group string) (Decision, bool, error) {
	e, err := c.get(ctx, viewerID)
	if err != nil || e.viewer == nil {
		return Decision{}, false, err
	}
	if units, ok := e.grants.Units(group); ok {
		d := Decision{Units: units}
		if kind, id := parseGroup(group); kind == kindRepo {
			d.RepoID = id
		}
		return d, true, nil
	}
	return check(ctx, e.viewer, group)
}

func (c *Cache) get(ctx context.Context, viewerID int64) (*cacheEntry, error) {
	c.mu.Lock()
	if el := c.entries[viewerID]; el != nil {
		e := el.Value.(*cacheEntry)
		if c.now().Before(e.expires) {
			c.lru.MoveToFront(el)
			c.mu.Unlock()
			return e, nil
		}
		c.removeLocked(viewerID)
	}
	if cl := c.inflight[viewerID]; cl != nil {
		c.mu.Unlock()
		select {
		case <-cl.done:
			return cl.entry, cl.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	cl := &call{done: make(chan struct{}), start: c.seq, viewer: viewerID}
	c.inflight[viewerID] = cl
	c.mu.Unlock()

	cl.entry, cl.err = c.compute(ctx, viewerID)

	c.mu.Lock()
	delete(c.inflight, viewerID)
	if cl.err == nil && !c.invalidatedLocked(cl) {
		c.storeLocked(viewerID, cl.entry)
	}
	if len(c.inflight) == 0 {
		c.recent = nil
	}
	c.mu.Unlock()
	close(cl.done)
	return cl.entry, cl.err
}

func (c *Cache) compute(ctx context.Context, viewerID int64) (*cacheEntry, error) {
	u, found, err := lookupUser(ctx, viewerID)
	if err != nil {
		return nil, err
	}
	var viewer *user_model.User // nil when missing: no grants
	if found {
		viewer = &u
	}
	g, err := compute(ctx, viewer, viewerID)
	if err != nil {
		return nil, err
	}
	e := &cacheEntry{grants: g, expires: c.now().Add(c.ttl)}
	if usable(viewer) {
		e.viewer = viewer
	}
	return e, nil
}

// invalidatedLocked reports whether an invalidation since cl started could
// concern its result.
func (c *Cache) invalidatedLocked(cl *call) bool {
	for _, rc := range c.recent {
		if rc.seq > cl.start && affects(rc.change, cl.viewer, cl.entry.grants) {
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
// or owners' groups (all of them for ch.All). Cost: O(affected entries).
func (c *Cache) Invalidate(ch protocol.PermissionChange) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.seq++
	if len(c.inflight) > 0 {
		c.recent = append(c.recent, recentChange{seq: c.seq, change: ch})
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
