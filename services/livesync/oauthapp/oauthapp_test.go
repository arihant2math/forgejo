// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package oauthapp

import (
	"testing"

	auth_model "forgejo.org/models/auth"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/test"

	"github.com/stretchr/testify/assert"
)

// Only the Next UI's exact sign-in request skips the consent page.
func TestIsOwnSignIn(t *testing.T) {
	defer test.MockVariableValue(&setting.AppURL, "https://code.example/")()
	callback := "https://code.example/-/next/callback"
	dev := "http://127.0.0.1/-/next/callback"
	own := &App{ClientID: "next", RedirectURI: callback, Scope: Scope}
	client := func(edit func(*auth_model.OAuth2Application)) *auth_model.OAuth2Application {
		app := &auth_model.OAuth2Application{ClientID: "next", Name: Name, RedirectURIs: []string{callback, dev}}
		if edit != nil {
			edit(app)
		}
		return app
	}

	assert.True(t, own.IsOwnSignIn(client(nil), callback, Scope, "S256"))

	for name, ok := range map[string]bool{
		"livesync not running":     (*App)(nil).IsOwnSignIn(client(nil), callback, Scope, "S256"),
		"another application":      own.IsOwnSignIn(client(func(a *auth_model.OAuth2Application) { a.ClientID = "other" }), callback, Scope, "S256"),
		"a user's application":     own.IsOwnSignIn(client(func(a *auth_model.OAuth2Application) { a.UID = 2 }), callback, Scope, "S256"),
		"a confidential client":    own.IsOwnSignIn(client(func(a *auth_model.OAuth2Application) { a.ConfidentialClient = true }), callback, Scope, "S256"),
		"no such redirect URI":     own.IsOwnSignIn(client(func(a *auth_model.OAuth2Application) { a.RedirectURIs = []string{dev} }), callback, Scope, "S256"),
		"a development server":     own.IsOwnSignIn(client(nil), dev, Scope, "S256"),
		"a loopback port":          own.IsOwnSignIn(client(nil), "http://127.0.0.1:5173/-/next/callback", Scope, "S256"),
		"another URL":              own.IsOwnSignIn(client(nil), "https://evil.example/-/next/callback", Scope, "S256"),
		"another scope":            own.IsOwnSignIn(client(nil), callback, "write:admin", "S256"),
		"the scope in other order": own.IsOwnSignIn(client(nil), callback, "write:repository write:issue write:user write:organization write:notification", "S256"),
		"no scope":                 own.IsOwnSignIn(client(nil), callback, "", "S256"),
		"plain PKCE":               own.IsOwnSignIn(client(nil), callback, Scope, "plain"),
		"no PKCE":                  own.IsOwnSignIn(client(nil), callback, Scope, ""),
		"no application":           own.IsOwnSignIn(nil, callback, Scope, "S256"),
		"an empty client id":       (&App{RedirectURI: callback, Scope: Scope}).IsOwnSignIn(client(func(a *auth_model.OAuth2Application) { a.ClientID = "" }), callback, Scope, "S256"),
		"a stale provisioning":     (&App{ClientID: "next", RedirectURI: "https://old.example/-/next/callback", Scope: Scope}).IsOwnSignIn(client(nil), callback, Scope, "S256"),
	} {
		assert.False(t, ok, name)
	}
}
