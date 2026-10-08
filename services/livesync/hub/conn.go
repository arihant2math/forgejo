// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package hub

import (
	"context"
	"sync"
	"time"

	"forgejo.org/modules/json"
	"forgejo.org/modules/log"
	"forgejo.org/services/livesync/metrics"
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
// bootstrap_required (and the marker's sync id).
type heldItem struct {
	ch     *protocol.Change
	unit   protocol.Unit
	marker *protocol.BootstrapRequiredMessage
	at     int64
}

// outItem is one queued server message: an encoded control message
// (data; pos is the position a caught_up claims), or (data nil) the
// changes of a delta frame (when capped, its to is at most maxTo: see
// conn.capLocked).
type outItem struct {
	data    []byte
	pos     int64
	changes []protocol.Change
	size    int
	capped  bool
	maxTo   int64
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

	// The outgoing queue, guarded by mu. Whatever one critical section of
	// mu queues is taken by the writer as a whole (take).
	mu     sync.Mutex
	room   *sync.Cond // signalled when the queue was taken or the session ends
	queue  []outItem
	queued int // bytes
	// wake: the current critical section of mu queued something or ended
	// the session; unlock wakes the writer after releasing mu.
	wake bool
	// holds: the subscriptions in stateRecheck and the position up to
	// which each is complete (frames claim no more than the lowest).
	holds  map[*sub]int64
	lastTo int64 // the position of the last frame written
	ending bool
	code   int
	reason string
	notify chan struct{}
	// onWake, when set (tests), runs instead of waking the writer: a
	// writer that takes the queue at every chance it gets (right after
	// mu was released).
	onWake func()
	// lastFrame: when the last delta was encoded (the writer's own).
	lastFrame time.Time

	// tails are the session's Actions log tails (logs.go): the tail
	// wanted for each job, guarded by tailMu with tailRunners, the jobs
	// that have a goroutine (it may still be finishing a stopped tail);
	// tailWG counts the goroutines (stop waits for them) and tailSlot
	// makes the session's tails take turns for the hub's check slots.
	tailMu      sync.Mutex
	tails       map[int64]*logTail
	tailRunners map[int64]bool
	tailWG      sync.WaitGroup
	tailSlot    chan struct{}
}

func (h *Hub) newConn(t transport, auth Authenticator) *conn {
	ctx, cancel := context.WithCancel(h.ctx)
	c := &conn{
		h: h, t: t, auth: auth, ctx: ctx, cancel: cancel,
		subs: map[string]*sub{}, holds: map[*sub]int64{}, tails: map[int64]*logTail{},
		tailRunners: map[int64]bool{}, tailSlot: make(chan struct{}, 1),
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

// wakeWriter wakes the session's writer (call without mu held).
func (c *conn) wakeWriter() {
	if c.onWake != nil {
		c.onWake()
		return
	}
	select {
	case c.notify <- struct{}{}:
	default:
	}
}

// unlock releases mu and then wakes the writer if the critical section
// queued something (or ended the session).
func (c *conn) unlock() {
	wake := c.wake
	c.wake = false
	c.mu.Unlock()
	if wake {
		c.wakeWriter()
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
	switch m := msg.(type) {
	case *protocol.CaughtUpMessage:
		it.pos = m.SyncID
	case *protocol.BootstrapRequiredMessage:
		metrics.BootstrapRequired.WithLabelValues(m.Reason).Inc()
	case *protocol.GroupRevokedMessage:
		metrics.GroupsRevoked.Inc()
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
	defer c.unlock()
	c.pushLocked(it)
}

// sendLocked is send with mu held.
func (c *conn) sendLocked(msg any) {
	if it, ok := encode(msg); ok {
		c.pushLocked(it)
	}
}

func (c *conn) pushLocked(it outItem) {
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
	defer c.unlock()
	c.enqueueChangeLocked(ch, live)
}

// enqueueDelivered and sendDelivered queue a live change or a control
// message of a delivery without waking the writer: Hub.Deliver wakes it
// once the hub's position includes the delivery, so that the frame
// carrying its changes claims it (to).
func (c *conn) enqueueDelivered(ch protocol.Change) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.enqueueChangeLocked(ch, true)
	c.wake = false
}

// sendDelivered queues a control message of a delivery after which the
// client's caught-up groups are complete up to limit only (see capLocked).
func (c *conn) sendDelivered(msg any, limit int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.capLocked(limit)
	c.sendLocked(msg)
	c.wake = false
}

// sendCapped queues a control message after which the client's caught-up
// groups are complete up to limit only (see capLocked).
func (c *conn) sendCapped(msg any, limit int64) {
	it, ok := encode(msg)
	if !ok {
		return
	}
	c.mu.Lock()
	defer c.unlock()
	c.capLocked(limit)
	c.pushLocked(it)
}

// sendAtHold queues a control message about s (bootstrap_required) that
// tells the client its position in s's group is not to be trusted: when s
// is suspended, frames queued before it claim no more than s's hold (see
// capLocked). A subscription that replays is not caught up for the client
// (to does not raise its position): nothing to cap. For replay_too_long
// and cursor_trimmed a resume from the hold derives the message again;
// permission_changed is not derived again (the client compares the units
// of its next grant), but the cap keeps the client's position from moving
// past held entries the new units drop, which a resume after the change
// was undone must replay.
func (c *conn) sendAtHold(s *sub, msg any) {
	it, ok := encode(msg)
	if !ok {
		return
	}
	c.mu.Lock()
	defer c.unlock()
	if hold, ok := c.holds[s]; ok {
		c.capLocked(hold)
	}
	c.pushLocked(it)
}

// capLocked caps the to of the last delta frame queued so far at limit,
// called right before queueing a message that tells the client that one of
// the groups it holds as caught up is complete only up to limit
// (bootstrap_required: entries after it must be loaded again;
// group_revoked). Neither carries a position, so until it arrives no frame
// may claim more: a client whose session broke after that frame resumes
// the group from the frame's to, and the replay from there would not
// include what the message was about (a re-bootstrap marker, the entries
// a suspended subscription never got). take computes to when it takes the
// frame, possibly after the hold or the hub position that kept it low has
// moved on, hence the cap travels with the frame. Frames queued after the
// message are not capped.
func (c *conn) capLocked(limit int64) {
	for i := len(c.queue) - 1; i >= 0; i-- {
		if it := &c.queue[i]; it.data == nil {
			if !it.capped || limit < it.maxTo {
				it.capped, it.maxTo = true, limit
			}
			return
		}
	}
}

func (c *conn) enqueueChangeLocked(ch protocol.Change, live bool) {
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
		metrics.SlowConsumers.Inc()
		c.endLocked(closeTryAgain, "client too slow", &protocol.ResumeFromCursorMessage{Type: protocol.MsgResumeFromCursor, SyncID: c.lastTo})
		return
	}
	c.wake = true
}

// waitRoom blocks a replay or a log tail until the queue is at most half
// full; false when the session ended or ctx (the session's, or a log
// tail's, derived from it) was cancelled.
func (c *conn) waitRoom(ctx context.Context) bool {
	if ctx != c.ctx {
		// c.stop wakes the waiters of the session's context; a tail's
		// own cancellation must wake them too.
		defer context.AfterFunc(ctx, func() {
			c.mu.Lock()
			c.room.Broadcast()
			c.mu.Unlock()
		})()
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for !c.ending && ctx.Err() == nil && c.queued >= c.h.cfg.SendBuffer/2 {
		c.room.Wait()
	}
	return !c.ending && ctx.Err() == nil
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
	defer c.unlock()
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
	c.wake = true
}

// writeLoop writes the queued messages, batching changes into frames of at
// most FrameInterval, until the session ends. It closes the transport.
func (c *conn) writeLoop() {
	defer c.cancel()
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
				wait = c.h.cfg.FrameInterval - time.Since(c.lastFrame)
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
			for _, f := range c.take() {
				if !c.write(f.data, f.pos) {
					c.t.close(closeInternal, "")
					return
				}
			}
		}
	}
}

// frame is an encoded server message and the position it claims (0:
// none; see write).
type frame struct {
	data []byte
	pos  int64
}

// take takes the queued messages and encodes them, the writer's step: the
// last delta frame claims the hub's position, capped by the holds (the
// suspended subscriptions are complete up to their hold only) and its
// maxTo (a message after it that the client must get first, see
// capLocked), earlier ones the position of the last frame written. Write
// them in order.
func (c *conn) take() []frame {
	// Load the position before taking the queue: everything up to it was
	// queued before (see Hub.pos).
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
	frames := make([]frame, 0, len(items))
	for i, it := range items {
		if it.data != nil {
			frames = append(frames, frame{it.data, it.pos})
			continue
		}
		at := prevTo
		if i == lastDelta {
			at = to
			if it.capped {
				at = max(min(at, it.maxTo), prevTo)
			}
		}
		data, err := json.Marshal(&protocol.DeltaMessage{Type: protocol.MsgDelta, To: at, Changes: it.changes})
		if err != nil {
			log.Error("livesync: encode a delta: %v", err)
			continue
		}
		c.lastFrame = time.Now()
		metrics.Frames.Inc()
		metrics.FrameBytes.Add(float64(len(data)))
		frames = append(frames, frame{data, at})
	}
	return frames
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
