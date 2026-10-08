// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	repo_model "forgejo.org/models/repo"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/git"
	"forgejo.org/modules/gitrepo"
	"forgejo.org/modules/json"
	"forgejo.org/modules/log"
	"forgejo.org/modules/setting"
	"forgejo.org/services/livesync/protocol"

	chi "github.com/go-chi/chi/v5"
)

// Immutable, SHA-addressed git reads (protocol/api.go): trees, files and
// blobs, blame and diffs addressed by full object ids only, so that every
// response can be cached forever (by the Next UI's service worker and
// IndexedDB; the browser's HTTP cache keys them by token: Vary:
// Authorization). They read the repository with modules/git as the classic
// code view does (routers/web/repo/view.go, blame.go, commit.go) and need
// the code unit (reqRepoCodeReader), decided by livesync's permission cache.

// validSHA reports whether s is a full object id of repo's object format
// (lowercase hexadecimal): the only addresses the immutable endpoints
// accept.
func validSHA(repo *repo_model.Repository, s string) bool {
	if len(s) != objectFormat(repo).FullLength() {
		return false
	}
	for i := 0; i < len(s); i++ {
		if c := s[i]; (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// objectFormat is repo's object format (SHA-1 unless it says SHA-256).
func objectFormat(repo *repo_model.Repository) git.ObjectFormat {
	if repo.ObjectFormatName == git.Sha256ObjectFormat.Name() {
		return git.Sha256ObjectFormat
	}
	return git.Sha1ObjectFormat
}

// codeRepo checks that the viewer may read the code of the repository {id}
// and that the named SHA parameters are full object ids, and opens the
// repository; it answers the request itself (404) and returns nil
// otherwise. The caller closes the git repository.
func (a *apiRequest) codeRepo(shaParams ...string) (*repo_model.Repository, *git.Repository) {
	id, ok := a.id("id")
	if !ok || !a.readable(protocol.RepoGroup(id), protocol.UnitCode) {
		return nil, nil
	}
	repo, err := repo_model.GetRepositoryByID(a.ctx, id)
	if err != nil {
		if repo_model.IsErrRepoNotExist(err) {
			a.notFound()
		} else {
			a.internal("load the repository", err)
		}
		return nil, nil
	}
	for _, p := range shaParams {
		if !validSHA(repo, chi.URLParam(a.req, p)) {
			a.notFound()
			return nil, nil
		}
	}
	if repo.IsEmpty {
		a.notFound()
		return nil, nil
	}
	gitRepo, err := gitrepo.OpenRepository(a.ctx, repo)
	if err != nil {
		a.internal("open the repository", err)
		return nil, nil
	}
	return repo, gitRepo
}

// commit loads the commit of the SHA parameter name (404 when the
// repository has none).
func (a *apiRequest) commit(gitRepo *git.Repository, name string) *git.Commit {
	c, err := gitRepo.GetCommit(chi.URLParam(a.req, name))
	if err != nil {
		if git.IsErrNotExist(err) {
			a.notFound()
		} else {
			a.internal("load the commit", err)
		}
		return nil
	}
	return c
}

// treePath is the wildcard path parameter, without leading or trailing
// slashes.
func (a *apiRequest) treePath() string {
	return strings.Trim(chi.URLParam(a.req, "*"), "/")
}

// immutable sets the headers of an immutable response with ETag etag and
// reports whether the client's If-None-Match already names it (then it
// answered 304).
func immutable(w http.ResponseWriter, req *http.Request, etag string) bool {
	h := w.Header()
	h.Set("Cache-Control", protocol.CacheImmutable)
	h.Set("Vary", "Authorization")
	quoted := `"` + etag + `"`
	h.Set("ETag", quoted)
	for tag := range strings.SplitSeq(req.Header.Get("If-None-Match"), ",") {
		tag = strings.TrimPrefix(strings.TrimSpace(tag), "W/")
		if tag == quoted || tag == "*" {
			w.WriteHeader(http.StatusNotModified)
			return true
		}
	}
	return false
}

// writeImmutableJSON answers an immutable JSON response.
func writeImmutableJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(v)
}

// apiTree answers GET /-/sync/api/repos/{id}/tree/{commit}[/{path}].
func apiTree(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, "")
	if a == nil {
		return
	}
	_, gitRepo := a.codeRepo("commit")
	if gitRepo == nil {
		return
	}
	defer gitRepo.Close()
	sha, path := chi.URLParam(req, "commit"), a.treePath()
	commit := a.commit(gitRepo, "commit")
	if commit == nil {
		return
	}
	tree := &commit.Tree
	if path != "" {
		sub, err := commit.SubTree(path)
		if err != nil {
			if git.IsErrNotExist(err) {
				a.notFound()
			} else {
				a.internal("load the tree", err)
			}
			return
		}
		tree = sub
	}
	if immutable(w, req, tree.ID.String()) {
		return
	}
	entries, err := tree.ListEntries()
	if err != nil {
		w.Header().Del("ETag")
		w.Header().Del("Cache-Control")
		a.internal("list the tree", err)
		return
	}
	res := protocol.APITree{Commit: sha, Path: path, SHA: tree.ID.String(), Entries: make([]protocol.APITreeEntry, 0, len(entries))}
	for _, e := range entries {
		entry := protocol.APITreeEntry{Name: e.Name(), Mode: fmt.Sprintf("%06o", int64(e.Mode())), SHA: e.ID.String()}
		switch {
		case e.IsSubmodule():
			entry.Type = "commit"
		case e.IsDir():
			entry.Type = "tree"
		case e.IsLink():
			entry.Type = "symlink"
		default:
			entry.Type = "blob"
		}
		if entry.Type == "blob" || entry.Type == "symlink" {
			size := e.Size()
			entry.Size = &size
		}
		res.Entries = append(res.Entries, entry)
	}
	writeImmutableJSON(w, res)
}

// serveObject streams a blob's bytes as an immutable download.
func serveObject(w http.ResponseWriter, req *http.Request, a *apiRequest, blob *git.Blob, size int64) {
	if immutable(w, req, blob.ID.String()) {
		return
	}
	rd, err := blob.DataAsync()
	if err != nil {
		w.Header().Del("ETag")
		w.Header().Del("Cache-Control")
		a.internal("read the blob", err)
		return
	}
	defer rd.Close()
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Content-Length", strconv.FormatInt(size, 10))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, rd)
}

// apiRaw answers GET /-/sync/api/repos/{id}/raw/{commit}/{path}.
func apiRaw(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, "")
	if a == nil {
		return
	}
	_, gitRepo := a.codeRepo("commit")
	if gitRepo == nil {
		return
	}
	defer gitRepo.Close()
	commit := a.commit(gitRepo, "commit")
	if commit == nil {
		return
	}
	path := a.treePath()
	entry, err := commit.GetTreeEntryByPath(path)
	switch {
	case git.IsErrNotExist(err):
		a.notFound()
		return
	case err != nil:
		a.internal("load the file", err)
		return
	case path == "" || entry.IsDir() || entry.IsSubmodule():
		a.notFound()
		return
	}
	blob := entry.Blob()
	serveObject(w, req, a, blob, blob.Size())
}

