// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	_ "embed" // classicHeader
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"forgejo.org/modules/json"
	"forgejo.org/modules/log"
	"forgejo.org/modules/setting"
	"forgejo.org/services/livesync/protocol"
)

// The Next UI on classic pages (PLAN §4.10), without an upstream change:
// classicHeader is a template an operator installs as
// templates/custom/header.tmpl in Forgejo's custom directory (Forgejo
// includes it in the <head> of every classic page, sign-in included; the
// admin page shows it). It loads /-/next/classic.js, which adds the "Try
// Forgejo Next" toggle (the opt-in / opt-out links, spa.go) and, once the
// browser is idle, prefetch hints for the build's boot files (the entry
// script, its modulepreloads and stylesheets, as index.html loads them),
// so that the app comes from the HTTP cache when the user enters it. F5
// may extend the script (e.g. register the service worker).

// classicHeader is the template for templates/custom/header.tmpl.
//
//go:embed classic_header.tmpl
var classicHeader string

// classicJS is the script; %s is the classicConfig. No innerHTML: the
// toggle is built with DOM calls.
const classicJS = `// Forgejo Next on classic pages (routers/livesync/classic.go).
(() => {
  const c = %s;
  const on = document.cookie.split(/;\s*/).includes(c.cookie);
  const here = location.pathname + location.search + location.hash;
  const pill = (href, text) => {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = text;
    a.style.cssText = "padding:2px 10px;border-radius:999px;font-size:12px;line-height:20px;text-decoration:none;background:var(--color-primary,#4183c4);color:var(--color-primary-contrast,#fff)";
    return a;
  };
  const box = document.createElement("div");
  box.id = "forgejo-next-toggle";
  box.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:1000;display:flex;gap:6px";
  if (on) {
    // Opted in, on a page the UI does not render (or asked for with ?ui=classic): the way back to the UI's
    // page for it (a code view mirrors the classic path below c.base), and the way out.
    const url = new URL(location.href);
    let back = c.base;
    if (url.searchParams.get("ui") === "classic") {
      url.searchParams.delete("ui");
      back = url.pathname + url.search + url.hash;
    } else {
      const sub = c.base.slice(0, -"/-/next/".length);
      const p = location.pathname.slice(sub.length);
      if (/^\/[^/]+\/[^/]+\/(src|blame|commits?|branches|tags|releases|actions|compare)(\/|$)/.test(p)) back = c.base + "code" + p.replace(/\/$/, "") + "/-";
    }
    box.append(pill(back, "Back to Forgejo Next"));
    const off = pill(c.opt_out + "?redirect=" + encodeURIComponent(here), "Turn off");
    off.style.opacity = "0.75";
    box.append(off);
  } else {
    box.append(pill(c.opt_in + "?redirect=" + encodeURIComponent(here), "Try Forgejo Next"));
  }
  document.body.append(box);
  if (navigator.connection && navigator.connection.saveData) return;
  const idle = (f) => (window.requestIdleCallback ? window.requestIdleCallback(f) : setTimeout(f, 1000));
  idle(() => {
    for (const href of c.prefetch) {
      const l = document.createElement("link");
      l.rel = "prefetch";
      l.href = href;
      l.crossOrigin = "";
      document.head.append(l);
    }
  });
})();
`

// classicConfig is what the script needs.
type classicConfig struct {
	Cookie   string   `json:"cookie"`
	Base     string   `json:"base"`
	OptIn    string   `json:"opt_in"`
	OptOut   string   `json:"opt_out"`
	Prefetch []string `json:"prefetch"`
}

var (
	reModuleScript = regexp.MustCompile(`(?is)<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>`)
	reLinkTag      = regexp.MustCompile(`(?is)<link\b[^>]*>`)
	reLinkRel      = regexp.MustCompile(`(?i)\srel\s*=\s*["']?([^"'\s>]+)`)
	reLinkHref     = regexp.MustCompile(`(?i)\shref\s*=\s*["']([^"']+)["']`)
)

// bootFiles returns the same-site files index.html loads at boot: script
// sources, modulepreloads and stylesheets, in document order.
func bootFiles(index []byte) []string {
	var files []string
	add := func(href string) {
		if strings.HasPrefix(href, "/") && !strings.HasPrefix(href, "//") {
			files = append(files, href)
		}
	}
	for _, m := range reModuleScript.FindAllSubmatch(index, -1) {
		add(string(m[1]))
	}
	for _, tag := range reLinkTag.FindAll(index, -1) {
		rel, href := reLinkRel.FindSubmatch(tag), reLinkHref.FindSubmatch(tag)
		if rel == nil || href == nil {
			continue
		}
		switch strings.ToLower(string(rel[1])) {
		case "modulepreload", "stylesheet":
			add(string(href[1]))
		}
	}
	return files
}

// classicScript renders classic.js for the current build (cached with the
// rendered index.html it reads).
func (s *spa) classicScript() (*spaBody, error) {
	index, err := s.renderIndex()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	b := s.classic
	s.mu.Unlock()
	if b != nil && b.key == index.key {
		return b, nil
	}
	cfg, err := json.Marshal(classicConfig{
		Cookie:   protocol.NextUICookie + "=" + protocol.NextUICookieValue,
		Base:     setting.AppSubURL + nextBase,
		OptIn:    setting.AppSubURL + nextPrefix + "/opt-in",
		OptOut:   setting.AppSubURL + nextPrefix + "/opt-out",
		Prefetch: bootFiles(index.raw),
	})
	if err != nil {
		return nil, err
	}
	data := []byte(fmt.Sprintf(classicJS, cfg))
	b = &spaBody{key: index.key, ctype: "text/javascript; charset=utf-8", raw: data, etag: etag(data)}
	s.mu.Lock()
	s.classic = b
	s.mu.Unlock()
	return b, nil
}

// serveClassicScript answers GET /-/next/classic.js (revalidated: it
// names the current build's files).
func (s *spa) serveClassicScript(w http.ResponseWriter, req *http.Request) {
	if !s.available() {
		notFound(w, req)
		return
	}
	b, err := s.classicScript()
	if err != nil {
		log.Error("livesync: render classic.js: %v", err)
		writeJSON(w, http.StatusInternalServerError, errorResponse{Message: http.StatusText(http.StatusInternalServerError)})
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	b.write(w, req)
}
