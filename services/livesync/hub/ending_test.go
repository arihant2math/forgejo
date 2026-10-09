// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package hub

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"forgejo.org/services/livesync/protocol"
	"forgejo.org/services/livesync/synclog"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// An ending session's worker stops: no step once the session is ending,
// although its context is cancelled only when the writer returns — after
// the frame it is writing, up to WriteTimeout (10s here) for a client that
// does not read. (process used to hand the subscription back as long as
// the context was alive, and drainWork took it again at once: the
// catch-up's and the replay's waitRoom fail at once when the session is
// ending, so the worker busy-looped — millions of steps, each taking the
// hub's lock twice, and on the replay path a read of the log range and its
// payloads per step — until the writer gave up.)
func TestEndingWorkerStops(t *testing.T) {
	// A subscription that fell behind (a burst that does not fit) and
	// catches up from the log when the client stopped reading.
	t.Run("catch-up", func(t *testing.T) {
		x := newHarness(t, Config{SendBuffer: 64 << 10, DrainTimeout: 200 * time.Millisecond})
		var steps atomic.Int64
		tr := newFakeTransport()
		cl := x.connectCounting(tr, &steps)
		cl.hello(2, protocol.GroupRequest{Group: "repo:1"})
		cl.expect(protocol.MsgCaughtUp)
		tr.gate = make(chan struct{}) // the client stops reading
		burst := make([]synclog.Entry, 0, 200)
		for i := range 200 {
			burst = append(burst, bigLabel("repo:1", int64(i+1), 1<<10))
		}
		x.append(burst...)
		x.deliver()
		endingStaysQuiet(t, x, []*client{cl}, &steps, 2)
		x.h.mu.Lock()
		behind := cl.c.subs["repo:1"].behind
		x.h.mu.Unlock()
		assert.True(t, behind, "repo:1 caught up from the log when the session ended")
		close(tr.gate)
		cl.await(protocol.MsgResumeFromCursor, 5*time.Second)
		assert.Eventually(t, func() bool { return tr.closeCode() == closeTryAgain }, 5*time.Second, time.Millisecond)
		<-cl.c.workerDone
		assert.LessOrEqual(t, steps.Load(), int64(2), "worker steps once the session was ending")
	})
	// A replay (hello with a since) whose client does not read.
	t.Run("replay", func(t *testing.T) {
		x := newHarness(t, Config{SendBuffer: 64 << 10, DrainTimeout: 200 * time.Millisecond})
		appendDelivered(x, 300)
		var steps atomic.Int64
		tr := newFakeTransport()
		tr.gate = make(chan struct{}) // not even the welcome is read
		cl := x.connectCounting(tr, &steps)
		cl.send(&protocol.HelloMessage{Type: protocol.MsgHello, Token: "u2", Groups: []protocol.GroupRequest{{Group: "repo:1", Since: since(0)}}})
		endingStaysQuiet(t, x, []*client{cl}, &steps, 2)
		close(tr.gate)
		cl.expect(protocol.MsgWelcome)
		cl.await(protocol.MsgResumeFromCursor, 5*time.Second)
		assert.Eventually(t, func() bool { return tr.closeCode() == closeTryAgain }, 5*time.Second, time.Millisecond)
		<-cl.c.workerDone
		assert.LessOrEqual(t, steps.Load(), int64(2), "worker steps once the session was ending")
	})
}

// Hub.Shutdown ends every session at once; the workers of those whose
// writer is stuck in a write stop at once too (they used to busy-loop
// until each writer gave up, replaying the same range again and again).
func TestEndingWorkerShutdown(t *testing.T) {
	const n = 24
	x := newHarness(t, Config{SendBuffer: 16 << 10, MaxConnections: n})
	appendDelivered(x, 100)
	var steps atomic.Int64
	clients := make([]*client, 0, n)
	for range n {
		tr := newFakeTransport()
		tr.gate = make(chan struct{})
		cl := x.connectCounting(tr, &steps)
		cl.send(&protocol.HelloMessage{Type: protocol.MsgHello, Token: "u2", Groups: []protocol.GroupRequest{{Group: "repo:1", Since: since(0)}}})
		clients = append(clients, cl)
	}
	// Every replay waits for room (its writer is stuck on the welcome).
	for _, cl := range clients {
		require.Eventually(t, func() bool {
			cl.c.mu.Lock()
			defer cl.c.mu.Unlock()
			return cl.c.queued >= x.h.cfg.SendBuffer/2
		}, 10*time.Second, time.Millisecond)
	}
	var wg sync.WaitGroup
	wg.Go(func() { x.h.Shutdown(30 * time.Second) })
	// One decision per session (the one that stops), and a little slack.
	endingStaysQuiet(t, x, clients, &steps, n+4)
	for _, cl := range clients {
		close(cl.tr.gate)
	}
	wg.Wait()
	for _, cl := range clients {
		assert.Equal(t, closeGoingAway, cl.tr.closeCode())
	}
	assert.LessOrEqual(t, steps.Load(), int64(n+4), "worker steps once the sessions were ending")
}

