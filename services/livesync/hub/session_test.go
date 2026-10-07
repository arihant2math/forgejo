// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package hub

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"forgejo.org/models/db"
	"forgejo.org/modules/json"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/services/livesync/synclog"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func (x *harness) connectAuth(auth Authenticator) *client {
	x.t.Helper()
	tr := newFakeTransport()
	c := x.h.newConn(tr, auth)
	require.True(x.t, c.start())
	go func() {
		c.writeLoop()
		c.stop()
	}()
	x.t.Cleanup(c.stop)
	return &client{t: x.t, c: c, tr: tr}
}

func (x *harness) epoch(ch protocol.PermissionChange, more ...synclog.Entry) {
	x.t.Helper()
	x.h.cfg.Perms.Invalidate(ch) // permSink's job
	payload, err := json.Marshal(ch)
	require.NoError(x.t, err)
	x.append(append([]synclog.Entry{{Group: protocol.GroupPermission, Op: protocol.OpPermission, Payload: string(payload)}}, more...)...)
	x.deliver()
}

// Control messages count against the send buffer: a client that sends
// pings without reading the pongs is closed like a slow one, and the queue
// never holds more than the buffer.
func TestControlMessagesBounded(t *testing.T) {
	x := newHarness(t, Config{SendBuffer: 2000})
	tr := newFakeTransport()
	cl := x.connect(tr)
	cl.hello(2)
	cl.expect(protocol.MsgCaughtUp)
	tr.gate = make(chan struct{})
	cl.send(&protocol.PingMessage{Type: protocol.MsgPing, ID: "first"})
	time.Sleep(20 * time.Millisecond) // the writer is blocked on the first pong
	for range 1000 {
		cl.send(&protocol.PingMessage{Type: protocol.MsgPing, ID: "flood"})
		cl.c.mu.Lock()
		queued := cl.c.queued
		cl.c.mu.Unlock()
		require.LessOrEqual(t, queued, 2000)
	}
	close(tr.gate)
	assert.Equal(t, "first", cl.expect(protocol.MsgPong).ID)
	assert.Equal(t, protocol.MsgResumeFromCursor, cl.next().Type)
	assert.Eventually(t, func() bool { return tr.closeCode() == closeTryAgain }, 5*time.Second, time.Millisecond)
}

// trackingWriter records uses of a ResponseWriter after its handler
// returned (net/http recycles the writer then) and before the headers.
type trackingWriter struct {
	http.ResponseWriter
	mu         sync.Mutex
	header     bool
	returned   bool
	violations []string
}

func (w *trackingWriter) use(what string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.returned {
		w.violations = append(w.violations, what+" after the handler returned")
	}
	if !w.header && what != "WriteHeader" {
		w.violations = append(w.violations, what+" before the headers")
	}
	if what == "WriteHeader" {
		w.header = true
	}
}

func (w *trackingWriter) WriteHeader(code int) {
	w.use("WriteHeader")
	w.ResponseWriter.WriteHeader(code)
}

func (w *trackingWriter) Write(b []byte) (int, error) {
	w.use("Write")
	return w.ResponseWriter.Write(b)
}

func (w *trackingWriter) Flush() {
	w.use("Flush")
	w.ResponseWriter.(http.Flusher).Flush()
}

