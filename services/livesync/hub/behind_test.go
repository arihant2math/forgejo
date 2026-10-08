// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package hub

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"forgejo.org/models/db"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/services/livesync/synclog"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// steadyWriter writes labels of group (about size bytes each) to the sync
// log and delivers them, n per step, until the test ends: a group written
// faster than the client reads.
func steadyWriter(x *harness, group string, n, size int) {
	ctx, cancel := context.WithCancel(x.t.Context())
	var wg sync.WaitGroup
	wg.Go(func() {
		id := int64(100000)
		for ctx.Err() == nil {
			entries := make([]synclog.Entry, 0, n)
			for range n {
				id++
				entries = append(entries, bigLabel(group, id, size))
			}
			if err := db.WithTx(ctx, func(ctx context.Context) error {
				_, err := x.w.Append(ctx, entries)
				return err
			}); err != nil {
				return
			}
			x.mu.Lock()
			delivered, err := synclog.ReadSince(ctx, "", x.h.pos.Load(), 1000)
			if err == nil {
				x.h.Deliver(ctx, delivered)
			}
			x.mu.Unlock()
			if err != nil {
				return
			}
			select {
			case <-ctx.Done():
			case <-time.After(2 * time.Millisecond):
			}
		}
	})
	x.t.Cleanup(func() {
		cancel()
		wg.Wait()
	})
}

// behindClient connects a client (with auth) subscribed to repo:1 that
// reads 500 bytes per ms after its caught_up, and starts writing repo:1
// faster than that: the subscription falls behind and stays behind,
// paging through the log, while the client keeps reading (a frame is
// written well within DrainTimeout, so it is not too slow).
func behindClient(t *testing.T, cfg Config, auth Authenticator) (*harness, *client, map[string]int64) {
	t.Helper()
	cfg.SendBuffer, cfg.DrainTimeout = 256<<10, time.Second
	x := newHarness(t, cfg)
	cl := x.connectAuth(auth)
	go func() { // only msgs is read here
		for range cl.tr.raw {
		}
	}()
	cl.hello(2, protocol.GroupRequest{Group: "repo:1"})
	cl.expect(protocol.MsgCaughtUp)
	cl.tr.setRate(500)
	steadyWriter(x, "repo:1", 5, 1<<10)
	behind := func() bool {
		x.h.mu.Lock()
		defer x.h.mu.Unlock()
		s := cl.c.subs["repo:1"]
		return s != nil && s.behind
	}
	require.Eventually(t, behind, 5*time.Second, time.Millisecond, "repo:1 falls behind")
	// Still behind a while later: the writer outpaces the client.
	newest := map[string]int64{}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		select {
		case m := <-cl.tr.msgs:
			require.Equal(t, protocol.MsgDelta, m.Type, "%+v", m)
			noteNewest(newest, m)
		case <-time.After(10 * time.Millisecond):
		}
	}
	require.True(t, behind(), "repo:1 stays behind")
	return x, cl, newest
}

// noteNewest records the highest sync id received per group.
func noteNewest(newest map[string]int64, m message) {
	for _, ch := range m.Changes {
		newest[ch.G] = max(newest[ch.G], ch.V)
	}
}

// await reads the client's messages until one of type typ arrives (the
// others must be deltas) and returns it, failing after timeout.
func (cl *client) await(typ protocol.MessageType, timeout time.Duration) message {
	cl.t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case m := <-cl.tr.msgs:
			if m.Type == typ {
				return m
			}
			require.Equal(cl.t, protocol.MsgDelta, m.Type, "%+v", m)
		case <-deadline:
			cl.t.Fatalf("no %s within %v", typ, timeout)
			return message{}
		}
	}
}

