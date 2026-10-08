// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package hub

import (
	"sync"
	"testing"
	"time"

	"forgejo.org/services/livesync/metrics"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/services/livesync/synclog"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// counterValue reads a counter of the metrics package.
func counterValue(t *testing.T, c prometheus.Counter) float64 {
	t.Helper()
	reg := prometheus.NewRegistry()
	require.NoError(t, reg.Register(c))
	families, err := reg.Gather()
	require.NoError(t, err)
	return families[0].GetMetric()[0].GetCounter().GetValue()
}

// queueSampler records the largest queue of a session while it runs.
func queueSampler(t *testing.T, c *conn) func() int {
	t.Helper()
	done := make(chan struct{})
	var wg sync.WaitGroup
	peak := 0
	wg.Go(func() {
		for {
			c.mu.Lock()
			peak = max(peak, c.queued)
			c.mu.Unlock()
			select {
			case <-done:
				return
			case <-time.After(50 * time.Microsecond):
			}
		}
	})
	var once sync.Once
	stop := func() int {
		once.Do(func() {
			close(done)
			wg.Wait()
		})
		return peak
	}
	t.Cleanup(func() { stop() })
	return stop
}

// burst appends n labels, spread round-robin over groups (distinct
// entities), and returns their sync ids by group.
func burst(x *harness, n int, groups ...string) map[string][]int64 {
	var entries []synclog.Entry
	for i := range n {
		entries = append(entries, upsert(groups[i%len(groups)], protocol.ModelLabel, int64(1000+i), protocol.UnitIssuesOrPulls))
	}
	first := x.append(entries...)
	want := map[string][]int64{}
	for i := range n {
		g := groups[i%len(groups)]
		want[g] = append(want[g], first+int64(i))
	}
	return want
}

// A burst of many times the send buffer in one delivery reaches a client
// that reads, in order and complete, without closing the session: the
// subscriptions whose changes did not fit catch up from the log as the
// client reads (paged, so even beyond MaxReplay), the queue never holds
// more than the buffer, and no frame claims a position (to) before the
// client got everything up to it.
func TestBurstReachesFastClient(t *testing.T) {
	x := newHarness(t, Config{SendBuffer: 8000, MaxReplay: 5}) // the welcome fits
	tr := newFakeTransport()
	cl := x.connect(tr)
	w := cl.hello(2, protocol.GroupRequest{Group: "repo:1"}, protocol.GroupRequest{Group: "repo:2"})
	require.Equal(t, []string{"repo:1", "repo:2"}, grantGroups(w.Granted))
	cl.expect(protocol.MsgCaughtUp)
	peak := queueSampler(t, cl.c)
	catchUps := counterValue(t, metrics.CatchUps)

	const n = 1000 // ≈ 95 bytes each: ≈ 12 × the send buffer, in one delivery
	want := burst(x, n, "repo:1", "repo:2")
	start := want["repo:1"][0] - 1
	x.deliver()
	x.h.mu.Lock()
	behind := cl.c.subs["repo:1"].behind && cl.c.subs["repo:2"].behind
	x.h.mu.Unlock()
	assert.True(t, behind, "the burst did not fit: both subscriptions catch up from the log")
	assert.Greater(t, counterValue(t, metrics.CatchUps), catchUps)

	got := map[string][]int64{}
	received := map[int64]bool{}
	for len(received) < n {
		m := cl.expect(protocol.MsgDelta)
		for _, ch := range m.Changes {
			got[ch.G] = append(got[ch.G], ch.V)
			received[ch.V] = true
		}
		for v := start + 1; v <= m.To; v++ {
			require.True(t, received[v], "delta.to %d claims %d before it was sent", m.To, v)
		}
	}
	assert.Equal(t, want, got, "every change once, in order per group")
	assert.LessOrEqual(t, peak(), 8000, "the queue never held more than the send buffer")

	// Live again, and the session is fine.
	v := x.append(label(1, "after"))
	x.deliver()
	chs, to := cl.changes(1)
	assert.Equal(t, v, chs[0].V)
	assert.Equal(t, v, to)
	cl.send(&protocol.BarrierMessage{Type: protocol.MsgBarrier, ID: "b"})
	assert.Equal(t, v, cl.expect(protocol.MsgBarrierOK).SyncID)
	cl.quiet(30 * time.Millisecond)
	assert.Zero(t, tr.closeCode())
	x.h.mu.Lock()
	defer x.h.mu.Unlock()
	assert.Zero(t, cl.c.busy)
	assert.Empty(t, cl.c.holds)
}

// While a subscription catches up, the frames claim no more than it has
// been sent (its hold, raised page by page), also when the writer takes
// the queue at every chance; a client that resumes from any claimed
// position misses nothing.
func TestBurstCatchUpFrameTo(t *testing.T) {
	x := newHarness(t, Config{SendBuffer: 8000}) // the welcome fits
	cl := x.connectManual()
	cl.send(&protocol.HelloMessage{Type: protocol.MsgHello, Token: "u2", Groups: []protocol.GroupRequest{{Group: "repo:1"}}})
	msgs := cl.take()
	require.Equal(t, protocol.MsgCaughtUp, msgs[len(msgs)-1].Type)

	const n = 1000 // one delivery, two catch-up pages
	want := burst(x, n, "repo:1")
	start := want["repo:1"][0] - 1
	x.deliver()
	received := map[int64]bool{}
	var claims []int64
	require.Eventually(t, func() bool {
		for _, m := range cl.take() {
			require.Equal(t, protocol.MsgDelta, m.Type, "%+v", m)
			for _, ch := range m.Changes {
				received[ch.V] = true
			}
			for v := start + 1; v <= m.To; v++ {
				require.True(t, received[v], "delta.to %d claims %d before it was sent", m.To, v)
			}
			claims = append(claims, m.To)
		}
		return len(received) == n
	}, 10*time.Second, time.Millisecond)
	assert.Equal(t, start+n, claims[len(claims)-1])
	// The position moved on while the subscription caught up (its hold
	// was raised once the first page was queued), not only at the end.
	var mid int64
	for _, to := range claims {
		if to > start+replayBatch && to < start+n {
			mid = to
			break
		}
	}
	require.NotZero(t, mid, "a frame claims the first page before the second was sent: %v", claims)

	// Resuming repo:1 from there gets the rest.
	other := x.connect(nil)
	other.hello(2, protocol.GroupRequest{Group: "repo:1", Since: since(mid)})
	var rest []int64
	for {
		m := other.next()
		if m.Type == protocol.MsgCaughtUp {
			break
		}
		require.Equal(t, protocol.MsgDelta, m.Type, "%+v", m)
		rest = append(rest, versions(m.Changes)...)
	}
	var wantRest []int64
	for _, v := range want["repo:1"] {
		if v > mid {
			wantRest = append(wantRest, v)
		}
	}
	assert.Equal(t, wantRest, rest)
}

// Entries held for a re-check that do not fit in the session's queue when
// they are released are not released (that overflowed the queue and
// closed the session): the subscription catches up from the log instead.
func TestHeldReleaseCatchesUp(t *testing.T) {
	x := newHarness(t, Config{SendBuffer: 8000}) // the welcome fits
	cl := x.connectManual()
	cl.send(&protocol.HelloMessage{Type: protocol.MsgHello, Token: "u2", Groups: []protocol.GroupRequest{{Group: "repo:1"}, {Group: "repo:2"}}})
	msgs := cl.take()
	require.Equal(t, protocol.MsgCaughtUp, msgs[len(msgs)-1].Type)

	// The writer does not take the queue: ≈ 4700 bytes of repo:2.
	var queued []synclog.Entry
	for i := range 50 {
		queued = append(queued, upsert("repo:2", protocol.ModelLabel, int64(i+1), protocol.UnitIssuesOrPulls))
	}
	x.append(queued...)
	x.deliver()
	// An epoch naming user 2 suspends both; ≈ 1900 bytes of repo:1 are
	// held.
	var held []synclog.Entry
	for i := range 20 {
		held = append(held, label(int64(i+1), "l"))
	}
	x.epoch(protocol.PermissionChange{Users: []int64{2}}, held...)
	head := x.h.pos.Load()
	require.Eventually(t, func() bool {
		x.h.mu.Lock()
		defer x.h.mu.Unlock()
		s := cl.c.subs["repo:1"]
		return s.state == stateRecheck && s.behind && !s.holding
	}, 5*time.Second, time.Millisecond, "the held entries did not fit: repo:1 catches up from the log")

	got := map[string]int{}
	require.Eventually(t, func() bool {
		for _, m := range cl.take() {
			switch m.Type {
			case protocol.MsgDelta:
				for _, ch := range m.Changes {
					got[ch.G]++
				}
			case protocol.MsgGrants:
			default:
				require.Failf(t, "unexpected message", "%+v", m)
			}
		}
		x.h.mu.Lock()
		defer x.h.mu.Unlock()
		return cl.c.subs["repo:1"].state == stateLive && got["repo:1"] == 20
	}, 5*time.Second, time.Millisecond)
	assert.Equal(t, map[string]int{"repo:1": 20, "repo:2": 50}, got)
	assert.Equal(t, head, cl.c.position())
}

// A client that stops reading is still closed with resume_from_cursor,
// once its queued messages waited longer than DrainTimeout — not when a
// burst exceeds the send buffer; what was not sent is dropped.
func TestSlowConsumer(t *testing.T) {
	x := newHarness(t, Config{SendBuffer: 2000, DrainTimeout: 300 * time.Millisecond})
	tr := newFakeTransport()
	cl := x.connect(tr)
	cl.hello(2, protocol.GroupRequest{Group: "repo:1"})
	cl.expect(protocol.MsgCaughtUp)
	x.append(upsert("repo:1", protocol.ModelLabel, 1, protocol.UnitIssuesOrPulls))
	x.deliver()
	_, to := cl.changes(1)
	assert.EqualValues(t, 1, to)
	slow := counterValue(t, metrics.SlowConsumers)

	tr.gate = make(chan struct{}) // the client stops reading
	x.append(upsert("repo:1", protocol.ModelLabel, 2, protocol.UnitIssuesOrPulls))
	x.deliver()
	time.Sleep(20 * time.Millisecond) // the writer is now blocked
	var many []synclog.Entry
	for i := range 40 {
		many = append(many, upsert("repo:1", protocol.ModelLabel, int64(10+i), protocol.UnitIssuesOrPulls))
	}
	x.append(many...)
	x.deliver()
	ending := func() bool {
		cl.c.mu.Lock()
		defer cl.c.mu.Unlock()
		return cl.c.ending
	}
	assert.False(t, ending(), "a burst larger than the buffer does not close the session")
	assert.Eventually(t, ending, 5*time.Second, time.Millisecond, "not drained within DrainTimeout")
	assert.InDelta(t, slow+1, counterValue(t, metrics.SlowConsumers), 0)
	close(tr.gate)
	chs, _ := cl.changes(1) // the frame the writer was writing
	assert.EqualValues(t, 2, chs[0].V)
	m := cl.expect(protocol.MsgResumeFromCursor)
	assert.EqualValues(t, 1, m.SyncID, "the last frame written when the session was found too slow")
	assert.Eventually(t, func() bool { return tr.closeCode() == closeTryAgain }, 5*time.Second, time.Millisecond)
	cl.quiet(50 * time.Millisecond)
}

// A client that reads, but slower than the server produces, is closed too:
// its queue's messages wait longer than DrainTimeout. Its memory stays
// bounded meanwhile.
func TestSlowReader(t *testing.T) {
	x := newHarness(t, Config{SendBuffer: 2000, DrainTimeout: 200 * time.Millisecond})
	tr := newFakeTransport()
	tr.bytesPerMs = 5 // the 1500 bytes of changes a frame may take need 300ms
	cl := x.connect(tr)
	cl.hello(2, protocol.GroupRequest{Group: "repo:1"})
	cl.expect(protocol.MsgCaughtUp)
	peak := queueSampler(t, cl.c)
	for i := range 100 {
		x.append(label(int64(i+1), "l"))
		x.deliver()
		if tr.closeCode() != 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	for {
		m := cl.next()
		if m.Type == protocol.MsgResumeFromCursor {
			break
		}
		require.Equal(t, protocol.MsgDelta, m.Type, "%+v", m)
	}
	assert.Eventually(t, func() bool { return tr.closeCode() == closeTryAgain }, 5*time.Second, time.Millisecond)
	assert.LessOrEqual(t, peak(), 2000)
}

// Control messages still fit while live changes fill the queue: a pong
// during a burst does not close the session.
func TestControlRoomDuringBurst(t *testing.T) {
	x := newHarness(t, Config{SendBuffer: 2000})
	cl := x.connectManual()
	cl.send(&protocol.HelloMessage{Type: protocol.MsgHello, Token: "u2", Groups: []protocol.GroupRequest{{Group: "repo:1"}}})
	cl.take()
	var many []synclog.Entry
	for i := range 40 {
		many = append(many, label(int64(i+1), "l"))
	}
	x.append(many...)
	x.deliver()
	for range 4 {
		cl.send(&protocol.PingMessage{Type: protocol.MsgPing, ID: "p"})
	}
	pongs, changes := 0, 0
	require.Eventually(t, func() bool {
		for _, m := range cl.take() {
			switch m.Type {
			case protocol.MsgPong:
				pongs++
			case protocol.MsgDelta:
				changes += len(m.Changes)
			default:
				require.Failf(t, "unexpected message", "%+v", m)
			}
		}
		return changes == 40
	}, 5*time.Second, time.Millisecond)
	assert.Equal(t, 4, pongs)
}

// The viewer's own profile is sent by the subscription of its group when
// there is one, in order with the group's other entries: also while the
// subscription catches up. (Sent at once instead, it arrived before the
// older entries the catch-up had not sent yet; a client resuming the
// group from the highest v it got skipped them.)
func TestSelfProfileInOrderWhileBehind(t *testing.T) {
	x := newHarness(t, Config{SendBuffer: 2000})
	cl := x.connect(nil)
	w := cl.hello(5, protocol.GroupRequest{Group: protocol.GroupProfilesLimited})
	require.Equal(t, []string{protocol.GroupProfilesLimited}, grantGroups(w.Granted))
	cl.expect(protocol.MsgCaughtUp)
	var entries []synclog.Entry
	for i := range 60 {
		entries = append(entries, upsert(protocol.GroupProfilesLimited, protocol.ModelUser, int64(100+i), protocol.UnitNone))
	}
	entries = append(entries, upsert(protocol.GroupProfilesLimited, protocol.ModelUser, 5, protocol.UnitNone))
	first := x.append(entries...)
	x.deliver()
	var got []int64
	for len(got) < len(entries) {
		m := cl.expect(protocol.MsgDelta)
		got = append(got, versions(m.Changes)...)
	}
	want := make([]int64, len(entries))
	for i := range want {
		want[i] = first + int64(i)
	}
	assert.Equal(t, want, got, "every entry once, in order")
	cl.quiet(30 * time.Millisecond)
}
