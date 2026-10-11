// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"bytes"
	"context"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	issues_model "forgejo.org/models/issues"
	perm_model "forgejo.org/models/perm"
	access_model "forgejo.org/models/perm/access"
	repo_model "forgejo.org/models/repo"
	unit_model "forgejo.org/models/unit"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/setting"
	"forgejo.org/services/context/upload"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAttachmentPermission(t *testing.T) {
	reader := access_model.Permission{AccessMode: perm_model.AccessModeRead, Units: []*repo_model.RepoUnit{{Type: unit_model.TypeIssues}}}
	writer := access_model.Permission{AccessMode: perm_model.AccessModeWrite, Units: reader.Units}
	assert.True(t, attachmentPermission(reader, false, nil))
	assert.False(t, attachmentPermission(reader, true, nil))
	assert.False(t, attachmentPermission(access_model.Permission{}, false, nil))
	assert.True(t, attachmentPermission(reader, false, &issues_model.Issue{}))
	assert.False(t, attachmentPermission(reader, false, &issues_model.Issue{IsPull: true}))
	assert.False(t, attachmentPermission(reader, false, &issues_model.Issue{IsLocked: true}))
	assert.True(t, attachmentPermission(writer, false, &issues_model.Issue{IsLocked: true}))
}

func TestReceiveAttachment(t *testing.T) {
	previous := setting.Attachment
	t.Cleanup(func() { setting.Attachment = previous })
	setting.Attachment.MaxSize = 1
	setting.Attachment.AllowedTypes = ".png"
	for _, tc := range []struct {
		name      string
		size      int
		forbidden bool
		status    int
	}{
		{"ok", 8, false, http.StatusCreated},
		{"too large", (1 << 20) + 1, false, http.StatusRequestEntityTooLarge},
		{"body too large", 2 << 20, false, http.StatusRequestEntityTooLarge},
		{"forbidden type", 8, true, http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var body bytes.Buffer
			form := multipart.NewWriter(&body)
			part, err := form.CreateFormFile("attachment", "image.png")
			require.NoError(t, err)
			_, err = io.Copy(part, strings.NewReader(strings.Repeat("x", tc.size)))
			require.NoError(t, err)
			require.NoError(t, form.Close())
			req := httptest.NewRequest(http.MethodPost, "/-/sync/api/repos/1/attachments", &body)
			req.Header.Set("Content-Type", form.FormDataContentType())
			rec := httptest.NewRecorder()
			a := &apiRequest{w: rec, req: req, ctx: req.Context(), viewer: &user_model.User{ID: 7}}
			called := false
			a.receiveAttachment(1, func(ctx context.Context, reader io.Reader, types string, size int64, attach *repo_model.Attachment) (*repo_model.Attachment, error) {
				called = true
				assert.Equal(t, int64(1), attach.RepoID)
				assert.Equal(t, int64(7), attach.UploaderID)
				assert.Equal(t, "image.png", attach.Name)
				assert.Equal(t, ".png", types)
				assert.Equal(t, int64(tc.size), size)
				if tc.forbidden {
					return nil, upload.ErrFileTypeForbidden{}
				}
				attach.UUID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a19"
				return attach, nil
			})
			assert.Equal(t, tc.status, rec.Code, rec.Body.String())
			assert.Equal(t, tc.status != http.StatusRequestEntityTooLarge, called)
			if tc.status == http.StatusCreated {
				assert.Contains(t, rec.Body.String(), "attachments/a0eebc99")
			}
		})
	}
}
