// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package auth

import (
	"net/http"
	"net/url"
	"testing"

	auth_model "forgejo.org/models/auth"
	"forgejo.org/models/unittest"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/test"
	"forgejo.org/modules/web"
	app_context "forgejo.org/services/context"
	"forgejo.org/services/contexttest"
	"forgejo.org/services/forms"
	"forgejo.org/services/livesync/oauthapp"

	"code.forgejo.org/go-chi/session"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// memorySession is the part of a session AuthorizeOAuth uses.
type memorySession struct {
	session.Store
	values map[any]any
}

func (s *memorySession) Set(k, v any) error { s.values[k] = v; return nil }
func (s *memorySession) Get(k any) any      { return s.values[k] }
func (s *memorySession) Delete(k any) error { delete(s.values, k); return nil }
func (s *memorySession) Release() error     { return nil }

// The site's own Forgejo Next UI signs in without the consent page; every other
// authorization (another client, scope or redirect URI) still asks.
func TestAuthorizeOAuthNextUI(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	defer test.MockVariableValue(&setting.AppURL, "https://code.example/")()
	callback := setting.AppURL + oauthapp.CallbackPath
	dev := "http://127.0.0.1/-/next/callback"
	next, err := auth_model.CreateOAuth2Application(t.Context(), auth_model.CreateOAuth2ApplicationOptions{
		Name: oauthapp.Name, RedirectURIs: []string{callback, dev},
	})
	require.NoError(t, err)
	provisioned := &oauthapp.App{ClientID: next.ClientID, RedirectURI: callback, Scope: oauthapp.Scope}
	defer test.MockVariableValue(&nextUIApp, func() *oauthapp.App { return provisioned })()

	type result struct {
		code     int
		location string
		consent  bool
	}
	authorize := func(t *testing.T, userID int64, form forms.AuthorizationForm) result {
		t.Helper()
		ctx, resp := contexttest.MockContext(t, "login/oauth/authorize")
		ctx.AppendContextValue(app_context.WebContextKey, ctx)
		ctx.Session = &memorySession{values: map[any]any{}}
		contexttest.LoadUser(t, ctx, userID)
		web.SetForm(ctx, &form)
		AuthorizeOAuth(ctx)
		_, consent := ctx.Data["Application"]
		return result{resp.Code, resp.Header().Get("Location"), consent}
	}
	form := func(edit func(*forms.AuthorizationForm)) forms.AuthorizationForm {
		f := forms.AuthorizationForm{
			ResponseType: "code", ClientID: next.ClientID, RedirectURI: callback, State: "st8", Scope: oauthapp.Scope,
			CodeChallengeMethod: "S256", CodeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		}
		if edit != nil {
			edit(&f)
		}
		return f
	}
	signedIn := func(t *testing.T, r result) {
		t.Helper()
		assert.False(t, r.consent, "no consent page")
		assert.Equal(t, http.StatusSeeOther, r.code)
		to, err := url.Parse(r.location)
		require.NoError(t, err)
		assert.Equal(t, callback, to.Scheme+"://"+to.Host+to.Path)
		assert.Equal(t, "st8", to.Query().Get("state"))
		assert.NotEmpty(t, to.Query().Get("code"))
	}
	asks := func(t *testing.T, r result) {
		t.Helper()
		assert.True(t, r.consent, "the consent page")
		assert.Equal(t, http.StatusOK, r.code)
		assert.Empty(t, r.location)
	}

	t.Run("first sign-in", func(t *testing.T) {
		grant, err := next.GetGrantByUserID(t.Context(), 4)
		require.NoError(t, err)
		require.Nil(t, grant)
		signedIn(t, authorize(t, 4, form(nil)))
		grant, err = next.GetGrantByUserID(t.Context(), 4)
		require.NoError(t, err)
		require.NotNil(t, grant)
		assert.Equal(t, oauthapp.Scope, grant.Scope)
	})
	t.Run("again", func(t *testing.T) {
		signedIn(t, authorize(t, 4, form(nil)))
	})
	t.Run("another scope", func(t *testing.T) {
		asks(t, authorize(t, 5, form(func(f *forms.AuthorizationForm) { f.Scope = "write:admin" })))
	})
	t.Run("a grant with another scope", func(t *testing.T) {
		_, err := next.CreateGrant(t.Context(), 8, "read:user")
		require.NoError(t, err)
		asks(t, authorize(t, 8, form(nil)))
	})
	t.Run("a development server's redirect URI", func(t *testing.T) {
		asks(t, authorize(t, 5, form(func(f *forms.AuthorizationForm) { f.RedirectURI = dev })))
	})
	t.Run("plain PKCE", func(t *testing.T) {
		asks(t, authorize(t, 5, form(func(f *forms.AuthorizationForm) { f.CodeChallengeMethod = "plain" })))
	})
	t.Run("a third-party public client", func(t *testing.T) {
		// oauth2_application fixture 2: user2's public "Test native app".
		asks(t, authorize(t, 5, form(func(f *forms.AuthorizationForm) {
			f.ClientID = "ce5a1322-42a7-11ed-b878-0242ac120002"
			f.RedirectURI = "b"
		})))
	})
	t.Run("livesync not running", func(t *testing.T) {
		defer test.MockVariableValue(&nextUIApp, func() *oauthapp.App { return nil })()
		asks(t, authorize(t, 4, form(nil)))
	})
}
