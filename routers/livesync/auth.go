// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"context"
	"errors"
	"net/http"

	auth_model "forgejo.org/models/auth"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/log"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/translation"
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
	u, _, aerr := authenticateResult(req)
	return u, aerr
}

// authenticateResult is authenticate that also returns the token's
// authentication result (its scope, for the writes of the gap endpoints).
func authenticateResult(req *http.Request) (*user_model.User, auth.AuthenticationResult, *authError) {
	var result auth.AuthenticationResult
	switch out := authMethods.Verify(req, nil, nil).(type) {
	case *auth.AuthenticationSuccess:
		result = out.Result
	case *auth.AuthenticationError:
		log.Error("livesync: authentication: %v", out.Error)
		return nil, nil, &authError{http.StatusInternalServerError, http.StatusText(http.StatusInternalServerError)}
	default:
		return nil, nil, &authError{http.StatusUnauthorized, "a valid access token is required"}
	}
	u := result.User()
	if u == nil {
		return nil, nil, &authError{http.StatusUnauthorized, "a valid access token is required"}
	}
	if aerr := checkAccount(req.Context(), u); aerr != nil {
		return nil, nil, aerr
	}
	if err := checkTokenAccess(result); err != nil {
		return nil, nil, &authError{http.StatusForbidden, err.Error()}
	}
	return u, result, nil
}

// checkAccount refuses accounts that API v1 refuses (verifyAuthWithOptions
// in routers/api/shared/middleware.go, applied to every API route), with
// the same statuses and messages: not activated, prohibited from signing
// in, required to change the password, or required to enable two-factor
// authentication ([security] GLOBAL_TWO_FACTOR_REQUIREMENT) without having
// done so.
func checkAccount(ctx context.Context, u *user_model.User) *authError {
	switch {
	case !u.IsActive && setting.Service.RegisterEmailConfirm:
		return &authError{http.StatusForbidden, "This account is not activated."}
	case !u.IsActive || u.ProhibitLogin:
		return &authError{http.StatusForbidden, "This account is prohibited from signing in, please contact your site administrator."}
	case u.MustChangePassword:
		return &authError{http.StatusForbidden, "You must change your password. Change it at: " + setting.AppURL + "/user/change_password"}
	case u.MustHaveTwoFactor():
		has, err := auth_model.HasTwoFactorByUID(ctx, u.ID)
		if err != nil {
			log.Error("livesync: two-factor authentication of user %d: %v", u.ID, err)
			return &authError{http.StatusInternalServerError, http.StatusText(http.StatusInternalServerError)}
		}
		if !has {
			return &authError{http.StatusForbidden, translation.NewLocale("en-US").TrString("error.must_enable_2fa", setting.AppURL+"user/settings/security")}
		}
	}
	return nil
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

// errWriteScope is the message of a gap endpoint's write with a token that
// lacks the write scope.
func errWriteScope(scope auth_model.AccessTokenScope) string {
	return "this request needs a token with the " + string(scope) + " scope"
}

// hasScope reports whether the token of result has scope (a token without
// scopes, e.g. a session, has every scope).
func hasScope(result auth.AuthenticationResult, scope auth_model.AccessTokenScope) bool {
	has, s := result.Scope().Get()
	if !has {
		return true
	}
	ok, err := s.HasScope(scope)
	return err == nil && ok
}
