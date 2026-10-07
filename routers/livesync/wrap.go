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
)

// Path prefixes owned by livesync. Requests below them never reach the
// upstream handler once livesync is running.
const (
	syncPrefix = "/-/sync" // sync protocol, bootstrap/load, gap endpoints, admin
	nextPrefix = "/-/next" // the Forgejo Next SPA (assets, service worker, OAuth callback)
)

// Wrap runs livesync.Init and returns the handler the web server must serve.
//
// When livesync is disabled, the database is not supported (SQLite) or Init
// fails, it logs why and returns inner itself, unchanged: Forgejo then behaves
// exactly as upstream. Otherwise it registers livesync's graceful-shutdown hook
// and returns a handler that serves /-/sync/* and /-/next/* itself and passes
// every other request to inner untouched.
func Wrap(inner http.Handler) http.Handler {
	if err := livesync_service.Init(graceful.GetManager().HammerContext()); err != nil {
		if errors.Is(err, livesync_service.ErrDisabled) || errors.Is(err, livesync_service.ErrUnsupportedDatabase) {
			log.Info("livesync: not serving: %v; serving the classic UI only", err)
		} else {
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
		h.inner.ServeHTTP(w, req)
		return
	}
	if p != req.URL.Path {
		req = withPath(req, p)
	}
	h.own.ServeHTTP(w, req)
}

// ownPath reports whether path belongs to livesync and returns it relative to
// the application root. Forgejo's routes are registered without
// setting.AppSubURL (a reverse proxy, or the FCGI server, strips it), but a
// request that still carries the sub-path is recognised too.
func ownPath(path string) (string, bool) {
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