func (w *trackingWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// The SSE transport never touches the ResponseWriter before its headers or
// after ServeSSE returned, although keep-alives come from another
// goroutine (with -race this also catches the data race with net/http).
func TestSSEWriterLifetime(t *testing.T) {
	x := newHarness(t, Config{KeepAlive: 20 * time.Microsecond})
	var mu sync.Mutex
	var writers []*trackingWriter
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		tw := &trackingWriter{ResponseWriter: w}
		mu.Lock()
		writers = append(writers, tw)
		mu.Unlock()
		x.h.ServeSSE(tw, req, fakeAuth)
		tw.mu.Lock()
		tw.returned = true
		tw.mu.Unlock()
	}))
	defer srv.Close()
	var wg sync.WaitGroup
	var streams atomic.Int64
	for range 4 {
		wg.Go(func() {
			for range 40 {
				resp, err := http.Get(srv.URL)
				if err != nil {
					t.Error(err)
					return
				}
				sc := bufio.NewScanner(resp.Body)
				for i := 0; i < 3 && sc.Scan(); i++ {
				}
				resp.Body.Close()
				streams.Add(1)
			}
		})
	}
	wg.Wait()
	assert.EqualValues(t, 160, streams.Load())
	// Let the last sessions end.
	assert.Eventually(t, func() bool {
		x.h.mu.Lock()
		defer x.h.mu.Unlock()
		return len(x.h.conns) == 0
	}, 5*time.Second, time.Millisecond)
	time.Sleep(10 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	for _, w := range writers {
		w.mu.Lock()
		assert.Empty(t, w.violations)
		w.mu.Unlock()
	}
}

// A group already subscribed takes no new slot when requested again.
func TestLimitCountsNewGroupsOnly(t *testing.T) {
	x := newHarness(t, Config{MaxSubscriptions: 2})
	cl := x.connect(nil)
	cl.hello(2, protocol.GroupRequest{Group: "repo:1"})
	cl.expect(protocol.MsgCaughtUp)
	cl.send(&protocol.SubscribeMessage{Type: protocol.MsgSubscribe, Groups: []protocol.GroupRequest{{Group: "repo:1"}, {Group: "repo:2"}}})
	m := cl.expect(protocol.MsgSubscribed)
	assert.Equal(t, []string{"repo:1", "repo:2"}, grantGroups(m.Granted))
	assert.Empty(t, m.Refused)
}

// A permission epoch delivered while a subscription's check runs makes the
// check stale only when it may concern that subscription.
func TestEpochDuringCheckConcerns(t *testing.T) {
	x := newHarness(t, Config{})
	cl := x.connect(nil)
	cl.hello(5)
	cl.expect(protocol.MsgCaughtUp)
	for _, tc := range []struct {
		name  string
		ch    protocol.PermissionChange
		stale bool
	}{
		{"touch of another repository", protocol.PermissionChange{Touched: []protocol.PermissionTouch{{Kind: protocol.TouchRepository, ID: 2, State: "false,2"}}}, false},
		{"touch in the state read", protocol.PermissionChange{Touched: []protocol.PermissionTouch{{Kind: protocol.TouchRepository, ID: 1, State: "false,2"}}}, false},
		{"another user", protocol.PermissionChange{Users: []int64{4}}, false},
		{"another repository", protocol.PermissionChange{Repos: []int64{3}}, false},
		{"another owner", protocol.PermissionChange{Owners: []int64{3}}, false},
		{"touch in another state", protocol.PermissionChange{Touched: []protocol.PermissionTouch{{Kind: protocol.TouchRepository, ID: 1, State: "true,2"}}}, true},
		{"the viewer", protocol.PermissionChange{Users: []int64{5}}, true},
		{"the repository", protocol.PermissionChange{Repos: []int64{1}}, true},
		{"everybody", protocol.PermissionChange{All: true}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			at := x.h.checkpoint()
			reqs, ok := cl.c.check([]protocol.GroupRequest{{Group: "repo:1"}}, nil)
			require.True(t, ok)
			require.True(t, reqs[0].ok)
			payload, _ := json.Marshal(tc.ch)
			x.append(synclog.Entry{Group: protocol.GroupPermission, Op: protocol.OpPermission, Payload: string(payload)})
			x.deliver()
			x.h.mu.Lock()
			x.h.subscribeLocked(cl.c, reqs, at)
			s := cl.c.subs["repo:1"]
			assert.Equal(t, tc.stale, s.recheck || s.state != stateLive)
			x.h.removeSubLocked(s)
			x.h.mu.Unlock()
		})
	}
	x.h.mu.Lock()
	x.h.epochs = nil // older than the log: every check is stale
	x.h.mu.Unlock()
	at := x.h.checkpoint()
	at.permSeq--
	reqs, _ := cl.c.check([]protocol.GroupRequest{{Group: "repo:1"}}, nil)
	x.h.mu.Lock()
	x.h.subscribeLocked(cl.c, reqs, at)
	assert.True(t, cl.c.subs["repo:1"].recheck)
	x.h.mu.Unlock()
}

