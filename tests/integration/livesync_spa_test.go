// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"forgejo.org/modules/json"
	livesync_service "forgejo.org/services/livesync"
	"forgejo.org/services/livesync/oauthapp"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/tests"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// livesyncDist writes a small build like next/dist (F1's layout) and
// returns its directory.
func livesyncDist(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for name, content := range map[string]string{
		"index.html": `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Forgejo</title>
<link rel="icon" href="data:,">
<script>(function(){performance.mark(` + "`appStart`" + `)})();</script>
  <script type="module" crossorigin src="/-/next/assets/index-abc.js"></script>
</head>
<body><div id="root"></div></body>
</html>
`,
		"assets/index-abc.js":     "const base=`/-/next/`;console.log(base);",
		"assets/index-abc.js.map": "{}",
		"sw.js":                   "self.addEventListener('install',()=>{});",
	} {
		p := filepath.Join(dir, filepath.FromSlash(name))
		require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o755))
		require.NoError(t, os.WriteFile(p, []byte(content), 0o644))
	}
	return dir
}

// The Next UI served by a running livesync from [livesync] ASSETS_DIR:
// immutable assets, the service worker, the document for the UI's own
// routes and — with the opt-in cookie, for document navigations only — on
// the canonical URLs it supports; everything else is the classic UI.
func TestLivesyncSPA(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncServeWith(t, map[string]string{"ASSETS_DIR": livesyncDist(t)})

	resp := MakeRequest(t, NewRequest(t, "GET", "/-/next/assets/index-abc.js"), http.StatusOK)
	assert.Equal(t, "public, max-age=31536000, immutable", resp.Header().Get("Cache-Control"))
	assert.Equal(t, "text/javascript; charset=utf-8", resp.Header().Get("Content-Type"))
	assert.Equal(t, "const base=`/-/next/`;console.log(base);", resp.Body.String())
	MakeRequest(t, NewRequest(t, "GET", "/-/next/assets/index-abc.js.map"), http.StatusNotFound)
	MakeRequest(t, NewRequest(t, "GET", "/-/next/assets/missing.js"), http.StatusNotFound)

	resp = MakeRequest(t, NewRequest(t, "GET", "/-/next/sw.js"), http.StatusOK)
	assert.Equal(t, "/", resp.Header().Get("Service-Worker-Allowed"))
	assert.Equal(t, "no-cache", resp.Header().Get("Cache-Control"))

	// The script classic pages load (routers/livesync/classic_header.tmpl).
	resp = MakeRequest(t, NewRequest(t, "GET", "/-/next/classic.js"), http.StatusOK)
	assert.Contains(t, resp.Body.String(), `"prefetch":["/-/next/assets/index-abc.js"]`)
	assert.Contains(t, resp.Body.String(), "Try Forgejo Next")

	app := livesync_service.OAuthApp()
	require.NotNil(t, app)
	document := func(t *testing.T, resp *http.Response, body string) {
		t.Helper()
		m := regexp.MustCompile(`<script type="application/json" id="forgejo-next-config">(.*?)</script>`).FindStringSubmatch(body)
		require.NotNil(t, m, "the Next UI's document")
		var cfg protocol.NextConfig
		require.NoError(t, json.Unmarshal([]byte(m[1]), &cfg))
		require.NotNil(t, cfg.OAuth)
		assert.Equal(t, app.ClientID, cfg.OAuth.ClientID)
		assert.Equal(t, oauthapp.Scope, cfg.OAuth.Scope)
		assert.Equal(t, app.RedirectURI, cfg.OAuth.RedirectURI)
		assert.Equal(t, "/login/oauth/authorize", cfg.OAuth.AuthorizeURL)
		csp := resp.Header.Get("Content-Security-Policy")
		sum := sha256.Sum256([]byte("(function(){performance.mark(`appStart`)})();"))
		assert.Contains(t, csp, "script-src 'self' 'sha256-"+base64.StdEncoding.EncodeToString(sum[:])+"';")
		assert.Contains(t, csp, "require-trusted-types-for 'script'")
	}

	// The UI's own routes (the OAuth callback included).
	rec := MakeRequest(t, NewRequest(t, "GET", "/-/next/callback?code=x&state=y"), http.StatusOK)
	document(t, rec.Result(), rec.Body.String())
	assert.Equal(t, "no-cache", rec.Header().Get("Cache-Control"))

	// A canonical URL: the classic page unless the browser opted in and
	// navigates to it.
	const issue = "/user2/repo1/issues/1"
	classic := func(t *testing.T, header ...string) {
		t.Helper()
		req := NewRequest(t, "GET", issue)
		for i := 0; i+1 < len(header); i += 2 {
			req.SetHeader(header[i], header[i+1])
		}
		rec := MakeRequest(t, req, http.StatusOK)
		assert.NotContains(t, rec.Body.String(), protocol.NextConfigElementID, "the classic page")
		assert.Contains(t, rec.Body.String(), "issue1", "the classic issue page")
	}
	classic(t)
	classic(t, "Sec-Fetch-Dest", "document")
	classic(t, "Cookie", "ui=next", "Sec-Fetch-Dest", "empty")
	classic(t, "Cookie", "ui=next")

	// Opting in sets the cookie.
	session := emptyTestSession(t)
	resp = session.MakeRequest(t, NewRequest(t, "GET", "/-/next/opt-in?redirect="+issue), http.StatusSeeOther)
	assert.Equal(t, issue, resp.Header().Get("Location"))
	assert.Contains(t, resp.Header().Get("Set-Cookie"), "ui=next")
	req := NewRequest(t, "GET", issue).SetHeader("Sec-Fetch-Dest", "document")
	rec = session.MakeRequest(t, req, http.StatusOK)
	document(t, rec.Result(), rec.Body.String())
	assert.Equal(t, "private, no-cache", rec.Header().Get("Cache-Control"))
	assert.Contains(t, strings.Join(rec.Header().Values("Vary"), ","), "Cookie")
	// Routes the UI does not support stay classic.
	req = NewRequest(t, "GET", "/user2/repo1/issues/new").SetHeader("Sec-Fetch-Dest", "document")
	rec = session.MakeRequest(t, req, http.StatusSeeOther) // upstream: sign in first
	assert.NotContains(t, rec.Body.String(), protocol.NextConfigElementID)
	req = NewRequest(t, "GET", "/user2/repo1/milestones").SetHeader("Sec-Fetch-Dest", "document")
	rec = session.MakeRequest(t, req, http.StatusOK)
	assert.NotContains(t, rec.Body.String(), protocol.NextConfigElementID)
	// Opting out clears it.
	session.MakeRequest(t, NewRequest(t, "POST", "/-/next/opt-out"), http.StatusSeeOther)
	req = NewRequest(t, "GET", issue).SetHeader("Sec-Fetch-Dest", "document")
	rec = session.MakeRequest(t, req, http.StatusOK)
	assert.NotContains(t, rec.Body.String(), protocol.NextConfigElementID)

	// /-/next/config is the inlined configuration.
	resp = MakeRequest(t, NewRequest(t, "GET", "/-/next/config"), http.StatusOK)
	var cfg protocol.NextConfig
	require.NoError(t, json.Unmarshal(resp.Body.Bytes(), &cfg))
	assert.Equal(t, app.ClientID, cfg.OAuth.ClientID)
}
