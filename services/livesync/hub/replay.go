// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package hub

import (
	"context"
	"errors"
	"slices"
	"time"

	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/json"
	"forgejo.org/modules/log"
	"forgejo.org/services/livesync/perm"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/services/livesync/synclog"
)

// workLoop is the session's worker: it replays subscriptions, checks them
// again after permission epochs, re-validates the session and keeps the
// connection alive, until the session ends.
func (c *conn) workLoop() {
	defer close(c.workerDone)
	keepAlive := time.NewTicker(c.h.cfg.KeepAlive)
	defer keepAlive.Stop()
	revalidate := time.NewTicker(c.h.cfg.RevalidateInterval)
	defer revalidate.Stop()
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-keepAlive.C:
			ctx, cancel := context.WithTimeout(c.ctx, c.h.cfg.WriteTimeout)
			err := c.t.keepAlive(ctx)
			cancel()
			if err != nil {
				log.Debug("livesync: sync session of user %d: keep-alive: %v", c.viewer, err)
				c.cancel()
				return
			}
			continue
		case <-revalidate.C:
			c.h.mu.Lock()
			c.revalidate = true
			c.h.mu.Unlock()
		case <-c.workNotify:
		}
		c.drainWork()
	}
}

func (c *conn) drainWork() {
	h := c.h
	h.skipIdle(c)
	for c.ctx.Err() == nil {
		h.mu.Lock()
		// Before the welcome the flag stays (hello kicks the worker again).
		revalidate := c.revalidate && c.welcomed
		if revalidate {
			c.revalidate = false
		}
		var s *sub
		if len(c.work) > 0 {
			s = c.work[0]
			c.work = slices.Delete(c.work, 0, 1)
			s.queued = false
		}
		h.mu.Unlock()
		if revalidate && !c.revalidateSession() {
			return
		}
		switch {
		case s != nil:
			h.process(s)
		case !revalidate:
			return
		}
	}
}

// withSlot runs one database read or check of the session in a slot of
// the hub's semaphore (never hold one while waiting for the client).
func (c *conn) withSlot(f func() error) error {
	select {
	case c.h.checks <- struct{}{}:
	case <-c.ctx.Done():
		return c.ctx.Err()
	}
	defer func() { <-c.h.checks }()
	return f()
}

// revalidateSession checks the session's token and account again (after a
// permission epoch naming the viewer, and every RevalidateInterval) and
// sends the implicit grants when they changed. False when the session
// ended.
func (c *conn) revalidateSession() bool {
	var viewer int64
	var invalid string
	var g *perm.Grants
	var gerr error
	err := c.withSlot(func() error {
		var err error
		if viewer, invalid, err = c.auth(c.ctx, c.token); err == nil && invalid == "" && viewer == c.viewer {
			g, gerr = c.h.cfg.Perms.Grants(c.ctx, viewer)
		}
		return err
	})
	switch {
	case c.ctx.Err() != nil:
		return false
	case err != nil:
		log.Warn("livesync: re-validate the sync session of user %d: %v", c.viewer, err)
		return true
	case invalid != "" || viewer != c.viewer:
		c.end(closePolicy, "session invalid", &protocol.SessionInvalidMessage{Type: protocol.MsgSessionInvalid, Message: invalid})
		return false
	case gerr != nil:
		log.Warn("livesync: grants of user %d: %v", viewer, gerr)
		return true
	}
	grants := g.Wire().Grants
	h := c.h
	h.mu.Lock()
	defer h.mu.Unlock()
	if !grantsEqual(grants, c.grants) {
		c.grants = grants
		c.send(&protocol.GrantsMessage{Type: protocol.MsgGrants, Grants: grants})
	}
	return true
}

func grantsEqual(a, b []protocol.Grant) bool {
	return slices.EqualFunc(a, b, func(x, y protocol.Grant) bool {
		return x.Group == y.Group && slices.Equal(x.Units, y.Units)
	})
}

