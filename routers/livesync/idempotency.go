// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"slices"
	"strconv"
	"strings"

	livesync_model "forgejo.org/models/livesync"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/json"
	"forgejo.org/modules/log"
	"forgejo.org/modules/setting"
	"forgejo.org/services/auth"
	"forgejo.org/services/authz"
	livesync_service "forgejo.org/services/livesync"
	"forgejo.org/services/livesync/idempotency"
	"forgejo.org/services/livesync/protocol"
)

// The idempotency layer in front of API v1 (PLAN §4.8, B7; the client
// contract is documented in services/livesync/protocol/writes.go).

const apiV1Prefix = "/api/v1"

// Variables so that tests can lower them.
var (
	// maxRequestBody bounds the request body buffered for a keyed write
	// (it is hashed, and passed to API v1 from memory).
	maxRequestBody = 16 << 20
	// maxResponseBody bounds the response buffered and stored; a larger
	// one is streamed to the client without X-Livesync-Sync-Id and stored
	// without its body (HeaderBodyOmitted).
	maxResponseBody = 16 << 20
)

// keyed reports whether req is a write to API v1 that carries an
// Idempotency-Key, and returns its path relative to the application root,
// normalised as upstream routes it. Everything else is passed to inner
// untouched; the header check comes first, so requests without it cost one
// map lookup.
func keyed(req *http.Request) (string, bool) {
	if _, ok := req.Header[protocol.HeaderIdempotencyKey]; !ok {
		return "", false
	}
	switch req.Method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return "", false // safe methods are idempotent by themselves
	}
	path := normalizeSlashes(req.URL.Path)
	if sub := setting.AppSubURL; sub != "" && strings.HasPrefix(path, sub+"/") {
		path = path[len(sub):]
	}
	if !strings.HasPrefix(path, apiV1Prefix+"/") {
		return "", false
	}
	return path, true
}

var errIdempotencyCredentials = errors.New("Idempotency-Key needs an OAuth2 or personal access token (Authorization: Bearer or token)")

// credentialScope describes what the token of a keyed write may do: its
// scope and repository restriction. It is part of the request hash, so that
// a response stored for one token is not replayed to another token of the
// same user that could not have made the request (a narrower scope, a
// token limited to public or specific repositories): that one gets 422.
// Refreshing an OAuth2 token keeps its grant's scope, so retries match.
func credentialScope(result auth.AuthenticationResult) string {
	var b strings.Builder
	if has, scope := result.Scope().Get(); has {
		if normalized, err := scope.Normalize(); err == nil {
			scope = normalized
		}
		b.WriteString(string(scope))
	}
	b.WriteString("|")
	switch r := result.Reducer().(type) {
	case nil, *authz.AllAccessAuthorizationReducer:
		b.WriteString("all")
	case *authz.PublicReposAuthorizationReducer:
		b.WriteString("public")
	case *authz.SpecificReposAuthorizationReducer:
		ids := make([]int64, 0, len(r.ResourceRepos))
		for _, repo := range r.ResourceRepos {
			ids = append(ids, repo.GetTargetRepoID())
		}
		slices.Sort(ids)
		fmt.Fprintf(&b, "repos:%v", ids)
	default:
		fmt.Fprintf(&b, "%T", r)
	}
	return b.String()
}

// identify returns the user a keyed write is made by. Only tokens are
// accepted (the methods of authMethods): another kind of credentials API v1
// would accept (basic auth, signatures, reverse proxy headers) would make
// the write run without the key being honoured, so it is refused instead.
// API v1 checks the account and the token's scopes itself.
// It also returns the token's credentialScope.
func identify(req *http.Request) (*user_model.User, string, *authError) {
	switch out := authMethods.Verify(req, nil, nil).(type) {
	case *auth.AuthenticationSuccess:
		if u := out.Result.User(); u != nil {
			return u, credentialScope(out.Result), nil
		}
	case *auth.AuthenticationError:
		log.Error("livesync: authentication: %v", out.Error)
		return nil, "", &authError{http.StatusInternalServerError, http.StatusText(http.StatusInternalServerError)}
	case *auth.AuthenticationNotAttempted:
		if req.Header.Get("Authorization") != "" {
			return nil, "", &authError{http.StatusBadRequest, errIdempotencyCredentials.Error()}
		}
	}
	return nil, "", &authError{http.StatusUnauthorized, "a valid access token is required"}
}

