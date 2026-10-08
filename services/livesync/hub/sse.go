// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package hub

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"sync"
	"time"

	"forgejo.org/services/livesync/metrics"
	"forgejo.org/services/livesync/protocol"
)

// The fallback transport (PLAN §4.6) for networks that break WebSockets:
// the server's messages are Server-Sent Events of GET /-/sync/sse (one
// "data:" line of JSON per message; the first is a SessionMessage), the
// client's messages are POSTed to /-/sync/send with the session id in the
// X-Livesync-Session header. The session id is a random 128-bit secret
// that only the client holding the stream knows; the hello authenticates
// the session exactly as over a WebSocket. No cookies are involved, and a
// cross-site page cannot set the header without a CORS preflight.

var (
	// ErrUnknownSession: no fallback session has this id (any more).
	ErrUnknownSession = errors.New("livesync: unknown sync session")
	// ErrMessageTooLarge: a client message exceeds the size limit.
	ErrMessageTooLarge = errors.New("livesync: sync message too large")
)

// MaxMessageSize is the size limit of a client message.
const MaxMessageSize = maxMessageSize

// sseTransport is a session over a Server-Sent Events stream. The
// ResponseWriter is only used under mu, between ServeSSE's headers (ready)
// and close: the session's worker sends keep-alives from its own
// goroutine, which must never touch the writer before the headers or after
// the handler returned (net/http then recycles it).
type sseTransport struct {
	mu     sync.Mutex
	w      http.ResponseWriter
	rc     *http.ResponseController
	ready  bool // the headers were written
	closed bool
}

func (t *sseTransport) writeRaw(ctx context.Context, keepAlive bool, chunks ...[]byte) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	switch {
	case t.closed:
		return http.ErrHandlerTimeout
	case !t.ready:
		if keepAlive {
			return nil // nothing to keep alive yet
		}
		return http.ErrHandlerTimeout
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = t.rc.SetWriteDeadline(deadline) // not supported by every writer
		defer func() { _ = t.rc.SetWriteDeadline(time.Time{}) }()
	}
	for _, b := range chunks {
		if _, err := t.w.Write(b); err != nil {
			return err
		}
	}
	return t.rc.Flush()
}

var (
	sseData      = []byte("data: ")
	sseEnd       = []byte("\n\n")
	sseKeepAlive = []byte(": keep-alive\n\n")
)

func (t *sseTransport) write(ctx context.Context, msg []byte) error {
	return t.writeRaw(ctx, false, sseData, msg, sseEnd)
}

func (t *sseTransport) keepAlive(ctx context.Context) error {
	return t.writeRaw(ctx, true, sseKeepAlive)
}

// close waits for a write in progress; later writes fail. The session's
// writer calls it before ServeSSE returns.
func (t *sseTransport) close(int, string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.closed = true
}

// start writes the stream's headers.
func (t *sseTransport) start() {
	t.mu.Lock()
	defer t.mu.Unlock()
	hdr := t.w.Header()
	hdr.Set("Content-Type", "text/event-stream")
	hdr.Set("Cache-Control", "no-store")
	hdr.Set("X-Accel-Buffering", "no") // nginx: do not buffer the stream
	t.w.WriteHeader(http.StatusOK)
	t.ready = true
}

// ServeSSE runs a fallback session (GET /-/sync/sse) until the client goes
// away or the session ends. Like ServeWebSocket it wants the server's own
// ResponseWriter (write deadlines, no buffering).
func (h *Hub) ServeSSE(w http.ResponseWriter, req *http.Request, auth Authenticator) {
	t := &sseTransport{w: w, rc: http.NewResponseController(w)}
	c := h.newConn(t, auth)
	if !c.start() {
		http.Error(w, "server shutting down", http.StatusServiceUnavailable)
		return
	}
	metrics.SessionsOpened.WithLabelValues(TransportSSE).Inc()
	defer c.stop()
	var raw [16]byte
	_, _ = rand.Read(raw[:])
	id := hex.EncodeToString(raw[:])
	h.mu.Lock()
	h.sessions[id] = c
	c.session = id
	h.mu.Unlock()

	t.start()
	c.send(&protocol.SessionMessage{Type: protocol.MsgSession, Session: id})

	stop := context.AfterFunc(req.Context(), c.cancel)
	defer stop()
	c.writeLoop() // closes t: nothing writes to w after it returned
}

// Send handles a client message of fallback session id (POST
// /-/sync/send). Answers go to the session's stream.
func (h *Hub) Send(id string, msg []byte) error {
	if len(msg) > maxMessageSize {
		return ErrMessageTooLarge
	}
	h.mu.Lock()
	c := h.sessions[id]
	h.mu.Unlock()
	if c == nil || c.ctx.Err() != nil {
		return ErrUnknownSession
	}
	c.handle(msg)
	return nil
}
