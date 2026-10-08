// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	auth_model "forgejo.org/models/auth"
	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/json"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/test"
	livesync_service "forgejo.org/services/livesync"
	"forgejo.org/services/livesync/oauthapp"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/tests"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type livesyncTokens struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
}

// livesyncPKCE runs the Next UI's sign-in as a browser would: the classic
// consent page, then the code exchange with the PKCE verifier (no secret).
func livesyncPKCE(t *testing.T, user string, app *oauthapp.App) livesyncTokens {
	t.Helper()
	raw := make([]byte, 32)
	_, _ = rand.Read(raw)
	verifier := base64.RawURLEncoding.EncodeToString(raw)
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	session := loginUser(t, user)
	authorize := "/login/oauth/authorize?" + url.Values{
		"client_id": {app.ClientID}, "redirect_uri": {app.RedirectURI}, "response_type": {"code"},
		"code_challenge": {challenge}, "code_challenge_method": {"S256"}, "state": {"st8"}, "scope": {app.Scope},
	}.Encode()
	// A public client always gets the consent page (RFC 6749 §10.2).
	resp := session.MakeRequest(t, NewRequest(t, "GET", authorize), http.StatusOK)
	NewHTMLParser(t, resp.Body).AssertElement(t, "#authorize-app", true)
	resp = session.MakeRequest(t, NewRequestWithValues(t, "POST", "/login/oauth/grant", map[string]string{
		"client_id": app.ClientID, "redirect_uri": app.RedirectURI, "state": "st8", "scope": app.Scope, "granted": "true",
	}), http.StatusSeeOther)
	location, err := url.Parse(test.RedirectURL(resp))
	require.NoError(t, err)
	assert.Equal(t, app.RedirectURI, location.Scheme+"://"+location.Host+location.Path)
	assert.Equal(t, "st8", location.Query().Get("state"))
	code := location.Query().Get("code")
	require.NotEmpty(t, code)

	resp = MakeRequest(t, NewRequestWithValues(t, "POST", "/login/oauth/access_token", map[string]string{
		"grant_type": "authorization_code", "client_id": app.ClientID, "redirect_uri": app.RedirectURI,
		"code": code, "code_verifier": verifier,
	}), http.StatusOK)
	var tokens livesyncTokens
	require.NoError(t, json.Unmarshal(resp.Body.Bytes(), &tokens))
	require.NotEmpty(t, tokens.AccessToken)
	require.NotEmpty(t, tokens.RefreshToken)
	return tokens
}

