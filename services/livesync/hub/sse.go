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

// sseTransport is a session over a Server-Sent Events stream.
type sseTransport struct {
	mu   sync.Mutex
	w    http.ResponseWriter
	rc   *http.ResponseController
	once sync.Once
	done chan struct{} // closed by close
}

func (t *sseTransport) writeRaw(ctx context.Context, chunks ...[]byte) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	select {
	case <-t.done:
		return http.ErrHandlerTimeout
	default:
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
	return t.writeRaw(ctx, sseData, msg, sseEnd)
}

func (t *sseTransport) keepAlive(ctx context.Context) error {
	return t.writeRaw(ctx, sseKeepAlive)
}

func (t *sseTransport) close(int, string) {
	t.once.Do(func() { close(t.done) })
}

// ServeSSE runs a fallback session (GET /-/sync/sse) until the client goes
// away or the session ends. Like ServeWebSocket it wants the server's own
// ResponseWriter (write deadlines, no buffering).
func (h *Hub) ServeSSE(w http.ResponseWriter, req *http.Request, auth Authenticator) {
	t := &sseTransport{w: w, rc: http.NewResponseController(w), done: make(chan struct{})}
	c := h.newConn(t, auth)
	if !c.start() {
		http.Error(w, "server shutting down", http.StatusServiceUnavailable)
		return
	}
	defer c.stop()
	var raw [16]byte
	_, _ = rand.Read(raw[:])
	id := hex.EncodeToString(raw[:])
	h.mu.Lock()
	h.sessions[id] = c
	c.session = id
	h.mu.Unlock()

	hdr := w.Header()
	hdr.Set("Content-Type", "text/event-stream")
	hdr.Set("Cache-Control", "no-store")
	hdr.Set("X-Accel-Buffering", "no") // nginx: do not buffer the stream
	w.WriteHeader(http.StatusOK)
	c.send(&protocol.SessionMessage{Type: protocol.MsgSession, Session: id})

	stop := context.AfterFunc(req.Context(), c.cancel)
	defer stop()
	c.writeLoop()
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
