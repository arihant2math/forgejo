// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Package livesync mounts the livesync backend in front of Forgejo's web
// handler. cmd/web.go calls Wrap once (the only upstream patch, PLAN §4.2).
package livesync

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"

	"forgejo.org/modules/graceful"
	"forgejo.org/modules/log"
	"forgejo.org/modules/setting"
	livesync_service "forgejo.org/services/livesync"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/services/livesync/idempotency"
	"forgejo.org/services/livesync/protocol"
)

// Path prefixes owned by livesync. Requests below them never reach the
// upstream handler once livesync is running.
const (
	syncPrefix = "/-/sync" // sync protocol, bootstrap/load, gap endpoints, admin
	nextPrefix = "/-/next" // the Forgejo Next SPA (assets, service worker, OAuth callback)
)

// Wrap runs livesync.Init and returns the handler the web server must serve.
//
// When livesync is disabled it runs the kill switch (livesync.Disable: the
// capture triggers of an earlier run are removed) and returns inner
// itself (ENABLED = false wins over any malformed [livesync] key); so it
// does on SQLite and with invalid [livesync] settings: Forgejo then
// behaves exactly as upstream. When livesync is enabled but
// Init fails (the capture triggers are missing or stale — logged with the
// DDL that installs them — or anything else), Forgejo serves the classic
// UI through a thin handler that only adds the admin page and the health
// check (degraded, admin.go). Otherwise it registers livesync's
// graceful-shutdown hook and returns a handler that serves /-/sync/* and
// /-/next/* itself, the Next UI's document to opted-in browsers on the
// routes it supports (spa.go), runs the API v1 writes that carry an
// Idempotency-Key through the idempotency layer (idempotency.go) and
// passes every other request to inner untouched.
func Wrap(inner http.Handler) http.Handler {
	ctx := graceful.GetManager().HammerContext()
	if err := livesync_service.Init(ctx); err != nil {
		var notInstalled *capture.NotInstalledError
		switch {
		case errors.Is(err, livesync_service.ErrDisabled):
			log.Info("livesync: not serving: %v; serving the classic UI only", err)
			if err := livesync_service.Disable(ctx); err != nil {
				log.Warn("livesync: disabled, but its capture triggers could not be removed: %v", err)
			}
			return inner
		case errors.Is(err, livesync_service.ErrUnsupportedDatabase):
			log.Info("livesync: not serving: %v; serving the classic UI only", err)
			return inner
		case livesync_service.State() != livesync_service.StateDegraded:
			// Invalid settings: nothing to show on an admin page.
			log.Error("livesync: failed to start, serving the classic UI only: %v", err)
			return inner
		case errors.As(err, &notInstalled):
			// An operational state rather than a crash: in INSTALL_MODE
			// verify a DBA has to run the DDL; in auto mode the database
			// user lacks the privileges. Either way the DDL is needed.
			// The triggers that are installed keep writing to the outbox,
			// which nothing drains until livesync runs again.
			log.Warn("livesync: not serving, serving the classic UI only: %v; the installed capture triggers keep filling livesync_change until livesync runs again (see %s)", err, adminPath)
			log.Info("livesync: DDL that installs the capture triggers (run it as a privileged database user, then restart Forgejo):\n%s", notInstalled.Status.Script())
		default:
			log.Error("livesync: failed to start, serving the classic UI only: %v (see %s)", err, adminPath)
		}
		return newDegraded(inner)
	}
	// The instance context is only cancelled by Shutdown or by a later Init,
	// so this hook runs exactly once for this instance at graceful shutdown.
	graceful.GetManager().RunAtShutdown(livesync_service.Context(), livesync_service.Shutdown)
	return newHandler(inner)
}

type handler struct {
	inner   http.Handler // upstream Forgejo
	own     http.Handler // livesync's routes (routes.go)
	spa     *spa         // the Next UI's build (spa.go)
	answers http.Handler // the idempotency layer's own responses (idempotency.go)
	// idempotency returns the running instance's idempotency store (nil
	// when stopped); a variable for tests.
	idempotency func() *idempotency.Service
}

func newHandler(inner http.Handler) *handler {
	s := newSPA(livesync_service.Setting.AssetsDir)
	return &handler{inner: inner, own: newRoutes(inner, s), spa: s, answers: newAnswers(), idempotency: livesync_service.Idempotency}
}

func (h *handler) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	p, ok := ownPath(req.URL.Path)
	if !ok {
		if path, ok := keyed(req); ok {
			h.serveKeyed(w, req, path, h.inner)
			return
		}
		if h.spa.document(req) {
			// Through the answers router: Forgejo's protocol middlewares
			// (access log, panic recovery) as for livesync's own routes.
			h.answer(w, req, func(w http.ResponseWriter, req *http.Request) { h.spa.serveIndex(w, req, true) })
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
	if strings.HasPrefix(p, protocol.APIPrefix+"/") && apiWrite(req.Method, p) {
		// Gap endpoint writes: through the idempotency layer with a key,
		// else with the sync id echo (idempotency.go).
		if _, ok := req.Header[protocol.HeaderIdempotencyKey]; ok {
			h.serveKeyed(w, req, p, h.own)
		} else {
			h.serveSynced(w, req)
		}
		return
	}
	req, abort := abortable(req)
	h.own.ServeHTTP(w, req)
	if abort.Load() && setting.Protocol != setting.FCGI && setting.Protocol != setting.FCGIUnix {
		// Out here, past Forgejo's panic recovery (ProtocolMiddlewares
		// recovers every panic and would append an error page to the
		// started response), net/http aborts the response: the
		// connection is closed without the final chunk (HTTP/1.1) or the
		// stream reset (HTTP/2). net/http/fcgi neither recovers panics
		// nor can abort a response: there the cut response is logged
		// only.
		panic(http.ErrAbortHandler)
	}
}

// abortKey is the context key of a request's abort flag (abortable).
type abortKey struct{}

// abortable returns req with a flag that abortResponse sets.
func abortable(req *http.Request) (*http.Request, *atomic.Bool) {
	flag := new(atomic.Bool)
	return req.WithContext(context.WithValue(req.Context(), abortKey{}, flag)), flag
}

// abortResponse asks handler.ServeHTTP to abort a response that already
// started (its status and headers were sent) when the handler returns:
// the body is incomplete and the client must not take it for complete.
func abortResponse(req *http.Request) {
	if flag, ok := req.Context().Value(abortKey{}).(*atomic.Bool); ok {
		flag.Store(true)
	}
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
