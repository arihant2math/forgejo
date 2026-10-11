// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package repo

import (
	"context"
	"regexp"
	"strings"

	"forgejo.org/models/db"
	"forgejo.org/modules/setting"
)

// AttachmentReferences finds local attachment URLs, including installations below a sub-path.
func AttachmentReferences(content string) []string {
	if !strings.Contains(content, "/attachments/") {
		return nil
	}
	prefix := regexp.QuoteMeta(setting.AppSubURL + "/attachments/")
	absolute := regexp.QuoteMeta(strings.TrimRight(setting.AppURL, "/") + "/attachments/")
	pattern := regexp.MustCompile(`(?:^|[\s(<"'])(?:` + absolute + `|` + prefix + `)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[)\s>"?#]|$)`)
	var ids []string
	seen := map[string]bool{}
	for _, match := range pattern.FindAllStringSubmatch(content, -1) {
		if !seen[match[1]] {
			ids = append(ids, match[1])
			seen[match[1]] = true
		}
	}
	return ids
}

// LinkMarkdownAttachments claims only the author's still-unattached uploads in this repository.
// Run inside the text write's transaction so retries cannot publish text without its assets.
func LinkMarkdownAttachments(ctx context.Context, repoID, uploaderID, issueID, commentID int64, content string) error {
	ids := AttachmentReferences(content)
	if len(ids) == 0 {
		return nil
	}
	_, err := db.GetEngine(ctx).Where("repo_id = ? AND uploader_id = ? AND issue_id = 0 AND comment_id = 0 AND release_id = 0", repoID, uploaderID).
		In("uuid", ids).Cols("issue_id", "comment_id").Update(&Attachment{IssueID: issueID, CommentID: commentID})
	return err
}
