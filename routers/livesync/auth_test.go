// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"net/http"
	"net/http/httptest"
	"testing"

	auth_model "forgejo.org/models/auth"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/optional"
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