// The Next UI's OAuth2 client: provisioned once (idempotent across
// restarts, repaired when edited or deleted), a public client whose PKCE
// sign-in yields a token that works for API v1 and for a sync session, with
// the scope it asked for whatever ENABLE_ADDITIONAL_GRANT_SCOPES says.
func TestLivesyncOAuth(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncServe(t)
	ctx := t.Context()

	app := livesync_service.OAuthApp()
	require.NotNil(t, app)
	assert.Equal(t, setting.AppURL+"-/next/callback", app.RedirectURI)
	assert.Equal(t, oauthapp.Scope, app.Scope)
	stored, err := auth_model.GetOAuth2ApplicationByClientID(ctx, app.ClientID)
	require.NoError(t, err)
	assert.Equal(t, oauthapp.Name, stored.Name)
	assert.Zero(t, stored.UID, "an instance-wide application")
	assert.False(t, stored.ConfidentialClient, "a public client: PKCE, no secret")
	assert.Equal(t, []string{app.RedirectURI}, stored.RedirectURIs)
	count := func() int64 {
		n, err := db.GetEngine(ctx).Where("name = ? AND uid = 0", oauthapp.Name).Count(&auth_model.OAuth2Application{})
		require.NoError(t, err)
		return n
	}
	assert.EqualValues(t, 1, count())

	t.Run("idempotent", func(t *testing.T) {
		require.NoError(t, livesync_service.Init(ctx))
		require.NoError(t, livesync_service.Init(ctx))
		assert.Equal(t, app, livesync_service.OAuthApp(), "the same client after restarts")
		assert.EqualValues(t, 1, count())

		// An administrator edited it: put back as livesync needs it.
		_, err := auth_model.UpdateOAuth2Application(ctx, auth_model.UpdateOAuth2ApplicationOptions{
			ID: stored.ID, Name: "renamed", ConfidentialClient: true, RedirectURIs: []string{"https://elsewhere/"},
		})
		require.NoError(t, err)
		require.NoError(t, livesync_service.Init(ctx))
		again, err := auth_model.GetOAuth2ApplicationByClientID(ctx, app.ClientID)
		require.NoError(t, err)
		assert.Equal(t, oauthapp.Name, again.Name)
		assert.False(t, again.ConfidentialClient)
		assert.Equal(t, []string{app.RedirectURI}, again.RedirectURIs)

		// Extra redirect URIs (a development server). (Not livesyncConfig:
		// its cleanup would stop livesync at the end of this subtest.)
		key := setting.CfgProvider.Section("livesync").Key("OAUTH_REDIRECT_URIS")
		key.SetValue("http://127.0.0.1/-/next/callback")
		defer key.SetValue("")
		require.NoError(t, livesync_service.Init(ctx))
		again, err = auth_model.GetOAuth2ApplicationByClientID(ctx, app.ClientID)
		require.NoError(t, err)
		assert.Equal(t, []string{app.RedirectURI, "http://127.0.0.1/-/next/callback"}, again.RedirectURIs)
		assert.True(t, again.ContainsRedirectURI("http://127.0.0.1:5173/-/next/callback"), "any loopback port for a public client")
		key.SetValue("")
		require.NoError(t, livesync_service.Init(ctx))
		assert.EqualValues(t, 1, count())
	})

	for _, additional := range []bool{false, true} {
		t.Run(fmt.Sprintf("ENABLE_ADDITIONAL_GRANT_SCOPES=%v", additional), func(t *testing.T) {
			defer test.MockVariableValue(&setting.OAuth2.EnableAdditionalGrantScopes, additional)()
			app := livesync_service.OAuthApp()
			tokens := livesyncPKCE(t, "user2", app)

			// API v1 with the token: reads and writes within the scope...
			req := NewRequest(t, "GET", "/api/v1/user").AddTokenAuth(tokens.AccessToken)
			resp := MakeRequest(t, req, http.StatusOK)
			assert.Contains(t, resp.Body.String(), `"login":"user2"`)
			req = NewRequestWithJSON(t, "POST", "/api/v1/repos/user2/repo1/issues", map[string]string{"title": "from the Next UI"}).AddTokenAuth(tokens.AccessToken)
			MakeRequest(t, req, http.StatusCreated)
			// ...and the token's scope is the grant's, in both modes: no
			// package scope was asked for.
			req = NewRequest(t, "GET", "/api/v1/packages/user2").AddTokenAuth(tokens.AccessToken)
			MakeRequest(t, req, http.StatusForbidden)
			// The account and organizations are read-only to it (PLAN
			// §4.9): no SSH keys, OAuth2 applications or org hooks from a
			// token held by the browser.
			req = NewRequestWithJSON(t, "POST", "/api/v1/user/keys", map[string]string{"title": "next", "key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGs4GE3ZIPkDvJwOLkhw3Ms1CVTX4ALUj9e8pnGhGmXg"}).AddTokenAuth(tokens.AccessToken)
			MakeRequest(t, req, http.StatusForbidden)
			req = NewRequestWithJSON(t, "POST", "/api/v1/user/applications/oauth2", map[string]any{"name": "x", "redirect_uris": []string{"https://example.com/"}}).AddTokenAuth(tokens.AccessToken)
			MakeRequest(t, req, http.StatusForbidden)
			req = NewRequestWithJSON(t, "POST", "/api/v1/orgs/org3/hooks", map[string]any{"type": "forgejo", "config": map[string]string{"url": "https://example.com/", "content_type": "json"}}).AddTokenAuth(tokens.AccessToken)
			MakeRequest(t, req, http.StatusForbidden)
			req = NewRequest(t, "GET", "/api/v1/orgs/org3").AddTokenAuth(tokens.AccessToken)
			MakeRequest(t, req, http.StatusOK)

			// livesync accepts it (the hello uses the same check).
			req = NewRequest(t, "GET", "/-/sync/grants").AddTokenAuth(tokens.AccessToken)
			MakeRequest(t, req, http.StatusOK)

			// A sync session over a real listener.
			srv := httptest.NewServer(testWebRoutes)
			defer srv.Close()
			u, err := url.Parse(srv.URL)
			require.NoError(t, err)
			cl := livesyncDial(t, u, "ws")
			cl.send(livesyncHello(tokens.AccessToken, protocol.GroupRequest{Group: "repo:1"}))
			welcome := cl.waitType(protocol.MsgWelcome)
			assert.EqualValues(t, 2, welcome.ViewerID)
			assert.Equal(t, []string{"repo:1"}, livesyncGrantGroups(welcome.Granted))
			cl.close()

			// Refresh (no secret for a public client).
			resp = MakeRequest(t, NewRequestWithValues(t, "POST", "/login/oauth/access_token", map[string]string{
				"grant_type": "refresh_token", "client_id": app.ClientID, "refresh_token": tokens.RefreshToken,
			}), http.StatusOK)
			var refreshed livesyncTokens
			require.NoError(t, json.Unmarshal(resp.Body.Bytes(), &refreshed))
			MakeRequest(t, NewRequest(t, "GET", "/api/v1/user").AddTokenAuth(refreshed.AccessToken), http.StatusOK)

			// Without PKCE a public client is refused (upstream rule).
			session := loginUser(t, "user2")
			resp = session.MakeRequest(t, NewRequest(t, "GET", "/login/oauth/authorize?"+url.Values{
				"client_id": {app.ClientID}, "redirect_uri": {app.RedirectURI}, "response_type": {"code"}, "state": {"x"},
			}.Encode()), http.StatusSeeOther)
			assert.Contains(t, test.RedirectURL(resp), "PKCE+is+required+for+public+clients")

			// The grant keeps its scope: the next sign-in must ask for the same.
			grants, err := auth_model.GetOAuth2GrantsByUserID(ctx, 2)
			require.NoError(t, err)
			var scopes []string
			for _, g := range grants {
				if g.ApplicationID == stored.ID {
					scopes = append(scopes, g.Scope)
				}
			}
			assert.Equal(t, []string{oauthapp.Scope}, scopes)
		})
	}

	t.Run("scope change revokes grants", func(t *testing.T) {
		require.NoError(t, db.Insert(ctx, &auth_model.OAuth2Grant{ApplicationID: stored.ID, UserID: 4, Scope: "read:issue"}))
		require.NoError(t, livesync_model.SetMeta(ctx, oauthapp.MetaScope, "read:issue"))
		require.NoError(t, livesync_service.Init(ctx))
		var grants []auth_model.OAuth2Grant
		require.NoError(t, db.GetEngine(ctx).Where("application_id = ?", stored.ID).Find(&grants))
		for _, g := range grants {
			assert.Equal(t, oauthapp.Scope, g.Scope, "grants with an old scope are revoked (user %d)", g.UserID)
		}
		assert.NotEmpty(t, grants, "user2's current grant stays")
	})

	t.Run("deleted", func(t *testing.T) {
		_, err := db.GetEngine(ctx).ID(stored.ID).Delete(&auth_model.OAuth2Application{})
		require.NoError(t, err)
		require.NoError(t, livesync_service.Init(ctx))
		recreated := livesync_service.OAuthApp()
		require.NotNil(t, recreated)
		assert.NotEqual(t, app.ClientID, recreated.ClientID, "created again with a new client id")
		_, err = auth_model.GetOAuth2ApplicationByClientID(ctx, recreated.ClientID)
		require.NoError(t, err)
		v, _, err := livesync_model.GetMeta(ctx, oauthapp.MetaClientID)
		require.NoError(t, err)
		assert.Equal(t, recreated.ClientID, v)
		assert.EqualValues(t, 1, count())
	})

	t.Run("client id forgotten", func(t *testing.T) {
		// livesync_meta was dropped (uninstall script): the instance's
		// application is adopted, not created a second time; a user's
		// application of the same name is not.
		before := livesync_service.OAuthApp()
		require.NotNil(t, before)
		_, err := auth_model.CreateOAuth2Application(ctx, auth_model.CreateOAuth2ApplicationOptions{
			Name: oauthapp.Name, UserID: 2, RedirectURIs: []string{before.RedirectURI},
		})
		require.NoError(t, err)
		_, err = db.GetEngine(ctx).Where("name = ?", oauthapp.MetaClientID).Delete(&livesync_model.Meta{})
		require.NoError(t, err)
		require.NoError(t, livesync_service.Init(ctx))
		assert.Equal(t, before, livesync_service.OAuthApp(), "adopted")
		v, _, err := livesync_model.GetMeta(ctx, oauthapp.MetaClientID)
		require.NoError(t, err)
		assert.Equal(t, before.ClientID, v)
		assert.EqualValues(t, 1, count())
	})

	t.Run("OAuth2 provider off", func(t *testing.T) {
		defer test.MockVariableValue(&setting.OAuth2.Enabled, false)()
		require.NoError(t, livesync_service.Init(ctx), "livesync still runs (personal access tokens)")
		assert.Nil(t, livesync_service.OAuthApp())
		resp := MakeRequest(t, NewRequest(t, "GET", "/-/next/config"), http.StatusOK)
		var cfg protocol.NextConfig
		require.NoError(t, json.Unmarshal(resp.Body.Bytes(), &cfg))
		assert.Nil(t, cfg.OAuth)
		assert.True(t, strings.HasSuffix(cfg.Base, "/-/next/"))
	})
}
