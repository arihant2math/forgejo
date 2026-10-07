// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"forgejo.org/models/db"
	issues_model "forgejo.org/models/issues"
	livesync_model "forgejo.org/models/livesync"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/json"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/services/livesync/synclog"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// livesyncMsg is any server message of the sync protocol, decoded.
type livesyncMsg struct {
	Type         protocol.MessageType   `json:"type"`
	Group        string                 `json:"group"`
	Reason       string                 `json:"reason"`
	Model        protocol.Model         `json:"model"`
	To           int64                  `json:"to"`
	Changes      []protocol.Change      `json:"changes"`
	SyncID       int64                  `json:"sync_id"`
	ID           string                 `json:"id"`
	Granted      []protocol.Grant       `json:"granted"`
	Refused      []protocol.Refusal     `json:"refused"`
	Grants       []protocol.Grant       `json:"grants"`
	Message      string                 `json:"message"`
	Code         string                 `json:"code"`
	Kind         string                 `json:"kind"`
	ServerSyncID int64                  `json:"server_sync_id"`
	ViewerID     int64                  `json:"viewer_id"`
	Profile      *protocol.Change       `json:"profile"`
	Session      string                 `json:"session"`
	Protocol     int                    `json:"protocol"`
	Schemas      map[protocol.Model]int `json:"schemas"`
}

// livesyncSyncClient is a raw sync protocol client over one transport.
type livesyncSyncClient struct {
	t      *testing.T
	msgs   chan livesyncMsg
	send   func(msg any)
	close  func()
	mu     sync.Mutex
	closed int // the WebSocket close status (-1: closed without one)
	// paused: when not nil, the reader stops before its next read until
	// it is closed (the client does not read: its socket fills up).
	paused chan struct{}
}

// pause makes the client stop reading; resume reads on.
func (cl *livesyncSyncClient) pause() {
	cl.mu.Lock()
	defer cl.mu.Unlock()
	cl.paused = make(chan struct{})
}

func (cl *livesyncSyncClient) resume() {
	cl.mu.Lock()
	defer cl.mu.Unlock()
	close(cl.paused)
	cl.paused = nil
}

func (cl *livesyncSyncClient) waitIfPaused() {
	cl.mu.Lock()
	p := cl.paused
	cl.mu.Unlock()
	if p != nil {
		<-p
	}
}

// livesyncSmallBuffers is an HTTP client whose connections have a small
// socket receive buffer, so that a client that stops reading blocks the
// server's writes soon.
func livesyncSmallBuffers() *http.Client {
	return &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
		conn, err := (&net.Dialer{}).DialContext(ctx, network, addr)
		if err == nil {
			_ = conn.(*net.TCPConn).SetReadBuffer(4096)
		}
		return conn, err
	}}}
}

// livesyncDial opens a sync session over transport "ws" or "sse".
func livesyncDial(t *testing.T, u *url.URL, transport string) *livesyncSyncClient {
	t.Helper()
	return livesyncDialWith(t, u, transport, http.DefaultClient)
}

