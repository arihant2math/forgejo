// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"bytes"
	"net/http"
	"path"
	"strings"

	repo_model "forgejo.org/models/repo"
	"forgejo.org/modules/markup"
	"forgejo.org/modules/util"
	"forgejo.org/services/livesync/protocol"
)

// apiMarkup answers POST /-/sync/api/markup: a repository file rendered as
// the classic file view renders it (routers/web/repo/view.go: markup by
// the file's extension, relative links and images resolved from the file's
// directory at the ref, the document metas). API v1's /markup cannot do
// that: it has no tree path, so a link in docs/guide.md to "more.md" or
// "../logo.svg" resolved against the repository's root. The viewer must
// read the repository's code (404 otherwise).
func apiMarkup(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, "")
	if a == nil {
		return
	}
	var body protocol.APIMarkupRequest
	if !a.decode(&body) {
		return
	}
	kind, name, ok := strings.Cut(body.Ref, "/")
	if !ok || name == "" || (kind != "branch" && kind != "tag" && kind != "commit") || body.Path == "" || strings.HasPrefix(body.Path, "/") {
		a.error(http.StatusBadRequest, "ref must be branch/…, tag/… or commit/…, and path a file's path in the repository")
		return
	}
	if !a.readable(protocol.RepoGroup(body.RepoID), protocol.UnitCode) {
		return
	}
	repo, err := repo_model.GetRepositoryByID(a.ctx, body.RepoID)
	if err != nil {
		if repo_model.IsErrRepoNotExist(err) {
			a.notFound()
		} else {
			a.internal("load the repository", err)
		}
		return
	}
	branchPath := kind + "/" + util.PathEscapeSegments(name)
	metas := repo.ComposeDocumentMetas(a.ctx)
	metas["BranchNameSubURL"] = branchPath
	var out bytes.Buffer
	if err := markup.Render(&markup.RenderContext{
		Ctx:          a.ctx,
		RelativePath: body.Path,
		Links: markup.Links{
			Base:       repo.Link(),
			BranchPath: branchPath,
			TreePath:   path.Dir(body.Path),
		},
		Metas: metas,
	}, strings.NewReader(body.Text), &out); err != nil {
		if markup.IsErrUnsupportedRenderExtension(err) || markup.IsErrMissingExtension(err) {
			a.error(http.StatusUnprocessableEntity, err.Error())
		} else {
			a.internal("render the file", err)
		}
		return
	}
	a.json(http.StatusOK, protocol.APIMarkupResponse{HTML: out.String()})
}
