// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package hub

import (
	"context"
	"sync"
	"time"

	"forgejo.org/modules/json"
	"forgejo.org/modules/log"
	"forgejo.org/services/livesync/perm"
	"forgejo.org/services/livesync/protocol"
)

// Close codes (WebSocket status codes; the SSE transport just ends the
// stream).
const (
	closeGoingAway = 1001
	closePolicy    = 1008
	closeInternal  = 1011
	closeTryAgain  = 1013
)

// transport carries one session's messages.
type transport interface {
	// write sends one server message.
	write(ctx context.Context, msg []byte) error
	// keepAlive pings the client (WebSocket ping, SSE comment).
	keepAlive(ctx context.Context) error
	// close ends the session with a WebSocket close code and reason.
	close(code int, reason string)
}

type subState int

const (
	// stateReplay: the subscription replays the log from cursor; the
	// client knows it is not caught up yet (caught_up follows).
	stateReplay subState = iota
	// stateLive: the hub sends the group's changes after liveFrom.
	stateLive
	// stateRecheck: a permission epoch at cursor may concern the
	// subscription; it is checked again and catches up from cursor. For
	// the client it is still caught up: frames do not claim completeness
	// beyond its hold (conn.holds).
	stateRecheck
)

// sub is a session's subscription to a group. Every field is guarded by
// Hub.mu.
type sub struct {
	c     *conn
	group string
	kind  string // groupKind(group)
	units perm.UnitSet
	dec   perm.Decision
	state subState
	// cursor: the position the replay continues from (replay, recheck).
	cursor int64
	// liveFrom: live entries up to it were sent by the replay.
	liveFrom int64
	// gen changes when the client restarts the replay (a subscribe with a
	// new since): a running replay starts over from the new cursor.
	gen uint64
	// recheck: the permission must be checked before the replay goes on.
	recheck bool
	queued  bool // in conn.work
	removed bool
	// The index entries of dec (byRepo, byRow).
	repo int64
	rows []rowKey
	// holding (stateRecheck): the group's entries after cursor are kept in
	// held (heldSize bytes) until the check decides; then they are sent
	// (with the units decided) and the subscription is live again, without
	// reading the log. False when they exceeded the session's share
	// (conn.heldBytes): the subscription then catches up from the log.
	holding  bool
	held     []heldItem
	heldSize int
}

// heldItem is an entry kept for a subscription while its permission is
// checked again: a change (and its unit) or a re-bootstrap marker's
// bootstrap_required.
type heldItem struct {
	ch     *protocol.Change
	unit   protocol.Unit
	marker *protocol.BootstrapRequiredMessage
}

// outItem is one queued server message: an encoded control message
// (data; pos is the position a caught_up claims), or (data nil) the
// changes of a delta frame.
type outItem struct {
	data    []byte
	pos     int64
	changes []protocol.Change
	size    int
}

type barrier struct {
	id   string
	head int64
}

// conn is one client session.
type conn struct {
	h      *Hub
	t      transport
	auth   Authenticator
	ctx    context.Context
	cancel context.CancelFunc

	// handleMu serialises the client's messages (the fallback transport
	// receives them from concurrent POSTs) and excludes them from stop;
	// helloDone and stopped are guarded by it. stopped: stop runs, later
	// messages are dropped.
	handleMu  sync.Mutex
	helloDone bool
	stopped   bool

	// session is the id of a fallback session (guarded by Hub.mu).
	session string

	// viewer and token are set when the hello succeeded (under Hub.mu)
	// and never change afterwards.
	viewer int64
	token  string

	// Guarded by Hub.mu. registered: counted as the viewer's session;
	// welcomed: the welcome is queued (nothing else may precede it).
	registered bool
	welcomed   bool
	// selfPending: changes of the viewer's profile delivered between the
	// registration and the welcome (sent right after it).
	selfPending []protocol.Change
	subs        map[string]*sub
	// busy counts the subscriptions that are not live (replay, recheck).
	busy int
	// catchUp: send caught_up when busy drops to 0.
	catchUp    bool
	work       []*sub
	revalidate bool
	barriers   []barrier
	grants     []protocol.Grant // the implicit grants last sent
	// heldBytes: the bytes held by the session's subscriptions (sub.held),
	// bounded by the send buffer.
	heldBytes int

	workNotify chan struct{}
	workerDone chan struct{} // closed when workLoop returned

	// The outgoing queue, guarded by mu.
	mu     sync.Mutex
	room   *sync.Cond // signalled when the queue was taken or the session ends
	queue  []outItem
	queued int // bytes
	// holds: the subscriptions in stateRecheck and the position up to
	// which each is complete (frames claim no more than the lowest).
	holds  map[*sub]int64
	lastTo int64 // the position of the last frame written
	ending bool
	code   int
	reason string
	notify chan struct{}
}

