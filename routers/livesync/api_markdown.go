// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"net/http"

	repo_model "forgejo.org/models/repo"
	"forgejo.org/services/livesync/materialize"
	"forgejo.org/services/livesync/protocol"
)

// Limits of a batch markdown preview.
const (
	maxPreviewItems = 64
	maxPreviewBytes = 1 << 20
)

// apiMarkdown answers POST /-/sync/api/markdown: batch markdown preview
// (protocol.APIMarkdownRequest), rendered by the materializer's renderer so
// that the preview is the body_html the sync log will carry. With repo_id
// the viewer must be able to read the repository (404 otherwise, as API
// v1's POST /markdown with a repository context it may not see).
func apiMarkdown(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, "")
	if a == nil {
		return
	}
	var body protocol.APIMarkdownRequest
	if !a.decode(&body) {
		return
	}
	total := 0
	for _, item := range body.Items {
		total += len(item)
	}
	if len(body.Items) > maxPreviewItems || total > maxPreviewBytes {
		a.error(http.StatusRequestEntityTooLarge, "at most 64 items and 1 MiB of text per request")
		return
	}
	var repo *repo_model.Repository
	if body.RepoID != 0 {
		if !a.readable(protocol.RepoGroup(body.RepoID), protocol.UnitNone) {
			return
		}
		var err error
		if repo, err = repo_model.GetRepositoryByID(a.ctx, body.RepoID); err != nil {
			if repo_model.IsErrRepoNotExist(err) {
				a.notFound()
			} else {
				a.internal("load the repository", err)
			}
			return
		}
	}
	a.json(http.StatusOK, protocol.APIMarkdownResponse{HTML: materialize.RenderPreview(a.ctx, repo, body.Items)})
}
