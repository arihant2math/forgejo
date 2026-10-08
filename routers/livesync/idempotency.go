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
	"mime"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	livesync_model "forgejo.org/models/livesync"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/json"
	"forgejo.org/modules/log"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/web"
	"forgejo.org/routers/common"
	"forgejo.org/services/auth"
	"forgejo.org/services/authz"
	"forgejo.org/services/livesync/idempotency"
	"forgejo.org/services/livesync/metrics"
	"forgejo.org/services/livesync/protocol"

	chi "github.com/go-chi/chi/v5"
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

// identify returns the user a keyed write is made by. Only tokens in the
// Authorization header are accepted (the methods of authMethods): another
// kind of credentials API v1 would accept (basic auth, signatures, reverse
// proxy headers) would make the write run without the key being honoured, so
// it is refused instead; tokens in the query or a form body are refused by
// formToken before. req must carry no body: the request is authenticated
// before its body is read. It also returns the token's credentialScope.
// API v1 checks the token's scopes itself; the account is checked by the
// caller (checkAccount), as for livesync's own endpoints.
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

// formTokenKeys are the query / form fields API v1 reads a token from
// (services/auth/method tokenFromForm), before the Authorization header.
var formTokenKeys = []string{"token", "access_token"}

var errFormToken = errors.New("with Idempotency-Key, send the token in the Authorization header, not in the query or the form")

// formToken reports whether values carry a token API v1 would authenticate
// with instead of the Authorization header. Such requests are refused: the
// layer would key the write on a user API v1 does not act as, and the
// token, which changes when it is refreshed, would be part of the request
// hash (the query) and of the synthetic GET of the crash-window check
// (which carries the header only).
func formToken(values url.Values) bool {
	return slices.ContainsFunc(formTokenKeys, values.Has)
}

// credentialRoutes are the API v1 writes whose response carries a secret
// upstream otherwise stores only as a hash (an OAuth2 client secret, an
// access token, a runner token). Storing it for replays would keep it in
// plaintext in livesync_idempotency for IDEMPOTENCY_TTL, so these refuse
// Idempotency-Key (400). Paths are relative to /api/v1; "*" is one segment.
var credentialRoutes = []struct{ method, path string }{
	{http.MethodPost, "/user/applications/oauth2"},
	{http.MethodPatch, "/user/applications/oauth2/*"}, // regenerates the secret
	{http.MethodPost, "/users/*/tokens"},
	{http.MethodPost, "/admin/users/*/tokens"},
	{http.MethodPost, "/user/actions/runners"},
	{http.MethodPost, "/orgs/*/actions/runners"},
	{http.MethodPost, "/repos/*/*/actions/runners"},
	{http.MethodPost, "/admin/actions/runners"},
}