// Entries trimmed before the tailer read them: every live subscription is
// told to bootstrap, and every subscription is checked again.
func TestSkipped(t *testing.T) {
	x := newHarness(t, Config{})
	ctx := t.Context()
	_, err := db.GetEngine(ctx).Exec("UPDATE repository SET is_private = ? WHERE id = 4", true)
	require.NoError(t, err)
	cl := x.connect(nil)
	w := cl.hello(4, protocol.GroupRequest{Group: "repo:4"}, protocol.GroupRequest{Group: "repo:1"})
	require.Equal(t, []string{"repo:4", "repo:1"}, grantGroups(w.Granted))
	cl.expect(protocol.MsgCaughtUp)

	_, err = db.GetEngine(ctx).Exec("DELETE FROM collaboration WHERE repo_id = 4 AND user_id = 4")
	require.NoError(t, err)
	_, err = db.GetEngine(ctx).Exec("DELETE FROM access WHERE repo_id = 4 AND user_id = 4")
	require.NoError(t, err)
	x.append(upsert("repo:4", protocol.ModelLabel, 1, protocol.UnitIssuesOrPulls), upsert("repo:1", protocol.ModelLabel, 1, protocol.UnitIssuesOrPulls))
	x.append(upsert("repo:4", protocol.ModelLabel, 2, protocol.UnitIssuesOrPulls), upsert("repo:1", protocol.ModelLabel, 2, protocol.UnitIssuesOrPulls))
	floor, err := x.w.Trim(ctx, 0, 2)
	require.NoError(t, err)
	require.EqualValues(t, 2, floor)
	x.h.cfg.Perms.Invalidate(protocol.PermissionChange{All: true}) // permSink's job
	x.h.Skipped(ctx, 0, floor)
	x.deliver()

	bootstrap := map[string]string{}
	var revoked string
	var got []protocol.Change
	for revoked == "" || len(got) < 1 || len(bootstrap) < 2 {
		m := cl.next()
		switch m.Type {
		case protocol.MsgBootstrapRequired:
			bootstrap[m.Group] = m.Reason
		case protocol.MsgGroupRevoked:
			revoked = m.Group
		case protocol.MsgDelta:
			got = append(got, m.Changes...)
		case protocol.MsgGrants:
		default:
			t.Fatalf("unexpected %+v", m)
		}
	}
	assert.Equal(t, map[string]string{"repo:4": protocol.BootstrapCursorTrimmed, "repo:1": protocol.BootstrapCursorTrimmed}, bootstrap)
	assert.Equal(t, "repo:4", revoked)
	require.Len(t, got, 1)
	assert.Equal(t, "repo:1", got[0].G)
	assert.EqualValues(t, 4, got[0].V)
	cl.quiet(50 * time.Millisecond)
}