// A subscription that catches up from a group written faster than the
// client reads may never be live again; the session's token is still
// checked every RevalidateInterval meanwhile (the worker handed the
// subscription back after each page): a revoked one ends the session.
// (The worker used to stay with the subscription until it was live: a
// client that reads slowly but steadily kept its session with a revoked
// token for as long as the group was written.)
func TestBehindRevalidates(t *testing.T) {
	var revoked atomic.Bool
	_, cl, _ := behindClient(t, Config{RevalidateInterval: 50 * time.Millisecond}, func(ctx context.Context, token string) (int64, string, error) {
		if revoked.Load() {
			return 0, "the token was revoked", nil
		}
		return fakeAuth(ctx, token)
	})
	revoked.Store(true)
	m := cl.await(protocol.MsgSessionInvalid, 5*time.Second)
	assert.Equal(t, "the token was revoked", m.Message)
	assert.Eventually(t, func() bool { return cl.tr.closeCode() == closePolicy }, 5*time.Second, time.Millisecond)
}

// While a subscription catches up (and stays behind), the session's other
// work goes on: a new subscription replays and caught_up follows (the
// behind subscription is caught up for the client; caught_up claims no
// more than it was sent), and a barrier is answered once the catch-up
// passed the barrier's head — not only once the subscription is live
// again, which it may never be. (The worker used to stay with the
// subscription until it was live, and caught_up and barrier_ok waited for
// it.)
func TestBehindOtherWork(t *testing.T) {
	x, cl, newest := behindClient(t, Config{}, fakeAuth)
	isBehind := func() bool {
		x.h.mu.Lock()
		defer x.h.mu.Unlock()
		return cl.c.subs["repo:1"].behind
	}
	head := x.h.pos.Load()
	cl.send(&protocol.BarrierMessage{Type: protocol.MsgBarrier, ID: "b"})
	first := x.append(upsert("repo:2", protocol.ModelLabel, 1, protocol.UnitIssuesOrPulls), upsert("repo:2", protocol.ModelLabel, 2, protocol.UnitIssuesOrPulls))
	// Delivered before the subscription: it replays them.
	require.Eventually(t, func() bool { return x.h.pos.Load() > first }, 5*time.Second, time.Millisecond)
	cl.send(&protocol.SubscribeMessage{Type: protocol.MsgSubscribe, Groups: []protocol.GroupRequest{{Group: "repo:2", Since: since(first - 1)}}})

	got := []int64{}
	deadline := time.After(20 * time.Second)
	subscribed := false
	var caughtUp, barrierOK *message
	for caughtUp == nil || barrierOK == nil {
		select {
		case m := <-cl.tr.msgs:
			switch m.Type {
			case protocol.MsgSubscribed:
				assert.Equal(t, []string{"repo:2"}, grantGroups(m.Granted))
				subscribed = true
			case protocol.MsgDelta:
				noteNewest(newest, m)
				for _, ch := range m.Changes {
					if ch.G == "repo:2" {
						got = append(got, ch.V)
					}
				}
			case protocol.MsgCaughtUp:
				assert.True(t, subscribed)
				assert.Equal(t, []int64{first, first + 1}, got, "repo:2 replayed before caught_up")
				assert.True(t, isBehind(), "caught_up came while repo:1 is still behind")
				// Every entry of repo:1 up to caught_up's position was sent
				// before it (the client resumes repo:1 from there).
				missed, err := synclog.ReadKeys(t.Context(), "repo:1", newest["repo:1"], m.SyncID, 1)
				require.NoError(t, err)
				assert.Empty(t, missed, "caught_up at %d claims entries of repo:1 after %d not sent yet", m.SyncID, newest["repo:1"])
				caughtUp = &m
			case protocol.MsgBarrierOK:
				assert.Equal(t, "b", m.ID)
				assert.GreaterOrEqual(t, m.SyncID, head)
				assert.True(t, isBehind(), "barrier_ok came while repo:1 is still behind")
				missed, err := synclog.ReadKeys(t.Context(), "repo:1", newest["repo:1"], m.SyncID, 1)
				require.NoError(t, err)
				assert.Empty(t, missed, "barrier_ok at %d claims entries of repo:1 after %d not sent yet", m.SyncID, newest["repo:1"])
				barrierOK = &m
			default:
				require.Failf(t, "unexpected message", "%+v", m)
			}
		case <-deadline:
			require.Fail(t, "no caught_up or barrier_ok within 20s", "subscribed: %v, repo:2 changes: %v, caught_up: %v, barrier_ok: %v", subscribed, got, caughtUp, barrierOK)
		}
	}
}
