// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package hub

import (
	"slices"
	"strings"
	"time"

	"forgejo.org/modules/json"
	"forgejo.org/modules/log"
	"forgejo.org/services/livesync/perm"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/services/livesync/synclog"
)

// start registers the session and runs its worker; the caller runs the
// writer (and, for WebSockets, the reader) and calls stop at the end. It
// returns false when the hub is shut down.
func (c *conn) start() bool {
	h := c.h
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return false
	}
	h.conns[c] = struct{}{}
	h.wg.Add(1)
	go c.workLoop()
	time.AfterFunc(h.cfg.HelloTimeout, func() {
		c.handleMu.Lock()
		done := c.helloDone
		c.handleMu.Unlock()
		if !done {
			c.end(closePolicy, "no hello", &protocol.ErrorMessage{Type: protocol.MsgError, Code: protocol.ErrorHelloRequired, Message: "no hello received"})
		}
	})
	return true
}

// stop unregisters the session (its subscriptions are dropped).
func (c *conn) stop() {
	c.cancel()
	c.mu.Lock()
	c.room.Broadcast()
	c.mu.Unlock()
	h := c.h
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.conns[c]; !ok {
		return
	}
	delete(h.conns, c)
	for _, s := range c.subs {
		h.removeSubLocked(s)
	}
	if c.registered {
		if set := h.byUser[c.viewer]; set != nil {
			delete(set, c)
			if len(set) == 0 {
				delete(h.byUser, c.viewer)
			}
		}
	}
	delete(h.barriers, c)
	if c.session != "" {
		delete(h.sessions, c.session)
	}
	h.wg.Done()
}

