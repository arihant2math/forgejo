// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Package livesync mounts the livesync backend in front of Forgejo's web
// handler. cmd/web.go calls Wrap once (the only upstream patch, PLAN §4.2).
package livesync

import (
	"errors"
	"net/http"
	"strings"

	"forgejo.org/modules/graceful"
	"forgejo.org/modules/log"
	"forgejo.org/modules/setting"
	livesync_service "forgejo.org/services/livesync"
	"forgejo.org/services/livesync/capture"
)

// Path prefixes owned by livesync. Requests below them never reach the
// upstream handler once livesync is running.
const (
	syncPrefix = "/-/sync" // sync protocol, bootstrap/load, gap endpoints, admin
	nextPrefix = "/-/next" // the Forgejo Next SPA (assets, service worker, OAuth callback)
)

// Wrap runs livesync.Init and returns the handler the web server must serve.
//
// When livesync is disabled, the database is not supported (SQLite), the
// capture triggers are missing or stale (logged with the DDL that installs
// them) or Init fails otherwise, it logs why and returns inner itself,
// unchanged: Forgejo then behaves
// exactly as upstream. Otherwise it registers livesync's graceful-shutdown hook
// and returns a handler that serves /-/sync/* and /-/next/* itself, runs the
// API v1 writes that carry an Idempotency-Key through the idempotency layer
// (idempotency.go) and passes every other request to inner untouched.
func Wrap(inner http.Handler) http.Handler {
	if err := livesync_service.Init(graceful.GetManager().HammerContext()); err != nil {
		var notInstalled *capture.NotInstalledError
		switch {
		case errors.Is(err, livesync_service.ErrDisabled) || errors.Is(err, livesync_service.ErrUnsupportedDatabase):
			log.Info("livesync: not serving: %v; serving the classic UI only", err)
		case errors.As(err, &notInstalled):
			// An operational state rather than a crash: in INSTALL_MODE
			// verify a DBA has to run the DDL; in auto mode the database
			// user lacks the privileges. Either way the DDL is needed.
			// The triggers that are installed keep writing to the outbox,
			// which nothing drains until livesync runs again.
			log.Warn("livesync: not serving, serving the classic UI only: %v; the installed capture triggers keep filling livesync_change until livesync runs again", err)
			log.Info("livesync: DDL that installs the capture triggers (run it as a privileged database user, then restart Forgejo):\n%s", notInstalled.Status.Script())
		default:
			log.Error("livesync: failed to start, serving the classic UI only: %v", err)
		}
		return inner
	}
	// The instance context is only cancelled by Shutdown or by a later Init,
	// so this hook runs exactly once for this instance at graceful shutdown.
	graceful.GetManager().RunAtShutdown(livesync_service.Context(), livesync_service.Shutdown)
	return &handler{inner: inner, own: newRoutes()}
}

type handler struct {
	inner http.Handler // upstream Forgejo
	own   http.Handler // livesync's routes (routes.go)
}

func (h *handler) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	p, ok := ownPath(req.URL.Path)
	if !ok {
		if path, ok := keyed(req); ok {
			h.serveKeyed(w, req, path)
			return
		}
		h.inner.ServeHTTP(w, req)
		return
	}
	if p != req.URL.Path {
		req = withPath(req, p)
	}
	// The sync sessions need the server's own ResponseWriter (WebSocket
	// hijack, SSE write deadlines and unbuffered flushes), which the
	// router's middlewares wrap: they are served before it.
	switch p {
	case syncPrefix + "/ws":
		serveWebSocket(w, req)
		return
	case syncPrefix + "/sse":
		serveSSE(w, req)
		return
	}
	h.own.ServeHTTP(w, req)
}

// ownPath reports whether path belongs to livesync and returns it relative to
// the application root. Forgejo's routes are registered without
// setting.AppSubURL (a reverse proxy, or the FCGI server, strips it), but a
// request that still carries the sub-path is recognised too.
//
// path is classified the way upstream will route it: Forgejo collapses
// repeated slashes and trims trailing ones (stripSlashesMiddleware in
// routers/common) only inside its routers, i.e. after Wrap's dispatch, so
// ownPath normalises first. The returned path is the normalised one; inner
// still gets its requests untouched and normalises them itself.
func ownPath(path string) (string, bool) {
	path = normalizeSlashes(path)
	if sub := setting.AppSubURL; sub != "" && strings.HasPrefix(path, sub+"/") {
		path = path[len(sub):]
	}
	for _, prefix := range [...]string{syncPrefix, nextPrefix} {
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			return path, true
		}
	}
	return "", false
}

// normalizeSlashes collapses runs of '/' into one and drops trailing slashes,
// exactly like routers/common's stripSlashesMiddleware does for upstream's
// routes, so that every spelling upstream treats as /-/sync/… is livesync's.
func normalizeSlashes(path string) string {
	if !strings.Contains(path, "//") && !strings.HasSuffix(path, "/") {
		return path // fast path: already clean
	}
	var b strings.Builder
	b.Grow(len(path))
	prevWasSlash := false
	for _, c := range []byte(strings.TrimRight(path, "/")) {
		if c != '/' || !prevWasSlash {
			b.WriteByte(c)
		}
		prevWasSlash = c == '/'
	}
	return b.String()
}

// withPath returns a shallow copy of req whose URL path is p.
func withPath(req *http.Request, p string) *http.Request {
	r := new(http.Request)
	*r = *req
	u := *req.URL
	u.Path = p
	u.RawPath = ""
	r.URL = &u
	return r
}
