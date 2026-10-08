// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package hub

import (
	"context"
	"net/http"
	"net/url"

	"forgejo.org/modules/log"
	"forgejo.org/modules/setting"
	"forgejo.org/services/livesync/metrics"
	"forgejo.org/services/livesync/protocol"

	"github.com/coder/websocket"
)

// wsTransport is a session over a WebSocket.
type wsTransport struct {
	ws *websocket.Conn
}

func (t wsTransport) write(ctx context.Context, msg []byte) error {
	return t.ws.Write(ctx, websocket.MessageText, msg)
}

func (t wsTransport) keepAlive(ctx context.Context) error {
	return t.ws.Ping(ctx)
}

func (t wsTransport) close(code int, reason string) {
	_ = t.ws.Close(websocket.StatusCode(code), reason)
}

// ServeWebSocket runs a session over a WebSocket (GET /-/sync/ws). The
// ResponseWriter must be the server's own (it is hijacked), so routers must
// call it before any middleware that wraps the writer. Messages are
// compressed with permessage-deflate when the client offers it.
func (h *Hub) ServeWebSocket(w http.ResponseWriter, req *http.Request, auth Authenticator) {
	opts := &websocket.AcceptOptions{
		// No context takeover: a pooled compressor per message instead of
		// a 32 KiB window (and a flate writer) kept per connection.
		CompressionMode: websocket.CompressionNoContextTakeover,
	}
	// The request host is always accepted; also accept the configured
	// public origin (a reverse proxy may rewrite the Host header). The
	// token in the hello authenticates, never a cookie.
	if u, err := url.Parse(setting.AppURL); err == nil && u.Host != "" {
		opts.OriginPatterns = []string{u.Host}
	}
	ws, err := websocket.Accept(w, req, opts)
	if err != nil {
		log.Debug("livesync: WebSocket upgrade: %v", err) // Accept answered the request
		return
	}
	ws.SetReadLimit(maxMessageSize)
	c := h.newConn(wsTransport{ws}, auth)
	if !c.start() {
		_ = ws.Close(websocket.StatusGoingAway, "server shutting down")
		return
	}
	metrics.SessionsOpened.WithLabelValues(TransportWebSocket).Inc()
	defer c.stop()
	writer := make(chan struct{})
	go func() {
		defer close(writer)
		c.writeLoop()
	}()
	for {
		typ, data, err := ws.Read(c.ctx)
		if err != nil {
			break
		}
		if typ != websocket.MessageText {
			c.sendError(protocol.ErrorBadMessage, "messages are JSON text")
			continue
		}
		c.handle(data)
	}
	c.cancel()
	<-writer
}
