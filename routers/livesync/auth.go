// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"errors"
	"net/http"

	auth_model "forgejo.org/models/auth"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/log"
	"forgejo.org/services/auth"
	auth_method "forgejo.org/services/auth/method"
	"forgejo.org/services/authz"
)

// authMethods authenticate livesync's HTTP endpoints like API v1 does for
// tokens: an OAuth2 access token (the Next SPA's, B8) or a personal access
// token, in the Authorization header (Bearer / token) or the form. No
// sessions (no cookies, so no CSRF surface) and no passwords.
var authMethods = auth_method.NewGroup(
	&auth_method.OAuth2{},
	&auth_method.AccessToken{PermitBearer: true},
)

// requiredScopes are the token scopes livesync needs: it serves
// repositories, issues and pull requests, organizations, users and
// notifications. A token without one of them (or a public-only token, or one
// restricted to specific repositories) is refused rather than served a
// partial view; filtering grants by scope is left for later.
var requiredScopes = []auth_model.AccessTokenScope{
	auth_model.AccessTokenScopeReadRepository,
	auth_model.AccessTokenScopeReadIssue,
	auth_model.AccessTokenScopeReadOrganization,
	auth_model.AccessTokenScopeReadUser,
	auth_model.AccessTokenScopeReadNotification,
}

// authError is why a request could not be authenticated.
type authError struct {
	status  int
	message string
}

// authenticate returns the viewer of a livesync request. The WebSocket
// hello (B5) validates its token the same way.
func authenticate(req *http.Request) (*user_model.User, *authError) {
	var result auth.AuthenticationResult
	switch out := authMethods.Verify(req, nil, nil).(type) {
	case *auth.AuthenticationSuccess:
		result = out.Result
	case *auth.AuthenticationError:
		log.Error("livesync: authentication: %v", out.Error)
		return nil, &authError{http.StatusInternalServerError, http.StatusText(http.StatusInternalServerError)}
	default:
		return nil, &authError{http.StatusUnauthorized, "a valid access token is required"}
	}
	u := result.User()
	if u == nil {
		return nil, &authError{http.StatusUnauthorized, "a valid access token is required"}
	}
	// As API v1 (routers/api/shared/middleware.go).
	if !u.IsActive || u.ProhibitLogin {
		return nil, &authError{http.StatusForbidden, "This account is prohibited from signing in, please contact your site administrator."}
	}
	if err := checkTokenAccess(result); err != nil {
		return nil, &authError{http.StatusForbidden, err.Error()}
	}
	return u, nil
}

var errTokenAccess = errors.New("livesync needs a token with read access to repositories, issues, organizations, users and notifications, not limited to public or specific repositories")

// checkTokenAccess refuses tokens that may not read everything livesync
// serves.
func checkTokenAccess(result auth.AuthenticationResult) error {
	if has, scope := result.Scope().Get(); has {
		ok, err := scope.HasScope(requiredScopes...)
		if err != nil || !ok {
			return errTokenAccess
		}
		if publicOnly, err := scope.PublicOnly(); err != nil || publicOnly {
			return errTokenAccess
		}
	}
	switch result.Reducer().(type) {
	case nil, *authz.AllAccessAuthorizationReducer:
		return nil
	}
	return errTokenAccess
}
