// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"net/http"

	"forgejo.org/modules/json"
	"forgejo.org/modules/web"
	"forgejo.org/modules/web/routing"
	"forgejo.org/routers/common"
	livesync_service "forgejo.org/services/livesync"

	chi "github.com/go-chi/chi/v5"
)

// newRoutes builds the router for everything below /-/sync and /-/next.
//
// This is the single registration point for livesync's HTTP endpoints; later
// milestones add theirs here. Routes are registered with their full path
// (including the /-/sync or /-/next prefix), relative to the application root.
//
// The sync session endpoints GET /-/sync/ws and GET /-/sync/sse are NOT
// registered here: the middlewares below wrap the ResponseWriter (hiding
// Hijack and write deadlines), so they are dispatched in handler.ServeHTTP
// before this router (sync.go).
//
// inner is upstream's handler (the admin page asks it about the session), s
// the Next UI's build.
func newRoutes(inner http.Handler, s *spa) http.Handler {
	r := newRouter()

	r.Get(syncPrefix+"/health", health)
	r.Get(syncPrefix+"/grants", grants)
	r.Post(syncPrefix+"/send", sendMessage)
	r.Get(syncPrefix+"/bootstrap", serveBootstrap)
	r.Get(syncPrefix+"/load", serveLoad)
	r.Get(syncPrefix+"/workspace", serveWorkspace)
	r.Get(adminPath, serveAdmin(inner, s))
	r.Post(syncPrefix+"/rum", serveRUM)

	// The Next UI (spa.go).
	r.Methods("GET,HEAD", nextPrefix+"/assets/*", s.serveAsset)
	r.Methods("GET,HEAD", nextPrefix+"/sw.js", s.serveServiceWorker)
	r.Methods("GET,HEAD", nextPrefix+"/classic.js", s.serveClassicScript)
	r.Methods("GET,POST", nextPrefix+"/opt-in", serveOptIn)
	r.Methods("GET,POST", nextPrefix+"/opt-out", serveOptOut)
	r.Get(nextPrefix+"/config", serveConfig)
	r.Methods("GET,HEAD", nextPrefix, s.serveRoot)
	r.Methods("GET,HEAD", nextPrefix+"/*", s.serveRoot)

	return r
}

// newRouter returns an empty router with Forgejo's protocol middlewares
// (panic recovery, process manager, access and router logs) and JSON 404 /
// 405 answers.
func newRouter() *web.Route {
	// A web.Route literal instead of web.NewRoute(): in tests NewRoute resets
	// the API v1 permission bookkeeping collected by routers.NormalRoutes().
	r := &web.Route{R: chi.NewRouter()}
	r.Use(common.ProtocolMiddlewares()...)

	r.NotFound(notFound)
	// chi calls the 405 handler directly, bypassing web.Route's bookkeeping,
	// so record the handler name for the router log here.
	methodNotAllowedInfo := routing.GetFuncInfo(methodNotAllowed)
	r.R.MethodNotAllowed(func(w http.ResponseWriter, req *http.Request) {
		routing.UpdateFuncInfo(req.Context(), methodNotAllowedInfo)
		methodNotAllowed(w, req)
	})
	return r
}

type errorResponse struct {
	Message string `json:"message"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// notFound answers unknown paths below /-/sync and /-/next. It is a named
// handler (rather than chi's default) so that the router log attributes the
// response instead of reporting an "unknown handler" error.
func notFound(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusNotFound, errorResponse{Message: http.StatusText(http.StatusNotFound)})
}

// methodNotAllowed answers a known path requested with the wrong method.
func methodNotAllowed(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusMethodNotAllowed, errorResponse{Message: http.StatusText(http.StatusMethodNotAllowed)})
}

type healthResponse struct {
	Status string `json:"status"`
}

// health answers GET /-/sync/health: 200 {"status":"ok"} while livesync is
// running, 503 {"status":"stopped"} once it has been shut down. It is public
// and reveals nothing beyond the fact that livesync is enabled.
func health(w http.ResponseWriter, _ *http.Request) {
	if !livesync_service.Running() {
		writeJSON(w, http.StatusServiceUnavailable, healthResponse{Status: "stopped"})
		return
	}
	writeJSON(w, http.StatusOK, healthResponse{Status: "ok"})
}
