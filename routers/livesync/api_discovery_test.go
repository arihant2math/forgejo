// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"net/url"
	"testing"

	"forgejo.org/models/db"
	"forgejo.org/modules/setting"
	"github.com/stretchr/testify/assert"
)

func TestDiscoveryOptions(t *testing.T) {
	list, order, ok := discoveryOptions(url.Values{"page": {"2"}, "sort": {"stars"}})
	assert.True(t, ok)
	assert.Equal(t, db.ListOptions{Page: 2, PageSize: 50}, list)
	assert.Equal(t, db.SearchOrderBy("num_stars DESC, id DESC"), order)
	for _, query := range []url.Values{{"page": {"-1"}}, {"page": {"bad"}}, {"page": {"100001"}}, {"sort": {"name; DROP TABLE repository"}}} {
		_, _, ok = discoveryOptions(query)
		assert.False(t, ok)
	}
	_, order, ok = discoveryOptions(url.Values{})
	assert.True(t, ok)
	assert.Equal(t, db.SearchOrderByRecentUpdated, order)
}

func TestDiscoveryRestrictions(t *testing.T) {
	old := setting.Service.Explore
	t.Cleanup(func() { setting.Service.Explore = old })
	setting.Service.Explore.DisableUsersPage = true
	setting.Service.Explore.DisableOrganizationsPage = true
	assert.True(t, discoveryAllowed("repositories"))
	assert.False(t, discoveryAllowed("users"))
	assert.False(t, discoveryAllowed("organizations"))
	assert.False(t, discoveryAllowed("unknown"))
	setting.Service.Explore.RequireSigninView = true
	assert.Equal(t, setting.Service.Explore.RequireSigninView, nextConfig().Explore.RequireSignin)
	assert.True(t, nextConfig().Explore.DisableUsers)
	assert.True(t, nextConfig().Explore.DisableOrganizations)
	setting.Service.Explore.DisableUsersPage = false
	setting.Service.Explore.DisableOrganizationsPage = false
	assert.True(t, discoveryAllowed("users"))
	assert.True(t, discoveryAllowed("organizations"))
}
