// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"net/http"

	auth_model "forgejo.org/models/auth"
	issues_model "forgejo.org/models/issues"
	access_model "forgejo.org/models/perm/access"
	actions_service "forgejo.org/services/actions"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/services/livesync/pullmerge"
)

// A pull request's merge box (protocol/api_merge.go): what the classic
// page computes for its viewer, without the admin-only protection rules of
// API v1, and the decision on runs that wait for a maintainer's approval
// (the classic page's trust panel, POST /{owner}/{repo}/pulls/{index}/action-user-trust).

// Deciding on runs is repository work, like API v1's run routes.
const actionTrustWriteScope = auth_model.AccessTokenScopeWriteRepository

// mergePull loads the pull request of the issue {id} and the viewer's
// permission in its repository (404 unless it is a pull request the viewer
// may read).
func (a *apiRequest) mergePull() (*issues_model.PullRequest, access_model.Permission, bool) {
	id, ok := a.id("id")
	if !ok {
		return nil, access_model.Permission{}, false
	}
	issue, err := issues_model.GetIssueByID(a.ctx, id)
	if err != nil {
		if issues_model.IsErrIssueNotExist(err) {
			a.notFound()
		} else {
			a.internal("load the issue", err)
		}
		return nil, access_model.Permission{}, false
	}
	repo, perm, ok := a.repoPermission(issue.RepoID)
	if !ok {
		return nil, access_model.Permission{}, false
	}
	issue.Repo = repo
	if !issue.IsPull || !canReadIssue(perm, issue) {
		a.notFound()
		return nil, access_model.Permission{}, false
	}
	if err := issue.LoadPullRequest(a.ctx); err != nil {
		a.internal("load the pull request", err)
		return nil, access_model.Permission{}, false
	}
	pr := issue.PullRequest
	pr.Issue = issue
	pr.BaseRepo = repo
	return pr, perm, true
}

// apiMergeCheck answers GET /-/sync/api/issues/{id}/merge-check.
func apiMergeCheck(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, "")
	if a == nil {
		return
	}
	pr, perm, ok := a.mergePull()
	if !ok {
		return
	}
	res, err := pullmerge.Check(a.ctx, pr, a.viewer, perm)
	if err != nil {
		a.internal("merge check", err)
		return
	}
	a.w.Header().Set("Cache-Control", "no-store")
	a.json(http.StatusOK, res)
}

// apiActionTrust answers POST /-/sync/api/issues/{id}/action-trust.
func apiActionTrust(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, actionTrustWriteScope)
	if a == nil {
		return
	}
	pr, perm, ok := a.mergePull()
	if !ok {
		return
	}
	if !pullmerge.ActionsReadable(perm) {
		a.notFound()
		return
	}
	if !pullmerge.CanDecide(pr, a.viewer, perm) {
		a.forbidden()
		return
	}
	var body protocol.APIActionTrust
	if !a.decode(&body) {
		return
	}
	trust, ok := pullmerge.Trusts[body.Trust]
	if !ok {
		a.error(http.StatusBadRequest, `trust must be "once", "always", "deny" or "revoke"`)
		return
	}
	if err := actions_service.UpdateTrustedWithPullRequest(a.ctx, a.viewer.ID, pr, trust); err != nil {
		a.internal("update the trust", err)
		return
	}
	a.noContent()
}
