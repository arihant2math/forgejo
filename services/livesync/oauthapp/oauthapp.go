// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Package oauthapp provisions the Next UI's OAuth2 client (PLAN §4.9): an
// instance-wide public client (no secret; Forgejo requires PKCE for public
// clients) whose redirect URI is {AppURL}-/next/callback. The SPA reads the
// client id, redirect URI and scope from the config the server inlines into
// its index.html (routers/livesync/spa.go).
//
// Scope behaviour (verified in tests/integration/livesync_oauth_test.go,
// against routers/web/auth/oauth.go and services/auth/method/oauth2.go):
//
//   - The access token's API scope is the grant's scope filtered to API
//     scopes (grantAdditionalScopes), whatever [oauth2]
//     ENABLE_ADDITIONAL_GRANT_SCOPES says: that setting only changes the
//     userinfo groups claim and the applications settings page. A grant
//     without any API scope (e.g. only "openid") gets "all".
//   - A user's grant keeps the scope of the first consent: an authorize
//     request with another scope string (even the same scopes in another
//     order) fails with "a grant exists with different scope". So the SPA
//     must send exactly Scope, and Ensure revokes the grants of this client
//     that have another scope when Scope changes (users consent again).
//   - Public clients get the consent page at every authorization (RFC 6749
//     §10.2; only confidential clients with a grant are redirected at
//     once): one consent per sign-in, not per token refresh.
package oauthapp

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	auth_model "forgejo.org/models/auth"
	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/log"
	"forgejo.org/modules/setting"
)

// Name is the application's name on the consent page and in the site
// administration.
const Name = "Forgejo Next"

// Scope is what the SPA asks for, exactly PLAN §4.9: livesync needs read
// access to repositories, issues, organizations, users and notifications
// (routers/livesync requiredScopes); the UI writes issues and pull
// requests, repository metadata (watch, star, labels, milestones) and
// notifications through API v1. No write:user / write:organization: the
// token lives in the browser (refresh token in IndexedDB), and those
// would let a stolen one add SSH keys, OAuth2 applications, hooks or emails
// to the account or change organizations. A later milestone that needs
// them widens Scope; Ensure then revokes the old grants (one forced
// sign-in, see the package documentation).
const Scope = "write:issue write:repository read:user read:organization write:notification"

// Meta names in livesync_meta.
const (
	MetaClientID = "oauth_client_id"
	MetaScope    = "oauth_scope"
)

// CallbackPath is the redirect path below the application root.
const CallbackPath = "-/next/callback"

// App is the provisioned client, as the SPA needs it.
type App struct {
	ClientID    string `json:"client_id"`
	RedirectURI string `json:"redirect_uri"`
	Scope       string `json:"scope"`
}

// ErrOAuth2Disabled is returned by Ensure when Forgejo's OAuth2 provider is
// off ([oauth2] ENABLED = false): the Next UI cannot sign in.
var ErrOAuth2Disabled = errors.New("Forgejo's OAuth2 provider is disabled ([oauth2] ENABLED = false); the Next UI cannot sign in")

// RedirectURIs returns the redirect URIs of the client: the callback below
// AppURL, then extra (e.g. a development server's).
func RedirectURIs(extra []string) []string {
	uris := []string{setting.AppURL + CallbackPath}
	for _, u := range extra {
		if u = strings.TrimSpace(u); u != "" && !slices.Contains(uris, u) {
			uris = append(uris, u)
		}
	}
	return uris
}

// Ensure makes sure the client exists and is current, idempotently and
// safely for instances starting together (under the livesync schema lock).
// Its client id is kept in livesync_meta; an application deleted by an
// administrator is created again (with a new client id). When livesync_meta
// lost the client id (livesync's tables were dropped, see
// capture.TablesScript), the instance-wide public application named Name
// with the callback redirect URI is adopted instead of creating a second.
func Ensure(ctx context.Context, extraRedirectURIs []string) (*App, error) {
	if !setting.OAuth2.Enabled {
		return nil, ErrOAuth2Disabled
	}
	var app *App
	err := livesync_model.WithSchemaLock(ctx, func(ctx context.Context) error {
		// One transaction (on the master database: no replica lag between
		// another instance's creation and this read).
		return db.WithTx(ctx, func(ctx context.Context) error {
			var err error
			app, err = ensureLocked(ctx, RedirectURIs(extraRedirectURIs))
			return err
		})
	})
	return app, err
}