// serveKeyed handles an API v1 write with an Idempotency-Key.
func (h *handler) serveKeyed(w http.ResponseWriter, req *http.Request, path string) {
	svc := livesync_service.Idempotency()
	if svc == nil {
		w.Header().Set("Retry-After", "2")
		writeJSON(w, http.StatusServiceUnavailable, errorResponse{Message: "livesync is not running; retry later"})
		return
	}
	keys := req.Header.Values(protocol.HeaderIdempotencyKey)
	if len(keys) != 1 || !idempotency.ValidKey(keys[0]) {
		writeJSON(w, http.StatusBadRequest, errorResponse{Message: "Idempotency-Key must be one value of 1 to 255 printable ASCII characters"})
		return
	}
	body, err := io.ReadAll(io.LimitReader(req.Body, int64(maxRequestBody)+1))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse{Message: "could not read the request body"})
		return
	}
	if len(body) > maxRequestBody {
		writeJSON(w, http.StatusRequestEntityTooLarge, errorResponse{Message: "the request body is too large for an Idempotency-Key (16 MiB at most)"})
		return
	}
	// Authentication may parse the form, i.e. read the body: give it its
	// own copy.
	u, credentials, aerr := identify(withBody(req.Clone(req.Context()), body))
	if aerr != nil {
		writeJSON(w, aerr.status, errorResponse{Message: aerr.message})
		return
	}
	ctx := req.Context()
	begun, err := svc.Begin(ctx, idempotency.Request{
		UserID: u.ID,
		Key:    keys[0],
		Method: req.Method,
		Path:   path,
		Hash:   idempotency.RequestHash(req.Method, path, req.URL.RawQuery, req.Header.Get("Content-Type"), credentials, body),
	})
	if err != nil {
		if ctx.Err() == nil {
			log.Error("livesync: idempotency key of user %d: %v", u.ID, err)
		}
		writeJSON(w, http.StatusInternalServerError, errorResponse{Message: http.StatusText(http.StatusInternalServerError)})
		return
	}
	switch begun.Outcome {
	case idempotency.Replay:
		replay(ctx, w, svc, begun.Record)
	case idempotency.InFlight:
		w.Header().Set("Retry-After", "1")
		writeJSON(w, http.StatusConflict, errorResponse{Message: "a request with this Idempotency-Key is in progress; retry later"})
	case idempotency.Mismatch:
		writeJSON(w, http.StatusUnprocessableEntity, errorResponse{Message: "this Idempotency-Key was used for a different request"})
	default:
		h.run(w, req, svc, begun.Reservation, u, path, body)
	}
}

// run runs a reserved attempt: API v1 in-process with a buffered response,
// then the wait for the materializer, then the record is completed (or
// released on a server error) and the response sent.
func (h *handler) run(w http.ResponseWriter, req *http.Request, svc *idempotency.Service, res *idempotency.Reservation, u *user_model.User, path string, body []byte) {
	ctx := req.Context()
	// Whatever happens to the request from here on, the record must end
	// completed or released.
	bg := context.WithoutCancel(ctx)
	defer func() {
		if p := recover(); p != nil {
			if err := svc.Release(bg, res); err != nil {
				log.Error("livesync: release idempotency record: %v", err)
			}
			panic(p)
		}
	}()

	var rec *recorder
	if res.Recovered {
		// An earlier attempt may have committed the write: answer with
		// what it created instead of creating it twice.
		dup, err := idempotency.FindDuplicate(ctx, u.ID, req.Method, strings.TrimPrefix(path, apiV1Prefix), req.Header.Get("Content-Type"), body, res.Since)
		switch {
		case errors.Is(err, idempotency.ErrNoDuplicate):
		case err != nil:
			if err := svc.Release(bg, res); err != nil {
				log.Error("livesync: release idempotency record: %v", err)
			}
			log.Error("livesync: idempotency crash-window check: %v", err)
			writeJSON(w, http.StatusInternalServerError, errorResponse{Message: http.StatusText(http.StatusInternalServerError)})
			return
		default:
			rec = newRecorder(nil)
			h.inner.ServeHTTP(rec, readRequest(req, path, dup.Path))
			if rec.code() == http.StatusOK {
				rec.status = dup.Status
			}
		}
	}
	if rec == nil {
		rec = newRecorder(w)
		h.inner.ServeHTTP(rec, withBody(req, body))
	}

	syncID := int64(-1)
	high, err := idempotency.Position(bg)
	if err != nil {
		log.Error("livesync: idempotent write: %v", err)
	} else if id, ok := svc.WaitSynced(ctx, res.Low, high); ok {
		syncID = id
	}
	status := rec.code()
	if status >= http.StatusInternalServerError {
		// The outcome is unknown: the next attempt checks for duplicates
		// and runs again.
		if err := svc.Release(bg, res); err != nil {
			log.Error("livesync: release idempotency record: %v", err)
		}
	} else {
		stored := idempotency.Response{Status: status, Headers: storedHeaders(rec.header, rec.omitted), SyncID: syncID, High: high}
		if !rec.omitted {
			stored.Body = rec.body.Bytes()
		}
		ok, err := svc.Complete(bg, res, stored)
		switch {
		case err != nil:
			log.Error("livesync: store idempotent response: %v", err)
		case !ok:
			log.Warn("livesync: idempotency record of user %d was taken over while its request ran; its response is not stored", u.ID)
		}
	}
	if rec.streaming {
		return // too large to buffer: already sent
	}
	writeResponse(w, rec.header, status, rec.body.Bytes(), syncID, false)
}