// A log tail stops polling its job once the session is ending (what it
// would send is not queued any more), not only once the writer returned.
func TestEndingLogTailStops(t *testing.T) {
	logs := &fakeLogs{jobs: map[int64]LogJob{}, lines: map[int64][]string{}}
	logs.set(1, LogJob{RepoID: 1, TaskID: 10})
	logs.add(10, "a")
	x := newHarness(t, Config{Logs: logs, LogInterval: 5 * time.Millisecond})
	tr := newFakeTransport()
	cl := x.connect(tr)
	cl.hello(5)
	cl.expect(protocol.MsgCaughtUp)
	cl.send(&protocol.LogTailMessage{Type: protocol.MsgLogTail, JobID: 1})
	cl.expect(protocol.MsgLog)
	tr.gate = make(chan struct{}) // the client stops reading
	polls := func() int {
		logs.mu.Lock()
		defer logs.mu.Unlock()
		return logs.polls
	}
	// The writer gets stuck on the final message.
	cl.c.end(closePolicy, "session invalid", &protocol.SessionInvalidMessage{Type: protocol.MsgSessionInvalid})
	time.Sleep(50 * time.Millisecond) // a poll running now may finish
	before := polls()
	time.Sleep(300 * time.Millisecond)
	require.NoError(t, cl.c.ctx.Err(), "the writer is still stuck in its write")
	assert.Equal(t, before, polls(), "the tail polled its job while the session was ending")
	close(tr.gate)
	cl.expect(protocol.MsgSessionInvalid)
	assert.Eventually(t, func() bool { return tr.closeCode() == closePolicy }, 5*time.Second, time.Millisecond)
}

// connectCounting connects a client whose worker counts in steps the
// decisions to go on (conn.next) it takes while the session is ending.
func (x *harness) connectCounting(tr *fakeTransport, steps *atomic.Int64) *client {
	x.t.Helper()
	c := x.h.newConn(tr, fakeAuth)
	c.onStep = func() {
		c.mu.Lock()
		ending := c.ending
		c.mu.Unlock()
		if ending {
			steps.Add(1)
		}
	}
	require.True(x.t, c.start())
	go func() {
		c.writeLoop()
		c.stop()
	}()
	x.t.Cleanup(c.stop)
	return &client{t: x.t, c: c, tr: tr}
}

// appendDelivered writes n labels of about 1 KiB to repo:1 and delivers
// them (nobody is subscribed yet: they are for replays).
func appendDelivered(x *harness, n int) {
	x.t.Helper()
	entries := make([]synclog.Entry, 0, n)
	for i := range n {
		entries = append(entries, bigLabel("repo:1", int64(i+1), 1<<10))
	}
	x.append(entries...)
	x.deliver()
}

// endingStaysQuiet waits until every client's session is ending, then
// checks that their workers take at most limit steps in all over 300ms
// while the writers are still stuck in a write (the sessions' contexts are
// not cancelled yet).
func endingStaysQuiet(t *testing.T, x *harness, clients []*client, steps *atomic.Int64, limit int) {
	t.Helper()
	for _, cl := range clients {
		require.Eventually(t, func() bool {
			cl.c.mu.Lock()
			defer cl.c.mu.Unlock()
			return cl.c.ending
		}, 10*time.Second, time.Millisecond, "the session ends")
	}
	time.Sleep(300 * time.Millisecond)
	for _, cl := range clients {
		require.NoError(t, cl.c.ctx.Err(), "the writer is still stuck in its write (WriteTimeout %v)", x.h.cfg.WriteTimeout)
	}
	t.Logf("steps while ending: %d", steps.Load())
	assert.LessOrEqual(t, steps.Load(), int64(limit), "worker steps while the sessions were ending")
}