// skipIdle makes the session's queued replays whose groups have no entry
// in their range live at once, with one read of the log range for all of
// them: a client that reconnects resumes many groups from about the same
// position, and most of them missed nothing. The others replay one by one.
func (h *Hub) skipIdle(c *conn) {
	type candidate struct {
		s   *sub
		gen uint64
	}
	h.mu.Lock()
	until := h.pos.Load()
	from := until
	var cands []candidate
	for _, s := range c.work {
		if s.state == stateReplay && !s.recheck && s.cursor < until {
			cands = append(cands, candidate{s, s.gen})
			from = min(from, s.cursor)
		}
	}
	h.mu.Unlock()
	if len(cands) < 2 || until-from > maxIdleScan {
		return
	}
	var last map[string]int64
	if err := c.withSlot(func() (err error) {
		last, err = synclog.ReadGroups(c.ctx, from, until)
		return err
	}); err != nil {
		if c.ctx.Err() == nil && !errors.Is(err, synclog.ErrTrimmed) {
			log.Warn("livesync: replay for user %d: %v", c.viewer, err)
		}
		return // each replays on its own (and reports a trimmed cursor)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, cd := range cands {
		s := cd.s
		if s.removed || s.gen != cd.gen || s.state != stateReplay || s.recheck || s.cursor < from ||
			max(last[s.group], last[protocol.GroupAll]) > s.cursor {
			continue
		}
		s.cursor = until
		if until >= h.pos.Load() {
			if s.queued {
				c.work = slices.DeleteFunc(c.work, func(w *sub) bool { return w == s })
				s.queued = false
			}
			h.goLiveLocked(s, until)
		}
	}
}

// process replays s from its cursor (checking its permission first when
// needed) until it is live, revoked or removed.
func (h *Hub) process(s *sub) {
	c := s.c
	scanned := 0 // log entries scanned for s's replay (MaxReplay)
	for c.ctx.Err() == nil {
		h.mu.Lock()
		if s.removed || s.state == stateLive {
			h.mu.Unlock()
			return
		}
		check := s.recheck
		s.recheck = false
		gen, cursor, units, until := s.gen, s.cursor, s.units, h.pos.Load()
		h.mu.Unlock()

		if check {
			h.check(s)
			continue
		}
		if cursor < until {
			n, ok := h.replay(s, gen, cursor, until, units, scanned)
			if !ok {
				continue
			}
			scanned += n
			cursor = until
		}
		h.mu.Lock()
		if !s.removed && s.gen == gen {
			s.cursor = cursor
			if !s.recheck && cursor >= h.pos.Load() {
				h.goLiveLocked(s, cursor)
			}
		}
		h.mu.Unlock()
	}
}

