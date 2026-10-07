// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Package hub is livesync's fan-out (PLAN §4.6, §4.11): it holds the
// sessions of the clients connected to this instance (WebSocket at
// /-/sync/ws, or Server-Sent Events + POST as a fallback), their
// subscriptions to sync groups, and streams the sync log to them.
//
//   - The Hub is the tailer's synclog.Sink: every instance tails the log
//     and delivers each entry to the live subscriptions of its group,
//     indexed by group (O(subscribers of the group) per entry; nothing
//     loops over all sessions except re-bootstrap markers, permission
//     epochs naming everybody and retention skips, which concern all).
//   - A subscription first replays the group from the client's position
//     (synclog.ReadKeys, up to what the tailer has delivered) and then goes
//     live under the hub lock, so nothing is lost or reordered between
//     replay and live stream.
//   - A replay sends only the newest state of each entity in the range
//     (a delete stays a delete), never the intermediate states the log
//     keeps: a reader gets what a bootstrap would give, not the history.
//   - Permission epochs (protocol.OpPermission entries, never sent to
//     clients) suspend the subscriptions they may concern at their position
//     in the log; each is checked again (perm.Cache.Check, after permSink
//     applied the epoch to the cache), and the entries held for it meanwhile
//     are sent (or it catches up from the log), or it is revoked
//     (group_revoked). Re-bootstrap markers
//     (protocol.OpRebootstrap) become bootstrap_required for the subscribed
//     groups that can hold the marker's model.
//   - Outgoing changes are batched into frames of at most FrameInterval
//     (16 ms); each session's send buffer is bounded: a session that does
//     not keep up is closed with resume_from_cursor.
package hub

import (
	"context"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/json"
	"forgejo.org/modules/log"
	"forgejo.org/services/livesync/perm"
	"forgejo.org/services/livesync/protocol"
)

// Defaults of Config.
const (
	DefaultSendBuffer         = 4 << 20
	DefaultMaxSubscriptions   = 1000
	DefaultMaxConnections     = 16
	DefaultMaxReplay          = 10000
	DefaultFrameInterval      = 16 * time.Millisecond
	DefaultHelloTimeout       = 10 * time.Second
	DefaultKeepAlive          = 25 * time.Second
	DefaultRevalidateInterval = 5 * time.Minute
	DefaultWriteTimeout       = 10 * time.Second
)

// Limits that are not settings.
const (
	// maxMessageSize bounds a client message.
	maxMessageSize = 256 << 10
	// maxFrameBytes: a delta frame is cut after this many bytes of changes
	// (the next changes go into the next frame, sent right after).
	maxFrameBytes = 256 << 10
	// replayBatch is the number of log entries read per replay query.
	replayBatch = 500
	// maxBarriers bounds the pending barriers of a session.
	maxBarriers = 16
	// maxConcurrentChecks bounds the database reads of replays and the
	// permission checks that run at the same time (reconnect storms must
	// not swamp the database). A slot is held for one read or check only,
	// never while waiting for a client.
	maxConcurrentChecks = 16
	// maxIdleScan: a session's queued replays are first checked for
	// missed entries with one read of the log range (Hub.skipIdle) when the
	// range has at most this many entries.
	maxIdleScan = 10000
	// maxEpochLog is the number of recent permission epochs kept to decide
	// whether a check that ran while they were delivered is stale.
	maxEpochLog = 64
	// retryPause is the pause before a failed replay read or check is
	// retried.
	retryPause = time.Second
)

// Config configures a Hub. Zero values mean the defaults.
type Config struct {
	// Perms decides which groups a viewer may read (required).
	Perms *perm.Cache
	// Profile returns the viewer's own User entity for the welcome message
	// (optional).
	Profile func(ctx context.Context, viewerID int64) (*protocol.Change, error)
	// BuildID identifies the server build (WelcomeMessage.BuildID).
	BuildID string
	// Schemas are the models' schema versions (WelcomeMessage.Schemas).
	Schemas map[protocol.Model]int
	// SendBuffer bounds the bytes queued for a session (changes and
	// control messages); a session that exceeds it is closed with
	// resume_from_cursor. Replays wait for room instead.
	SendBuffer int
	// MaxSubscriptions bounds the subscriptions of one viewer (all of the
	// viewer's sessions on this instance).
	MaxSubscriptions int
	// MaxConnections bounds the sessions of one viewer on this instance.
	MaxConnections int
	// MaxReplay bounds the log entries of a group scanned for one
	// subscription's replay; beyond it the client gets bootstrap_required
	// (replay_too_long), decided before anything is sent.
	MaxReplay int
	// FrameInterval is the longest a change waits to be batched with
	// others into one frame.
	FrameInterval time.Duration
	// HelloTimeout: a session that sends no hello within it is closed.
	HelloTimeout time.Duration
	// KeepAlive is the interval of WebSocket pings and SSE heartbeats.
	KeepAlive time.Duration
	// RevalidateInterval: how often a session's token and account are
	// checked again (and its implicit grants refreshed).
	RevalidateInterval time.Duration
	// WriteTimeout bounds one write to a client.
	WriteTimeout time.Duration
}