func livesyncDialWith(t *testing.T, u *url.URL, transport string, httpClient *http.Client) *livesyncSyncClient {
	t.Helper()
	cl := &livesyncSyncClient{t: t, msgs: make(chan livesyncMsg, 10000)}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	deliver := func(data []byte) {
		var m livesyncMsg
		require.NoError(t, json.Unmarshal(data, &m), "%s", data)
		for _, ch := range m.Changes {
			assert.False(t, strings.HasPrefix(ch.G, "!") || ch.G == protocol.GroupAll, "pseudo-group entry sent to a client: %+v", ch)
		}
		cl.msgs <- m
	}
	switch transport {
	case "ws":
		ws, resp, err := websocket.Dial(ctx, "ws://"+u.Host+"/-/sync/ws", &websocket.DialOptions{CompressionMode: websocket.CompressionNoContextTakeover, HTTPClient: httpClient})
		require.NoError(t, err)
		assert.Contains(t, resp.Header.Get("Sec-WebSocket-Extensions"), "permessage-deflate")
		ws.SetReadLimit(64 << 20)
		go func() {
			defer close(cl.msgs)
			for {
				cl.waitIfPaused()
				_, data, err := ws.Read(ctx)
				if err != nil {
					cl.mu.Lock()
					cl.closed = int(websocket.CloseStatus(err))
					cl.mu.Unlock()
					return
				}
				deliver(data)
			}
		}()
		cl.send = func(msg any) {
			data, err := json.Marshal(msg)
			require.NoError(t, err)
			require.NoError(t, ws.Write(ctx, websocket.MessageText, data))
		}
		cl.close = func() { _ = ws.Close(websocket.StatusNormalClosure, "") }
	case "sse":
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+u.Host+"/-/sync/sse", nil)
		require.NoError(t, err)
		resp, err := httpClient.Do(req)
		require.NoError(t, err)
		require.Equal(t, http.StatusOK, resp.StatusCode)
		require.Equal(t, "text/event-stream", resp.Header.Get("Content-Type"))
		sessions := make(chan string, 1)
		go func() {
			defer close(cl.msgs)
			defer resp.Body.Close()
			sc := bufio.NewScanner(resp.Body)
			sc.Buffer(make([]byte, 64<<10), 64<<20)
			first := true
			for {
				if !first {
					cl.waitIfPaused()
				}
				if !sc.Scan() {
					break
				}
				line := sc.Bytes()
				data, ok := bytes.CutPrefix(line, []byte("data: "))
				if !ok {
					continue // blank line or keep-alive comment
				}
				if first {
					var m livesyncMsg
					require.NoError(t, json.Unmarshal(data, &m))
					require.Equal(t, protocol.MsgSession, m.Type)
					sessions <- m.Session
					first = false
					continue
				}
				deliver(data)
			}
			cl.mu.Lock()
			cl.closed = -1
			cl.mu.Unlock()
		}()
		var session string
		select {
		case session = <-sessions:
		case <-time.After(livesyncWait):
			t.Fatal("no session event")
		}
		cl.send = func(msg any) {
			data, err := json.Marshal(msg)
			require.NoError(t, err)
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+u.Host+"/-/sync/send", bytes.NewReader(data))
			require.NoError(t, err)
			req.Header.Set(protocol.SessionHeader, session)
			resp, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			resp.Body.Close()
			require.Equal(t, http.StatusNoContent, resp.StatusCode)
		}
		cl.close = cancel
	default:
		t.Fatalf("unknown transport %q", transport)
	}
	t.Cleanup(cl.close)
	return cl
}

// waitFor returns the first message matching, dropping the others.
func (cl *livesyncSyncClient) waitFor(what string, match func(m *livesyncMsg) bool) livesyncMsg {
	cl.t.Helper()
	deadline := time.After(livesyncWait)
	for {
		select {
		case m, ok := <-cl.msgs:
			if !ok {
				cl.t.Fatalf("the session was closed while waiting for %s", what)
			}
			if match(&m) {
				return m
			}
		case <-deadline:
			cl.t.Fatalf("no %s within the timeout", what)
		}
	}
}

func (cl *livesyncSyncClient) waitType(typ protocol.MessageType) livesyncMsg {
	cl.t.Helper()
	return cl.waitFor(string(typ), func(m *livesyncMsg) bool { return m.Type == typ })
}

// waitChange waits for a delta change matching and returns it.
func (cl *livesyncSyncClient) waitChange(what string, match func(ch *protocol.Change) bool) protocol.Change {
	cl.t.Helper()
	var found protocol.Change
	cl.waitFor(what, func(m *livesyncMsg) bool {
		for _, ch := range m.Changes {
			if match(&ch) {
				found = ch
				return true
			}
		}
		return false
	})
	return found
}

// waitClosed waits until the session is closed and returns its close status.
func (cl *livesyncSyncClient) waitClosed() int {
	cl.t.Helper()
	deadline := time.After(livesyncWait)
	for {
		select {
		case _, ok := <-cl.msgs:
			if !ok {
				cl.mu.Lock()
				defer cl.mu.Unlock()
				return cl.closed
			}
		case <-deadline:
			cl.t.Fatal("the session was not closed")
		}
	}
}

func livesyncHello(token string, groups ...protocol.GroupRequest) *protocol.HelloMessage {
	return &protocol.HelloMessage{Type: protocol.MsgHello, Token: token, ClientID: "test", Protocol: protocol.ProtocolVersion, Groups: groups}
}

func livesyncSince(v int64) *int64 { return new(v) }

