// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"net/http"
	"testing"

	"forgejo.org/modules/setting"
	"forgejo.org/modules/test"

	"github.com/stretchr/testify/assert"
)

func TestClassicLocation(t *testing.T) {
	defer test.MockVariableValue(&setting.AppURL, "https://forge.example/")()
	defer test.MockVariableValue(&setting.AppSubURL, "")()
	for loc, want := range map[string]string{
		// RedirectToLatestAttempt: an absolute URL of a run's attempt, a page of the UI.
		"https://forge.example/user2/repo1/actions/runs/10/jobs/0/attempt/1": "https://forge.example/user2/repo1/actions/runs/10/jobs/0/attempt/1?ui=classic",
		"/user2/repo1/actions/runs/10/jobs/0/attempt/2":                      "/user2/repo1/actions/runs/10/jobs/0/attempt/2?ui=classic",
		"/user2/repo1/pulls/3?x=1":                                           "/user2/repo1/pulls/3?ui=classic&x=1",
		// Left alone: classic-only pages, other sites, already explicit.
		"/user/login":                                   "",
		"/user2/repo1/actions/runs/10/delete":           "",
		"https://elsewhere.example/user2/repo1/pulls/3": "",
		"//elsewhere.example/user2/repo1/pulls/3":       "",
		"/user2/repo1/pulls/3?ui=next":                  "",
		"http://forge.example/user2/repo1/pulls/3":      "",
		"":                    "",
		"user2/repo1/pulls/3": "",
		"https://forge.example/user2/repo1/actions/runs/10/x": "",
	} {
		got, ok := classicLocation(loc)
		assert.Equal(t, want != "", ok, loc)
		assert.Equal(t, want, got, loc)
	}

	defer test.MockVariableValue(&setting.AppURL, "https://forge.example/sub/")()
	defer test.MockVariableValue(&setting.AppSubURL, "/sub")()
	got, ok := classicLocation("https://forge.example/sub/user2/repo1/actions/runs/10/jobs/0/attempt/1")
	assert.True(t, ok)
	assert.Equal(t, "https://forge.example/sub/user2/repo1/actions/runs/10/jobs/0/attempt/1?ui=classic", got)
	_, ok = classicLocation("https://forge.example/user2/repo1/pulls/3")
	assert.False(t, ok, "outside the sub-path")
}

// "Open in the classic UI" on a run (…/runs/10?ui=classic) used to land on the UI again: Forgejo redirects
// to the latest attempt without the query (issue #218).
func TestClassicRunRedirect(t *testing.T) {
	defer test.MockVariableValue(&setting.AppURL, "https://forge.example/")()
	defer test.MockVariableValue(&setting.AppSubURL, "")()
	inner := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		http.Redirect(w, req, "https://forge.example/user2/repo1/actions/runs/10/jobs/0/attempt/1", http.StatusTemporaryRedirect)
	})
	h := spaHandler(t, writeDist(t), inner)
	for _, path := range []string{"/user2/repo1/actions/runs/10?ui=classic", "/user2/repo1/actions/runs/10/jobs/0?ui=classic"} {
		rec := get(t, h, path, "Cookie", "ui=next", "Sec-Fetch-Dest", "document")
		assert.Equal(t, http.StatusTemporaryRedirect, rec.Code, path)
		assert.Equal(t, "https://forge.example/user2/repo1/actions/runs/10/jobs/0/attempt/1?ui=classic", rec.Header().Get("Location"), path)
	}
	// Without ?ui=classic the redirect is Forgejo's own.
	rec := get(t, h, "/user2/repo1/actions/runs/10", "Cookie", "ui=classic")
	assert.Equal(t, "https://forge.example/user2/repo1/actions/runs/10/jobs/0/attempt/1", rec.Header().Get("Location"))
}
