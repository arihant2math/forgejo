// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"net/http"
	"net/url"
	"testing"

	"forgejo.org/models/unittest"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/setting"
	api "forgejo.org/modules/structs"
	"forgejo.org/services/livesync/protocol"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The settings pages' gap endpoints (services/livesync/protocol/user.go):
// the appearance choices, and making an email address primary.
func TestLivesyncUserSettings(t *testing.T) {
	livesyncSkipSQLite(t)
	livesyncServe(t)
	onApplicationRun(t, func(t *testing.T, _ *url.URL) {
		livesyncWaitBackfill(t)
		livesyncSettle(t)
		all2 := livesyncToken(t, &user_model.User{ID: 2})
		read2 := livesyncReadToken(t, 2)

		// The choices: the instance's themes in their order, its languages.
		resp := MakeRequest(t, livesyncAPI(t, "GET", "/user/options", read2, nil), http.StatusOK)
		var opts protocol.APIUserOptions
		DecodeJSON(t, resp, &opts)
		themes := make([]string, 0, len(opts.Themes))
		for _, th := range opts.Themes {
			themes = append(themes, th.ID)
			assert.NotEmpty(t, th.Name)
		}
		assert.Equal(t, setting.UI.Themes, themes)
		assert.Equal(t, setting.UI.DefaultTheme, opts.DefaultTheme)
		require.NotEmpty(t, opts.Languages)
		assert.Contains(t, opts.Languages, protocol.APIOption{ID: "en-US", Name: "English"})
		MakeRequest(t, livesyncAPI(t, "GET", "/user/options", "", nil), http.StatusUnauthorized)

		// Primary: the write scope, the viewer's own verified address.
		primary := func(token, email string, status int) {
			t.Helper()
			MakeRequest(t, livesyncAPI(t, "PUT", "/user/emails/primary", token, protocol.APIPrimaryEmail{Email: email}), status)
		}
		primary(read2, "user2@example.com", http.StatusForbidden)
		primary(all2, "user2-2@example.com", http.StatusUnprocessableEntity) // not verified (fixture)
		primary(all2, "user1@example.com", http.StatusNotFound)              // someone else's
		primary(all2, "nobody@example.com", http.StatusNotFound)
		primary(all2, "user2@example.com", http.StatusNoContent) // already primary
		MakeRequest(t, livesyncAPI(t, "PUT", "/user/emails/primary", all2, map[string]string{}), http.StatusBadRequest)

		req := NewRequestWithJSON(t, "POST", "/api/v1/user/emails", api.CreateEmailOption{Emails: []string{"user2-next@example.com"}}).AddTokenAuth(all2)
		MakeRequest(t, req, http.StatusCreated)
		primary(all2, "User2-Next@example.com", http.StatusNoContent)
		u := unittest.AssertExistsAndLoadBean(t, &user_model.User{ID: 2})
		assert.Equal(t, "user2-next@example.com", u.Email)
		e := unittest.AssertExistsAndLoadBean(t, &user_model.EmailAddress{LowerEmail: "user2@example.com"})
		assert.False(t, e.IsPrimary)

		// Back as it was.
		primary(all2, "user2@example.com", http.StatusNoContent)
		req = NewRequestWithJSON(t, "DELETE", "/api/v1/user/emails", api.DeleteEmailOption{Emails: []string{"user2-next@example.com"}}).AddTokenAuth(all2)
		MakeRequest(t, req, http.StatusNoContent)
		assert.Equal(t, "user2@example.com", unittest.AssertExistsAndLoadBean(t, &user_model.User{ID: 2}).Email)
	})
}