func livesyncGrantGroups(grants []protocol.Grant) []string {
	res := []string{}
	for _, g := range grants {
		res = append(res, g.Group)
	}
	return res
}

// livesyncCreateLabel creates a label in user2/repo1 through API v1 and
// returns its id.
func livesyncCreateLabel(t *testing.T, token, name string) int64 {
	t.Helper()
	var label struct {
		ID int64 `json:"id"`
	}
	DecodeJSON(t, MakeRequest(t, NewRequestWithJSON(t, "POST", "/api/v1/repos/user2/repo1/labels", map[string]string{"name": name, "color": "#00aabb"}).AddTokenAuth(token), http.StatusCreated), &label)
	return label.ID
}

// TestLivesyncHub is B5's acceptance scenario, over the WebSocket and over
// the SSE + POST fallback, with a real listener: hello → welcome, replay
// from a cursor then a live delta after an API write, an unauthorized
// subscription refused, collaborator removal ⇒ group_revoked, a cursor
// older than the retention ⇒ bootstrap_required, an invalid token ⇒
// session_invalid, a re-bootstrap marker ⇒ bootstrap_required for the
// groups that can hold the model.
func TestLivesyncHub(t *testing.T) {
	livesyncSkipSQLite(t)
	livesyncServe(t)
	onApplicationRun(t, func(t *testing.T, u *url.URL) {
		livesyncWaitBackfill(t)
		assert.Eventually(t, func() bool { return len(livesyncOutbox(t)) == 0 }, livesyncWait, 20*time.Millisecond)
		for _, transport := range []string{"ws", "sse"} {
			t.Run(transport, func(t *testing.T) { livesyncHubScenario(t, u, transport) })
		}
	})
}

