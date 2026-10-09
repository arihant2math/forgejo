// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"io/fs"
	"net/http"
	"slices"
	"strings"
	"sync"

	"forgejo.org/modules/json"
	"forgejo.org/modules/setting"
)

// Route preloads (QA round 2, the "fast first load" direction): the UI's
// document is the same for every route, and index.html preloads only the
// boot route's modules. The view of the route asked for (an issue, a code
// page) is its own chunk, which the app fetched only once its entry ran
// (router.load: a round trip after the entry's). The document's answer now
// names that chunk and its imports in Link headers (rel=modulepreload): the
// browser fetches them while it parses the document and the entry, in
// parallel. The body stays one cached, precompressed document.

// routeModules are the source modules of the view a site path renders (the
// lazy views of next/src/app/router.tsx, and what Home renders first, its
// Dashboard), or nil. Keep in step with router.tsx: routes.test.ts checks
// that each module named here is a lazy view of the router.
func routeModules(p string) []string {
	segs := strings.Split(strings.Trim(p, "/"), "/")
	if p == "/" || p == "" {
		return []string{"src/features/home/Home.tsx", "src/features/home/Dashboard.tsx"}
	}
	if segs[0] == "-" {
		switch {
		case len(segs) >= 3 && segs[1] == "next" && segs[2] == "boards":
			return []string{"src/features/board/BoardsList.tsx"}
		case len(segs) == 4 && segs[1] == "next" && segs[2] == "projects":
			return []string{"src/features/board/BoardView.tsx"}
		case len(segs) > 3 && segs[1] == "next" && segs[2] == "code":
			return []string{"src/features/code/CodePage.tsx"}
		}
		return nil
	}
	switch len(segs) {
	case 1:
		switch segs[0] {
		case "notifications":
			return []string{"src/features/inbox/Inbox.tsx"}
		case "issues", "pulls":
			return []string{"src/features/my/MyWork.tsx"}
		}
		return []string{"src/features/owner/OwnerPage.tsx"}
	case 2:
		return []string{"src/features/repo/RepoHome.tsx"}
	case 3:
		if segs[2] == "issues" || segs[2] == "pulls" {
			return []string{"src/features/repo/RepoViews.tsx"}
		}
	case 4:
		if segs[2] == "issues" || segs[2] == "pulls" {
			return []string{"src/features/issue/IssueView.tsx"}
		}
	}
	return nil
}

// manifestChunk is an entry of Vite's build manifest (.vite/manifest.json).
type manifestChunk struct {
	File    string   `json:"file"`
	Imports []string `json:"imports"`
	IsEntry bool     `json:"isEntry"`
}

// preloader answers the files to preload for a set of modules, from the
// manifest of the build on disk (read again when the build changes).
type preloader struct {
	mu      sync.Mutex
	version string
	chunks  map[string]manifestChunk
	boot    map[string]bool // the entry's own modules (index.html preloads them already)
}

func (p *preloader) load(fsys fs.FS, version string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.version == version && p.chunks != nil {
		return
	}
	p.version, p.chunks, p.boot = version, map[string]manifestChunk{}, map[string]bool{}
	data, err := fs.ReadFile(fsys, ".vite/manifest.json")
	if err != nil || json.Unmarshal(data, &p.chunks) != nil {
		return // no manifest (a dev build): no preloads
	}
	for key, c := range p.chunks {
		if c.IsEntry {
			p.walk(key, p.boot)
		}
	}
}

// walk adds key and its static imports to seen.
func (p *preloader) walk(key string, seen map[string]bool) {
	if seen[key] {
		return
	}
	seen[key] = true
	for _, dep := range p.chunks[key].Imports {
		p.walk(dep, seen)
	}
}

// files are the build files (below the base) of modules and their static
// imports that the entry does not preload, in a stable order.
func (p *preloader) files(modules []string) []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	seen := map[string]bool{}
	for _, m := range modules {
		if _, ok := p.chunks[m]; ok {
			p.walk(m, seen)
		}
	}
	var out []string
	for key := range seen {
		c := p.chunks[key]
		if p.boot[key] || c.File == "" || !strings.HasSuffix(c.File, ".js") {
			continue
		}
		out = append(out, c.File)
	}
	slices.Sort(out)
	return out
}

// preloadHeaders adds the Link headers of the route's view to a document
// answer (site path p, without the sub-path).
func (s *spa) preloadHeaders(h http.Header, p string) {
	modules := routeModules(p)
	if modules == nil {
		return
	}
	version, err := s.buildVersion()
	if err != nil {
		return
	}
	s.preload.load(s.fsys, version)
	for _, f := range s.preload.files(modules) {
		h.Add("Link", "<"+setting.AppSubURL+nextBase+f+">; rel=modulepreload; crossorigin")
	}
}