func (cfg *Config) setDefaults() {
	def := func(v *int, d int) {
		if *v <= 0 {
			*v = d
		}
	}
	defDur := func(v *time.Duration, d time.Duration) {
		if *v <= 0 {
			*v = d
		}
	}
	def(&cfg.SendBuffer, DefaultSendBuffer)
	def(&cfg.MaxSubscriptions, DefaultMaxSubscriptions)
	def(&cfg.MaxConnections, DefaultMaxConnections)
	def(&cfg.MaxReplay, DefaultMaxReplay)
	defDur(&cfg.FrameInterval, DefaultFrameInterval)
	defDur(&cfg.HelloTimeout, DefaultHelloTimeout)
	defDur(&cfg.KeepAlive, DefaultKeepAlive)
	defDur(&cfg.RevalidateInterval, DefaultRevalidateInterval)
	defDur(&cfg.WriteTimeout, DefaultWriteTimeout)
}

// Authenticator validates the token of a hello (and, periodically, again).
// It returns the viewer, or invalid != "" (the message of
// session_invalid) when the token or the account is not acceptable, or an
// error when it could not decide (the session is closed without telling
// the client to drop its token).
type Authenticator func(ctx context.Context, token string) (viewerID int64, invalid string, err error)

// Hub holds this instance's sessions and subscriptions (see the package
// documentation).
type Hub struct {
	cfg Config
	ctx context.Context
	// pos is the last sync id delivered by the tailer. It only changes
	// under mu; it is stored after the entries up to it were queued for
	// every live subscription, so a frame built after loading it holds
	// everything up to it. (Deliver wakes the writers only after storing
	// it, so a delivery's frame claims the delivery's position.)
	pos atomic.Int64

	mu      sync.Mutex
	closed  bool
	conns   map[*conn]struct{}
	byUser  map[int64]map[*conn]struct{}
	byGroup map[string]map[*sub]struct{}
	// byRepo indexes subscriptions by the repository their decision came
	// from (repo:{id} and issue:{id} groups), byRow by the repository and
	// user rows it was computed from (perm.Basis), for permission epochs.
	byRepo   map[int64]map[*sub]struct{}
	byRow    map[rowKey]map[*sub]struct{}
	subCount map[int64]int
	// barriers are the sessions with pending barriers.
	barriers map[*conn]struct{}
	// delivered: the sessions the current Deliver queued messages for
	// (their writers are woken when it is done).
	delivered map[*conn]struct{}
	// sessions are the fallback (SSE) sessions by id.
	sessions map[string]*conn
	// permSeq counts the permission epochs delivered; epochs are the last
	// (at most maxEpochLog) of them (see subscribeLocked).
	permSeq uint64
	epochs  []protocol.PermissionChange

	checks chan struct{} // semaphore: replays and checks running
	wg     sync.WaitGroup
}

type rowKey struct {
	kind string
	id   int64
}

// New returns a hub whose sessions live until ctx is done or Shutdown;
// pos is the sync id after which its tailer starts delivering.
func New(ctx context.Context, cfg Config, pos int64) *Hub {
	cfg.setDefaults()
	h := &Hub{
		cfg: cfg, ctx: ctx,
		conns: map[*conn]struct{}{}, byUser: map[int64]map[*conn]struct{}{},
		byGroup: map[string]map[*sub]struct{}{}, byRepo: map[int64]map[*sub]struct{}{},
		byRow: map[rowKey]map[*sub]struct{}{}, subCount: map[int64]int{},
		barriers: map[*conn]struct{}{}, delivered: map[*conn]struct{}{}, sessions: map[string]*conn{},
		checks: make(chan struct{}, maxConcurrentChecks),
	}
	h.pos.Store(pos)
	return h
}