func livesyncHubScenario(t *testing.T, u *url.URL, transport string) {
	ctx := t.Context()
	user2 := livesyncToken(t, &user_model.User{ID: 2})
	user5 := livesyncToken(t, &user_model.User{ID: 5})

	// An invalid token: session_invalid, then the session is closed.
	bad := livesyncDial(t, u, transport)
	bad.send(livesyncHello("not-a-token"))
	assert.NotEmpty(t, bad.waitType(protocol.MsgSessionInvalid).Message)
	status := bad.waitClosed()
	if transport == "ws" {
		assert.Equal(t, int(websocket.StatusPolicyViolation), status)
	}

	// A label written before the session: replayed from the cursor.
	cursor := livesyncLogHead(t)
	before := livesyncCreateLabel(t, user2, "hub-before-"+transport)
	livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelLabel, before, protocol.OpUpsert))

	cl := livesyncDial(t, u, transport)
	cl.send(livesyncHello(user2,
		protocol.GroupRequest{Group: "repo:1", Since: livesyncSince(cursor)},
		protocol.GroupRequest{Group: "user:2"},
		protocol.GroupRequest{Group: "repo:999999"}))
	w := cl.waitType(protocol.MsgWelcome)
	assert.EqualValues(t, 2, w.ViewerID)
	assert.Equal(t, []string{"repo:1", "user:2"}, livesyncGrantGroups(w.Granted))
	assert.Equal(t, []protocol.Refusal{{Group: "repo:999999", Reason: protocol.RefusedForbidden}}, w.Refused)
	assert.Contains(t, livesyncGrantGroups(w.Grants), "repo:2")
	assert.Equal(t, protocol.ProtocolVersion, w.Protocol)
	assert.Equal(t, protocol.SchemaLabel, w.Schemas[protocol.ModelLabel])
	require.NotNil(t, w.Profile)
	assert.EqualValues(t, 2, w.Profile.ID)
	assert.Equal(t, protocol.ModelUser, w.Profile.M)
	replayed := cl.waitChange("the replayed label", func(ch *protocol.Change) bool {
		return ch.M == protocol.ModelLabel && ch.ID == before
	})
	assert.Equal(t, "repo:1", replayed.G)
	assert.Greater(t, replayed.V, cursor)
	cl.waitType(protocol.MsgCaughtUp)

	// Live: a delta shortly after an API write.
	start := time.Now()
	live := livesyncCreateLabel(t, user2, "hub-live-"+transport)
	ch := cl.waitChange("the live label", func(ch *protocol.Change) bool { return ch.M == protocol.ModelLabel && ch.ID == live })
	latency := time.Since(start)
	t.Logf("%s: API write → delta: %s", transport, latency)
	assert.Less(t, latency, 150*time.Millisecond, "live delta latency")
	assert.Equal(t, protocol.OpUpsert, ch.Op)
	assert.Equal(t, "hub-live-"+transport, ch.D.(map[string]any)["name"])

	// barrier → barrier_ok at or after the head.
	head := livesyncLogHead(t)
	cl.send(&protocol.BarrierMessage{Type: protocol.MsgBarrier, ID: "b1"})
	ok := cl.waitType(protocol.MsgBarrierOK)
	assert.Equal(t, "b1", ok.ID)
	assert.GreaterOrEqual(t, ok.SyncID, head)

	// An unauthorized group is refused (user5 may not read private repo2).
	other := livesyncDial(t, u, transport)
	other.send(livesyncHello(user5))
	other.waitType(protocol.MsgWelcome)
	other.send(&protocol.SubscribeMessage{Type: protocol.MsgSubscribe, Groups: []protocol.GroupRequest{{Group: "repo:2"}, {Group: "user:2"}, {Group: protocol.GroupPermission}}})
	sub := other.waitType(protocol.MsgSubscribed)
	assert.Empty(t, sub.Granted)
	assert.Equal(t, []protocol.Refusal{
		{Group: "repo:2", Reason: protocol.RefusedForbidden},
		{Group: "user:2", Reason: protocol.RefusedForbidden},
		{Group: protocol.GroupPermission, Reason: protocol.RefusedForbidden},
	}, sub.Refused)

	// Made a collaborator: the new implicit grant is announced; the group
	// can be subscribed. Removed again: group_revoked.
	MakeRequest(t, NewRequestWithJSON(t, "PUT", "/api/v1/repos/user2/repo2/collaborators/user5", map[string]string{"permission": "read"}).AddTokenAuth(user2), http.StatusNoContent)
	other.waitFor("grants with repo:2", func(m *livesyncMsg) bool {
		return m.Type == protocol.MsgGrants && slices.Contains(livesyncGrantGroups(m.Grants), "repo:2")
	})
	other.send(&protocol.SubscribeMessage{Type: protocol.MsgSubscribe, Groups: []protocol.GroupRequest{{Group: "repo:2"}}})
	sub = other.waitType(protocol.MsgSubscribed)
	require.Equal(t, []string{"repo:2"}, livesyncGrantGroups(sub.Granted))
	other.waitType(protocol.MsgCaughtUp)
	MakeRequest(t, NewRequest(t, "DELETE", "/api/v1/repos/user2/repo2/collaborators/user5").AddTokenAuth(user2), http.StatusNoContent)
	revoked := other.waitType(protocol.MsgGroupRevoked)
	assert.Equal(t, "repo:2", revoked.Group)
	// Nothing of repo2 reaches user5 any more.
	cursor = livesyncLogHead(t)
	MakeRequest(t, NewRequestWithJSON(t, "PATCH", "/api/v1/repos/user2/repo2", map[string]any{"description": "after revocation " + transport}).AddTokenAuth(user2), http.StatusOK)
	livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelRepository, 2, protocol.OpUpsert))
	other.send(&protocol.BarrierMessage{Type: protocol.MsgBarrier, ID: "after"})
	other.waitFor("barrier_ok", func(m *livesyncMsg) bool {
		for _, ch := range m.Changes {
			assert.NotEqual(t, "repo:2", ch.G, "a change of a revoked group")
		}
		return m.Type == protocol.MsgBarrierOK
	})

	// A cursor older than the retention: bootstrap_required, then live.
	floor := livesyncLogHead(t)
	require.NoError(t, livesync_model.SetMeta(ctx, synclog.MetaFloor, strconv.FormatInt(floor, 10)))
	other.send(&protocol.SubscribeMessage{Type: protocol.MsgSubscribe, Groups: []protocol.GroupRequest{{Group: "repo:1", Since: livesyncSince(floor - 1)}}})
	other.waitType(protocol.MsgSubscribed)
	br := other.waitType(protocol.MsgBootstrapRequired)
	assert.Equal(t, "repo:1", br.Group)
	assert.Equal(t, protocol.BootstrapCursorTrimmed, br.Reason)
	other.waitType(protocol.MsgCaughtUp)

	// A re-bootstrap marker (a schema epoch bump, handled by the writer
	// within its epoch check interval): bootstrap_required for repo:1,
	// which can hold labels, not for user:2.
	epochs := livesyncEpochs(t)
	require.NoError(t, livesync_model.SetMeta(ctx, capture.MetaEpochPrefix+"label", strconv.FormatInt(epochs["label"]+1, 10)))
	m := cl.waitFor("bootstrap_required", func(m *livesyncMsg) bool {
		assert.False(t, m.Type == protocol.MsgBootstrapRequired && m.Group == "user:2", "user:2 cannot hold labels")
		return m.Type == protocol.MsgBootstrapRequired
	})
	assert.Equal(t, "repo:1", m.Group)
	assert.Equal(t, protocol.RebootstrapTriggerRepaired, m.Reason)
	assert.Equal(t, protocol.ModelLabel, m.Model)

	// ping → pong with the position.
	cl.send(&protocol.PingMessage{Type: protocol.MsgPing, ID: "p"})
	pong := cl.waitType(protocol.MsgPong)
	assert.Equal(t, "p", pong.ID)
	assert.Positive(t, pong.SyncID)
}

