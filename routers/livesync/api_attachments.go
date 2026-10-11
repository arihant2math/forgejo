// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strconv"

	issues_model "forgejo.org/models/issues"
	access_model "forgejo.org/models/perm/access"
	quota_model "forgejo.org/models/quota"
	repo_model "forgejo.org/models/repo"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/setting"
	attachment_service "forgejo.org/services/attachment"
	"forgejo.org/services/context/upload"
	"forgejo.org/services/livesync/protocol"
)

// Uploads are online-only; text writes claim the resulting UUIDs atomically via LinkMarkdownAttachments.
func apiAttachmentUpload(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, bodyWriteScope)
	if a == nil {
		return
	}
	if !setting.Attachment.Enabled {
		a.error(http.StatusNotFound, "attachments are disabled on this instance")
		return
	}
	id, ok := a.id("id")
	if !ok {
		return
	}
	repo, p, ok := a.repoPermission(id)
	if !ok {
		return
	}
	var issue *issues_model.Issue
	if raw := req.URL.Query().Get("issue_id"); raw != "" {
		issueID, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || issueID <= 0 {
			a.error(http.StatusBadRequest, "invalid issue_id")
			return
		}
		issue, err = issues_model.GetIssueByID(a.ctx, issueID)
		if err != nil || issue.RepoID != id {
			a.notFound()
			return
		}
	}
	blockedBy := []int64{repo.OwnerID}
	if issue != nil {
		blockedBy = append(blockedBy, issue.PosterID)
	}
	if !attachmentPermission(p, repo.IsArchived, issue) || user_model.IsBlockedMultiple(a.ctx, blockedBy, a.viewer.ID) {
		a.forbidden()
		return
	}
	if req.Method == http.MethodGet {
		a.json(http.StatusOK, protocol.APIAttachmentPermission{Allowed: true})
		return
	}
	allowed, err := quota_model.EvaluateForUser(a.ctx, repo.OwnerID, quota_model.LimitSubjectSizeAssetsAttachmentsIssues)
	if err != nil {
		a.internal("check attachment quota", err)
		return
	}
	if !allowed {
		a.error(http.StatusRequestEntityTooLarge, "attachment storage quota exceeded")
		return
	}
	a.receiveAttachment(id, attachment_service.UploadAttachment)
}

func attachmentPermission(p access_model.Permission, archived bool, issue *issues_model.Issue) bool {
	if archived {
		return false
	}
	if issue != nil {
		return p.CanReadIssuesOrPulls(issue.IsPull) && (!issue.IsLocked || p.CanWriteIssuesOrPulls(issue.IsPull))
	}
	return p.CanReadIssuesOrPulls(false) || p.CanReadIssuesOrPulls(true)
}

type attachmentStore func(context.Context, io.Reader, string, int64, *repo_model.Attachment) (*repo_model.Attachment, error)

func (a *apiRequest) receiveAttachment(repoID int64, store attachmentStore) {
	maxSize := setting.Attachment.MaxSize << 20
	a.req.Body = http.MaxBytesReader(a.w, a.req.Body, maxSize+(64<<10))
	if err := a.req.ParseMultipartForm(1 << 20); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			a.error(http.StatusRequestEntityTooLarge, "attachment exceeds the maximum upload size")
		} else {
			a.error(http.StatusBadRequest, "expected a multipart attachment upload")
		}
		if a.req.MultipartForm != nil {
			_ = a.req.MultipartForm.RemoveAll()
		}
		return
	}
	defer a.req.MultipartForm.RemoveAll()
	file, header, err := a.req.FormFile("attachment")
	if err != nil {
		a.error(http.StatusBadRequest, "choose a file to attach")
		return
	}
	defer file.Close()
	if header.Size > maxSize {
		a.error(http.StatusRequestEntityTooLarge, fmt.Sprintf("attachment exceeds the maximum size of %d MiB", setting.Attachment.MaxSize))
		return
	}
	attach, err := store(a.ctx, file, setting.Attachment.AllowedTypes, header.Size, &repo_model.Attachment{RepoID: repoID, UploaderID: a.viewer.ID, Name: filepath.Base(header.Filename)})
	if err != nil {
		if upload.IsErrFileTypeForbidden(err) {
			a.error(http.StatusBadRequest, err.Error())
		} else {
			a.internal("upload attachment", err)
		}
		return
	}
	a.json(http.StatusCreated, protocol.APIUploadedAttachment{UUID: attach.UUID, URL: attach.DownloadURL()})
}