// handle processes one client message.
func (c *conn) handle(data []byte) {
	c.handleMu.Lock()
	defer c.handleMu.Unlock()
	var env struct {
		Type protocol.MessageType `json:"type"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		c.sendError(protocol.ErrorBadMessage, "not a JSON message")
		return
	}
	if !c.helloDone && env.Type != protocol.MsgHello {
		c.sendError(protocol.ErrorHelloRequired, "the first message must be a hello")
		return
	}
	var err error
	switch env.Type {
	case protocol.MsgHello:
		var m protocol.HelloMessage
		if err = json.Unmarshal(data, &m); err == nil {
			if c.helloDone {
				c.sendError(protocol.ErrorBadMessage, "hello was already sent")
				return
			}
			c.hello(&m)
		}
	case protocol.MsgSubscribe:
		var m protocol.SubscribeMessage
		if err = json.Unmarshal(data, &m); err == nil {
			c.subscribe(m.Groups)
		}
	case protocol.MsgUnsubscribe:
		var m protocol.UnsubscribeMessage
		if err = json.Unmarshal(data, &m); err == nil {
			c.unsubscribe(m.Groups)
		}
	case protocol.MsgBarrier:
		var m protocol.BarrierMessage
		if err = json.Unmarshal(data, &m); err == nil {
			c.barrier(m.ID)
		}
	case protocol.MsgPing:
		var m protocol.PingMessage
		if err = json.Unmarshal(data, &m); err == nil {
			c.send(&protocol.PongMessage{Type: protocol.MsgPong, ID: m.ID, SyncID: c.position()})
		}
	default:
		c.sendError(protocol.ErrorBadMessage, "unknown message type "+string(env.Type))
		return
	}
	if err != nil {
		c.sendError(protocol.ErrorBadMessage, "malformed "+string(env.Type)+" message")
	}
}

func (c *conn) sendError(code, message string) {
	c.send(&protocol.ErrorMessage{Type: protocol.MsgError, Code: code, Message: message})
}

// position is the position up to which every caught-up group of the
// session is complete once the messages queued so far have been sent.
func (c *conn) position() int64 {
	pos := c.h.pos.Load()
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, hold := range c.holds {
		pos = min(pos, hold)
	}
	return pos
}

// request is a checked group request.
type request struct {
	group string
	since *int64
	dec   perm.Decision
	ok    bool
	// limit: beyond the subscription limit (not checked).
	limit bool
	// unknown: since is ahead of the sync log.
	unknown bool
}

// check decides the requested groups (outside the hub lock: it may read
// the database).
func (c *conn) check(groups []protocol.GroupRequest, defaultSince *int64) ([]request, bool) {
	reqs := make([]request, 0, len(groups))
	seen := map[string]bool{}
	var head int64 = -1
	// Requests beyond the limit are not checked (the limit is enforced
	// again under the hub lock).
	c.h.mu.Lock()
	room := c.h.cfg.MaxSubscriptions - c.h.subCount[c.viewer]
	c.h.mu.Unlock()
	for _, g := range groups {
		if seen[g.Group] {
			continue
		}
		seen[g.Group] = true
		r := request{group: g.Group, since: g.Since}
		if r.since == nil {
			r.since = defaultSince
		}
		if room <= 0 && c.subscribed(g.Group) == nil {
			r.limit = true
		} else if !strings.HasPrefix(g.Group, "!") && g.Group != protocol.GroupAll {
			room--
			var err error
			r.dec, r.ok, err = c.h.cfg.Perms.Check(c.ctx, c.viewer, g.Group)
			if err != nil {
				if c.ctx.Err() == nil {
					log.Error("livesync: check %q for user %d: %v", g.Group, c.viewer, err)
					c.end(closeInternal, "internal error", &protocol.ErrorMessage{Type: protocol.MsgError, Code: protocol.ErrorInternal, Message: "internal error"})
				}
				return nil, false
			}
		}
		if r.ok && r.since != nil && *r.since > c.h.pos.Load() {
			// Ahead of this hub: fine if the log has it (a bootstrap's
			// watermark may be ahead of the tailer for a moment).
			if head < 0 {
				var err error
				if head, err = synclog.Head(c.ctx); err != nil {
					log.Error("livesync: read the sync log head: %v", err)
					c.end(closeInternal, "internal error", &protocol.ErrorMessage{Type: protocol.MsgError, Code: protocol.ErrorInternal, Message: "internal error"})
					return nil, false
				}
			}
			if *r.since > head {
				r.unknown, r.since = true, nil
			}
		}
		reqs = append(reqs, r)
	}
	return reqs, true
}

// subscribed returns the session's subscription to group, if any.
func (c *conn) subscribed(group string) *sub {
	c.h.mu.Lock()
	defer c.h.mu.Unlock()
	return c.subs[group]
}

// subscribeLocked registers the checked requests and returns the answer
// and the messages to send after it. at is the hub state when the checks
// started: a permission epoch delivered since may not be reflected in
// them, so the new subscriptions are then checked again before they go
// live (from at.pos).
func (h *Hub) subscribeLocked(c *conn, reqs []request, at checkpoint) (granted []protocol.Grant, refused []protocol.Refusal, after []any) {
	granted, refused = []protocol.Grant{}, []protocol.Refusal{}
	stale := h.permSeq != at.permSeq
	for _, r := range reqs {
		s := c.subs[r.group]
		switch {
		case r.limit:
			refused = append(refused, protocol.Refusal{Group: r.group, Reason: protocol.RefusedLimit})
			continue
		case !r.ok:
			refused = append(refused, protocol.Refusal{Group: r.group, Reason: protocol.RefusedForbidden})
			if s != nil {
				h.revokeLocked(s)
			}
			continue
		case s == nil && h.subCount[c.viewer] >= h.cfg.MaxSubscriptions:
			refused = append(refused, protocol.Refusal{Group: r.group, Reason: protocol.RefusedLimit})
			continue
		}
		if r.unknown {
			after = append(after, &protocol.BootstrapRequiredMessage{Type: protocol.MsgBootstrapRequired, Group: r.group, Reason: protocol.BootstrapCursorUnknown})
		}
		if s != nil && r.since == nil {
			// Already subscribed: its decision is kept current by the
			// permission epochs.
			granted = append(granted, s.dec.Wire(r.group))
			continue
		}
		if s == nil {
			s = &sub{c: c, group: r.group, kind: groupKind(r.group), state: stateLive, liveFrom: h.pos.Load()}
			c.subs[r.group] = s
			set := h.byGroup[r.group]
			if set == nil {
				set = map[*sub]struct{}{}
				h.byGroup[r.group] = set
			}
			set[s] = struct{}{}
			h.subCount[c.viewer]++
		}
		h.setDecisionLocked(s, r.dec)
		since := r.since
		if stale {
			s.recheck = true
			if since == nil {
				since = &at.pos
			}
		}
		if since != nil {
			// (Re)start the replay from since.
			if s.state == stateLive {
				s.state = stateReplay
				c.busy++
			}
			s.cursor = *since
			s.gen++
			h.queueLocked(s)
		}
		granted = append(granted, r.dec.Wire(r.group))
	}
	return granted, refused, after
}

// checkpoint is the hub state when a session's checks started.
type checkpoint struct {
	pos     int64
	permSeq uint64
}

func (h *Hub) checkpoint() checkpoint {
	h.mu.Lock()
	defer h.mu.Unlock()
	return checkpoint{pos: h.pos.Load(), permSeq: h.permSeq}
}

// caughtUpLocked sends caught_up when the session waits for one and every
// subscription is live.
func (h *Hub) caughtUpLocked(c *conn) {
	if c.catchUp && c.busy == 0 {
		c.catchUp = false
		c.send(&protocol.CaughtUpMessage{Type: protocol.MsgCaughtUp, SyncID: h.pos.Load()})
	}
}

// hello authenticates the session, subscribes the requested groups and
// answers welcome.
func (c *conn) hello(m *protocol.HelloMessage) {
	h := c.h
	viewer, invalid, err := c.auth(c.ctx, m.Token)
	switch {
	case err != nil:
		if c.ctx.Err() == nil {
			log.Error("livesync: authenticate a sync session: %v", err)
			c.end(closeInternal, "internal error", &protocol.ErrorMessage{Type: protocol.MsgError, Code: protocol.ErrorInternal, Message: "internal error"})
		}
		return
	case invalid != "":
		c.end(closePolicy, "session invalid", &protocol.SessionInvalidMessage{Type: protocol.MsgSessionInvalid, Message: invalid})
		return
	}
	c.helloDone = true

	h.mu.Lock()
	if len(h.byUser[viewer]) >= h.cfg.MaxConnections {
		h.mu.Unlock()
		c.end(closePolicy, "too many sessions", &protocol.ErrorMessage{Type: protocol.MsgError, Code: protocol.ErrorTooManyConnections, Message: "too many sync sessions for this user"})
		return
	}
	c.viewer, c.token, c.registered = viewer, m.Token, true
	set := h.byUser[viewer]
	if set == nil {
		set = map[*conn]struct{}{}
		h.byUser[viewer] = set
	}
	set[c] = struct{}{}
	h.mu.Unlock()

	at := h.checkpoint()
	grants, err := h.cfg.Perms.Grants(c.ctx, viewer)
	if err != nil {
		if c.ctx.Err() == nil {
			log.Error("livesync: grants of user %d: %v", viewer, err)
			c.end(closeInternal, "internal error", &protocol.ErrorMessage{Type: protocol.MsgError, Code: protocol.ErrorInternal, Message: "internal error"})
		}
		return
	}
	reqs, ok := c.check(m.Groups, m.LastSyncID)
	if !ok {
		return
	}
	// Loaded after the registration: later changes of the profile reach
	// the session (selfPending until the welcome is queued).
	var profile *protocol.Change
	if h.cfg.Profile != nil {
		if profile, err = h.cfg.Profile(c.ctx, viewer); err != nil {
			log.Warn("livesync: profile of user %d: %v", viewer, err)
		}
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	// The welcome is queued before anything of the new subscriptions can
	// be (fan-out takes the hub lock too).
	welcome := &protocol.WelcomeMessage{
		Type: protocol.MsgWelcome, ServerSyncID: h.pos.Load(), ViewerID: viewer,
		Grants: grants.Wire().Grants, BuildID: h.cfg.BuildID, Protocol: protocol.ProtocolVersion,
		Schemas: h.cfg.Schemas, Profile: profile,
	}
	var after []any
	welcome.Granted, welcome.Refused, after = h.subscribeLocked(c, reqs, at)
	c.send(welcome)
	for _, m := range after {
		c.send(m)
	}
	c.grants = welcome.Grants
	c.welcomed = true
	for _, ch := range c.selfPending {
		c.enqueueChange(ch, false)
	}
	c.selfPending = nil
	if c.revalidate {
		c.kick() // an epoch named the viewer meanwhile
	}
	c.catchUp = true
	h.caughtUpLocked(c)
	if m.BuildID != "" && m.BuildID != h.cfg.BuildID {
		c.send(&protocol.NoticeMessage{Type: protocol.MsgNotice, Kind: protocol.NoticeNewBuild})
	}
}

func (c *conn) subscribe(groups []protocol.GroupRequest) {
	at := c.h.checkpoint()
	reqs, ok := c.check(groups, nil)
	if !ok {
		return
	}
	h := c.h
	h.mu.Lock()
	defer h.mu.Unlock()
	msg := &protocol.SubscribedMessage{Type: protocol.MsgSubscribed}
	var after []any
	msg.Granted, msg.Refused, after = h.subscribeLocked(c, reqs, at)
	c.send(msg)
	for _, m := range after {
		c.send(m)
	}
	c.catchUp = true
	h.caughtUpLocked(c)
}

func (c *conn) unsubscribe(groups []string) {
	h := c.h
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, g := range groups {
		if s := c.subs[g]; s != nil {
			h.removeSubLocked(s)
		}
	}
	h.caughtUpLocked(c)
	h.checkBarrierLocked(c)
}

func (c *conn) barrier(id string) {
	head, err := synclog.Head(c.ctx)
	if err != nil {
		if c.ctx.Err() == nil {
			log.Error("livesync: read the sync log head: %v", err)
			c.sendError(protocol.ErrorInternal, "internal error")
		}
		return
	}
	h := c.h
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(c.barriers) >= maxBarriers {
		c.sendError(protocol.ErrorTooManyBarriers, "too many pending barriers")
		return
	}
	c.barriers = append(c.barriers, barrier{id: id, head: head})
	h.barriers[c] = struct{}{}
	h.checkBarrierLocked(c)
}

// setDecisionLocked records s's decision and indexes it for permission
// epochs.
func (h *Hub) setDecisionLocked(s *sub, d perm.Decision) {
	h.unindexLocked(s)
	s.dec, s.units = d, d.Units
	if d.RepoID != 0 {
		s.repo = d.RepoID
		set := h.byRepo[s.repo]
		if set == nil {
			set = map[*sub]struct{}{}
			h.byRepo[s.repo] = set
		}
		set[s] = struct{}{}
	}
	for kind, id := range d.Basis.Rows() {
		k := rowKey{kind, id}
		s.rows = append(s.rows, k)
		set := h.byRow[k]
		if set == nil {
			set = map[*sub]struct{}{}
			h.byRow[k] = set
		}
		set[s] = struct{}{}
	}
}

func (h *Hub) unindexLocked(s *sub) {
	if s.repo != 0 {
		removeFrom(h.byRepo, s.repo, s)
		s.repo = 0
	}
	for _, k := range s.rows {
		removeFrom(h.byRow, k, s)
	}
	s.rows = s.rows[:0]
}

func removeFrom[K comparable](index map[K]map[*sub]struct{}, k K, s *sub) {
	if set := index[k]; set != nil {
		delete(set, s)
		if len(set) == 0 {
			delete(index, k)
		}
	}
}

// removeSubLocked drops s (unsubscribe, revocation, session end).
func (h *Hub) removeSubLocked(s *sub) {
	if s.removed {
		return
	}
	s.removed = true
	c := s.c
	delete(c.subs, s.group)
	removeFrom(h.byGroup, s.group, s)
	h.unindexLocked(s)
	if h.subCount[c.viewer]--; h.subCount[c.viewer] <= 0 {
		delete(h.subCount, c.viewer)
	}
	if s.state != stateLive {
		c.busy--
		c.clearHold(s)
	}
	if s.queued {
		c.work = slices.DeleteFunc(c.work, func(w *sub) bool { return w == s })
		s.queued = false
	}
}

// revokeLocked drops s and tells the client.
func (h *Hub) revokeLocked(s *sub) {
	h.removeSubLocked(s)
	s.c.send(&protocol.GroupRevokedMessage{Type: protocol.MsgGroupRevoked, Group: s.group})
	h.caughtUpLocked(s.c)
	h.checkBarrierLocked(s.c)
}

// goLiveLocked makes s live from position from.
func (h *Hub) goLiveLocked(s *sub, from int64) {
	if s.state == stateLive {
		return
	}
	s.state = stateLive
	s.liveFrom = from
	s.c.busy--
	s.c.clearHold(s)
	h.caughtUpLocked(s.c)
	h.checkBarrierLocked(s.c)
}
