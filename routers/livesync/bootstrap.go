// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"context"
	"errors"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	user_model "forgejo.org/models/user"
	"forgejo.org/modules/log"
	livesync_service "forgejo.org/services/livesync"
	"forgejo.org/services/livesync/bootstrap"
	"forgejo.org/services/livesync/materialize"
	"forgejo.org/services/livesync/perm"
	"forgejo.org/services/livesync/protocol"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/gzip"
)

// Bootstraps and partial loads (B6, PLAN §4.7; the format is documented in
// services/livesync/protocol/bootstrap.go):
//
//   - GET /-/sync/bootstrap?group=G[&model=M,…]: any client group the viewer
//     may read; repo:{id} groups get their summary tier, the others
//     everything.
//   - GET /-/sync/load?group=issue:{id}[&model=…]: an issue's lazy tier
//     (the same as its bootstrap).
//   - GET /-/sync/load?group=repo:{id}&closedBefore=C[&limit=N][&model=…]:
//     a page of the repository's older closed issues and pull requests.
//   - GET /-/sync/workspace: the groups to keep subscribed.
//
// A group the viewer may not read, or that does not exist, is 404 (never
// 403: the answer does not tell them apart). While the entity index
// backfill of a table the response needs is not done (livesync was just
// installed, or a re-bootstrap marker restarted it), the answer is 503 with
// Retry-After: the client retries.

// bootstrapRetryAfter is the Retry-After of a 503 while the entity index
// backfill runs.
const bootstrapRetryAfter = "2"

// Page size of the closed tier (load?closedBefore=): default and maximum.
const (
	defaultClosedPage = 500
	maxClosedPage     = 2000
)

// serveBootstrap answers GET /-/sync/bootstrap.
func serveBootstrap(w http.ResponseWriter, req *http.Request) {
	serveSnapshot(w, req, false)
}

// serveLoad answers GET /-/sync/load.
func serveLoad(w http.ResponseWriter, req *http.Request) {
	serveSnapshot(w, req, true)
}

func badRequest(w http.ResponseWriter, message string) {
	writeJSON(w, http.StatusBadRequest, errorResponse{Message: message})
}