func (h *Hub) newConn(t transport, auth Authenticator) *conn {
	ctx, cancel := context.WithCancel(h.ctx)
	c := &conn{
		h: h, t: t, auth: auth, ctx: ctx, cancel: cancel,
		subs: map[string]*sub{}, holds: map[*sub]int64{},
		workNotify: make(chan struct{}, 1), notify: make(chan struct{}, 1), workerDone: make(chan struct{}),
	}
	c.room = sync.NewCond(&c.mu)
	return c
}

// kick wakes the session's worker.
func (c *conn) kick() {
	select {
	case c.workNotify <- struct{}{}:
	default:
	}
}

func (c *conn) wakeWriter() {
	select {
	case c.notify <- struct{}{}:
	default:
	}
}

// encode encodes a control message for the queue.
func encode(msg any) (outItem, bool) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Error("livesync: encode %T: %v", msg, err)
		return outItem{}, false
	}
	it := outItem{data: data, size: len(data)}
	if m, ok := msg.(*protocol.CaughtUpMessage); ok {
		it.pos = m.SyncID
	}
	return it, true
}

// send queues a control message. Control messages count against the send
// buffer like live changes: a client that sends messages (pings, garbage)
// without reading the answers is closed like a slow one.
func (c *conn) send(msg any) {
	it, ok := encode(msg)
	if !ok {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ending {
		return
	}
	c.queue = append(c.queue, it)
	c.addedLocked(it.size, true)
}

// enqueueChange queues a change for the next delta frame. A live change
// that makes the queue exceed the send buffer ends the session with
// resume_from_cursor (replays wait for room instead, see waitRoom).
func (c *conn) enqueueChange(ch protocol.Change, live bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ending {
		return
	}
	size := changeSize(&ch)
	if n := len(c.queue); n > 0 && c.queue[n-1].data == nil && c.queue[n-1].size+size <= maxFrameBytes {
		last := &c.queue[n-1]
		last.changes = append(last.changes, ch)
		last.size += size
	} else {
		c.queue = append(c.queue, outItem{changes: []protocol.Change{ch}, size: size})
	}
	c.addedLocked(size, live)
}

// addedLocked accounts for size bytes just queued; bounded: end the
// session if the queue now exceeds the send buffer. One item larger than
// the buffer is allowed into an empty queue (it could never be sent
// otherwise).
func (c *conn) addedLocked(size int, bounded bool) {
	c.queued += size
	if bounded && c.queued > c.h.cfg.SendBuffer && c.queued > size {
		// Too slow: drop what was not sent; the client resumes from the
		// last frame it got.
		c.queue, c.queued = nil, 0
		c.endLocked(closeTryAgain, "client too slow", &protocol.ResumeFromCursorMessage{Type: protocol.MsgResumeFromCursor, SyncID: c.lastTo})
		return
	}
	c.wakeWriter()
}

// waitRoom blocks a replay until the queue is at most half full; false
// when the session ended.
func (c *conn) waitRoom() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for !c.ending && c.ctx.Err() == nil && c.queued >= c.h.cfg.SendBuffer/2 {
		c.room.Wait()
	}
	return !c.ending && c.ctx.Err() == nil
}

