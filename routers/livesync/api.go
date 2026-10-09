// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"context"
	"io"
	"net/http"
	"strconv"

	auth_model "forgejo.org/models/auth"
	access_model "forgejo.org/models/perm/access"
	repo_model "forgejo.org/models/repo"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/json"
	"forgejo.org/modules/log"
	"forgejo.org/modules/web"
	livesync_service "forgejo.org/services/livesync"
	"forgejo.org/services/livesync/perm"
	"forgejo.org/services/livesync/protocol"

	chi "github.com/go-chi/chi/v5"
)

// The gap endpoints (B9, PLAN §4.8): what API v1 lacks, below
// /-/sync/api/. The contract (routes, request and response shapes,
// statuses) is documented in services/livesync/protocol/api.go; every
// endpoint calls Forgejo's service layer (or the model functions the
// classic UI calls where there is no service function; SURFACE.md) and
// decides permissions as the classic UI does for the same action.
//
// Writes are dispatched by handler.ServeHTTP (wrap.go) through the
// idempotency layer when they carry an Idempotency-Key, else through
// serveSynced, so that every write answers with X-Livesync-Sync-Id.

// maxAPIBody bounds the JSON body of a gap endpoint (markdown previews are
// the largest: 1 MiB of text).
const maxAPIBody = 2 << 20

// registerAPI adds the gap endpoints to livesync's router.
func registerAPI(r *web.Route) {
	p := protocol.APIPrefix
	r.Post(p+"/projects/{id}/columns", apiColumnCreate)
	r.Patch(p+"/projects/{id}/columns/{column}", apiColumnEdit)
	r.Delete(p+"/projects/{id}/columns/{column}", apiColumnDelete)
	r.Put(p+"/projects/{id}/column-order", apiColumnOrder)
	r.Post(p+"/projects/{id}/columns/{column}/cards", apiCardMove)
	r.Patch(p+"/issues/{id}/body", apiIssueBody)
	r.Patch(p+"/comments/{id}/body", apiCommentBody)
	r.Get(p+"/bodies/{model}/{id}", apiFullBody)
	r.Get(p+"/issues/{id}/viewed", apiViewedGet)
	r.Put(p+"/issues/{id}/viewed", apiViewedPut)
	r.Put(p+"/issues/{id}/project", apiIssueProject)
	r.Post(p+"/markdown", apiMarkdown)
	r.Post(p+"/markup", apiMarkup)
	r.Get(p+"/repos/{id}/tree/{commit}", apiTree)
	r.Get(p+"/repos/{id}/tree/{commit}/*", apiTree)
	r.Get(p+"/repos/{id}/raw/{commit}/*", apiRaw)
	r.Get(p+"/repos/{id}/blobs/{sha}", apiBlob)
	r.Get(p+"/repos/{id}/blame/{commit}/*", apiBlame)
	r.Get(p+"/repos/{id}/diff/{commit}", apiDiff)
	r.Get(p+"/repos/{id}/diff/{base}/{head}", apiDiff)
}

// apiReadOnlyPost are the gap endpoints that are POSTed but write nothing:
// no sync id, and an Idempotency-Key is ignored.
var apiReadOnlyPost = map[string]bool{protocol.APIPrefix + "/markdown": true, protocol.APIPrefix + "/markup": true}

// apiWrite reports whether a request to path (normalised, below
// /-/sync/api/) is a gap endpoint write.
func apiWrite(method, path string) bool {
	switch method {
	case http.MethodPost:
		return !apiReadOnlyPost[path]
	case http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	}
	return false
}

// apiRequest is an authenticated request to a gap endpoint.
type apiRequest struct {
	w      http.ResponseWriter
	req    *http.Request
	ctx    context.Context
	viewer *user_model.User
	perms  *perm.Cache
}

