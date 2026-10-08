// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"net/http"

	auth_model "forgejo.org/models/auth"
	issues_model "forgejo.org/models/issues"
	pull_model "forgejo.org/models/pull"
	"forgejo.org/modules/gitrepo"
	"forgejo.org/modules/log"
	"forgejo.org/services/livesync/protocol"
)

// A pull request's "viewed files" (protocol/api.go): the review_state
// rows the classic files view reads (pull_model.GetNewestReviewState) and
// writes (pull_model.UpdateReviewState, as UpdateViewedFiles in
// routers/web/repo/pull_review.go; there is no service function). The
// rows are synced (ReviewState in user:{viewer}, unit self); these
// endpoints read and write them without the diff page.

// Writing the viewed state is pull request review work: API v1's pull
// request routes are in the repository scope category.
const viewedWriteScope = auth_model.AccessTokenScopeWriteRepository

// viewedPull loads the pull request of the issue {id} for the viewer (404
// unless it is a pull request the viewer may read, as getPullInfo with the
// repository context's checks).
func (a *apiRequest) viewedPull() (*issues_model.Issue, bool) {
	id, ok := a.id("id")
	if !ok {
		return nil, false
	}
	issue, err := issues_model.GetIssueByID(a.ctx, id)
	if err != nil {
		if issues_model.IsErrIssueNotExist(err) {
			a.notFound()
		} else {
			a.internal("load the issue", err)
		}
		return nil, false
	}
	repo, perm, ok := a.repoPermission(issue.RepoID)
	if !ok {
		return nil, false
	}
	issue.Repo = repo
	if !issue.IsPull || !canReadIssue(perm, issue) {
		a.notFound()
		return nil, false
	}
	if err := issue.LoadPullRequest(a.ctx); err != nil {
		a.internal("load the pull request", err)
		return nil, false
	}
	return issue, true
}

// viewedFiles converts a review state to its wire form; changed are files
// that changed since the state's commit (reported as has_changed when they
// were viewed).
func viewedFiles(pullID int64, state *pull_model.ReviewState, changed []string) protocol.APIViewedFiles {
	res := protocol.APIViewedFiles{PullID: pullID, Files: map[string]string{}}
	if state == nil {
		return res
	}
	res.CommitSHA = state.CommitSHA
	for path, s := range state.UpdatedFiles {
		switch s {
		case pull_model.Viewed:
			res.Files[path] = protocol.ViewedViewed
		case pull_model.HasChanged:
			res.Files[path] = protocol.ViewedHasChanged
		default:
			res.Files[path] = protocol.ViewedUnviewed
		}
	}
	for _, path := range changed {
		if res.Files[path] == protocol.ViewedViewed {
			res.Files[path] = protocol.ViewedHasChanged
		}
	}
	return res
}

// apiViewedGet answers GET /-/sync/api/issues/{id}/viewed[?head=].
func apiViewedGet(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, "")
	if a == nil {
		return
	}
	issue, ok := a.viewedPull()
	if !ok {
		return
	}
	pull := issue.PullRequest
	state, err := pull_model.GetNewestReviewState(a.ctx, a.viewer.ID, pull.ID)
	if err != nil {
		a.internal("load the review state", err)
		return
	}
	var changed []string
	if head := req.URL.Query().Get("head"); head != "" && state != nil && head != state.CommitSHA {
		if !validSHA(issue.Repo, head) {
			a.error(http.StatusBadRequest, "head must be a full commit SHA")
			return
		}
		gitRepo, err := gitrepo.OpenRepository(a.ctx, issue.Repo)
		if err != nil {
			a.internal("open the repository", err)
			return
		}
		defer gitRepo.Close()
		// As SyncAndGetUserSpecificDiff: a commit that is gone (force
		// push, gc) means "nothing known to have changed".
		if changed, err = gitRepo.GetFilesChangedBetween(state.CommitSHA, head); err != nil {
			log.Debug("livesync: files changed between %s and %s in %s: %v", state.CommitSHA, head, issue.Repo.FullName(), err)
			changed = nil
		}
	}
	a.json(http.StatusOK, viewedFiles(pull.ID, state, changed))
}

// apiViewedPut answers PUT /-/sync/api/issues/{id}/viewed.
func apiViewedPut(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, viewedWriteScope)
	if a == nil {
		return
	}
	issue, ok := a.viewedPull()
	if !ok {
		return
	}
	if issue.Repo.IsArchived {
		a.error(http.StatusForbidden, "the repository is archived")
		return
	}
	var body protocol.APIViewedUpdate
	if !a.decode(&body) {
		return
	}
	pull := issue.PullRequest
	commit := body.CommitSHA
	if commit == "" {
		commit = pull.HeadCommitID
	}
	if !validSHA(issue.Repo, commit) {
		a.error(http.StatusBadRequest, "commit_sha must be a full commit SHA")
		return
	}
	files := make(map[string]pull_model.ViewedState, len(body.Files))
	for path, viewed := range body.Files {
		if path == "" {
			a.error(http.StatusBadRequest, "file paths must not be empty")
			return
		}
		files[path] = pull_model.Unviewed
		if viewed {
			files[path] = pull_model.Viewed
		}
	}
	if err := pull_model.UpdateReviewState(a.ctx, a.viewer.ID, pull.ID, commit, files); err != nil {
		a.internal("update the review state", err)
		return
	}
	state, _, err := pull_model.GetReviewState(a.ctx, a.viewer.ID, pull.ID, commit)
	if err != nil {
		a.internal("load the review state", err)
		return
	}
	a.json(http.StatusOK, viewedFiles(pull.ID, state, nil))
}