// setHold / clearHold maintain the holds (call with Hub.mu held).
func (c *conn) setHold(s *sub, pos int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.holds[s]; !ok {
		c.holds[s] = pos
	}
}

func (c *conn) clearHold(s *sub) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.holds, s)
}

// end closes the session after the queued messages and final (if not nil)
// were sent.
func (c *conn) end(code int, reason string, final any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.endLocked(code, reason, final)
}

func (c *conn) endLocked(code int, reason string, final any) {
	if c.ending {
		return
	}
	c.ending, c.code, c.reason = true, code, reason
	if final != nil {
		if it, ok := encode(final); ok {
			c.queue = append(c.queue, it)
		}
	}
	c.room.Broadcast()
	c.wakeWriter()
}

// writeLoop writes the queued messages, batching changes into frames of at
// most FrameInterval, until the session ends. It closes the transport.
func (c *conn) writeLoop() {
	defer c.cancel()
	var lastFrame time.Time
	for {
		select {
		case <-c.ctx.Done():
			c.t.close(closeGoingAway, "")
			return
		case <-c.notify:
		}
		for {
			c.mu.Lock()
			if len(c.queue) == 0 {
				ending, code, reason := c.ending, c.code, c.reason
				c.mu.Unlock()
				if ending {
					c.t.close(code, reason)
					return
				}
				break
			}
			var wait time.Duration
			if !c.ending && onlyChanges(c.queue) {
				wait = c.h.cfg.FrameInterval - time.Since(lastFrame)
			}
			c.mu.Unlock()
			if wait > 0 {
				timer := time.NewTimer(wait)
				select {
				case <-c.ctx.Done():
					timer.Stop()
					c.t.close(closeGoingAway, "")
					return
				case <-timer.C:
				}
			}
			// Load the position before taking the queue: everything up
			// to it was queued before (see Hub.pos).
			pos := c.h.pos.Load()
			c.mu.Lock()
			items := c.queue
			c.queue, c.queued = nil, 0
			prevTo := c.lastTo
			to := pos
			for _, hold := range c.holds {
				to = min(to, hold)
			}
			to = max(to, prevTo)
			c.room.Broadcast()
			c.mu.Unlock()

			lastDelta := -1
			for i, it := range items {
				if it.data == nil {
					lastDelta = i
				}
			}
			for i, it := range items {
				data, pos := it.data, it.pos
				if data == nil {
					pos = prevTo
					if i == lastDelta {
						pos = to
					}
					var err error
					if data, err = json.Marshal(&protocol.DeltaMessage{Type: protocol.MsgDelta, To: pos, Changes: it.changes}); err != nil {
						log.Error("livesync: encode a delta: %v", err)
						continue
					}
					lastFrame = time.Now()
				}
				if !c.write(data, pos) {
					c.t.close(closeInternal, "")
					return
				}
			}
		}
	}
}

func onlyChanges(items []outItem) bool {
	for _, it := range items {
		if it.data != nil {
			return false
		}
	}
	return true
}

// write sends one encoded message that makes the client's caught-up
// groups complete up to pos (0: a message without a position); false when
// the session is broken.
func (c *conn) write(data []byte, pos int64) bool {
	ctx, cancel := context.WithTimeout(c.ctx, c.h.cfg.WriteTimeout)
	defer cancel()
	if err := c.t.write(ctx, data); err != nil {
		log.Debug("livesync: sync session of user %d: write: %v", c.viewer, err)
		return false
	}
	if pos > 0 {
		c.mu.Lock()
		c.lastTo = max(c.lastTo, pos)
		c.mu.Unlock()
	}
	return true
}
