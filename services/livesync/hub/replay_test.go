// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package hub

import (
	"strconv"
	"testing"
	"time"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/json"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/services/livesync/synclog"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func label(id int64, name string) synclog.Entry {
	e := upsert("repo:1", protocol.ModelLabel, id, protocol.UnitIssuesOrPulls)
	e.Payload = `{"id":` + strconv.FormatInt(id, 10) + `,"name":"` + name + `"}`
	return e
}

func remove(group string, model protocol.Model, id int64, unit protocol.Unit) synclog.Entry {
	return synclog.Entry{Group: group, Model: model, EntityID: id, Op: protocol.OpDelete, Unit: unit, SchemaVer: 1}
}

// A replay sends the newest state of each entity in its range, never the
// states before it (edited or deleted text stays gone), whatever position
// the client claims.
func TestReplayNewestState(t *testing.T) {
	x := newHarness(t, Config{})
	x.append(label(1, "first"), label(1, "edited"), label(2, "two"))               // 1-3
	x.append(remove("repo:1", protocol.ModelLabel, 1, protocol.UnitIssuesOrPulls)) // 4
	x.append(label(3, "secret"), label(3, "redacted"))                             // 5, 6
	// A marker in between concerns repo:1 (labels).
	x.append(synclog.Entry{Group: protocol.GroupAll, Model: protocol.ModelLabel, Op: protocol.OpRebootstrap, Payload: `{"table":"label","epoch":2,"reason":"trigger_repaired"}`}) // 7
	x.deliver()

	cl := x.connect(nil)
	cl.hello(2, protocol.GroupRequest{Group: "repo:1", Since: since(0)})
	var got []protocol.Change
	var marker bool
	for {
		m := cl.next()
		if m.Type == protocol.MsgCaughtUp {
			break
		}
		switch m.Type {
		case protocol.MsgDelta:
			got = append(got, m.Changes...)
		case protocol.MsgBootstrapRequired:
			assert.Equal(t, protocol.ModelLabel, m.Model)
			assert.Len(t, got, 3, "the marker comes after the entries before it")
			marker = true
		default:
			t.Fatalf("unexpected %+v", m)
		}
	}
	assert.True(t, marker)
	assert.Equal(t, []int64{3, 4, 6}, versions(got))
	assert.Equal(t, protocol.OpDelete, got[1].Op)
	assert.Nil(t, got[1].D)
	assert.Equal(t, "redacted", got[2].D.(map[string]any)["name"])
	for _, raw := range drain(cl) {
		assert.NotContains(t, raw, "secret")
		assert.NotContains(t, raw, "first")
	}

	// Paging with chosen positions does not reveal older states either.
	cl2 := x.connect(nil)
	cl2.hello(2, protocol.GroupRequest{Group: "repo:1", Since: since(4)})
	chs, _ := cl2.changes(1)
	assert.EqualValues(t, 6, chs[0].V)
	assert.Equal(t, protocol.MsgBootstrapRequired, cl2.next().Type)
	cl2.expect(protocol.MsgCaughtUp)
}

// drain returns the raw messages received so far.
func drain(cl *client) []string {
	var res []string
	for {
		select {
		case raw := <-cl.tr.raw:
			res = append(res, raw)
		default:
			return res
		}
	}
}

// A unit change moves an entity (D in the old unit, U in the new one): a
// reader who may read only the old unit gets the delete, one who may read
// both gets the newest state.
func TestReplayUnitChange(t *testing.T) {
	x := newHarness(t, Config{})
	// Org3's public membership of user28, then concealed.
	x.append(upsert("org:3", protocol.ModelOrgUser, 9, protocol.UnitNone))
	x.append(remove("org:3", protocol.ModelOrgUser, 9, protocol.UnitNone), upsert("org:3", protocol.ModelOrgUser, 9, protocol.UnitMembers))
	x.deliver()

	outsider := x.connect(nil)
	outsider.hello(5, protocol.GroupRequest{Group: "org:3", Since: since(0)})
	chs, _ := outsider.changes(1)
	assert.Equal(t, protocol.OpDelete, chs[0].Op)
	assert.EqualValues(t, 2, chs[0].V)
	outsider.expect(protocol.MsgCaughtUp)

	member := x.connect(nil)
	member.hello(2, protocol.GroupRequest{Group: "org:3", Since: since(0)})
	chs, _ = member.changes(1)
	assert.Equal(t, protocol.OpUpsert, chs[0].Op)
	assert.EqualValues(t, 3, chs[0].V)
	member.expect(protocol.MsgCaughtUp)
}

// The hub's position is a position like any other: at 0 nothing is
// replayed (the log may hold entries the tailer has not delivered, behind
// a permission epoch the hub has not applied yet).
func TestReplayAtPositionZero(t *testing.T) {
	x := newHarness(t, Config{})
	ctx := t.Context()
	_, err := db.GetEngine(ctx).Exec("UPDATE repository SET is_private = ? WHERE id = 4", true)
	require.NoError(t, err)
	// The hub's cache still has user4 as collaborator (the epoch is not
	// delivered yet).
	_, err = x.h.cfg.Perms.Grants(ctx, 4)
	require.NoError(t, err)
	_, err = db.GetEngine(ctx).Exec("DELETE FROM collaboration WHERE repo_id = 4 AND user_id = 4")
	require.NoError(t, err)
	_, err = db.GetEngine(ctx).Exec("DELETE FROM access WHERE repo_id = 4 AND user_id = 4")
	require.NoError(t, err)
	payload, _ := json.Marshal(protocol.PermissionChange{Users: []int64{4}})
	// Written while user4 still collaborated (the hub's cache says so).
	x.append(upsert("repo:4", protocol.ModelLabel, 1, protocol.UnitIssuesOrPulls))
	x.append(synclog.Entry{Group: protocol.GroupPermission, Op: protocol.OpPermission, Payload: string(payload)})
	x.append(upsert("repo:4", protocol.ModelLabel, 2, protocol.UnitIssuesOrPulls))
	require.Zero(t, x.h.pos.Load())

	cl := x.connect(nil)
	cl.send(&protocol.HelloMessage{Type: protocol.MsgHello, Token: "u4", Groups: []protocol.GroupRequest{{Group: "repo:4", Since: since(0)}}})
	w := cl.expect(protocol.MsgWelcome)
	assert.Equal(t, []string{"repo:4"}, grantGroups(w.Granted), "granted from the cached grants")
	cl.expect(protocol.MsgCaughtUp)
	cl.quiet(30 * time.Millisecond)

	x.h.cfg.Perms.Invalidate(protocol.PermissionChange{Users: []int64{4}})
	x.deliver()
	var got []int64
	for {
		m := cl.next()
		if m.Type == protocol.MsgDelta {
			got = append(got, versions(m.Changes)...)
		}
		if m.Type == protocol.MsgGroupRevoked {
			break
		}
	}
	assert.Equal(t, []int64{1}, got, "live from 0: the entry before the epoch, nothing after it")
	cl.quiet(30 * time.Millisecond)
}

// Replays wait for room in the client's send buffer without holding a
// slot of the hub's semaphore: one user's sessions that read slowly do not
// stall other replays.
func TestReplaySlotsNotHeldWhileWaiting(t *testing.T) {
	x := newHarness(t, Config{SendBuffer: 2000, WriteTimeout: time.Minute})
	var many []synclog.Entry
	for i := range 200 {
		many = append(many, label(int64(i+1), "l"))
	}
	x.append(many...)
	x.append(upsert("repo:1", protocol.ModelMilestone, 1, protocol.UnitIssuesOrPulls))
	x.deliver()
	var gates []chan struct{}
	t.Cleanup(func() {
		for _, g := range gates {
			close(g)
		}
	})
	for range maxConcurrentChecks + 4 {
		tr := newFakeTransport()
		tr.gate = make(chan struct{})
		gates = append(gates, tr.gate)
		cl := x.connect(tr)
		cl.send(&protocol.HelloMessage{Type: protocol.MsgHello, Token: "u" + strconv.Itoa(2+len(gates)%2*3), Groups: []protocol.GroupRequest{{Group: "repo:1", Since: since(0)}}})
	}
	time.Sleep(100 * time.Millisecond) // the slow sessions' replays wait for room

	victim := x.connect(nil)
	victim.hello(8, protocol.GroupRequest{Group: "repo:1", Since: since(200)})
	start := time.Now()
	chs, _ := victim.changes(1)
	assert.Equal(t, protocol.ModelMilestone, chs[0].M)
	victim.expect(protocol.MsgCaughtUp)
	assert.Less(t, time.Since(start), 3*time.Second)
}

// A subscription resumed at (or ahead of) the hub's position goes live at
// once, without a replay.
func TestResumeAtPositionGoesLive(t *testing.T) {
	x := newHarness(t, Config{})
	x.append(label(1, "a"), label(2, "b"))
	x.deliver()
	cl := x.connect(nil)
	cl.hello(2, protocol.GroupRequest{Group: "repo:1", Since: since(2)}, protocol.GroupRequest{Group: "repo:2", Since: since(2)})
	x.h.mu.Lock()
	for _, s := range cl.c.subs {
		assert.Equal(t, stateLive, s.state, s.group)
		assert.Zero(t, s.gen, "no replay was started for %s", s.group)
		assert.EqualValues(t, 2, s.liveFrom)
	}
	x.h.mu.Unlock()
	cl.expect(protocol.MsgCaughtUp)
	x.append(label(3, "c"))
	x.deliver()
	chs, _ := cl.changes(1)
	assert.EqualValues(t, 3, chs[0].V)
}

// The queued replays of a session are checked with one read: groups that
// missed nothing go live without a replay of their own.
func TestSkipIdle(t *testing.T) {
	x := newHarness(t, Config{})
	x.append(label(1, "a"))
	x.append(upsert("repo:2", protocol.ModelLabel, 9, protocol.UnitIssuesOrPulls))
	x.append(label(2, "b"))
	x.deliver()
	// No worker: the test runs skipIdle itself.
	c := x.h.newConn(newFakeTransport(), fakeAuth)
	t.Cleanup(func() { close(c.workerDone) })
	data, err := json.Marshal(&protocol.HelloMessage{Type: protocol.MsgHello, Token: "u2", Groups: []protocol.GroupRequest{
		{Group: "repo:1", Since: since(1)}, {Group: "repo:2", Since: since(2)}, {Group: "user:2", Since: since(1)}, {Group: "repo:3", Since: since(0)},
	}})
	require.NoError(t, err)
	c.handle(data)
	x.h.mu.Lock()
	require.Len(t, c.work, 4)
	x.h.mu.Unlock()
	x.h.skipIdle(c)
	x.h.mu.Lock()
	defer x.h.mu.Unlock()
	live := map[string]bool{}
	for g, s := range c.subs {
		live[g] = s.state == stateLive
	}
	assert.Equal(t, map[string]bool{"repo:1": false, "repo:2": true, "user:2": true, "repo:3": true}, live)
	assert.Len(t, c.work, 1)
	assert.EqualValues(t, 3, c.subs["repo:2"].liveFrom)
}

// The entries of a subscription suspended by a permission epoch are held
// and sent after the check, without reading the log again.
func TestHeldEntries(t *testing.T) {
	x := newHarness(t, Config{})
	cl := x.connect(nil)
	cl.hello(2, protocol.GroupRequest{Group: "repo:1"})
	cl.expect(protocol.MsgCaughtUp)
	payload, _ := json.Marshal(protocol.PermissionChange{Users: []int64{2}})
	pos := x.h.pos.Load()
	// Delivered without being in the log: only the held copy has them.
	x.h.Deliver(t.Context(), []livesync_model.LogEntry{
		{SyncID: pos + 1, Grp: protocol.GroupPermission, Op: string(protocol.OpPermission), Payload: string(payload)},
		{SyncID: pos + 2, Grp: "repo:1", Model: string(protocol.ModelLabel), EntityID: 1, Op: string(protocol.OpUpsert), Unit: string(protocol.UnitIssuesOrPulls), Payload: `{"id":1}`},
		{SyncID: pos + 3, Grp: protocol.GroupAll, Model: string(protocol.ModelLabel), Op: string(protocol.OpRebootstrap), Payload: `{"reason":"placement_changed"}`},
		{SyncID: pos + 4, Grp: "repo:1", Model: string(protocol.ModelMilestone), EntityID: 1, Op: string(protocol.OpUpsert), Unit: string(protocol.UnitCode), Payload: `{"id":1}`},
	})
	chs, _ := cl.changes(1)
	assert.Equal(t, pos+2, chs[0].V)
	m := cl.expect(protocol.MsgBootstrapRequired)
	assert.Equal(t, protocol.RebootstrapPlacementChanged, m.Reason)
	chs, to := cl.changes(1)
	assert.Equal(t, pos+4, chs[0].V)
	assert.Equal(t, pos+4, to)
	x.h.mu.Lock()
	assert.Equal(t, stateLive, cl.c.subs["repo:1"].state)
	assert.Zero(t, cl.c.heldBytes)
	x.h.mu.Unlock()
}

// The frames that carry the entries held for a re-check claim the
// position they reach, and never one past what was sent: the hold goes and
// the held entries are queued in one critical section of the queue lock.
// With the hold removed after queueing them, a writer that took the queue
// in between claimed the stale hold (to = the epoch, until the session's
// next change); removed before, it would claim the hub's position before
// they were queued (a client resuming from there would miss them).
func TestHeldEntriesFrameTo(t *testing.T) {
	x := newHarness(t, Config{})
	cl := x.connectEager()
	cl.hello(2, protocol.GroupRequest{Group: "repo:1"})
	cl.expect(protocol.MsgCaughtUp)
	payload, _ := json.Marshal(protocol.PermissionChange{Users: []int64{2}})
	pos := x.h.pos.Load()
	x.h.Deliver(t.Context(), []livesync_model.LogEntry{
		{SyncID: pos + 1, Grp: protocol.GroupPermission, Op: string(protocol.OpPermission), Payload: string(payload)},
		{SyncID: pos + 2, Grp: "repo:1", Model: string(protocol.ModelLabel), EntityID: 1, Op: string(protocol.OpUpsert), Unit: string(protocol.UnitIssuesOrPulls), Payload: `{"id":1}`},
		{SyncID: pos + 3, Grp: protocol.GroupAll, Model: string(protocol.ModelLabel), Op: string(protocol.OpRebootstrap), Payload: `{"reason":"placement_changed"}`},
		{SyncID: pos + 4, Grp: "repo:1", Model: string(protocol.ModelMilestone), EntityID: 1, Op: string(protocol.OpUpsert), Unit: string(protocol.UnitCode), Payload: `{"id":1}`},
	})
	want := []int64{pos + 2, pos + 4}
	got := []int64{}
	var to int64
	for len(got) < len(want) {
		m := cl.next()
		if m.Type != protocol.MsgDelta {
			require.Equal(t, protocol.MsgBootstrapRequired, m.Type, "%+v", m)
			continue
		}
		got = append(got, versions(m.Changes)...)
		for _, v := range want {
			if v <= m.To {
				assert.Contains(t, got, v, "a frame claims %d before it was sent", m.To)
			}
		}
		to = m.To
	}
	assert.Equal(t, want, got)
	assert.Equal(t, pos+4, to)
	cl.quiet(20 * time.Millisecond)
}

// Held entries beyond the session's share: the subscription catches up
// from the log instead (and still gets everything).
func TestHeldEntriesOverflow(t *testing.T) {
	x := newHarness(t, Config{SendBuffer: 2000})
	cl := x.connect(nil)
	cl.hello(2, protocol.GroupRequest{Group: "repo:1"})
	cl.expect(protocol.MsgCaughtUp)
	payload, _ := json.Marshal(protocol.PermissionChange{Users: []int64{2}})
	entries := []synclog.Entry{{Group: protocol.GroupPermission, Op: protocol.OpPermission, Payload: string(payload)}}
	for i := range 40 {
		entries = append(entries, label(int64(i+1), "a-longer-name-for-a-label"))
	}
	x.append(entries...)
	x.deliver()
	var got []int64
	for len(got) < 40 {
		m := cl.next()
		if m.Type == protocol.MsgDelta {
			got = append(got, versions(m.Changes)...)
		}
	}
	assert.Equal(t, int64(2), got[0])
	assert.Equal(t, int64(41), got[39])
}