func serveSnapshot(w http.ResponseWriter, req *http.Request, load bool) {
	perms := livesync_service.Permissions()
	if perms == nil {
		writeJSON(w, http.StatusServiceUnavailable, errorResponse{Message: http.StatusText(http.StatusServiceUnavailable)})
		return
	}
	viewer, aerr := authenticate(req)
	if aerr != nil {
		writeJSON(w, aerr.status, errorResponse{Message: aerr.message})
		return
	}
	query := req.URL.Query()
	group := query.Get("group")
	if group == "" {
		badRequest(w, "the group parameter is required")
		return
	}
	breq := bootstrap.Request{Group: group, ViewerID: viewer.ID, Recent: time.Now().Add(-livesync_service.Setting.SummaryRecency)}
	prefix, _, _ := protocol.ParseGroup(group)
	closedBefore := query.Get("closedBefore")
	switch {
	case load && prefix == protocol.GroupPrefixIssue && closedBefore == "":
		breq.Tier = protocol.TierFull
	case load && prefix == protocol.GroupPrefixRepo && closedBefore != "":
		c, err := materialize.ParseClosedCursor(closedBefore)
		if err != nil {
			badRequest(w, err.Error())
			return
		}
		breq.Tier, breq.ClosedBefore, breq.Limit = protocol.TierClosed, c, defaultClosedPage
		if s := query.Get("limit"); s != "" {
			if breq.Limit, err = strconv.Atoi(s); err != nil || breq.Limit <= 0 || breq.Limit > maxClosedPage {
				badRequest(w, "limit must be between 1 and "+strconv.Itoa(maxClosedPage))
				return
			}
		}
	case load:
		badRequest(w, "load serves issue:{id} groups, and repo:{id} groups with closedBefore")
		return
	case closedBefore != "":
		badRequest(w, "closedBefore is a parameter of /-/sync/load")
		return
	case prefix == protocol.GroupPrefixRepo:
		breq.Tier = protocol.TierSummary
	default:
		breq.Tier = protocol.TierFull
	}
	if s := query.Get("model"); s != "" {
		schemas := materialize.Schemas()
		for m := range strings.SplitSeq(s, ",") {
			if _, ok := schemas[protocol.Model(m)]; !ok {
				badRequest(w, "unknown model "+strconv.Quote(m))
				return
			}
			if !slices.Contains(breq.Models, protocol.Model(m)) {
				breq.Models = append(breq.Models, protocol.Model(m))
			}
		}
	}

	ctx := req.Context()
	units, ok := checkGroup(ctx, w, req, perms, viewer, group)
	if !ok {
		return
	}
	breq.Units = units
	prepared, pending, err := bootstrap.Prepare(ctx, breq)
	if err != nil {
		log.Error("livesync: bootstrap of %s: %v", group, err)
		writeJSON(w, http.StatusInternalServerError, errorResponse{Message: http.StatusText(http.StatusInternalServerError)})
		return
	}
	if len(pending) > 0 {
		w.Header().Set("Retry-After", bootstrapRetryAfter)
		writeJSON(w, http.StatusServiceUnavailable, errorResponse{Message: "livesync is indexing " + strings.Join(pending, ", ") + "; retry later"})
		return
	}

	enc := negotiateEncoding(req.Header.Get("Accept-Encoding"))
	h := w.Header()
	h.Set("Content-Type", "application/x-ndjson; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Add("Vary", "Accept-Encoding")
	if enc != "" {
		h.Set("Content-Encoding", enc)
	}
	w.WriteHeader(http.StatusOK)
	out, closeOut := compress(w, enc)
	flush := func() error {
		if err := out.Flush(); err != nil {
			return err
		}
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		return nil
	}
	err = prepared.Stream(ctx, out, flush, perms)
	if cerr := closeOut(); err == nil {
		err = cerr
	}
	switch {
	case err == nil:
	case ctx.Err() != nil || errors.Is(err, context.Canceled):
		log.Debug("livesync: bootstrap of %s for user %d cancelled: %v", group, viewer.ID, err)
	default:
		// The response has no end line: the client discards it.
		log.Error("livesync: bootstrap of %s for user %d: %v", group, viewer.ID, err)
	}
}

// checkGroup decides whether viewer may read group (404 when not, which
// it writes) and returns their units in it.
func checkGroup(ctx context.Context, w http.ResponseWriter, req *http.Request, perms *perm.Cache, viewer *user_model.User, group string) (perm.UnitSet, bool) {
	d, ok, err := perms.Check(ctx, viewer.ID, group)
	switch {
	case err != nil:
		log.Error("livesync: check %q for user %d: %v", group, viewer.ID, err)
		writeJSON(w, http.StatusInternalServerError, errorResponse{Message: http.StatusText(http.StatusInternalServerError)})
		return 0, false
	case !ok:
		notFound(w, req)
		return 0, false
	}
	return d.Units, true
}

// flushWriter is a response body writer that can flush what it buffered.
type flushWriter interface {
	io.Writer
	Flush() error
}

// identity is the flushWriter of an uncompressed response.
type identity struct{ io.Writer }

func (identity) Flush() error { return nil }

// compress returns the writer of the response body for the content
// encoding enc ("br", "gzip" or "" for none) and the function that ends
// the encoded stream.
func compress(w io.Writer, enc string) (flushWriter, func() error) {
	switch enc {
	case "br":
		// Quality 4 with a 256 KiB window: fast enough to stream, small
		// per-response memory.
		bw := brotli.NewWriterOptions(w, brotli.WriterOptions{Quality: 4, LGWin: 18})
		return bw, bw.Close
	case "gzip":
		gw, _ := gzip.NewWriterLevel(w, gzip.DefaultCompression)
		return gw, gw.Close
	}
	return identity{w}, func() error { return nil }
}

// negotiateEncoding picks the response's content encoding from an
// Accept-Encoding header: br, else gzip, else none.
func negotiateEncoding(header string) string {
	accepted := map[string]bool{}
	for part := range strings.SplitSeq(header, ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		q := 1.0
		for p := range strings.SplitSeq(params, ";") {
			if v, ok := strings.CutPrefix(strings.TrimSpace(p), "q="); ok {
				if f, err := strconv.ParseFloat(v, 64); err == nil {
					q = f
				}
			}
		}
		accepted[strings.ToLower(strings.TrimSpace(name))] = q > 0
	}
	for _, enc := range []string{"br", "gzip"} {
		if accepted[enc] {
			return enc
		}
	}
	return ""
}

// serveWorkspace answers GET /-/sync/workspace (protocol.Workspace).
func serveWorkspace(w http.ResponseWriter, req *http.Request) {
	perms := livesync_service.Permissions()
	if perms == nil {
		writeJSON(w, http.StatusServiceUnavailable, errorResponse{Message: http.StatusText(http.StatusServiceUnavailable)})
		return
	}
	viewer, aerr := authenticate(req)
	if aerr != nil {
		writeJSON(w, aerr.status, errorResponse{Message: aerr.message})
		return
	}
	ws, err := bootstrap.Workspace(req.Context(), perms, viewer.ID, livesync_service.Setting.WorkspaceMaxRepos)
	if err != nil {
		log.Error("livesync: workspace of user %d: %v", viewer.ID, err)
		writeJSON(w, http.StatusInternalServerError, errorResponse{Message: http.StatusText(http.StatusInternalServerError)})
		return
	}
	writeJSON(w, http.StatusOK, ws)
}