// apiBlob answers GET /-/sync/api/repos/{id}/blobs/{sha}.
func apiBlob(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, "")
	if a == nil {
		return
	}
	_, gitRepo := a.codeRepo("sha")
	if gitRepo == nil {
		return
	}
	defer gitRepo.Close()
	sha := chi.URLParam(req, "sha")
	var typ string
	var size int64
	err := gitRepo.WithCatFileBatchCheck(a.ctx, func(wr io.Writer, rd *bufio.Reader) error {
		if _, err := wr.Write([]byte(sha + "\n")); err != nil {
			return err
		}
		var err error
		_, typ, size, err = git.ReadBatchLine(rd)
		return err
	})
	switch {
	case git.IsErrNotExist(err) || (err == nil && typ != "blob"):
		a.notFound()
		return
	case err != nil:
		a.internal("look up the blob", err)
		return
	}
	blob, err := gitRepo.GetBlob(sha)
	if err != nil {
		a.internal("load the blob", err)
		return
	}
	serveObject(w, req, a, blob, size)
}

// apiDiff answers GET /-/sync/api/repos/{id}/diff/{commit} (against the
// first parent, or the empty tree for a root commit) and
// /diff/{base}/{head}: a unified diff with rename detection (git diff -M).
func apiDiff(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, "")
	if a == nil {
		return
	}
	params := []string{"commit"}
	if chi.URLParam(req, "commit") == "" {
		params = []string{"base", "head"}
	}
	repo, gitRepo := a.codeRepo(params...)
	if gitRepo == nil {
		return
	}
	defer gitRepo.Close()
	var base, etag string
	var head *git.Commit
	if len(params) == 1 {
		if head = a.commit(gitRepo, "commit"); head == nil {
			return
		}
		etag = head.ID.String()
		if head.ParentCount() == 0 {
			base = objectFormat(repo).EmptyTree().String()
		} else {
			parent, err := head.ParentID(0)
			if err != nil {
				a.internal("load the parent commit", err)
				return
			}
			base = parent.String()
		}
	} else {
		baseCommit := a.commit(gitRepo, "base")
		if baseCommit == nil {
			return
		}
		if head = a.commit(gitRepo, "head"); head == nil {
			return
		}
		base = baseCommit.ID.String()
		etag = base + ".." + head.ID.String()
	}
	if immutable(w, req, etag) {
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Streamed: an error after the first bytes can only cut the response
	// (the client then has no complete diff: no trailing newline, or a
	// broken connection).
	if err := git.GetRepoRawDiffForFile(gitRepo, base, head.ID.String(), git.RawDiffNormal, "", w); err != nil && a.ctx.Err() == nil {
		a.internalLogged("diff", err)
	}
}

// internalLogged logs an error after the response started.
func (a *apiRequest) internalLogged(what string, err error) {
	if a.ctx.Err() == nil {
		log.Error("livesync: %s %s: %s: %v", a.req.Method, a.req.URL.Path, what, err)
	}
}