// issuesCredentials reports whether method apiPath (relative to /api/v1)
// is one of credentialRoutes.
func issuesCredentials(method, apiPath string) bool {
	seg := strings.Split(apiPath, "/")
	for _, r := range credentialRoutes {
		if r.method != method {
			continue
		}
		pattern := strings.Split(r.path, "/")
		if len(pattern) != len(seg) {
			continue
		}
		match := true
		for i, p := range pattern {
			if p != "*" && p != seg[i] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

// answerFunc writes one of the layer's own responses (an error, a replay,
// a 409/422, a crash-window answer).
type answerFunc func(w http.ResponseWriter, req *http.Request)

type answerKey struct{}

// newAnswers returns the handler the layer's own responses go through: the
// common protocol middlewares (process entry, access and router log, panic
// recovery), as for livesync's other endpoints, with idempotencyAnswer for
// every path. Responses of a request that runs are written by API v1, whose
// router has those middlewares itself.
func newAnswers() http.Handler {
	r := &web.Route{R: chi.NewRouter()}
	r.Use(common.ProtocolMiddlewares()...)
	r.Any("/*", idempotencyAnswer)
	return r
}

// idempotencyAnswer writes the answerFunc the request carries.
func idempotencyAnswer(w http.ResponseWriter, req *http.Request) {
	if fn, ok := req.Context().Value(answerKey{}).(answerFunc); ok {
		fn(w, req)
	}
}

// answer sends one of the layer's own responses through h.answers.
func (h *handler) answer(w http.ResponseWriter, req *http.Request, fn answerFunc) {
	h.answers.ServeHTTP(w, req.WithContext(context.WithValue(req.Context(), answerKey{}, fn)))
}

func answerJSON(status int, message string, header ...string) answerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		for i := 0; i+1 < len(header); i += 2 {
			w.Header().Set(header[i], header[i+1])
		}
		writeJSON(w, status, errorResponse{Message: message})
	}
}

var (
	answerUnavailable = answerJSON(http.StatusServiceUnavailable, "livesync is not running; retry later", "Retry-After", "2")
	answerInternal    = answerJSON(http.StatusInternalServerError, http.StatusText(http.StatusInternalServerError))
)

// keyedWrite is a keyed request that may run.
type keyedWrite struct {
	svc  *idempotency.Service
	user *user_model.User
	path string
	body []byte
	res  *idempotency.Reservation
}

// serveKeyed handles an API v1 write with an Idempotency-Key.
func (h *handler) serveKeyed(w http.ResponseWriter, req *http.Request, path string) {
	svc := h.idempotency()
	var release func()
	if svc != nil {
		var ok bool
		if release, ok = svc.Enter(); !ok {
			svc = nil
		}
	}
	if svc == nil {
		metrics.Idempotency.WithLabelValues(outcomeRefused).Inc()
		h.answer(w, req, answerUnavailable)
		return
	}
	// The instance keeps its lock until the request has answered, from
	// here on (a stopping instance waits for it, see Service.Enter).
	defer release()
	kw, ans := prepare(req, svc, path)
	if ans != nil {
		h.answer(w, req, ans)
		return
	}
	h.run(w, req, kw)
}

// prepare checks a keyed request, authenticates it, reads its body and
// reserves its key. It returns the write to run, or the answer to send.
func prepare(req *http.Request, svc *idempotency.Service, path string) (kw *keyedWrite, ans answerFunc) {
	outcome := outcomeRefused
	defer func() {
		if kw == nil {
			metrics.Idempotency.WithLabelValues(outcome).Inc()
		}
	}()
	keys := req.Header.Values(protocol.HeaderIdempotencyKey)
	if len(keys) != 1 || !idempotency.ValidKey(keys[0]) {
		return nil, answerJSON(http.StatusBadRequest, "Idempotency-Key must be one value of 1 to 255 printable ASCII characters")
	}
	if issuesCredentials(req.Method, strings.TrimPrefix(path, apiV1Prefix)) {
		return nil, answerJSON(http.StatusBadRequest, "Idempotency-Key is not accepted for requests that issue credentials (their response would be stored)")
	}
	if formToken(req.URL.Query()) {
		return nil, answerJSON(http.StatusBadRequest, errFormToken.Error())
	}
	// Authenticated before the body is read, as API v1 does; the clone
	// has no body (token extraction may call ParseForm).
	ctx := req.Context()
	u, credentials, aerr := identify(withBody(req.Clone(ctx), nil))
	if aerr == nil {
		aerr = checkAccount(ctx, u)
	}
	if aerr != nil {
		return nil, answerJSON(aerr.status, aerr.message)
	}
	body, err := io.ReadAll(io.LimitReader(req.Body, int64(maxRequestBody)+1))
	if err != nil {
		return nil, answerJSON(http.StatusBadRequest, "could not read the request body")
	}
	if len(body) > maxRequestBody {
		return nil, answerJSON(http.StatusRequestEntityTooLarge, "the request body is too large for an Idempotency-Key (16 MiB at most)")
	}
	if ct, _, _ := mime.ParseMediaType(req.Header.Get("Content-Type")); ct == "application/x-www-form-urlencoded" {
		if values, err := url.ParseQuery(string(body)); err == nil && formToken(values) {
			return nil, answerJSON(http.StatusBadRequest, errFormToken.Error())
		}
	}
	begun, err := svc.Begin(ctx, idempotency.Request{
		UserID: u.ID,
		Key:    keys[0],
		Method: req.Method,
		Path:   path,
		Hash:   idempotency.RequestHash(req.Method, path, req.URL.RawQuery, req.Header.Get("Content-Type"), req.Header.Get("Sudo"), credentials, body),
	})
	switch {
	case errors.Is(err, idempotency.ErrUnavailable):
		return nil, answerUnavailable
	case err != nil:
		if ctx.Err() == nil {
			log.Error("livesync: idempotency key of user %d: %v", u.ID, err)
		}
		return nil, answerInternal
	}
	switch begun.Outcome {
	case idempotency.Replay:
		outcome = outcomeReplay
		return nil, func(w http.ResponseWriter, req *http.Request) { replay(req.Context(), w, svc, begun.Record) }
	case idempotency.InFlight:
		outcome = outcomeInFlight
		return nil, answerJSON(http.StatusConflict, "a request with this Idempotency-Key is in progress; retry later", "Retry-After", "1")
	case idempotency.Mismatch:
		outcome = outcomeMismatch
		return nil, answerJSON(http.StatusUnprocessableEntity, "this Idempotency-Key was used for a different request")
	}
	return &keyedWrite{svc: svc, user: u, path: path, body: body, res: begun.Reservation}, nil
}

// dedupeUser returns the user API v1 creates entities as for req: the token's
// user, or the one an administrator's token acts as with sudo (?sudo= or the
// Sudo header, as API v1's sudo() reads them for a JSON body). ok is false
// when API v1 would refuse the sudo (not an administrator, unknown user):
// nothing to look for then.
func dedupeUser(ctx context.Context, u *user_model.User, req *http.Request) (int64, bool) {
	name := req.URL.Query().Get("sudo")
	if name == "" {
		name = req.Header.Get("Sudo")
	}
	if name == "" {
		return u.ID, true
	}
	if !u.IsAdmin {
		return 0, false
	}
	sudo, err := user_model.GetUserByName(ctx, name)
	if err != nil {
		return 0, false
	}
	return sudo.ID, true
}

// run runs a reserved attempt: API v1 in-process with a buffered response,
// then the wait for the materializer, then the record is completed (or
// released on a server error) and the response sent.
func (h *handler) run(w http.ResponseWriter, req *http.Request, kw *keyedWrite) {
	ctx := req.Context()
	svc, res := kw.svc, kw.res
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
		var found *idempotency.Duplicate
		err := idempotency.ErrNoDuplicate
		if userID, ok := dedupeUser(ctx, kw.user, req); ok {
			found, err = idempotency.FindDuplicate(ctx, userID, req.Method, strings.TrimPrefix(kw.path, apiV1Prefix), req.Header.Get("Content-Type"), kw.body, res.Since)
		}
		switch {
		case errors.Is(err, idempotency.ErrNoDuplicate):
		case err != nil:
			if err := svc.Release(bg, res); err != nil {
				log.Error("livesync: release idempotency record: %v", err)
			}
			log.Error("livesync: idempotency crash-window check: %v", err)
			h.answer(w, req, answerInternal)
			return
		default:
			rec = newRecorder(nil)
			h.inner.ServeHTTP(rec, readRequest(req, kw.path, found.Path))
			if rec.code() == http.StatusOK {
				rec.status = found.Status
			}
		}
	}
	duplicate := rec != nil
	switch {
	case duplicate:
		metrics.Idempotency.WithLabelValues(outcomeDuplicate).Inc()
	case res.Recovered:
		metrics.Idempotency.WithLabelValues(outcomeRecovered).Inc()
	default:
		metrics.Idempotency.WithLabelValues(outcomeRun).Inc()
	}
	if rec == nil {
		rec = newRecorder(w)
		h.inner.ServeHTTP(rec, withBody(req, kw.body))
	}

	status := rec.code()
	syncID, high := int64(-1), int64(-1)
	if pos, err := idempotency.Position(bg); err != nil {
		// Unknown: stored as -1, a replay reads the position then.
		log.Error("livesync: idempotent write: %v", err)
	} else {
		high = pos
		if id, ok := synced(ctx, svc, status, res.Low, high); ok {
			syncID = id
		}
	}
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
			log.Warn("livesync: idempotency record of user %d was taken over while its request ran; its response is not stored", kw.user.ID)
		}
	}
	if rec.streaming {
		return // too large to buffer: already sent
	}
	if duplicate {
		// API v1 answered (and logged) the GET; the create's answer goes
		// through the layer's handler.
		h.answer(w, req, func(w http.ResponseWriter, _ *http.Request) {
			writeResponse(w, rec.header, status, rec.body.Bytes(), syncID, false)
		})
		return
	}
	writeResponse(w, rec.header, status, rec.body.Bytes(), syncID, false)
}

