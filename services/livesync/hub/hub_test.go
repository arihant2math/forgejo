// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package hub

import (
	"context"
	"fmt"
	"strconv"
	"sync"
	"testing"
	"time"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/models/unittest"
	"forgejo.org/modules/json"
	"forgejo.org/services/livesync/materialize"
	"forgejo.org/services/livesync/perm"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/services/livesync/synclog"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The hub's logic on SQLite with Forgejo's fixtures: a real sync log
// (synclog over SQLite), real permission checks (perm.Cache), a fake
// transport, and Deliver called by the test instead of a tailer. The
// transports and the database-specific parts are covered by the
// TestLivesyncHub* integration tests on PostgreSQL and MySQL.

func TestMain(m *testing.M) {
	unittest.MainTest(m)
}

// message is any server message, decoded.
type message struct {
	Type         protocol.MessageType `json:"type"`
	Group        string               `json:"group"`
	Reason       string               `json:"reason"`
	Model        protocol.Model       `json:"model"`
	To           int64                `json:"to"`
	Changes      []protocol.Change    `json:"changes"`
	SyncID       int64                `json:"sync_id"`
	ID           string               `json:"id"`
	Granted      []protocol.Grant     `json:"granted"`
	Refused      []protocol.Refusal   `json:"refused"`
	Grants       []protocol.Grant     `json:"grants"`
	Message      string               `json:"message"`
	Code         string               `json:"code"`
	Kind         string               `json:"kind"`
	ServerSyncID int64                `json:"server_sync_id"`
	ViewerID     int64                `json:"viewer_id"`
	Profile      *protocol.Change     `json:"profile"`
	BuildID      string               `json:"build_id"`
}

type fakeTransport struct {
	msgs   chan message
	raw    chan string
	gate   chan struct{} // when not nil, writes wait for it
	mu     sync.Mutex
	closed int
}

func newFakeTransport() *fakeTransport {
	return &fakeTransport{msgs: make(chan message, 1000), raw: make(chan string, 1000)}
}

func (f *fakeTransport) write(ctx context.Context, data []byte) error {
	if f.gate != nil {
		select {
		case <-f.gate:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	var m message
	if err := json.Unmarshal(data, &m); err != nil {
		return err
	}
	f.raw <- string(data)
	f.msgs <- m
	return nil
}

func (f *fakeTransport) keepAlive(context.Context) error { return nil }

func (f *fakeTransport) close(code int, _ string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed == 0 {
		f.closed = code
	}
}

func (f *fakeTransport) closeCode() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closed
}

// fakeAuth accepts the tokens "u<id>".
func fakeAuth(_ context.Context, token string) (int64, string, error) {
	var id int64
	if _, err := fmt.Sscanf(token, "u%d", &id); err != nil || id <= 0 {
		return 0, "invalid token", nil
	}
	return id, "", nil
}

type harness struct {
	t  *testing.T
	h  *Hub
	w  *synclog.Writer
	mu sync.Mutex // serialises deliver
}

func newHarness(t *testing.T, cfg Config) *harness {
	t.Helper()
	require.NoError(t, unittest.PrepareTestDatabase())
	ctx := t.Context()
	require.NoError(t, livesync_model.SyncTables(ctx))
	for _, q := range []string{"DELETE FROM livesync_log", "DELETE FROM livesync_meta"} {
		_, err := db.GetEngine(ctx).Exec(q)
		require.NoError(t, err)
	}
	w, err := synclog.AcquireWriter(ctx, nil)
	require.NoError(t, err)
	t.Cleanup(w.Release)
	cfg.Perms = perm.NewCache(0, 0)
	if cfg.FrameInterval == 0 {
		cfg.FrameInterval = time.Millisecond
	}
	hubCtx, cancel := context.WithCancel(ctx)
	h := New(hubCtx, cfg, 0)
	t.Cleanup(func() {
		h.Shutdown(5 * time.Second)
		cancel()
	})
	return &harness{t: t, h: h, w: w}
}

// append writes entries to the sync log (not yet delivered).
func (x *harness) append(entries ...synclog.Entry) int64 {
	x.t.Helper()
	var first int64
	require.NoError(x.t, db.WithTx(x.t.Context(), func(ctx context.Context) error {
		var err error
		first, err = x.w.Append(ctx, entries)
		return err
	}))
	return first
}

// deliver hands the entries after the hub's position to the hub, as the
// tailer would.
func (x *harness) deliver() {
	x.t.Helper()
	x.mu.Lock()
	defer x.mu.Unlock()
	entries, err := synclog.ReadSince(x.t.Context(), "", x.h.pos.Load(), 1000)
	require.NoError(x.t, err)
	x.h.Deliver(x.t.Context(), entries)
}

func upsert(group string, model protocol.Model, id int64, unit protocol.Unit) synclog.Entry {
	return synclog.Entry{Group: group, Model: model, EntityID: id, Op: protocol.OpUpsert, Unit: unit, SchemaVer: 1, Payload: `{"id":` + strconv.FormatInt(id, 10) + `}`}
}

type client struct {
	t  *testing.T
	c  *conn
	tr *fakeTransport
}

func (x *harness) connect(tr *fakeTransport) *client {
	x.t.Helper()
	if tr == nil {
		tr = newFakeTransport()
	}
	c := x.h.newConn(tr, fakeAuth)
	require.True(x.t, c.start())
	go func() {
		c.writeLoop()
		c.stop()
	}()
	x.t.Cleanup(c.stop)
	return &client{t: x.t, c: c, tr: tr}
}

func (cl *client) send(v any) {
	cl.t.Helper()
	data, err := json.Marshal(v)
	require.NoError(cl.t, err)
	cl.c.handle(data)
}

func (cl *client) hello(viewer int64, groups ...protocol.GroupRequest) message {
	cl.t.Helper()
	cl.send(&protocol.HelloMessage{Type: protocol.MsgHello, Token: "u" + strconv.FormatInt(viewer, 10), Groups: groups})
	return cl.expect(protocol.MsgWelcome)
}

func (cl *client) next() message {
	cl.t.Helper()
	select {
	case m := <-cl.tr.msgs:
		return m
	case <-time.After(5 * time.Second):
		cl.t.Fatal("no message within 5s")
		return message{}
	}
}

func (cl *client) expect(typ protocol.MessageType) message {
	cl.t.Helper()
	m := cl.next()
	require.Equal(cl.t, typ, m.Type, "%+v", m)
	return m
}

// quiet fails if a message arrives within d.
func (cl *client) quiet(d time.Duration) {
	cl.t.Helper()
	select {
	case m := <-cl.tr.msgs:
		cl.t.Fatalf("unexpected message %+v", m)
	case <-time.After(d):
	}
}

// changes collects delta changes until n arrived; other messages fail.
func (cl *client) changes(n int) ([]protocol.Change, int64) {
	cl.t.Helper()
	var res []protocol.Change
	var to int64
	for len(res) < n {
		m := cl.expect(protocol.MsgDelta)
		res = append(res, m.Changes...)
		to = m.To
	}
	require.Len(cl.t, res, n)
	return res, to
}

func since(v int64) *int64 { return new(v) }

func versions(chs []protocol.Change) []int64 {
	res := []int64{}
	for _, ch := range chs {
		res = append(res, ch.V)
	}
	return res
}

func TestHelloWelcome(t *testing.T) {
	x := newHarness(t, Config{BuildID: "b1", Schemas: map[protocol.Model]int{protocol.ModelIssue: 1}, Profile: func(_ context.Context, id int64) (*protocol.Change, error) {
		return &protocol.Change{V: 7, G: protocol.GroupProfilesPublic, M: protocol.ModelUser, ID: id, Op: protocol.OpUpsert}, nil
	}})
	cl := x.connect(nil)
	// Anything before hello is refused.
	cl.send(&protocol.PingMessage{Type: protocol.MsgPing})
	assert.Equal(t, protocol.ErrorHelloRequired, cl.expect(protocol.MsgError).Code)

	// user2 owns repo1 (public) and repo2 (private); user5 may read
	// neither repo2 nor user2's own group; "!perm" and "*" are no groups.
	w := cl.hello(2, protocol.GroupRequest{Group: "repo:1"}, protocol.GroupRequest{Group: "repo:2"}, protocol.GroupRequest{Group: "user:5"},
		protocol.GroupRequest{Group: protocol.GroupPermission}, protocol.GroupRequest{Group: protocol.GroupAll}, protocol.GroupRequest{Group: "repo:999999"})
	assert.EqualValues(t, 2, w.ViewerID)
	assert.Equal(t, "b1", w.BuildID)
	assert.Equal(t, []string{"repo:1", "repo:2"}, grantGroups(w.Granted))
	assert.Equal(t, []protocol.Refusal{
		{Group: "user:5", Reason: protocol.RefusedForbidden},
		{Group: protocol.GroupPermission, Reason: protocol.RefusedForbidden},
		{Group: protocol.GroupAll, Reason: protocol.RefusedForbidden},
		{Group: "repo:999999", Reason: protocol.RefusedForbidden},
	}, w.Refused)
	assert.Contains(t, grantGroups(w.Grants), "user:2", "the implicit grants")
	assert.Contains(t, grantGroups(w.Grants), "repo:2")
	require.NotNil(t, w.Profile)
	assert.EqualValues(t, 2, w.Profile.ID)
	cl.expect(protocol.MsgCaughtUp)
	// Subscriptions are indexed by the rows that decided their group only
	// (repo2 and its owner user2, who is the viewer).
	x.h.mu.Lock()
	assert.ElementsMatch(t, []rowKey{{protocol.TouchRepository, 2}, {protocol.TouchUser, 2}}, cl.c.subs["repo:2"].rows)
	x.h.mu.Unlock()

	cl.send(&protocol.PingMessage{Type: protocol.MsgPing, ID: "p"})
	assert.Equal(t, "p", cl.expect(protocol.MsgPong).ID)
	cl.send(&protocol.HelloMessage{Type: protocol.MsgHello, Token: "u2"})
	assert.Equal(t, protocol.ErrorBadMessage, cl.expect(protocol.MsgError).Code)
	cl.c.handle([]byte("nonsense"))
	assert.Equal(t, protocol.ErrorBadMessage, cl.expect(protocol.MsgError).Code)

	// An invalid token: session_invalid, then the session is closed.
	bad := x.connect(nil)
	bad.send(&protocol.HelloMessage{Type: protocol.MsgHello, Token: "nope"})
	assert.Equal(t, "invalid token", bad.expect(protocol.MsgSessionInvalid).Message)
	assert.Eventually(t, func() bool { return bad.tr.closeCode() == closePolicy }, 5*time.Second, time.Millisecond)

	// Another build: a notice after the welcome.
	other := x.connect(nil)
	other.send(&protocol.HelloMessage{Type: protocol.MsgHello, Token: "u2", BuildID: "b0"})
	other.expect(protocol.MsgWelcome)
	other.expect(protocol.MsgCaughtUp)
	assert.Equal(t, protocol.NoticeNewBuild, other.expect(protocol.MsgNotice).Kind)
}

func grantGroups(grants []protocol.Grant) []string {
	res := []string{}
	for _, g := range grants {
		res = append(res, g.Group)
	}
	return res
}

// A subscription replays from its position, then goes live: nothing is
// lost or sent twice, whatever is delivered while it replays.
func TestReplayThenLive(t *testing.T) {
	x := newHarness(t, Config{})
	for i := range 5 {
		x.append(upsert("repo:1", protocol.ModelLabel, int64(i+1), protocol.UnitIssuesOrPulls), upsert("repo:2", protocol.ModelLabel, 100, protocol.UnitIssuesOrPulls))
	}
	x.deliver()
	// 10 entries: repo:1 has 1, 3, 5, 7, 9.
	cl := x.connect(nil)
	w := cl.hello(2, protocol.GroupRequest{Group: "repo:1", Since: since(2)})
	assert.EqualValues(t, 10, w.ServerSyncID)
	chs, _ := cl.changes(4)
	assert.Equal(t, []int64{3, 5, 7, 9}, versions(chs))
	assert.Equal(t, "repo:1", chs[0].G)
	assert.Equal(t, protocol.ModelLabel, chs[0].M)
	assert.Equal(t, map[string]any{"id": float64(2)}, chs[0].D, "the payload, embedded")
	assert.EqualValues(t, 10, cl.expect(protocol.MsgCaughtUp).SyncID)

	// Live: the next entries of repo:1 only.
	x.append(upsert("repo:2", protocol.ModelLabel, 101, protocol.UnitIssuesOrPulls), upsert("repo:1", protocol.ModelLabel, 6, protocol.UnitIssuesOrPulls))
	x.deliver()
	chs, to := cl.changes(1)
	assert.EqualValues(t, 12, chs[0].V)
	assert.EqualValues(t, 12, to)

	// Entries written while a second subscription replays are delivered
	// once, in order.
	for i := range 20 {
		x.append(upsert("repo:1", protocol.ModelLabel, int64(100+i), protocol.UnitIssuesOrPulls))
	}
	cl2 := x.connect(nil)
	cl2.hello(2, protocol.GroupRequest{Group: "repo:1", Since: since(0)})
	var wg sync.WaitGroup
	wg.Go(func() {
		for range 5 {
			x.deliver()
			x.append(upsert("repo:1", protocol.ModelLabel, 200, protocol.UnitIssuesOrPulls))
		}
		x.deliver()
	})
	wg.Wait()
	var got []int64
	var caughtUp bool
	for len(got) < 6+20+5 || !caughtUp {
		m := cl2.next()
		switch m.Type {
		case protocol.MsgDelta:
			got = append(got, versions(m.Changes)...)
		case protocol.MsgCaughtUp:
			caughtUp = true
		default:
			t.Fatalf("unexpected %+v", m)
		}
	}
	want := []int64{1, 3, 5, 7, 9, 12}
	for v := int64(13); v <= 37; v++ {
		want = append(want, v)
	}
	assert.Equal(t, want, got)
	cl2.quiet(50 * time.Millisecond)
}

// Changes are batched into frames of at most FrameInterval.
func TestFrameBatching(t *testing.T) {
	x := newHarness(t, Config{FrameInterval: 200 * time.Millisecond})
	cl := x.connect(nil)
	cl.hello(2, protocol.GroupRequest{Group: "repo:1"})
	cl.expect(protocol.MsgCaughtUp)
	// The first change goes out at once (the last frame is long ago)...
	x.append(upsert("repo:1", protocol.ModelLabel, 1, protocol.UnitIssuesOrPulls))
	x.deliver()
	assert.Len(t, cl.expect(protocol.MsgDelta).Changes, 1)
	// ... the next ones within the interval share a frame.
	for i := range 3 {
		x.append(upsert("repo:1", protocol.ModelLabel, int64(2+i), protocol.UnitIssuesOrPulls))
		x.deliver()
	}
	m := cl.expect(protocol.MsgDelta)
	assert.Equal(t, []int64{2, 3, 4}, versions(m.Changes))
	assert.EqualValues(t, 4, m.To)
}

// Units filter entries: user5 reads repo1's code but no entry needs more
// than... a unit the viewer lacks is never sent.
func TestUnitsAndSelfProfile(t *testing.T) {
	x := newHarness(t, Config{})
	cl := x.connect(nil)
	// org3 has members-only entries; user5 is not a member.
	w := cl.hello(5, protocol.GroupRequest{Group: "org:3"})
	require.Equal(t, []string{"org:3"}, grantGroups(w.Granted))
	cl.expect(protocol.MsgCaughtUp)
	x.append(upsert("org:3", protocol.ModelTeam, 1, protocol.UnitMembers), upsert("org:3", protocol.ModelOrgUser, 1, protocol.UnitNone))
	// The viewer's own profile arrives without a subscription; others' do not.
	x.append(upsert(protocol.GroupProfilesLimited, protocol.ModelUser, 5, protocol.UnitNone), upsert(protocol.GroupProfilesLimited, protocol.ModelUser, 6, protocol.UnitNone))
	x.deliver()
	chs, _ := cl.changes(2)
	assert.Equal(t, protocol.ModelOrgUser, chs[0].M)
	assert.Equal(t, protocol.ModelUser, chs[1].M)
	assert.EqualValues(t, 5, chs[1].ID)
	cl.quiet(50 * time.Millisecond)
}

// A permission epoch: subscriptions it concerns are checked again; a
// revoked one gets group_revoked and nothing written after the epoch.
func TestPermissionEpochRevokes(t *testing.T) {
	x := newHarness(t, Config{})
	ctx := t.Context()
	// user4 collaborates on user5's repo4, made private here.
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
	x.h.cfg.Perms.Invalidate(protocol.PermissionChange{Users: []int64{4}}) // permSink's job
	epoch := protocol.PermissionChange{Users: []int64{4}}
	payload, _ := json.Marshal(epoch)
	x.append(synclog.Entry{Group: protocol.GroupPermission, Op: protocol.OpPermission, Payload: string(payload)},
		upsert("repo:4", protocol.ModelLabel, 1, protocol.UnitIssuesOrPulls), upsert("repo:1", protocol.ModelLabel, 2, protocol.UnitIssuesOrPulls))
	x.deliver()
	var revoked bool
	var got []int64
	for !revoked || len(got) < 1 {
		m := cl.next()
		switch m.Type {
		case protocol.MsgGroupRevoked:
			assert.Equal(t, "repo:4", m.Group)
			revoked = true
		case protocol.MsgGrants:
			// The epoch named the viewer: their implicit grants changed.
			assert.NotContains(t, grantGroups(m.Grants), "repo:4")
		case protocol.MsgDelta:
			for _, ch := range m.Changes {
				assert.Equal(t, "repo:1", ch.G, "nothing of the revoked group after the epoch")
				got = append(got, ch.V)
			}
		default:
			t.Fatalf("unexpected %+v", m)
		}
	}
	assert.Equal(t, []int64{3}, got, "repo:1 checked again (user epoch) and caught up")
	cl.quiet(50 * time.Millisecond)
	x.h.mu.Lock()
	assert.Nil(t, cl.c.subs["repo:4"])
	assert.Empty(t, x.h.byGroup["repo:4"])
	assert.Empty(t, x.h.byRepo[4])
	assert.Equal(t, 1, x.h.subCount[4])
	x.h.mu.Unlock()

	// The epoch entry itself is never sent; neither is a GroupAll or
	// pseudo-group entry other than markers.
	cl.quiet(10 * time.Millisecond)
}

// A touch whose state differs from what a decision read re-checks the
// subscription (which stays and catches up from the epoch's position); a
// touch with the recorded state concerns nobody.
func TestTouches(t *testing.T) {
	x := newHarness(t, Config{})
	cl := x.connect(nil)
	cl.hello(5, protocol.GroupRequest{Group: "repo:1"})
	cl.expect(protocol.MsgCaughtUp)
	x.h.mu.Lock()
	s := cl.c.subs["repo:1"]
	require.NotEmpty(t, x.h.byRow[rowKey{protocol.TouchRepository, 1}])
	x.h.mu.Unlock()

	touch := func(state string) {
		payload, _ := json.Marshal(protocol.PermissionChange{Touched: []protocol.PermissionTouch{{Kind: protocol.TouchRepository, ID: 1, State: state}}})
		x.append(synclog.Entry{Group: protocol.GroupPermission, Op: protocol.OpPermission, Payload: string(payload)},
			upsert("repo:1", protocol.ModelLabel, 1, protocol.UnitIssuesOrPulls))
		x.deliver()
	}
	touch("false,2") // repo1's current state: nothing to do
	chs, _ := cl.changes(1)
	assert.EqualValues(t, 2, chs[0].V)
	x.h.mu.Lock()
	assert.Equal(t, stateLive, s.state)
	x.h.mu.Unlock()

	touch("true,2") // undone private: the decision is checked again
	chs, to := cl.changes(1)
	assert.EqualValues(t, 4, chs[0].V)
	assert.EqualValues(t, 4, to)
	cl.quiet(50 * time.Millisecond)
}

// Re-bootstrap markers become bootstrap_required for the groups that can
// hold the model (live and replaying subscriptions).
func TestRebootstrapMarker(t *testing.T) {
	x := newHarness(t, Config{})
	cl := x.connect(nil)
	cl.hello(2, protocol.GroupRequest{Group: "repo:1"}, protocol.GroupRequest{Group: "user:2"})
	cl.expect(protocol.MsgCaughtUp)
	marker := `{"table":"label","epoch":2,"reason":"trigger_repaired"}`
	x.append(synclog.Entry{Group: protocol.GroupAll, Model: protocol.ModelLabel, Op: protocol.OpRebootstrap, Payload: marker})
	x.deliver()
	m := cl.expect(protocol.MsgBootstrapRequired)
	assert.Equal(t, "repo:1", m.Group)
	assert.Equal(t, protocol.RebootstrapTriggerRepaired, m.Reason)
	assert.Equal(t, protocol.ModelLabel, m.Model)
	cl.quiet(50 * time.Millisecond) // user:2 cannot hold labels

	// A replay over the marker tells the replaying subscription.
	cl2 := x.connect(nil)
	cl2.hello(2, protocol.GroupRequest{Group: "repo:1", Since: since(0)}, protocol.GroupRequest{Group: "user:2", Since: since(0)})
	assert.Equal(t, "repo:1", cl2.expect(protocol.MsgBootstrapRequired).Group)
	cl2.expect(protocol.MsgCaughtUp)
}

// A position older than the retention floor: bootstrap_required, then live.
// A position ahead of the log: bootstrap_required too.
func TestTrimmedAndUnknownCursor(t *testing.T) {
	x := newHarness(t, Config{})
	for i := range 4 {
		x.append(upsert("repo:1", protocol.ModelLabel, int64(i), protocol.UnitIssuesOrPulls))
	}
	x.deliver()
	_, err := x.w.Trim(t.Context(), 0, 2)
	require.NoError(t, err)
	cl := x.connect(nil)
	cl.hello(2, protocol.GroupRequest{Group: "repo:1", Since: since(1)}, protocol.GroupRequest{Group: "repo:2", Since: since(99)})
	got := map[string]string{}
	for range 2 {
		m := cl.expect(protocol.MsgBootstrapRequired)
		got[m.Group] = m.Reason
	}
	assert.Equal(t, map[string]string{"repo:1": protocol.BootstrapCursorTrimmed, "repo:2": protocol.BootstrapCursorUnknown}, got)
	cl.expect(protocol.MsgCaughtUp)
	x.append(upsert("repo:1", protocol.ModelLabel, 9, protocol.UnitIssuesOrPulls))
	x.deliver()
	chs, _ := cl.changes(1)
	assert.EqualValues(t, 5, chs[0].V)
}

// A replay longer than MaxReplay: bootstrap_required, then live.
func TestReplayTooLong(t *testing.T) {
	x := newHarness(t, Config{MaxReplay: 3})
	for i := range 6 {
		x.append(upsert("repo:1", protocol.ModelLabel, int64(i), protocol.UnitIssuesOrPulls))
	}
	x.deliver()
	cl := x.connect(nil)
	cl.hello(2, protocol.GroupRequest{Group: "repo:1", Since: since(0)})
	n := 0
	for {
		m := cl.next()
		if m.Type == protocol.MsgDelta {
			n += len(m.Changes)
			continue
		}
		assert.Equal(t, protocol.MsgBootstrapRequired, m.Type)
		assert.Equal(t, protocol.BootstrapReplayTooLong, m.Reason)
		break
	}
	assert.Equal(t, 6, n, "one replay batch was sent")
	cl.expect(protocol.MsgCaughtUp)
}

// A session that does not read is closed with resume_from_cursor once its
// live changes exceed the send buffer; what was not sent is dropped.
func TestSlowConsumer(t *testing.T) {
	x := newHarness(t, Config{SendBuffer: 2000})
	tr := newFakeTransport()
	cl := x.connect(tr)
	cl.hello(2, protocol.GroupRequest{Group: "repo:1"})
	cl.expect(protocol.MsgCaughtUp)
	x.append(upsert("repo:1", protocol.ModelLabel, 1, protocol.UnitIssuesOrPulls))
	x.deliver()
	_, to := cl.changes(1)
	assert.EqualValues(t, 1, to)

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
	close(tr.gate)
	chs, _ := cl.changes(1) // the frame the writer was writing
	assert.EqualValues(t, 2, chs[0].V)
	m := cl.expect(protocol.MsgResumeFromCursor)
	assert.EqualValues(t, 1, m.SyncID, "the last frame written when the buffer overflowed")
	assert.Eventually(t, func() bool { return tr.closeCode() == closeTryAgain }, 5*time.Second, time.Millisecond)
	cl.quiet(50 * time.Millisecond)
}

// barrier_ok once the hub delivered everything committed before the
// barrier; unsubscribe stops the changes; limits.
func TestBarrierUnsubscribeLimits(t *testing.T) {
	x := newHarness(t, Config{MaxSubscriptions: 2, MaxConnections: 1})
	cl := x.connect(nil)
	cl.hello(2, protocol.GroupRequest{Group: "repo:1"})
	cl.expect(protocol.MsgCaughtUp)
	x.append(upsert("repo:1", protocol.ModelLabel, 1, protocol.UnitIssuesOrPulls))
	cl.send(&protocol.BarrierMessage{Type: protocol.MsgBarrier, ID: "b"})
	cl.quiet(30 * time.Millisecond) // not delivered yet
	x.deliver()
	cl.changes(1)
	m := cl.expect(protocol.MsgBarrierOK)
	assert.Equal(t, "b", m.ID)
	assert.EqualValues(t, 1, m.SyncID)

	cl.send(&protocol.SubscribeMessage{Type: protocol.MsgSubscribe, Groups: []protocol.GroupRequest{{Group: "repo:2"}, {Group: "user:2"}, {Group: "repo:3"}}})
	sub := cl.expect(protocol.MsgSubscribed)
	assert.Equal(t, []string{"repo:2"}, grantGroups(sub.Granted))
	assert.Equal(t, []protocol.Refusal{{Group: "user:2", Reason: protocol.RefusedLimit}, {Group: "repo:3", Reason: protocol.RefusedLimit}}, sub.Refused)
	cl.expect(protocol.MsgCaughtUp)

	cl.send(&protocol.UnsubscribeMessage{Type: protocol.MsgUnsubscribe, Groups: []string{"repo:1"}})
	x.append(upsert("repo:1", protocol.ModelLabel, 1, protocol.UnitIssuesOrPulls), upsert("repo:2", protocol.ModelLabel, 1, protocol.UnitIssuesOrPulls))
	x.deliver()
	chs, _ := cl.changes(1)
	assert.Equal(t, "repo:2", chs[0].G)

	second := x.connect(nil)
	second.send(&protocol.HelloMessage{Type: protocol.MsgHello, Token: "u2"})
	assert.Equal(t, protocol.ErrorTooManyConnections, second.expect(protocol.MsgError).Code)
}

// Shutdown tells every session and closes it.
func TestShutdown(t *testing.T) {
	x := newHarness(t, Config{})
	cl := x.connect(nil)
	cl.hello(2)
	cl.expect(protocol.MsgCaughtUp)
	x.h.Shutdown(5 * time.Second)
	assert.Equal(t, protocol.NoticeShutdown, cl.expect(protocol.MsgNotice).Kind)
	assert.Equal(t, closeGoingAway, cl.tr.closeCode())
	assert.False(t, x.h.newConn(newFakeTransport(), fakeAuth).start(), "no new sessions")
}

// Every model the materializer writes has its group kinds (re-bootstrap
// markers).
func TestModelKindsCoverModels(t *testing.T) {
	for model := range materialize.Schemas() {
		assert.Contains(t, modelKinds, model)
	}
	assert.True(t, canHold("repo", protocol.ModelLabel))
	assert.False(t, canHold("user", protocol.ModelLabel))
	assert.True(t, canHold("user", "SomeFutureModel"), "unknown models concern every group")
}

// A permission epoch delivered while a subscription's check runs: the new
// subscription is checked again before it goes live.
func TestEpochDuringCheck(t *testing.T) {
	x := newHarness(t, Config{})
	ctx := t.Context()
	_, err := db.GetEngine(ctx).Exec("UPDATE repository SET is_private = ? WHERE id = 4", true)
	require.NoError(t, err)
	cl := x.connect(nil)
	cl.hello(4)
	cl.expect(protocol.MsgCaughtUp)

	at := x.h.checkpoint()
	reqs, ok := cl.c.check([]protocol.GroupRequest{{Group: "repo:4"}}, nil)
	require.True(t, ok)
	require.True(t, reqs[0].ok, "readable when checked")
	// Collaboration removed and its epoch delivered before the
	// subscription is registered.
	_, err = db.GetEngine(ctx).Exec("DELETE FROM collaboration WHERE repo_id = 4 AND user_id = 4")
	require.NoError(t, err)
	_, err = db.GetEngine(ctx).Exec("DELETE FROM access WHERE repo_id = 4 AND user_id = 4")
	require.NoError(t, err)
	x.h.cfg.Perms.Invalidate(protocol.PermissionChange{Users: []int64{4}})
	payload, _ := json.Marshal(protocol.PermissionChange{Users: []int64{4}})
	x.append(synclog.Entry{Group: protocol.GroupPermission, Op: protocol.OpPermission, Payload: string(payload)},
		upsert("repo:4", protocol.ModelLabel, 1, protocol.UnitIssuesOrPulls))
	x.deliver()

	x.h.mu.Lock()
	granted, _, _ := x.h.subscribeLocked(cl.c, reqs, at)
	cl.c.catchUp = true
	x.h.caughtUpLocked(cl.c)
	x.h.mu.Unlock()
	require.Equal(t, []string{"repo:4"}, grantGroups(granted))
	for {
		m := cl.next()
		require.NotEqual(t, protocol.MsgDelta, m.Type, "nothing of repo:4 may be sent")
		if m.Type == protocol.MsgGroupRevoked {
			assert.Equal(t, "repo:4", m.Group)
			break
		}
	}
	cl.expect(protocol.MsgCaughtUp)
}