// apiBlame answers GET /-/sync/api/repos/{id}/blame/{commit}/{path}
// (?bypass_ignore=1 ignores .git-blame-ignore-revs).
func apiBlame(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, "")
	if a == nil {
		return
	}
	repo, gitRepo := a.codeRepo("commit")
	if gitRepo == nil {
		return
	}
	defer gitRepo.Close()
	commit := a.commit(gitRepo, "commit")
	if commit == nil {
		return
	}
	path := a.treePath()
	entry, err := commit.GetTreeEntryByPath(path)
	switch {
	case git.IsErrNotExist(err):
		a.notFound()
		return
	case err != nil:
		a.internal("load the file", err)
		return
	case path == "" || entry.IsDir() || entry.IsSubmodule():
		a.notFound()
		return
	}
	if entry.Blob().Size() >= setting.UI.MaxDisplayFileSize {
		a.error(http.StatusUnprocessableEntity, "the file is too large to blame")
		return
	}
	bypass := req.URL.Query().Get("bypass_ignore") == "1"
	etag := commit.ID.String() + ":" + path
	if bypass {
		etag += ":bypass"
	}
	if immutable(w, req, etag) {
		return
	}
	res, err := blame(a, repo, gitRepo, commit, path, bypass)
	if err != nil {
		w.Header().Del("ETag")
		w.Header().Del("Cache-Control")
		if a.ctx.Err() == nil {
			a.internal("blame", err)
		}
		return
	}
	writeImmutableJSON(w, res)
}

// blame runs git blame as the classic blame page does (performBlame: when
// .git-blame-ignore-revs makes it fail without a result, again without
// it) and describes the parts' commits.
func blame(a *apiRequest, repo *repo_model.Repository, gitRepo *git.Repository, commit *git.Commit, path string, bypass bool) (*protocol.APIBlame, error) {
	f := objectFormat(repo)
	res := &protocol.APIBlame{Commit: commit.ID.String(), Path: path, Parts: []protocol.APIBlamePart{}, Commits: map[string]protocol.APIBlameCommit{}}
	parts, uses, err := blameParts(a, f, repo.RepoPath(), commit, path, bypass)
	if err != nil {
		if len(parts) != 0 || !uses {
			return nil, err
		}
		if parts, _, err = blameParts(a, f, repo.RepoPath(), commit, path, true); err != nil {
			return nil, err
		}
		res.FaultyIgnoreRevsFile = true
	} else {
		res.UsesIgnoreRevs = uses
	}

	// As fillBlameResult: a part without a previous commit takes the one
	// of an earlier part of the same commit.
	first := map[string]*git.BlamePart{}
	line := 1
	commits := make([]*git.Commit, 0, len(parts))
	byID := map[string]*git.Commit{commit.ID.String(): commit}
	for _, p := range parts {
		if prev, ok := first[p.Sha]; ok {
			if p.PreviousSha == "" {
				p.PreviousSha, p.PreviousPath = prev.PreviousSha, prev.PreviousPath
			}
		} else {
			first[p.Sha] = p
			c, ok := byID[p.Sha]
			if !ok {
				if c, err = gitRepo.GetCommit(p.Sha); err != nil {
					return nil, err
				}
				byID[p.Sha] = c
			}
			commits = append(commits, c)
		}
		res.Parts = append(res.Parts, protocol.APIBlamePart{
			SHA: p.Sha, StartLine: line, Lines: len(p.Lines), PreviousSHA: p.PreviousSha, PreviousPath: p.PreviousPath,
		})
		line += len(p.Lines)
	}
	for _, uc := range user_model.ValidateCommitsWithEmails(a.ctx, commits) {
		bc := protocol.APIBlameCommit{Summary: uc.Summary()}
		if uc.Author != nil {
			bc.AuthorName, bc.AuthorEmail, bc.AuthoredAt = uc.Author.Name, uc.Author.Email, uc.Author.When.UTC().Format(time.RFC3339)
		}
		if uc.Committer != nil {
			bc.CommittedAt = uc.Committer.When.UTC().Format(time.RFC3339)
		}
		if uc.User != nil {
			bc.AuthorID = uc.User.ID
		}
		res.Commits[uc.ID.String()] = bc
	}
	return res, nil
}

// blameParts reads git blame's parts; uses: the ignore-revs file was
// applied. On an error the parts read so far are returned.
func blameParts(a *apiRequest, f git.ObjectFormat, repoPath string, commit *git.Commit, path string, bypass bool) ([]*git.BlamePart, bool, error) {
	br, err := git.CreateBlameReader(a.ctx, f, repoPath, commit, path, bypass)
	if err != nil {
		return nil, false, err
	}
	uses := br.UsesIgnoreRevs()
	var parts []*git.BlamePart
	for {
		p, err := br.NextPart()
		if err != nil {
			_ = br.Close()
			return parts, uses, err
		}
		if p == nil {
			break
		}
		parts = append(parts, p)
	}
	if err := br.Close(); err != nil {
		return parts, uses, err
	}
	return parts, uses, nil
}