// replay answers with a completed record's stored response. A record
// completed without a sync id (the wait timed out) gets one now.
func replay(ctx context.Context, w http.ResponseWriter, svc *idempotency.Service, rec *livesync_model.Idempotency) {
	header := http.Header{}
	if rec.Headers != "" {
		if err := json.Unmarshal([]byte(rec.Headers), &header); err != nil {
			log.Error("livesync: idempotency record %d: stored headers: %v", rec.ID, err)
		}
	}
	syncID := rec.SyncID
	if syncID < 0 {
		if id, ok := svc.WaitSynced(ctx, rec.OutboxLow, max(rec.OutboxHigh, rec.OutboxLow)); ok {
			syncID = id
			if err := idempotency.StoreSyncID(context.WithoutCancel(ctx), rec, id); err != nil {
				log.Error("livesync: %v", err)
			}
		}
	}
	writeResponse(w, header, rec.Status, rec.Body, syncID, true)
}

// writeResponse sends a buffered or stored response, with the sync id
// (when known, >= 0) and the replay marker.
func writeResponse(w http.ResponseWriter, header http.Header, status int, body []byte, syncID int64, replayed bool) {
	dst := w.Header()
	maps.Copy(dst, header)
	if syncID >= 0 {
		dst.Set(protocol.HeaderSyncID, strconv.FormatInt(syncID, 10))
	}
	if replayed {
		dst.Set(protocol.HeaderIdempotentReplay, "true")
	}
	if len(body) > 0 {
		dst.Set("Content-Length", strconv.Itoa(len(body)))
	}
	w.WriteHeader(status)
	if len(body) > 0 {
		_, _ = w.Write(body)
	}
}

// unstoredHeaders are not stored with a response: they belong to one
// connection or one response (cookies would hand a session to whoever
// replays), or livesync sets them itself.
var unstoredHeaders = map[string]bool{
	"Set-Cookie": true, "Date": true, "Content-Length": true, "Transfer-Encoding": true,
	"Connection": true, "Keep-Alive": true, "Trailer": true, "Upgrade": true,
}

// storedHeaders encodes the headers of a response for its record.
func storedHeaders(h http.Header, omitted bool) string {
	keep := http.Header{}
	for k, v := range h {
		if unstoredHeaders[k] || strings.HasPrefix(k, "X-Livesync-") {
			continue
		}
		keep[k] = v
	}
	if omitted {
		keep.Set(protocol.HeaderBodyOmitted, "true")
	}
	b, err := json.Marshal(keep)
	if err != nil {
		return ""
	}
	return string(b)
}

// withBody returns a shallow copy of req that reads body.
func withBody(req *http.Request, body []byte) *http.Request {
	r := new(http.Request)
	*r = *req
	r.Body = io.NopCloser(bytes.NewReader(body))
	r.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }
	r.ContentLength = int64(len(body))
	r.TransferEncoding = nil
	return r
}

// readRequest turns a keyed create into the API v1 GET of what it created
// (apiPath, relative to /api/v1), with the same credentials, keeping the
// sub-path the original request carried.
func readRequest(req *http.Request, path, apiPath string) *http.Request {
	r := req.Clone(req.Context())
	r.Method = http.MethodGet
	r.Body = http.NoBody
	r.GetBody = nil
	r.ContentLength = 0
	r.TransferEncoding = nil
	r.Header.Del("Content-Type")
	r.Header.Del("Content-Length")
	r.Header.Del(protocol.HeaderIdempotencyKey)
	prefix := ""
	if orig := normalizeSlashes(req.URL.Path); orig != path {
		prefix = setting.AppSubURL // the request still carried the sub-path
	}
	r.URL.Path = prefix + apiV1Prefix + apiPath
	r.URL.RawPath = ""
	r.URL.RawQuery = ""
	r.RequestURI = r.URL.RequestURI()
	return r
}

// recorder buffers a response. With a real writer, a body over
// maxResponseBody is streamed to it instead (status and headers as the
// handler set them, no sync id); without one, the rest is discarded. Either
// way omitted is set.
type recorder struct {
	out       http.ResponseWriter
	header    http.Header
	status    int
	body      bytes.Buffer
	omitted   bool
	streaming bool
}

func newRecorder(out http.ResponseWriter) *recorder {
	return &recorder{out: out, header: http.Header{}}
}

func (r *recorder) Header() http.Header { return r.header }

func (r *recorder) WriteHeader(status int) {
	if r.status == 0 && status >= 200 {
		r.status = status
	}
}

func (r *recorder) Write(p []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	if r.streaming {
		return r.out.Write(p)
	}
	if r.body.Len()+len(p) <= maxResponseBody {
		return r.body.Write(p)
	}
	r.omitted = true
	if r.out == nil {
		return len(p), nil
	}
	maps.Copy(r.out.Header(), r.header)
	r.out.WriteHeader(r.status)
	r.streaming = true
	if _, err := r.out.Write(r.body.Bytes()); err != nil {
		return 0, err
	}
	r.body.Reset()
	return r.out.Write(p)
}

// code is the response status (200 if the handler set none).
func (r *recorder) code() int {
	if r.status == 0 {
		return http.StatusOK
	}
	return r.status
}
