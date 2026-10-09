// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"bytes"
	"io"
	"net/http"
	"path"
	"strings"

	repo_model "forgejo.org/models/repo"
	"forgejo.org/modules/git"
	"forgejo.org/modules/gitrepo"
	"forgejo.org/modules/markup"
	"forgejo.org/modules/setting"
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
	text := body.Text
	if body.Commit != "" {
		var ok, missing bool
		if text, missing, ok = a.fileText(repo, body.Commit, body.Path); !ok {
			return
		}
		if missing {
			a.json(http.StatusOK, protocol.APIMarkupResponse{Missing: true})
			return
		}
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
	}, strings.NewReader(text), &out); err != nil {
		if markup.IsErrUnsupportedRenderExtension(err) || markup.IsErrMissingExtension(err) {
			a.error(http.StatusUnprocessableEntity, err.Error())
		} else {
			a.internal("render the file", err)
		}
		return
	}
	a.json(http.StatusOK, protocol.APIMarkupResponse{HTML: out.String()})
}

// fileText reads a repository file's text at a commit (the markup request's
// Commit): missing when there is no such file (or it is a directory), 404
// for no such commit, 413 for a file larger than the classic view
// displays. It answers the request itself when it fails (ok false).
func (a *apiRequest) fileText(repo *repo_model.Repository, sha, treePath string) (text string, missing, ok bool) {
	if !validSHA(repo, sha) || repo.IsEmpty {
		a.notFound()
		return "", false, false
	}
	gitRepo, err := gitrepo.OpenRepository(a.ctx, repo)
	if err != nil {
		a.internal("open the repository", err)
		return "", false, false
	}
	defer gitRepo.Close()
	commit, err := gitRepo.GetCommit(sha)
	if err != nil {
		if git.IsErrNotExist(err) {
			a.notFound()
		} else {
			a.internal("load the commit", err)
		}
		return "", false, false
	}
	entry, err := commit.GetTreeEntryByPath(treePath)
	switch {
	case git.IsErrNotExist(err):
		return "", true, true
	case err != nil:
		a.internal("load the file", err)
		return "", false, false
	case entry.IsDir() || entry.IsSubmodule():
		return "", true, true
	}
	blob := entry.Blob()
	if blob.Size() > setting.UI.MaxDisplayFileSize {
		a.error(http.StatusRequestEntityTooLarge, "the file is too large to render")
		return "", false, false
	}
	rd, err := blob.DataAsync()
	if err != nil {
		a.internal("read the file", err)
		return "", false, false
	}
	defer rd.Close()
	data, err := io.ReadAll(io.LimitReader(rd, setting.UI.MaxDisplayFileSize))
	if err != nil {
		a.internal("read the file", err)
		return "", false, false
	}
	return string(data), false, true
}
