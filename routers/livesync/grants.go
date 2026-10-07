// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"net/http"

	"forgejo.org/modules/log"
	livesync_service "forgejo.org/services/livesync"
)

// grants answers GET /-/sync/grants: the viewer's implicit grants
// (protocol.Grants), or with ?group=<group> the on-demand decision for one
// group (protocol.Grant). A group the viewer may not read — or that does
// not exist, or is not a client group — is a 404 in every case, so the
// answer does not reveal whether a private repository, user or issue
// exists.
func grants(w http.ResponseWriter, req *http.Request) {
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
	ctx := req.Context()
	if group := req.URL.Query().Get("group"); group != "" {
		d, ok, err := perms.Check(ctx, viewer.ID, group)
		switch {
		case err != nil:
			log.Error("livesync: check %q for user %d: %v", group, viewer.ID, err)
			writeJSON(w, http.StatusInternalServerError, errorResponse{Message: http.StatusText(http.StatusInternalServerError)})
		case !ok:
			notFound(w, req)
		default:
			writeJSON(w, http.StatusOK, d.Wire(group))
		}
		return
	}
	g, err := perms.Grants(ctx, viewer.ID)
	if err != nil {
		log.Error("livesync: grants of user %d: %v", viewer.ID, err)
		writeJSON(w, http.StatusInternalServerError, errorResponse{Message: http.StatusText(http.StatusInternalServerError)})
		return
	}
	writeJSON(w, http.StatusOK, g.Wire())
}