// A client that does not keep up with its live changes is disconnected
// with resume_from_cursor: it stops reading, 400 comments of 4 KB arrive in
// a few materializer batches, each far beyond the send buffer (64 KiB)
// while the frame before it is being written. When the client reads again
// it gets what was written before the overflow, then resume_from_cursor at
// a position it was sent (its resume point), then the session is closed
// (WS 1013); the rest was dropped. (A writer blocked by a full socket is
// TestSlowConsumer's case: here the kernel would first buffer up to
// net.ipv4.tcp_wmem's maximum, 4 MiB by default, per connection.)
func TestLivesyncHubSlowConsumer(t *testing.T) {
	livesyncSkipSQLite(t)
	livesyncServeWith(t, map[string]string{"SEND_BUFFER": "65536"})
	onApplicationRun(t, func(t *testing.T, u *url.URL) {
		livesyncWaitBackfill(t)
		livesyncSettle(t)
		const comments = 400
		for _, transport := range []string{"ws", "sse"} {
			t.Run(transport, func(t *testing.T) {
				cl := livesyncDialWith(t, u, transport, livesyncSmallBuffers())
				cl.send(livesyncHello(livesyncToken(t, &user_model.User{ID: 2}), protocol.GroupRequest{Group: "issue:1"}))
				cl.waitType(protocol.MsgWelcome)
				caughtUp := cl.waitType(protocol.MsgCaughtUp)
				cl.pause()
				random := make([]byte, 2<<10)
				for i := range comments {
					_, _ = rand.Read(random)
					content := fmt.Sprintf("slow %s %d %x", transport, i, random) // hardly compressible
					require.NoError(t, db.Insert(t.Context(), &issues_model.Comment{Type: issues_model.CommentTypeComment, IssueID: 1, PosterID: 2, Content: content}))
				}
				livesyncSettle(t)
				last := livesyncLogHead(t)
				time.Sleep(200 * time.Millisecond) // delivered by the hub
				cl.resume()

				positions := map[int64]bool{caughtUp.SyncID: true}
				received := 0
				var resume livesyncMsg
				for resume.Type == "" {
					m := cl.waitFor("resume_from_cursor", func(*livesyncMsg) bool { return true })
					switch m.Type {
					case protocol.MsgDelta:
						positions[m.To] = true
						for _, ch := range m.Changes {
							if ch.M == protocol.ModelComment {
								received++
							}
						}
					case protocol.MsgResumeFromCursor:
						resume = m
					default:
						t.Fatalf("unexpected %+v", m)
					}
				}
				t.Logf("%s: %d of %d comments received before resume_from_cursor %d", transport, received, comments, resume.SyncID)
				assert.Positive(t, received, "frames were written until the socket was full")
				assert.Less(t, received, comments, "the unsent changes were dropped")
				assert.True(t, positions[resume.SyncID], "resume_from_cursor names a position the client was sent")
				assert.Less(t, resume.SyncID, last)
				status := cl.waitClosed()
				if transport == "ws" {
					assert.Equal(t, int(websocket.StatusTryAgainLater), status)
				}
			})
		}
	})
}
