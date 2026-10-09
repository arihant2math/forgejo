// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"context"
	"errors"
	"io"
	"net/http"

	"forgejo.org/modules/log"
	livesync_service "forgejo.org/services/livesync"
	"forgejo.org/services/livesync/hub"
	"forgejo.org/services/livesync/protocol"
)

// serveWebSocket serves GET /-/sync/ws: a sync session over a WebSocket
// (services/livesync/hub). It is called with the server's ResponseWriter.
func serveWebSocket(w http.ResponseWriter, req *http.Request) {
	h := livesync_service.Hub()
	if h == nil {
		writeJSON(w, http.StatusServiceUnavailable, errorResponse{Message: http.StatusText(http.StatusServiceUnavailable)})
		return
	}
	h.ServeWebSocket(w, req, authenticateToken)
}

// serveSSE serves GET /-/sync/sse: a sync session over Server-Sent Events
// (the fallback transport; client messages go to POST /-/sync/send).
func serveSSE(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		methodNotAllowed(w, req)
		return
	}
	h := livesync_service.Hub()
	if h == nil {
		writeJSON(w, http.StatusServiceUnavailable, errorResponse{Message: http.StatusText(http.StatusServiceUnavailable)})
		return
	}
	h.ServeSSE(w, req, authenticateToken)
}

// sendMessage serves POST /-/sync/send: one client message of the fallback
// session named by the X-Livesync-Session header. The answers are sent on
// the session's stream; 204 means the message was handled.
func sendMessage(w http.ResponseWriter, req *http.Request) {
	h := livesync_service.Hub()
	if h == nil {
		writeJSON(w, http.StatusServiceUnavailable, errorResponse{Message: http.StatusText(http.StatusServiceUnavailable)})
		return
	}
	body, err := io.ReadAll(io.LimitReader(req.Body, hub.MaxMessageSize+1))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse{Message: http.StatusText(http.StatusBadRequest)})
		return
	}
	switch err := h.Send(req.Header.Get(protocol.SessionHeader), body); {
	case errors.Is(err, hub.ErrUnknownSession):
		notFound(w, req)
	case errors.Is(err, hub.ErrMessageTooLarge):
		writeJSON(w, http.StatusRequestEntityTooLarge, errorResponse{Message: http.StatusText(http.StatusRequestEntityTooLarge)})
	case err != nil:
		log.Error("livesync: sync message: %v", err)
		writeJSON(w, http.StatusInternalServerError, errorResponse{Message: http.StatusText(http.StatusInternalServerError)})
	default:
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNoContent)
	}
}

// authenticateToken validates the token of a sync session's hello exactly
// like a bearer token of livesync's HTTP endpoints (authenticate): an
// OAuth2 or personal access token, API v1's account checks, livesync's
// scope requirements.
func authenticateToken(ctx context.Context, token string) (int64, string, error) {
	if token == "" {
		return 0, "a valid access token is required", nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, syncPrefix+"/ws", nil)
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	u, aerr := authenticate(req)
	switch {
	case aerr == nil:
		return u.ID, "", nil
	case aerr.status >= http.StatusInternalServerError:
		return 0, "", errors.New(aerr.message)
	}
	return 0, aerr.message, nil
}
