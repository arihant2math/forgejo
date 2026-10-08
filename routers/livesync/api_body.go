// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"errors"
	"net/http"

	auth_model "forgejo.org/models/auth"
	issues_model "forgejo.org/models/issues"
	access_model "forgejo.org/models/perm/access"
	issue_service "forgejo.org/services/issue"
	"forgejo.org/services/livesync/protocol"
	pull_service "forgejo.org/services/pull"
)

// Conflict-checked body edits (protocol/api.go): issue_service.ChangeContent
// and issue_service.UpdateComment with the client's expected
// content_version, which API v1 does not pass on (it reads the current
// one, i.e. silently overwrites). Permission checks as the classic
// UpdateIssueContent / UpdateCommentContent (routers/web/repo/issue.go).

const bodyWriteScope = auth_model.AccessTokenScopeWriteIssue

// bodyIssue loads an issue and the viewer's permission in its repository
// for a body edit: 404 unless the viewer may read it (the issues or pull
// requests unit, checkIssueRights), 403 unless they posted it (poster) or
// write the unit, or when the repository is archived.
func (a *apiRequest) bodyIssue(issueID, posterID int64) (*issues_model.Issue, bool) {
	issue, err := issues_model.GetIssueByID(a.ctx, issueID)
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
	if !canReadIssue(perm, issue) {
		a.notFound()
		return nil, false
	}
	if posterID < 0 {
		posterID = issue.PosterID
	}
	if a.viewer.ID != posterID && !perm.CanWriteIssuesOrPulls(issue.IsPull) {
		a.forbidden()
		return nil, false
	}
	if repo.IsArchived {
		a.error(http.StatusForbidden, "the repository is archived")
		return nil, false
	}
	return issue, true
}

func canReadIssue(perm access_model.Permission, issue *issues_model.Issue) bool {
	return perm.CanReadIssuesOrPulls(issue.IsPull)
}

// apiIssueBody answers PATCH /-/sync/api/issues/{id}/body.
func apiIssueBody(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, bodyWriteScope)
	if a == nil {
		return
	}
	id, ok := a.id("id")
	if !ok {
		return
	}
	issue, ok := a.bodyIssue(id, -1)
	if !ok {
		return
	}
	var body protocol.APIBodyEdit
	if !a.decode(&body) {
		return
	}
	err := issue_service.ChangeContent(a.ctx, issue, a.viewer, body.Body, body.ExpectedVersion)
	if errors.Is(err, issues_model.ErrIssueAlreadyChanged) {
		current, err := issues_model.GetIssueByID(a.ctx, id)
		if err != nil {
			a.internal("reload the issue", err)
			return
		}
		a.json(http.StatusConflict, protocol.APIBodyConflict{
			Message: "the body was changed since expected_version", Body: current.Content, ContentVersion: current.ContentVersion,
		})
		return
	}
	if err != nil {
		a.internal("change the issue's body", err)
		return
	}
	a.json(http.StatusOK, protocol.APIBodyEdited{ContentVersion: issue.ContentVersion})
}

// apiCommentBody answers PATCH /-/sync/api/comments/{id}/body.
func apiCommentBody(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, bodyWriteScope)
	if a == nil {
		return
	}
	id, ok := a.id("id")
	if !ok {
		return
	}
	comment, err := issues_model.GetCommentByID(a.ctx, id)
	if err != nil {
		if issues_model.IsErrCommentNotExist(err) {
			a.notFound()
		} else {
			a.internal("load the comment", err)
		}
		return
	}
	issue, ok := a.bodyIssue(comment.IssueID, comment.PosterID)
	if !ok {
		return
	}
	comment.Issue = issue
	if err := comment.LoadReview(a.ctx); err != nil {
		a.internal("load the comment's review", err)
		return
	}
	if comment.Review != nil && comment.Review.Type == issues_model.ReviewTypePending && comment.PosterID != a.viewer.ID {
		// Another user's draft: not readable (the classic UI shows a
		// pending review to its author only).
		a.notFound()
		return
	}
	if !comment.Type.HasContentSupport() {
		a.error(http.StatusUnprocessableEntity, "this comment has no editable content")
		return
	}
	var body protocol.APIBodyEdit
	if !a.decode(&body) {
		return
	}
	if comment.Type == issues_model.CommentTypeCode {
		if err := pull_service.ValidateCodeCommentSuggestions(body.Body); err != nil {
			if errors.Is(err, pull_service.ErrMultipleSuggestions) {
				a.error(http.StatusUnprocessableEntity, "a code comment may carry at most one suggestion")
			} else {
				a.internal("validate the suggestions", err)
			}
			return
		}
	}
	oldContent := comment.Content
	comment.Content = body.Body
	err = issue_service.UpdateComment(a.ctx, comment, body.ExpectedVersion, a.viewer, oldContent)
	if errors.Is(err, issues_model.ErrCommentAlreadyChanged) {
		current, err := issues_model.GetCommentByID(a.ctx, id)
		if err != nil {
			a.internal("reload the comment", err)
			return
		}
		a.json(http.StatusConflict, protocol.APIBodyConflict{
			Message: "the body was changed since expected_version", Body: current.Content, ContentVersion: current.ContentVersion,
		})
		return
	}
	if err != nil {
		a.internal("change the comment's body", err)
		return
	}
	a.json(http.StatusOK, protocol.APIBodyEdited{ContentVersion: comment.ContentVersion})
}