// The viewer's units in a group changed: bootstrap_required
// (permission_changed), the subscription stays with the new units.
func TestPermissionChangedUnits(t *testing.T) {
	x := newHarness(t, Config{})
	cl := x.connect(nil)
	w := cl.hello(4, protocol.GroupRequest{Group: "org:3"})
	require.Equal(t, []string{"org:3"}, grantGroups(w.Granted))
	require.Equal(t, []protocol.Unit{protocol.UnitMembers}, w.Granted[0].Units)
	cl.expect(protocol.MsgCaughtUp)

	_, err := db.GetEngine(t.Context()).Exec("DELETE FROM org_user WHERE org_id = 3 AND uid = 4")
	require.NoError(t, err)
	x.epoch(protocol.PermissionChange{Users: []int64{4}},
		upsert("org:3", protocol.ModelTeam, 1, protocol.UnitMembers), upsert("org:3", protocol.ModelOrgUser, 1, protocol.UnitNone))
	var changed bool
	var got []protocol.Change
	for !changed || len(got) < 1 {
		m := cl.next()
		switch m.Type {
		case protocol.MsgBootstrapRequired:
			assert.Equal(t, "org:3", m.Group)
			assert.Equal(t, protocol.BootstrapPermissionChanged, m.Reason)
			changed = true
		case protocol.MsgDelta:
			got = append(got, m.Changes...)
		case protocol.MsgGrants:
			assert.NotContains(t, grantGroups(m.Grants), "org:3")
		default:
			t.Fatalf("unexpected %+v", m)
		}
	}
	require.Len(t, got, 1)
	assert.Equal(t, protocol.ModelOrgUser, got[0].M, "members-only entries are no longer sent")
	cl.quiet(50 * time.Millisecond)
	x.h.mu.Lock()
	assert.Equal(t, stateLive, cl.c.subs["org:3"].state)
	x.h.mu.Unlock()
}

// A client that missed bootstrap_required{permission_changed} is not told
// again when it resumes the group, from whatever position: the server does
// not know the units it had. The resumed grant carries the units, and they
// differ from the ones the client holds exactly when the change concerns
// it (the client contract in protocol.GroupRequest): a change undone in
// between needs nothing, the replay is filtered by the current units.
func TestPermissionChangedResume(t *testing.T) {
	leave := func(t *testing.T, x *harness) {
		_, err := db.GetEngine(t.Context()).Exec("DELETE FROM org_user WHERE org_id = 3 AND uid = 4")
		require.NoError(t, err)
		x.epoch(protocol.PermissionChange{Users: []int64{4}})
	}
	join := func(t *testing.T, x *harness) {
		_, err := db.GetEngine(t.Context()).Exec("INSERT INTO org_user (id, uid, org_id, is_public) VALUES (2, 4, 3, ?)", false)
		require.NoError(t, err)
		x.epoch(protocol.PermissionChange{Users: []int64{4}})
	}
	// missed reads cl's messages up to bootstrap_required{permission_changed}
	// for org:3, which the client then misses (the session breaks).
	missed := func(t *testing.T, cl *client) {
		for {
			m := cl.next()
			if m.Type == protocol.MsgBootstrapRequired {
				require.Equal(t, "org:3", m.Group)
				require.Equal(t, protocol.BootstrapPermissionChanged, m.Reason)
				return
			}
		}
	}
	// resume resumes org:3 from pos in a new session and returns the
	// grant's units; the replay has nothing to say about the change.
	resume := func(t *testing.T, x *harness, pos int64) ([]protocol.Unit, []protocol.Change) {
		cl := x.connect(nil)
		w := cl.hello(4, protocol.GroupRequest{Group: "org:3", Since: since(pos)})
		require.Equal(t, []string{"org:3"}, grantGroups(w.Granted))
		var chs []protocol.Change
		for {
			m := cl.next()
			switch m.Type {
			case protocol.MsgCaughtUp:
				return w.Granted[0].Units, chs
			case protocol.MsgDelta:
				chs = append(chs, m.Changes...)
			default:
				require.Failf(t, "unexpected message", "%+v", m)
			}
		}
	}
	members := []protocol.Unit{protocol.UnitMembers}

	t.Run("units shrank", func(t *testing.T) {
		x := newHarness(t, Config{})
		cl := x.connect(nil)
		w := cl.hello(4, protocol.GroupRequest{Group: "org:3"})
		require.Equal(t, members, w.Granted[0].Units)
		cl.expect(protocol.MsgCaughtUp)
		leave(t, x)
		missed(t, cl)
		units, _ := resume(t, x, x.h.pos.Load())
		assert.Empty(t, units, "the client holds members: it must bootstrap")
	})

	t.Run("units grew", func(t *testing.T) {
		x := newHarness(t, Config{})
		leave(t, x)
		team := x.append(upsert("org:3", protocol.ModelTeam, 1, protocol.UnitMembers))
		x.deliver()
		cl := x.connect(nil)
		w := cl.hello(4, protocol.GroupRequest{Group: "org:3"})
		require.Empty(t, w.Granted[0].Units)
		cl.expect(protocol.MsgCaughtUp)
		join(t, x)
		missed(t, cl)
		units, chs := resume(t, x, x.h.pos.Load())
		assert.Equal(t, members, units, "the client holds none: it must bootstrap")
		assert.NotContains(t, versions(chs), team, "older members-only entities come only with a bootstrap")
	})

	t.Run("changed and undone", func(t *testing.T) {
		x := newHarness(t, Config{})
		cl := x.connect(nil)
		w := cl.hello(4, protocol.GroupRequest{Group: "org:3"})
		require.Equal(t, members, w.Granted[0].Units)
		cl.expect(protocol.MsgCaughtUp)
		pos := x.h.pos.Load()
		cl.c.stop() // the client goes away
		leave(t, x)
		team := x.append(upsert("org:3", protocol.ModelTeam, 1, protocol.UnitMembers))
		x.deliver()
		join(t, x)
		units, chs := resume(t, x, pos)
		assert.Equal(t, members, units, "same units: nothing to bootstrap")
		assert.Equal(t, []int64{team}, versions(chs), "the replay sends what changed meanwhile")
	})
}