// apiAuth authenticates a gap endpoint request; writeScope, when not
// empty, is the token scope the request needs besides livesync's read
// scopes. It answers the request itself (and returns nil) when it may not
// go on.
func apiAuth(w http.ResponseWriter, req *http.Request, writeScope auth_model.AccessTokenScope) *apiRequest {
	perms := livesync_service.Permissions()
	if perms == nil {
		w.Header().Set("Retry-After", "2")
		writeJSON(w, http.StatusServiceUnavailable, errorResponse{Message: "livesync is not running; retry later"})
		return nil
	}
	viewer, result, aerr := authenticateResult(req)
	if aerr != nil {
		writeJSON(w, aerr.status, errorResponse{Message: aerr.message})
		return nil
	}
	if writeScope != "" && !hasScope(result, writeScope) {
		writeJSON(w, http.StatusForbidden, errorResponse{Message: errWriteScope(writeScope)})
		return nil
	}
	return &apiRequest{w: w, req: req, ctx: req.Context(), viewer: viewer, perms: perms}
}

func (a *apiRequest) json(status int, v any) { writeJSON(a.w, status, v) }

func (a *apiRequest) error(status int, message string) {
	writeJSON(a.w, status, errorResponse{Message: message})
}

func (a *apiRequest) notFound() { notFound(a.w, a.req) }

func (a *apiRequest) forbidden() {
	a.error(http.StatusForbidden, "you may not change this")
}

// internal logs err and answers 500 (nothing when the client went away).
func (a *apiRequest) internal(what string, err error) {
	if a.ctx.Err() == nil {
		log.Error("livesync: %s %s: %s: %v", a.req.Method, a.req.URL.Path, what, err)
	}
	a.error(http.StatusInternalServerError, http.StatusText(http.StatusInternalServerError))
}

// noContent answers 204.
func (a *apiRequest) noContent() {
	a.w.Header().Set("Cache-Control", "no-store")
	a.w.WriteHeader(http.StatusNoContent)
}

// id is the positive integer path parameter name; false (and a 404) when
// it is not one.
func (a *apiRequest) id(name string) (int64, bool) {
	id, err := strconv.ParseInt(chi.URLParam(a.req, name), 10, 64)
	if err != nil || id <= 0 {
		a.notFound()
		return 0, false
	}
	return id, true
}

// decode reads the JSON body into v; false (and a 400) when it is not
// one.
func (a *apiRequest) decode(v any) bool {
	body, err := io.ReadAll(io.LimitReader(a.req.Body, maxAPIBody+1))
	switch {
	case err != nil:
		a.error(http.StatusBadRequest, "could not read the request body")
		return false
	case len(body) > maxAPIBody:
		a.error(http.StatusRequestEntityTooLarge, "the request body is too large")
		return false
	}
	if err := json.Unmarshal(body, v); err != nil {
		a.error(http.StatusBadRequest, "the request body is not the expected JSON: "+err.Error())
		return false
	}
	return true
}

// repoPermission loads a repository and the viewer's permission in it as
// the classic UI's repository context does (GetUserRepoPermission); ok is
// false (and a 404 was sent) when it does not exist or the viewer has no
// access at all.
func (a *apiRequest) repoPermission(repoID int64) (*repo_model.Repository, access_model.Permission, bool) {
	repo, err := repo_model.GetRepositoryByID(a.ctx, repoID)
	if err != nil {
		if repo_model.IsErrRepoNotExist(err) {
			a.notFound()
		} else {
			a.internal("load the repository", err)
		}
		return nil, access_model.Permission{}, false
	}
	p, err := access_model.GetUserRepoPermission(a.ctx, repo, a.viewer)
	if err != nil {
		a.internal("repository permission", err)
		return nil, access_model.Permission{}, false
	}
	if !p.HasAccess() {
		a.notFound()
		return nil, access_model.Permission{}, false
	}
	return repo, p, true
}

// readable decides with livesync's permission cache (the decisions B4
// compares with API v1) whether the viewer may read group and, when unit
// is not empty, that unit in it; false (and a 404 or 500) otherwise.
func (a *apiRequest) readable(group string, unit protocol.Unit) bool {
	d, ok, err := a.perms.Check(a.ctx, a.viewer.ID, group)
	switch {
	case err != nil:
		a.internal("check "+group, err)
		return false
	case !ok || (unit != protocol.UnitNone && !d.Units.Allows(unit)):
		a.notFound()
		return false
	}
	return true
}
