// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	auth_model "forgejo.org/models/auth"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/optional"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/test"
	"forgejo.org/services/auth"
	"forgejo.org/services/authz"

	"github.com/stretchr/testify/assert"
)

// fakeResult is an authentication result with a given scope and reducer.
type fakeResult struct {
	*auth.BaseAuthenticationResult
	scope   optional.Option[auth_model.AccessTokenScope]
	reducer authz.AuthorizationReducer
}

func (*fakeResult) User() *user_model.User { return &user_model.User{ID: 1, IsActive: true} }

func (r *fakeResult) Scope() optional.Option[auth_model.AccessTokenScope] { return r.scope }

func (r *fakeResult) Reducer() authz.AuthorizationReducer { return r.reducer }

func TestCheckTokenAccess(t *testing.T) {
	scope := func(s string) optional.Option[auth_model.AccessTokenScope] {
		return optional.Some(auth_model.AccessTokenScope(s))
	}
	cases := []struct {
		name    string
		result  *fakeResult
		allowed bool
	}{
		{"all", &fakeResult{scope: scope("all")}, true},
		{"no scope (session-like)", &fakeResult{}, true},
		{"every read scope", &fakeResult{scope: scope("read:repository,read:issue,read:organization,read:user,read:notification")}, true},
		{"write scopes imply read", &fakeResult{scope: scope("write:repository,write:issue,write:organization,write:user,write:notification")}, true},
		{"all, all repositories", &fakeResult{scope: scope("all"), reducer: &authz.AllAccessAuthorizationReducer{}}, true},
		{"repository only", &fakeResult{scope: scope("read:repository")}, false},
		{"no notifications", &fakeResult{scope: scope("read:repository,read:issue,read:organization,read:user")}, false},
		{"public only", &fakeResult{scope: scope("all,public-only")}, false},
		{"public repositories reducer", &fakeResult{scope: scope("all"), reducer: &authz.PublicReposAuthorizationReducer{}}, false},
		{"specific repositories", &fakeResult{scope: scope("all"), reducer: &authz.SpecificReposAuthorizationReducer{}}, false},
		{"invalid scope", &fakeResult{scope: scope("read:nonsense")}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := checkTokenAccess(c.result)
			if c.allowed {
				assert.NoError(t, err)
			} else {
				assert.ErrorIs(t, err, errTokenAccess)
			}
		})
	}
}

// Without a token: 401 (no database needed: no method attempts anything).
func TestAuthenticateWithoutToken(t *testing.T) {
	_, aerr := authenticate(httptest.NewRequest(http.MethodGet, "/-/sync/grants", nil))
	if assert.NotNil(t, aerr) {
		assert.Equal(t, http.StatusUnauthorized, aerr.status)
	}
}

// Accounts API v1 refuses are refused with API v1's answers (the
// two-factor case needs the database: TestLivesyncPermAuth).
func TestCheckAccount(t *testing.T) {
	defer test.MockVariableValue(&setting.GlobalTwoFactorRequirement, setting.NoneTwoFactorRequirement)()
	defer test.MockVariableValue(&setting.Service.RegisterEmailConfirm, false)()
	ctx := t.Context()
	assert.Nil(t, checkAccount(ctx, &user_model.User{ID: 1, IsActive: true}))
	cases := map[string]*user_model.User{
		"prohibited from signing in": {ID: 1, IsActive: false},
		"prohibited ":                {ID: 1, IsActive: true, ProhibitLogin: true},
		"change your password":       {ID: 1, IsActive: true, MustChangePassword: true},
	}
	for want, u := range cases {
		aerr := checkAccount(ctx, u)
		if assert.NotNil(t, aerr, want) {
			assert.Equal(t, http.StatusForbidden, aerr.status)
			assert.Contains(t, aerr.message, strings.TrimSpace(want))
		}
	}
	defer test.MockVariableValue(&setting.Service.RegisterEmailConfirm, true)()
	aerr := checkAccount(ctx, &user_model.User{ID: 1})
	if assert.NotNil(t, aerr) {
		assert.Equal(t, "This account is not activated.", aerr.message)
	}
}
