// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package issues_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"forgejo.org/models/db"
	issues_model "forgejo.org/models/issues"
	repo_model "forgejo.org/models/repo"
	"forgejo.org/models/unittest"
	user_model "forgejo.org/models/user"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMarkdownAttachmentLifecycle(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	rollback := errors.New("rollback")
	err := db.WithTx(db.DefaultContext, func(ctx context.Context) error {
		repo := unittest.AssertExistsAndLoadBean(t, &repo_model.Repository{ID: 1})
		user := unittest.AssertExistsAndLoadBean(t, &user_model.User{ID: 2})
		sequence := 0
		upload := func() (*repo_model.Attachment, string) {
			sequence++
			a := &repo_model.Attachment{UUID: fmt.Sprintf("22222222-2222-2222-2222-%012d", sequence), Name: "image.png", RepoID: repo.ID, UploaderID: user.ID}
			require.NoError(t, db.Insert(ctx, a))
			return a, "![image](" + a.DownloadURL() + ")"
		}
		check := func(a *repo_model.Attachment, issueID, commentID int64) {
			got, err := repo_model.GetAttachmentByUUID(ctx, a.UUID)
			require.NoError(t, err)
			assert.Equal(t, issueID, got.IssueID)
			assert.Equal(t, commentID, got.CommentID)
		}
		a, text := upload()
		issue := &issues_model.Issue{RepoID: repo.ID, PosterID: user.ID, Poster: user, Title: "Attachments", Content: text}
		require.NoError(t, issues_model.NewIssue(ctx, repo, issue, nil, nil))
		check(a, issue.ID, 0)
		edit, editText := upload()
		require.NoError(t, issues_model.ChangeIssueContent(ctx, issue, user, text+"\n"+editText, issue.ContentVersion))
		check(edit, issue.ID, 0)
		for _, kind := range []issues_model.CommentType{issues_model.CommentTypeComment, issues_model.CommentTypeCode, issues_model.CommentTypeReview} {
			a, text := upload()
			c, err := issues_model.CreateComment(ctx, &issues_model.CreateCommentOptions{Type: kind, Doer: user, Repo: repo, Issue: issue, Content: text})
			require.NoError(t, err)
			check(a, issue.ID, c.ID)
			edit, editText := upload()
			c.Content = text + "\n" + editText
			require.NoError(t, issues_model.UpdateComment(ctx, c, c.ContentVersion, user))
			check(edit, issue.ID, c.ID)
		}
		return rollback
	})
	require.ErrorIs(t, err, rollback)
}