// An epoch naming an owner re-checks the subscriptions of its org:{id}
// and profile:{id} groups only.
func TestOwnerEpoch(t *testing.T) {
	x := newHarness(t, Config{})
	cl := x.connect(nil)
	cl.hello(5, protocol.GroupRequest{Group: "org:3"}, protocol.GroupRequest{Group: "repo:1"})
	cl.expect(protocol.MsgCaughtUp)
	_, err := db.GetEngine(t.Context()).Exec("UPDATE `user` SET visibility = 2 WHERE id = 3")
	require.NoError(t, err)
	x.epoch(protocol.PermissionChange{Owners: []int64{3}}, upsert("org:3", protocol.ModelOrgUser, 1, protocol.UnitNone))
	x.h.mu.Lock()
	assert.Equal(t, stateLive, cl.c.subs["repo:1"].state, "not concerned")
	x.h.mu.Unlock()
	assert.Equal(t, "org:3", cl.expect(protocol.MsgGroupRevoked).Group)
	cl.quiet(50 * time.Millisecond)
}

// A change of the viewer's profile delivered between the registration and
// the welcome is sent right after the welcome.
func TestSelfPending(t *testing.T) {
	var x *harness
	x = newHarness(t, Config{Profile: func(_ context.Context, id int64) (*protocol.Change, error) {
		x.append(upsert(protocol.GroupProfilesLimited, protocol.ModelUser, id, protocol.UnitNone))
		x.deliver()
		return &protocol.Change{V: 0, G: protocol.GroupProfilesLimited, M: protocol.ModelUser, ID: id, Op: protocol.OpUpsert}, nil
	}})
	cl := x.connect(nil)
	w := cl.hello(5)
	assert.Zero(t, w.Profile.V)
	chs, _ := cl.changes(1)
	assert.Equal(t, protocol.ModelUser, chs[0].M)
	assert.EqualValues(t, 5, chs[0].ID)
	assert.EqualValues(t, 1, chs[0].V)
	cl.expect(protocol.MsgCaughtUp)
}

