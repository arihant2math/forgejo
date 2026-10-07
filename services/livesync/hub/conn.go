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
	closeNormal    = 1000
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
}

// outItem is one queued server message: a control message, or (msg nil)
// the changes of a delta frame.
type outItem struct {
	msg     any
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
	// receives them from concurrent POSTs); helloDone and clientBuild are
	// guarded by it.
	handleMu  sync.Mutex
	helloDone bool

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

	workNotify chan struct{}

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
		workNotify: make(chan struct{}, 1), notify: make(chan struct{}, 1),
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

// send queues a control message.
func (c *conn) send(msg any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ending {
		return
	}
	c.queue = append(c.queue, outItem{msg: msg})
	c.wakeWriter()
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
	if n := len(c.queue); n > 0 && c.queue[n-1].msg == nil && c.queue[n-1].size+size <= maxFrameBytes {
		last := &c.queue[n-1]
		last.changes = append(last.changes, ch)
		last.size += size
	} else {
		c.queue = append(c.queue, outItem{changes: []protocol.Change{ch}, size: size})
	}
	c.queued += size
	if live && c.queued > c.h.cfg.SendBuffer {
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
		c.queue = append(c.queue, outItem{msg: final})
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
				if it.msg == nil {
					lastDelta = i
				}
			}
			for i, it := range items {
				msg := it.msg
				if msg == nil {
					frameTo := prevTo
					if i == lastDelta {
						frameTo = to
					}
					msg = &protocol.DeltaMessage{Type: protocol.MsgDelta, To: frameTo, Changes: it.changes}
					lastFrame = time.Now()
				}
				if !c.write(msg) {
					c.t.close(closeInternal, "")
					return
				}
			}
		}
	}
}

func onlyChanges(items []outItem) bool {
	for _, it := range items {
		if it.msg != nil {
			return false
		}
	}
	return true
}

// write encodes and sends one message; false when the session is broken.
func (c *conn) write(msg any) bool {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Error("livesync: encode %T: %v", msg, err)
		return true
	}
	ctx, cancel := context.WithTimeout(c.ctx, c.h.cfg.WriteTimeout)
	defer cancel()
	if err := c.t.write(ctx, data); err != nil {
		log.Debug("livesync: sync session of user %d: write: %v", c.viewer, err)
		return false
	}
	var pos int64
	switch m := msg.(type) {
	case *protocol.DeltaMessage:
		pos = m.To
	case *protocol.CaughtUpMessage:
		pos = m.SyncID
	default:
		return true
	}
	c.mu.Lock()
	c.lastTo = max(c.lastTo, pos)
	c.mu.Unlock()
	return true
}
