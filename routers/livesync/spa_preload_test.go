// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"net/http"
	"testing"
	"testing/fstest"

	"github.com/stretchr/testify/assert"
)

func TestRouteModules(t *testing.T) {
	for p, want := range map[string]string{
		"/":                                  "src/features/home/Home.tsx",
		"/notifications":                     "src/features/inbox/Inbox.tsx",
		"/issues":                            "src/features/my/MyWork.tsx",
		"/acme":                              "src/features/owner/OwnerPage.tsx",
		"/acme/atlas":                        "src/features/repo/RepoHome.tsx",
		"/acme/atlas/pulls":                  "src/features/repo/RepoViews.tsx",
		"/acme/atlas/issues/85":              "src/features/issue/IssueView.tsx",
		"/-/next/projects/4":                 "src/features/board/BoardView.tsx",
		"/-/next/code/acme/atlas/src/main/-": "src/features/code/CodePage.tsx",
		"/-/next/boards":                     "src/features/board/BoardsList.tsx",
		"/acme/atlas/settings":               "src/features/settings/Settings.tsx",
		"/acme/atlas/settings/hooks":         "src/features/settings/Settings.tsx",
		"/repo/create":                       "src/features/new/NewRepo.tsx",
		"/org/create":                        "src/features/new/NewOrg.tsx",
		"/acme/atlas/wiki":                   "src/features/wiki/WikiPage.tsx",
		"/acme/atlas/wiki/Home/-/edit":       "src/features/wiki/WikiPage.tsx",
		"/acme/atlas/activity":               "src/features/activity/Activity.tsx",
		"/acme/atlas/activity/contributors":  "src/features/activity/Activity.tsx",
		"/user/settings":                     "src/features/usersettings/UserSettings.tsx",
		"/user/settings/keys":                "src/features/usersettings/UserSettings.tsx",
		"/acme/atlas/releases":               "src/features/code/CodePage.tsx",
		"/acme/atlas/releases/new":           "src/features/code/CodePage.tsx",
		"/acme/atlas/releases/edit/v1.0":     "src/features/code/CodePage.tsx",
		"/acme/atlas/src/branch/main/a.go":   "src/features/code/CodePage.tsx",
		"/acme/atlas/pulls/3/files":          "src/features/issue/IssueView.tsx",
		"/acme/atlas/labels":                 "src/features/meta/LabelsPage.tsx",
		"/acme/atlas/milestones":             "src/features/meta/MilestonesPage.tsx",
		"/acme/atlas/milestones/new":         "src/features/meta/MilestoneForm.tsx",
		"/acme/atlas/milestone/3":            "src/features/meta/MilestonePage.tsx",
		"/acme/atlas/milestone/3/edit":       "src/features/meta/MilestoneForm.tsx",
	} {
		got := routeModules(p)
		if assert.NotEmpty(t, got, p) {
			assert.Equal(t, want, got[0], p)
		}
	}
	assert.Nil(t, routeModules("/-/next/"))
	assert.Nil(t, routeModules("/acme/atlas/settings/x"))
	assert.Nil(t, routeModules("/user/settings/applications"), "a classic settings page")
	assert.Nil(t, routeModules("/user/login"))
	assert.Nil(t, routeModules("/acme/atlas/milestone/3/x"))
	assert.Nil(t, routeModules("/acme/atlas/labels/x"))
}

func TestPreloadHeaders(t *testing.T) {
	manifest := `{
		"index.html": {"file": "assets/index-a.js", "isEntry": true, "imports": ["_vendor-react.js"]},
		"_vendor-react.js": {"file": "assets/vendor-react.js"},
		"_cells.js": {"file": "assets/cells.js", "imports": ["_vendor-react.js"]},
		"src/features/issue/IssueView.tsx": {"file": "assets/IssueView-b.js", "imports": ["_cells.js", "_vendor-react.js", "index.html"]}
	}`
	s := &spa{fsys: fstest.MapFS{
		"index.html":          {Data: []byte("<html></html>")},
		".vite/manifest.json": {Data: []byte(manifest)},
	}}
	h := http.Header{}
	s.preloadHeaders(h, "/acme/atlas/issues/85")
	// The view and its imports, not what the entry preloads already.
	assert.Equal(t, []string{
		"</-/next/assets/IssueView-b.js>; rel=modulepreload; crossorigin",
		"</-/next/assets/cells.js>; rel=modulepreload; crossorigin",
	}, h.Values("Link"))
	h = http.Header{}
	s.preloadHeaders(h, "/user/settings/x/y/z")
	assert.Empty(t, h.Values("Link"))
}