// Shutdown tells every session that the server shuts down, closes them and
// waits (at most timeout) until they are gone. New sessions are refused.
func (h *Hub) Shutdown(timeout time.Duration) {
	h.mu.Lock()
	h.closed = true
	for c := range h.conns {
		c.end(closeGoingAway, "server shutting down", &protocol.NoticeMessage{Type: protocol.MsgNotice, Kind: protocol.NoticeShutdown})
	}
	h.mu.Unlock()
	done := make(chan struct{})
	go func() {
		h.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
		log.Warn("livesync: sync sessions did not close within %s", timeout)
	}
}

// Deliver implements synclog.Sink: it applies the tailer's entries in
// order (permission epochs, re-bootstrap markers, entity changes).
func (h *Hub) Deliver(_ context.Context, entries []livesync_model.LogEntry) {
	if len(entries) == 0 {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for i := range entries {
		e := &entries[i]
		switch {
		case protocol.Op(e.Op) == protocol.OpPermission:
			ch, _, err := perm.DecodeChange(e)
			if err != nil {
				log.Error("%v; checking every subscription again", err)
				ch = protocol.PermissionChange{All: true}
			}
			h.permissionLocked(ch, e.SyncID, e.SyncID)
		case e.Grp == protocol.GroupAll:
			if protocol.Op(e.Op) == protocol.OpRebootstrap {
				h.markerLocked(e)
			}
		case strings.HasPrefix(e.Grp, "!"):
			// Another pseudo group: never for clients.
		default:
			h.fanOutLocked(e)
		}
	}
	h.pos.Store(entries[len(entries)-1].SyncID)
	// Woken now, not when the changes were queued: a frame taken before
	// the store would claim the previous position only (to < the
	// changes' v), and nothing would raise it while the session is quiet.
	for c := range h.delivered {
		c.wakeWriter()
	}
	clear(h.delivered)
	h.checkBarriersLocked()
}

// Skipped implements synclog.Sink: the entries after from up to floor were
// trimmed before the tailer read them. Every subscription may have missed
// changes (bootstrap_required) and permission epochs (checked again).
func (h *Hub) Skipped(_ context.Context, from, floor int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.conns {
		for _, s := range c.subs {
			if s.state == stateLive {
				// Replaying ones are told by their replay (their position
				// is below the floor).
				// Complete up to from only (see conn.capLocked).
				c.sendCapped(&protocol.BootstrapRequiredMessage{Type: protocol.MsgBootstrapRequired, Group: s.group, Reason: protocol.BootstrapCursorTrimmed}, from)
			}
		}
	}
	h.permissionLocked(protocol.PermissionChange{All: true}, floor, from)
	for c := range h.conns {
		for _, s := range c.subs {
			// What they held misses the skipped entries: they read from
			// their cursor (and are told if it was trimmed).
			h.dropHeldLocked(s)
		}
	}
	h.pos.Store(floor)
	h.checkBarriersLocked()
}

// fanOutLocked queues entity change e for the live subscriptions of its
// group whose units allow it, and for the viewer's own profile.
func (h *Hub) fanOutLocked(e *livesync_model.LogEntry) {
	var ch *protocol.Change
	unit := protocol.Unit(e.Unit)
	for s := range h.byGroup[e.Grp] {
		switch {
		case s.state == stateLive && e.SyncID > s.liveFrom && s.units.Allows(unit):
			if ch == nil {
				ch = change(e)
			}
			h.enqueueDeliveredLocked(s.c, ch)
		case s.state == stateRecheck && s.holding && e.SyncID > s.cursor:
			// Held unfiltered: the check may change the units.
			if ch == nil {
				ch = change(e)
			}
			h.holdLocked(s, heldItem{ch: ch, unit: unit}, changeSize(ch))
		}
	}
	if protocol.Model(e.Model) == protocol.ModelUser {
		// A viewer always gets their own profile (WelcomeMessage.Profile).
		for c := range h.byUser[e.EntityID] {
			if s := c.subs[e.Grp]; s != nil && s.state == stateLive {
				continue // got it above (or may not, by unit)
			}
			if ch == nil {
				ch = change(e)
			}
			if !c.welcomed {
				// The welcome's profile may predate it: send it after.
				c.selfPending = append(c.selfPending, *ch)
				continue
			}
			h.enqueueDeliveredLocked(c, ch)
		}
	}
}

// enqueueDeliveredLocked queues a live change of the current Deliver for
// session c (its writer is woken at the end of Deliver, see
// conn.enqueueDelivered).
func (h *Hub) enqueueDeliveredLocked(c *conn, ch *protocol.Change) {
	c.enqueueDelivered(*ch)
	h.delivered[c] = struct{}{}
}

// markerLocked turns a re-bootstrap marker into bootstrap_required for the
// live subscriptions whose group can hold the marker's model. Subscriptions
// that are replaying meet the marker in their replay. A frame queued
// before bootstrap_required claims no more than the position before the
// marker (conn.capLocked): a client resuming from there replays it.
func (h *Hub) markerLocked(e *livesync_model.LogEntry) {
	var marker protocol.RebootstrapMarker
	if err := json.Unmarshal([]byte(e.Payload), &marker); err != nil {
		log.Error("livesync: re-bootstrap marker %d: %v", e.SyncID, err)
	}
	model := protocol.Model(e.Model)
	for c := range h.conns {
		for _, s := range c.subs {
			switch {
			case !canHold(s.kind, model):
			case s.state == stateLive && e.SyncID > s.liveFrom:
				c.sendDelivered(bootstrapFor(s.group, &marker, model), e.SyncID-1)
				h.delivered[c] = struct{}{}
			case s.state == stateRecheck && s.holding && e.SyncID > s.cursor:
				h.holdLocked(s, heldItem{marker: bootstrapFor(s.group, &marker, model), at: e.SyncID}, 128)
			}
		}
	}
}

// holdLocked keeps an entry for s while its permission is checked again.
// When the session's held entries would exceed the send buffer, s drops
// what it holds and catches up from the log after the check.
func (h *Hub) holdLocked(s *sub, it heldItem, size int) {
	if s.c.heldBytes+size > h.cfg.SendBuffer {
		h.dropHeldLocked(s)
		return
	}
	s.held = append(s.held, it)
	s.heldSize += size
	s.c.heldBytes += size
}

// dropHeldLocked forgets what s holds (it catches up from the log if it
// is still suspended).
func (h *Hub) dropHeldLocked(s *sub) {
	s.c.heldBytes -= s.heldSize
	s.held, s.heldSize, s.holding = nil, 0, false
}

// releaseHeldLocked sends what s held while it was checked again (with
// the units just decided) and makes it live: everything of its group after
// its cursor up to the hub's position was held.
//
// The hold is removed and the held entries are queued in one critical
// section of the session's queue lock, which the writer takes too (not
// the hub's): a frame taken before it still claims at most the hold, one
// taken after it carries the held entries. Queueing them first would let
// the writer send them under the stale hold (to < their v, not raised
// until the session's next change); removing the hold first would let it
// claim the hub's position (to ≥ their v) before they were queued, and a
// client that resumed from that frame's to would never get them. A
// marker's bootstrap_required caps the frame queued before it, as live
// (markerLocked).
func (h *Hub) releaseHeldLocked(s *sub) {
	c := s.c
	c.mu.Lock()
	delete(c.holds, s)
	for _, it := range s.held {
		switch {
		case it.marker != nil:
			c.capLocked(it.at - 1)
			c.sendLocked(it.marker)
		case s.units.Allows(it.unit):
			c.enqueueChangeLocked(*it.ch, true)
		}
	}
	c.unlock()
	h.dropHeldLocked(s)
	h.goLiveLocked(s, h.pos.Load())
}

func bootstrapFor(group string, marker *protocol.RebootstrapMarker, model protocol.Model) *protocol.BootstrapRequiredMessage {
	reason := marker.Reason
	if reason == "" {
		reason = protocol.RebootstrapTriggerRepaired
	}
	return &protocol.BootstrapRequiredMessage{Type: protocol.MsgBootstrapRequired, Group: group, Reason: reason, Model: model}
}

// permissionLocked applies a permission epoch at log position p: every
// subscription it may concern stops receiving live changes and is checked
// again, then catches up from p (or is revoked). hold is the position up
// to which those subscriptions are complete (p, or the position before a
// retention skip).
func (h *Hub) permissionLocked(ch protocol.PermissionChange, p, hold int64) {
	h.permSeq++
	if len(h.epochs) == maxEpochLog {
		h.epochs = slices.Delete(h.epochs, 0, 1)
	}
	h.epochs = append(h.epochs, ch)
	affected := map[*sub]struct{}{}
	addAll := func(set map[*sub]struct{}) {
		for s := range set {
			affected[s] = struct{}{}
		}
	}
	revalidate := func(c *conn) {
		c.revalidate = true
		for _, s := range c.subs {
			affected[s] = struct{}{}
		}
		c.kick()
	}
	if ch.All {
		for c := range h.conns {
			revalidate(c)
		}
	}
	for _, u := range ch.Users {
		for c := range h.byUser[u] {
			revalidate(c)
		}
	}
	for _, r := range ch.Repos {
		addAll(h.byGroup[protocol.RepoGroup(r)])
		addAll(h.byRepo[r])
	}
	for _, o := range ch.Owners {
		addAll(h.byGroup[protocol.OrgGroup(o)])
		addAll(h.byGroup[protocol.ProfileGroup(o)])
	}
	for _, t := range ch.Touched {
		for s := range h.byRow[rowKey{t.Kind, t.ID}] {
			if s.dec.Basis.Stale([]protocol.PermissionTouch{t}) {
				affected[s] = struct{}{}
			}
		}
	}
	for s := range affected {
		h.suspendLocked(s, p, hold)
	}
}

// suspendLocked makes s check its permission again before it receives
// anything after position p.
func (h *Hub) suspendLocked(s *sub, p, hold int64) {
	if s.state == stateLive {
		s.state = stateRecheck
		s.cursor = p
		s.holding = true
		s.c.busy++
		s.c.setHold(s, hold)
	}
	s.recheck = true
	h.queueLocked(s)
}

// epochConcerns reports whether permission epoch ch could change the
// decision dec of viewer for group (the subscriptions permissionLocked
// would suspend).
func epochConcerns(ch *protocol.PermissionChange, viewer int64, group string, dec *perm.Decision) bool {
	if ch.All || slices.Contains(ch.Users, viewer) {
		return true
	}
	for _, r := range ch.Repos {
		if r == dec.RepoID || group == protocol.RepoGroup(r) {
			return true
		}
	}
	for _, o := range ch.Owners {
		if group == protocol.OrgGroup(o) || group == protocol.ProfileGroup(o) {
			return true
		}
	}
	return len(ch.Touched) > 0 && dec.Basis.Stale(ch.Touched)
}

// queueLocked hands s to its session's worker (replay / check).
func (h *Hub) queueLocked(s *sub) {
	if !s.queued {
		s.queued = true
		s.c.work = append(s.c.work, s)
		s.c.kick()
	}
}

// checkBarriersLocked answers the pending barriers that are satisfied.
func (h *Hub) checkBarriersLocked() {
	for c := range h.barriers {
		h.checkBarrierLocked(c)
	}
}

func (h *Hub) checkBarrierLocked(c *conn) {
	if c.busy > 0 {
		return
	}
	pos := h.pos.Load()
	kept := c.barriers[:0]
	for _, b := range c.barriers {
		if b.head <= pos {
			c.send(&protocol.BarrierOKMessage{Type: protocol.MsgBarrierOK, ID: b.id, SyncID: pos})
		} else {
			kept = append(kept, b)
		}
	}
	c.barriers = kept
	if len(kept) == 0 {
		delete(h.barriers, c)
	}
}

// change converts a log entry into the change sent to clients.
func change(e *livesync_model.LogEntry) *protocol.Change {
	ch := &protocol.Change{V: e.SyncID, G: e.Grp, M: protocol.Model(e.Model), ID: e.EntityID, Op: protocol.Op(e.Op)}
	if ch.Op == protocol.OpUpsert && e.Payload != "" {
		ch.D = rawJSON(e.Payload)
	}
	return ch
}

// rawJSON is a JSON value embedded verbatim (an entity payload as the
// materializer encoded it).
type rawJSON string

func (r rawJSON) MarshalJSON() ([]byte, error) { return []byte(r), nil }

// changeSize estimates the bytes a change adds to a frame.
func changeSize(ch *protocol.Change) int {
	n := 64 + len(ch.G) + len(ch.M)
	if d, ok := ch.D.(rawJSON); ok {
		n += len(d)
	}
	return n
}

// groupKind is the prefix of a group name ("repo" for repo:1, "profiles"
// for the profile directories; protocol.ParseGroup).
func groupKind(group string) string {
	kind, _, _ := protocol.ParseGroup(group)
	return kind
}