// No hello within HelloTimeout: the session is closed.
func TestHelloTimeout(t *testing.T) {
	x := newHarness(t, Config{HelloTimeout: 30 * time.Millisecond})
	cl := x.connect(nil)
	assert.Equal(t, protocol.ErrorHelloRequired, cl.expect(protocol.MsgError).Code)
	assert.Eventually(t, func() bool { return cl.tr.closeCode() == closePolicy }, 5*time.Second, time.Millisecond)
}

// The token is checked again periodically and on epochs naming the
// viewer: a revoked one ends the session with session_invalid.
func TestRevalidate(t *testing.T) {
	for _, periodic := range []bool{true, false} {
		t.Run(map[bool]string{true: "periodic", false: "epoch"}[periodic], func(t *testing.T) {
			cfg := Config{RevalidateInterval: time.Hour}
			if periodic {
				cfg.RevalidateInterval = 20 * time.Millisecond
			}
			x := newHarness(t, cfg)
			var revoked atomic.Bool
			cl := x.connectAuth(func(ctx context.Context, token string) (int64, string, error) {
				if revoked.Load() {
					return 0, "the token was revoked", nil
				}
				return fakeAuth(ctx, token)
			})
			cl.hello(2, protocol.GroupRequest{Group: "repo:1"})
			cl.expect(protocol.MsgCaughtUp)
			if periodic {
				cl.quiet(60 * time.Millisecond) // re-validated, still fine
			}
			revoked.Store(true)
			if !periodic {
				x.epoch(protocol.PermissionChange{Users: []int64{2}})
			}
			assert.Equal(t, "the token was revoked", cl.expect(protocol.MsgSessionInvalid).Message)
			assert.Eventually(t, func() bool { return cl.tr.closeCode() == closePolicy }, 5*time.Second, time.Millisecond)
		})
	}
}

// Over SSE a hello (POST /-/sync/send) may still be handled when the
// stream's handler returns and stops the session. stop waits for it, and a
// message handled after stop registers nothing: the session must not stay
// in byUser, byGroup or subCount (review round 2).
func TestStopDuringHello(t *testing.T) {
	x := newHarness(t, Config{})
	// Warm user 2's grants: the blocked hello then finds them in the cache
	// and registers without noticing the cancelled context.
	cl := x.connect(nil)
	cl.hello(2, protocol.GroupRequest{Group: "repo:1"})
	cl.expect(protocol.MsgCaughtUp)

	entered, release := make(chan struct{}), make(chan struct{})
	c := x.h.newConn(newFakeTransport(), func(ctx context.Context, token string) (int64, string, error) {
		close(entered)
		<-release // ignores ctx, like the cached paths after it
		return fakeAuth(ctx, token)
	})
	require.True(t, c.start())
	hello, err := json.Marshal(&protocol.HelloMessage{Type: protocol.MsgHello, Token: "u2", Groups: []protocol.GroupRequest{{Group: "repo:1"}}})
	require.NoError(t, err)
	handled := make(chan struct{})
	go func() {
		defer close(handled)
		c.handle(hello)
	}()
	<-entered
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		c.stop() // ServeSSE's defer
	}()
	select {
	case <-stopped:
		t.Fatal("stop returned while the hello was handled")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	<-handled
	<-stopped

	// A message of the stopped session handled afterwards (Send looked the
	// session up before stop removed it) is dropped.
	late := x.h.newConn(newFakeTransport(), fakeAuth)
	require.True(t, late.start())
	late.stop()
	late.handle(hello)

	x.h.mu.Lock()
	defer x.h.mu.Unlock()
	assert.NotContains(t, x.h.conns, c)
	assert.NotContains(t, x.h.conns, late)
	assert.Len(t, x.h.byUser[2], 1)
	assert.Contains(t, x.h.byUser[2], cl.c)
	assert.Equal(t, 1, x.h.subCount[2])
	require.Len(t, x.h.byGroup["repo:1"], 1)
	for s := range x.h.byGroup["repo:1"] {
		assert.Same(t, cl.c, s.c)
	}
	assert.Empty(t, c.subs)
	assert.Empty(t, late.subs)
}