// check decides s's permission again: revoked, or the entries held
// meanwhile are sent (or, when it holds none, it catches up from its
// cursor).
func (h *Hub) check(s *sub) {
	c := s.c
	var d perm.Decision
	var ok bool
	if err := c.withSlot(func() (err error) {
		d, ok, err = h.cfg.Perms.Check(c.ctx, c.viewer, s.group)
		return err
	}); err != nil {
		if c.ctx.Err() == nil {
			log.Error("livesync: check %q for user %d: %v; retrying", s.group, c.viewer, err)
		}
		h.retryLater(s, true)
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	switch {
	case s.removed:
	case s.recheck:
		// Another epoch since: check again.
	case !ok:
		h.revokeLocked(s)
	default:
		if d.Units != s.units {
			// Not capped at the hold (conn.sendAtHold): a resume does not
			// tell permission_changed again, whatever position it starts
			// from (the server does not know the units the client had).
			// The client compares the units of the resumed group's grant
			// with those it holds instead (see protocol.GroupRequest).
			c.send(&protocol.BootstrapRequiredMessage{Type: protocol.MsgBootstrapRequired, Group: s.group, Reason: protocol.BootstrapPermissionChanged})
		}
		h.setDecisionLocked(s, d)
		if s.state == stateRecheck && s.holding {
			h.releaseHeldLocked(s)
		}
	}
}

// replay sends the group's entries in (cursor, until] to s: the newest
// state of each entity the viewer may read (an entity changed several
// times in the range is sent once, as it is at until; a deleted one as a
// delete), and the re-bootstrap markers that concern the group. A range
// with more than MaxReplay entries is not replayed: the client gets
// bootstrap_required (replay_too_long) before anything was sent. False
// when the replay did not complete (restarted, to be retried, or the
// session ended). scanned is the number of entries s's replay has scanned
// in earlier ranges; n the number scanned in this one.
func (h *Hub) replay(s *sub, gen uint64, cursor, until int64, units perm.UnitSet, scanned int) (n int, ok bool) {
	c := s.c
	var keys []livesync_model.LogEntry
	err := c.withSlot(func() (err error) {
		keys, err = synclog.ReadKeys(c.ctx, s.group, cursor, until, h.cfg.MaxReplay+1-scanned)
		return err
	})
	if h.replayFailed(s, gen, err) {
		return 0, false
	}
	if scanned+len(keys) > h.cfg.MaxReplay {
		// A bootstrap is cheaper than going on.
		h.restartLive(s, gen, protocol.BootstrapReplayTooLong)
		return 0, false
	}
	items := replayPlan(keys, units, s.kind)
	for len(items) > 0 {
		chunk := items[:min(len(items), replayBatch)]
		items = items[len(chunk):]
		var ids []int64
		for _, i := range chunk {
			if keys[i].Op != string(protocol.OpDelete) {
				ids = append(ids, keys[i].SyncID)
			}
		}
		var full []livesync_model.LogEntry
		err := c.withSlot(func() (err error) {
			full, err = synclog.ReadEntries(c.ctx, ids)
			return err
		})
		if h.replayFailed(s, gen, err) {
			return 0, false
		}
		h.mu.Lock()
		stale := s.removed || s.gen != gen
		h.mu.Unlock()
		if stale {
			return 0, false // unsubscribed, or the client restarted the replay
		}
		for _, i := range chunk {
			e := &keys[i]
			if len(full) > 0 && full[0].SyncID == e.SyncID {
				e, full = &full[0], full[1:]
			}
			if !c.waitRoom() {
				return 0, false
			}
			if e.Grp == protocol.GroupAll {
				var marker protocol.RebootstrapMarker
				_ = json.Unmarshal([]byte(e.Payload), &marker)
				// A catching-up subscription is caught up for the
				// client: frames before it claim no more than the
				// position before the marker (conn.capLocked).
				c.sendCapped(bootstrapFor(s.group, &marker, protocol.Model(e.Model)), e.SyncID-1)
			} else {
				c.enqueueChange(*change(e), false)
			}
		}
	}
	return len(keys), true
}

// replayFailed handles an error of a replay read: true when the replay
// cannot go on (trimmed: the client must bootstrap; otherwise retried).
func (h *Hub) replayFailed(s *sub, gen uint64, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, synclog.ErrTrimmed):
		h.restartLive(s, gen, protocol.BootstrapCursorTrimmed)
	default:
		if s.c.ctx.Err() == nil {
			log.Error("livesync: replay %q for user %d: %v; retrying", s.group, s.c.viewer, err)
		}
		h.retryLater(s, false)
	}
	return true
}

// replayPlan returns the indexes of the keys a replay sends: for each
// entity, its newest entry the units allow, and the re-bootstrap markers
// for models the group kind can hold.
func replayPlan(keys []livesync_model.LogEntry, units perm.UnitSet, kind string) []int {
	type entity struct {
		model string
		id    int64
	}
	newest := map[entity]int{}
	for i := range keys {
		if k := &keys[i]; k.Grp != protocol.GroupAll && units.Allows(protocol.Unit(k.Unit)) {
			newest[entity{k.Model, k.EntityID}] = i
		}
	}
	res := make([]int, 0, len(newest))
	for i := range keys {
		k := &keys[i]
		if k.Grp == protocol.GroupAll {
			if protocol.Op(k.Op) == protocol.OpRebootstrap && canHold(kind, protocol.Model(k.Model)) {
				res = append(res, i)
			}
		} else if j, ok := newest[entity{k.Model, k.EntityID}]; ok && j == i {
			res = append(res, i)
		}
	}
	return res
}

// restartLive gives up replaying s: the client must bootstrap the group,
// which goes live from the hub's position.
func (h *Hub) restartLive(s *sub, gen uint64, reason string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if s.removed || s.gen != gen {
		return
	}
	s.c.sendAtHold(s, &protocol.BootstrapRequiredMessage{Type: protocol.MsgBootstrapRequired, Group: s.group, Reason: reason})
	s.cursor = h.pos.Load()
	if !s.recheck {
		h.goLiveLocked(s, s.cursor)
	}
}

// retryLater pauses after a failed read or check (recheck: the check
// must be done again).
func (h *Hub) retryLater(s *sub, recheck bool) {
	if recheck {
		h.mu.Lock()
		s.recheck = true
		h.mu.Unlock()
	}
	select {
	case <-s.c.ctx.Done():
	case <-time.After(retryPause):
	}
}
