// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package hub

import (
	"context"
	"errors"
	"slices"
	"time"

	"forgejo.org/modules/json"
	"forgejo.org/modules/log"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/services/livesync/synclog"
)

// workLoop is the session's worker: it replays subscriptions, checks them
// again after permission epochs, re-validates the session and keeps the
// connection alive, until the session ends.
func (c *conn) workLoop() {
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

// acquire takes a slot of the hub's check semaphore.
func (c *conn) acquire() bool {
	select {
	case c.h.checks <- struct{}{}:
		return true
	case <-c.ctx.Done():
		return false
	}
}

func (c *conn) release() { <-c.h.checks }

// revalidateSession checks the session's token and account again (after a
// permission epoch naming the viewer, and every RevalidateInterval) and
// sends the implicit grants when they changed. False when the session
// ended.
func (c *conn) revalidateSession() bool {
	if !c.acquire() {
		return false
	}
	defer c.release()
	viewer, invalid, err := c.auth(c.ctx, c.token)
	switch {
	case c.ctx.Err() != nil:
		return false
	case err != nil:
		log.Warn("livesync: re-validate the sync session of user %d: %v", c.viewer, err)
		return true
	case invalid != "" || viewer != c.viewer:
		c.end(closePolicy, "session invalid", &protocol.SessionInvalidMessage{Type: protocol.MsgSessionInvalid, Message: invalid})
		return false
	}
	g, err := c.h.cfg.Perms.Grants(c.ctx, viewer)
	if err != nil {
		if c.ctx.Err() == nil {
			log.Warn("livesync: grants of user %d: %v", viewer, err)
		}
		return c.ctx.Err() == nil
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

// process replays s from its cursor (checking its permission first when
// needed) until it is live, revoked or removed.
func (h *Hub) process(s *sub) {
	c := s.c
	if !c.acquire() {
		return
	}
	defer c.release()
	replayed := 0
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
			d, ok, err := h.cfg.Perms.Check(c.ctx, c.viewer, s.group)
			if err != nil {
				if c.ctx.Err() == nil {
					log.Error("livesync: check %q for user %d: %v; retrying", s.group, c.viewer, err)
				}
				h.retryLater(s, true)
				continue
			}
			h.mu.Lock()
			switch {
			case s.removed:
			case s.recheck:
				// Another epoch since: check again.
			case !ok:
				h.revokeLocked(s)
			default:
				if d.Units != s.units {
					c.send(&protocol.BootstrapRequiredMessage{Type: protocol.MsgBootstrapRequired, Group: s.group, Reason: protocol.BootstrapPermissionChanged})
				}
				h.setDecisionLocked(s, d)
			}
			h.mu.Unlock()
			continue
		}

		entries, err := synclog.ReadRange(c.ctx, s.group, cursor, until, replayBatch)
		if _, trimmed := errors.AsType[*synclog.TrimmedError](err); trimmed {
			h.restartLive(s, gen, protocol.BootstrapCursorTrimmed)
			continue
		} else if err != nil {
			if c.ctx.Err() == nil {
				log.Error("livesync: replay %q for user %d: %v; retrying", s.group, c.viewer, err)
			}
			h.retryLater(s, false)
			continue
		}
		for i := range entries {
			e := &entries[i]
			if !c.waitRoom() {
				return
			}
			if e.Grp == protocol.GroupAll {
				if protocol.Op(e.Op) == protocol.OpRebootstrap && canHold(s.kind, protocol.Model(e.Model)) {
					var marker protocol.RebootstrapMarker
					_ = json.Unmarshal([]byte(e.Payload), &marker)
					c.send(bootstrapFor(s.group, &marker, protocol.Model(e.Model)))
				}
			} else if units.Allows(protocol.Unit(e.Unit)) {
				c.enqueueChange(*change(e), false)
				replayed++
			}
			cursor = e.SyncID
		}
		if len(entries) < replayBatch {
			cursor = max(cursor, until)
		}

		h.mu.Lock()
		switch {
		case s.removed || s.gen != gen:
			// Unsubscribed, or the client restarted the replay.
		case replayed > h.cfg.MaxReplay:
			// A bootstrap is cheaper than going on.
			h.mu.Unlock()
			h.restartLive(s, gen, protocol.BootstrapReplayTooLong)
			replayed = 0
			continue
		default:
			s.cursor = cursor
			if !s.recheck && cursor >= h.pos.Load() {
				h.goLiveLocked(s, cursor)
			}
		}
		h.mu.Unlock()
	}
}

// restartLive gives up replaying s: the client must bootstrap the group,
// which goes live from the hub's position.
func (h *Hub) restartLive(s *sub, gen uint64, reason string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if s.removed || s.gen != gen {
		return
	}
	s.c.send(&protocol.BootstrapRequiredMessage{Type: protocol.MsgBootstrapRequired, Group: s.group, Reason: reason})
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
