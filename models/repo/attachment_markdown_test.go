// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package repo_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"forgejo.org/models/db"
	repo_model "forgejo.org/models/repo"
	"forgejo.org/models/unittest"
	"forgejo.org/modules/setting"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAttachmentReferences(t *testing.T) {
	oldURL, oldSub := setting.AppURL, setting.AppSubURL
	t.Cleanup(func() { setting.AppURL, setting.AppSubURL = oldURL, oldSub })
	setting.AppURL, setting.AppSubURL = "https://forgejo.example/sub/", "/sub"
	uuid := "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a19"
	text := "![image](https://forgejo.example/sub/attachments/" + uuid + ") [file](/sub/attachments/" + uuid + ")"
	assert.Equal(t, []string{uuid}, repo_model.AttachmentReferences(text))
	assert.Empty(t, repo_model.AttachmentReferences("/sub/attachments/"+uuid+"a"))
	assert.Empty(t, repo_model.AttachmentReferences("/attachments/"+uuid))
	assert.Empty(t, repo_model.AttachmentReferences("![image](https://other.example/sub/attachments/"+uuid+")"))
}

func TestLinkMarkdownAttachments(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	ctx := db.DefaultContext
	var uploads []*repo_model.Attachment
	for n := range 5 {
		a := &repo_model.Attachment{UUID: fmt.Sprintf("11111111-1111-1111-1111-%012d", n), Name: "image.png", RepoID: 1, UploaderID: 2}
		if n == 1 {
			a.UploaderID = 3
		}
		if n == 2 {
			a.RepoID = 2
		}
		if n == 3 {
			a.IssueID = 4
		}
		if n == 4 {
			a.ReleaseID = 1
		}
		require.NoError(t, db.Insert(ctx, a))
		uploads = append(uploads, a)
	}
	text := ""
	for _, a := range uploads {
		text += "![image](" + a.DownloadURL() + ")\n"
	}
	rollback := errors.New("rollback")
	err := db.WithTx(ctx, func(ctx context.Context) error {
		require.NoError(t, repo_model.LinkMarkdownAttachments(ctx, 1, 2, 1, 2, text))
		return rollback
	})
	require.ErrorIs(t, err, rollback)
	a, err := repo_model.GetAttachmentByUUID(ctx, uploads[0].UUID)
	require.NoError(t, err)
	assert.Zero(t, a.IssueID, "rolled back with the text write")
	require.NoError(t, repo_model.LinkMarkdownAttachments(ctx, 1, 2, 1, 2, text))
	require.NoError(t, repo_model.LinkMarkdownAttachments(ctx, 1, 2, 1, 2, text), "retry is harmless")
	for n, before := range uploads {
		after, err := repo_model.GetAttachmentByUUID(ctx, before.UUID)
		require.NoError(t, err)
		if n == 0 {
			assert.Equal(t, int64(1), after.IssueID)
			assert.Equal(t, int64(2), after.CommentID)
		} else {
			assert.Equal(t, before.IssueID, after.IssueID)
			assert.Equal(t, before.CommentID, after.CommentID)
			assert.Equal(t, before.ReleaseID, after.ReleaseID)
		}
	}
}