func ensureLocked(ctx context.Context, redirects []string) (*App, error) {
	clientID, ok, err := livesync_model.GetMeta(ctx, MetaClientID)
	if err != nil {
		return nil, err
	}
	var app *auth_model.OAuth2Application
	if ok && clientID != "" {
		app, err = auth_model.GetOAuth2ApplicationByClientID(ctx, clientID)
		switch {
		case auth_model.IsErrOauthClientIDInvalid(err):
			log.Warn("livesync: the OAuth2 application of the Next UI (client id %s) was deleted; creating it again", clientID)
			app = nil
		case err != nil:
			return nil, fmt.Errorf("livesync: read the OAuth2 application: %w", err)
		}
	}
	if app == nil {
		orphans, err := findOrphans(ctx, redirects[0])
		if err != nil {
			return nil, err
		}
		if len(orphans) > 0 {
			app = orphans[0]
			if err := livesync_model.SetMeta(ctx, MetaClientID, app.ClientID); err != nil {
				return nil, err
			}
			log.Info("livesync: adopted the existing OAuth2 application of the Next UI (client id %s)", app.ClientID)
		}
	}
	if app == nil {
		app, err = auth_model.CreateOAuth2Application(ctx, auth_model.CreateOAuth2ApplicationOptions{
			Name: Name, UserID: 0, ConfidentialClient: false, RedirectURIs: redirects,
		})
		if err != nil {
			return nil, fmt.Errorf("livesync: create the OAuth2 application: %w", err)
		}
		if err := livesync_model.SetMeta(ctx, MetaClientID, app.ClientID); err != nil {
			return nil, err
		}
		log.Info("livesync: created the OAuth2 application of the Next UI (client id %s)", app.ClientID)
	} else if app.UID != 0 || app.Name != Name || app.ConfidentialClient || !slices.Equal(app.RedirectURIs, redirects) {
		if app.UID != 0 {
			return nil, fmt.Errorf("livesync: the OAuth2 application %s belongs to user %d, not to the instance", app.ClientID, app.UID)
		}
		if _, err := auth_model.UpdateOAuth2Application(ctx, auth_model.UpdateOAuth2ApplicationOptions{
			ID: app.ID, Name: Name, UserID: 0, ConfidentialClient: false, RedirectURIs: redirects,
		}); err != nil {
			return nil, fmt.Errorf("livesync: update the OAuth2 application: %w", err)
		}
		log.Info("livesync: updated the OAuth2 application of the Next UI (redirect URIs %s)", strings.Join(redirects, ", "))
	}

	// A changed Scope: grants with another scope would make every
	// authorization of their users fail; revoke them (they consent again).
	stored, _, err := livesync_model.GetMeta(ctx, MetaScope)
	if err != nil {
		return nil, err
	}
	if stored != Scope {
		n, err := db.GetEngine(ctx).Where("application_id = ? AND scope <> ?", app.ID, Scope).Delete(&auth_model.OAuth2Grant{})
		if err != nil {
			return nil, fmt.Errorf("livesync: revoke the Next UI's grants with an old scope: %w", err)
		}
		if n > 0 {
			log.Info("livesync: revoked %d grant(s) of the Next UI with another scope than %q", n, Scope)
		}
		if err := livesync_model.SetMeta(ctx, MetaScope, Scope); err != nil {
			return nil, err
		}
	}
	return &App{ClientID: app.ClientID, RedirectURI: redirects[0], Scope: Scope}, nil
}

// findOrphans returns the instance-wide public applications named Name
// whose redirect URIs include callback, oldest first: the Next UI's, from
// before livesync_meta was dropped.
func findOrphans(ctx context.Context, callback string) ([]*auth_model.OAuth2Application, error) {
	var apps []*auth_model.OAuth2Application
	if err := db.GetEngine(ctx).Where("uid = ? AND name = ? AND confidential_client = ?", 0, Name, false).OrderBy("id").Find(&apps); err != nil {
		return nil, fmt.Errorf("livesync: look for the OAuth2 application: %w", err)
	}
	return slices.DeleteFunc(apps, func(app *auth_model.OAuth2Application) bool {
		return !slices.Contains(app.RedirectURIs, callback)
	}), nil
}