// synced waits for the outbox rows of a write in (low, high] (see
// Service.WaitSynced) and returns the sync id that covers them. An error
// response (status >= 400) normally committed nothing: it is checked once
// rather than held up by other writes' rows in the range.
func synced(ctx context.Context, svc *idempotency.Service, status int, low, high int64) (int64, bool) {
	if status >= http.StatusBadRequest {
		return svc.SyncedNow(ctx, low, high)
	}
	start := time.Now()
	id, ok := svc.WaitSynced(ctx, low, high)
	metrics.SyncWait.Observe(time.Since(start).Seconds())
	if !ok && ctx.Err() == nil {
		metrics.SyncWaitTimeouts.Inc()
	}
	return id, ok
}

// Outcomes of keyed writes (metrics.Idempotency).
const (
	outcomeRun       = "run"
	outcomeRecovered = "recovered"
	outcomeDuplicate = "duplicate"
	outcomeReplay    = "replay"
	outcomeInFlight  = "in_flight"
	outcomeMismatch  = "mismatch"
	outcomeRefused   = "refused"
)

// replay answers with a completed record's stored response. A record
// completed without a sync id (the wait timed out, or the outbox position
// could not be read) gets one now.
func replay(ctx context.Context, w http.ResponseWriter, svc *idempotency.Service, rec *livesync_model.Idempotency) {
	header := http.Header{}
	if rec.Headers != "" {
		if err := json.Unmarshal([]byte(rec.Headers), &header); err != nil {
			log.Error("livesync: idempotency record %d: stored headers: %v", rec.ID, err)
		}
	}
	syncID := rec.SyncID
	if syncID < 0 {
		high := rec.OutboxHigh
		if high < 0 {
			// Not read after the write: the current position is above
			// every row the write committed.
			pos, err := idempotency.Position(ctx)
			if err != nil {
				log.Error("livesync: idempotency replay: %v", err)
				high = -1
			} else {
				high = pos
			}
		}
		if high >= 0 {
			if id, ok := synced(ctx, svc, rec.Status, rec.OutboxLow, max(high, rec.OutboxLow)); ok {
				syncID = id
				if err := idempotency.StoreSyncID(context.WithoutCancel(ctx), rec, id); err != nil {
					log.Error("livesync: %v", err)
				}
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
	if !bodyAllowed(r.status) {
		// As net/http does: nothing to buffer, store or replay (e.g. a
		// 204 written with ctx.JSON).
		return 0, http.ErrBodyNotAllowed
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

// bodyAllowed reports whether a response with status may have a body (as
// net/http decides: not 1xx, 204 or 304).
func bodyAllowed(status int) bool {
	return (status < 100 || status > 199) && status != http.StatusNoContent && status != http.StatusNotModified
}
