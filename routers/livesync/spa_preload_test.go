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
	} {
		got := routeModules(p)
		if assert.NotEmpty(t, got, p) {
			assert.Equal(t, want, got[0], p)
		}
	}
	assert.Nil(t, routeModules("/-/next/"))
	assert.Nil(t, routeModules("/acme/atlas/wiki/x"))
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
