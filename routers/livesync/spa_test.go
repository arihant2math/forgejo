// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"forgejo.org/modules/json"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/test"
	"forgejo.org/services/livesync/protocol"

	"github.com/andybalholm/brotli"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// bootScript is an inline script like F1's splash (it references the base
// in a template literal).
const bootScript = "(function(){performance.mark(`appStart`);window.base=`/-/next/`})();"

// writeDist writes a fixture build like next/dist and returns its path.
func writeDist(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"index.html": `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Forgejo</title>
<link rel="icon" href="data:,">
<script>` + bootScript + `</script>
  <script type="module" crossorigin src="/-/next/assets/index-abc.js"></script><link rel="modulepreload" crossorigin href="/-/next/assets/vendor-def.js">
  <style>.x{background:url(/-/next/assets/bg.svg)}</style>
</head>
<body><div id="root"></div></body>
</html>
`,
		"assets/index-abc.js":     "const B=`/-/next/`;const C=\"/-/next/\";import(`./vendor-def.js`);const D=\"/-/next/assets/x\";" + strings.Repeat("// padding so that it is compressed\n", 40),
		"assets/index-abc.js.map": `{"version":3}`,
		"assets/vendor-def.js":    "export const v=1;",
		"assets/bg.svg":           `<svg xmlns="http://www.w3.org/2000/svg"/>`,
		"assets/font.woff2":       "wOF2binary",
		"sw.js":                   "self.addEventListener('fetch',()=>{});const base='/-/next/';",
		"favicon.svg":             `<svg xmlns="http://www.w3.org/2000/svg"/>`,
		".vite/manifest.json":     `{"index.html":{}}`,
	}
	for name, content := range files {
		p := filepath.Join(dir, filepath.FromSlash(name))
		require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o755))
		require.NoError(t, os.WriteFile(p, []byte(content), 0o644))
	}
	return dir
}

// spaHandler is the running handler with the fixture build.
func spaHandler(t *testing.T, dir string, inner http.Handler) *handler {
	t.Helper()
	s := newSPA(dir)
	return &handler{inner: inner, own: newRoutes(inner, s), spa: s, answers: newAnswers()}
}

func get(t *testing.T, h http.Handler, path string, header ...string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestSPARoute(t *testing.T) {
	for p, want := range map[string]bool{
		"/":                         true,
		"/notifications":            true,
		"/issues":                   true,
		"/pulls":                    true,
		"/user2/repo1/issues":       true,
		"/user2/repo1/issues/1":     true,
		"/user2/repo1/pulls/12":     true,
		"/user2/repo1.wiki/issues":  false, // not a usable repository name
		"/user2/repo1/issues/new":   false,
		"/user2/repo1/issues/0":     false,
		"/user2/repo1/issues/1/x":   false,
		"/user2/repo1":              false,
		"/api/v1/issues":            false, // reserved owner names are upstream's routes
		"/user/settings/issues":     false,
		"/admin/repo1/pulls":        false,
		"/-/next/issues":            false,
		"/user2/repo1/milestones":   false,
		"/explore/repos/issues":     false,
		"/org/org3/issues":          false,
		"/user2/repo1/issues/1.png": false,
	} {
		assert.Equal(t, want, spaRoute(p), p)
	}
}

func TestRewriteBase(t *testing.T) {
	js := []byte("a=`/-/next/`;b=\"/-/next/\";c='/-/next/';d=\"/-/next/assets/x.js\";e=`/-/nextx/`")
	assert.Equal(t, js, rewriteBase(js, "x.js", ""), "no sub-path: unchanged")
	assert.Equal(t, "a=`/sub/-/next/`;b=\"/sub/-/next/\";c='/sub/-/next/';d=\"/-/next/assets/x.js\";e=`/-/nextx/`",
		string(rewriteBase(js, "x.js", "/sub")), "only literals that are exactly the base")
	html := []byte(`<script src="/-/next/a.js"></script><link href='/-/next/b.js'><style>.x{background:url(/-/next/c.svg)}</style><script>x=` + "`/-/next/`" + `</script><p>/-/next/ text</p>`)
	assert.Equal(t, `<script src="/sub/-/next/a.js"></script><link href='/sub/-/next/b.js'><style>.x{background:url(/sub/-/next/c.svg)}</style><script>x=`+"`/sub/-/next/`"+`</script><p>/-/next/ text</p>`,
		string(rewriteBase(html, "index.html", "/sub")))
	css := []byte(`.a{background:url(/-/next/a.svg)}.b{background:url("/-/next/b.svg")}`)
	assert.Equal(t, `.a{background:url(/sub/-/next/a.svg)}.b{background:url("/sub/-/next/b.svg")}`, string(rewriteBase(css, "a.css", "/sub")))
	manifest := []byte(`{"start_url":"/-/next/","scope":"/-/next/x"}`)
	assert.JSONEq(t, `{"start_url":"/sub/-/next/","scope":"/sub/-/next/x"}`, string(rewriteBase(manifest, "app.webmanifest", "/sub")))
	png := []byte(`"/-/next/"`)
	assert.Equal(t, png, rewriteBase(png, "a.png", "/sub"), "binary files are never rewritten")
}

func TestDocumentCSP(t *testing.T) {
	doc := []byte(`<head><script>one()</script><script type="module" src="/a.js"></script><script type="application/json" id="c">{"a":1}</script><SCRIPT type=module>two()</SCRIPT></head>`)
	csp := documentCSP(doc)
	hash := func(s string) string {
		sum := sha256.Sum256([]byte(s))
		return "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
	}
	assert.Contains(t, csp, "script-src 'self' "+hash("one()")+" "+hash("two()")+";")
	assert.NotContains(t, csp, hash(`{"a":1}`), "data blocks are not hashed")
	assert.NotContains(t, csp, "unsafe-eval")
	assert.Contains(t, csp, "require-trusted-types-for 'script'")
	assert.Contains(t, csp, "trusted-types forgejo-next default")
	assert.Contains(t, csp, "object-src 'none'")
	assert.Contains(t, csp, "connect-src 'self'")
}

func TestSPAServing(t *testing.T) {
	for _, sub := range []string{"", "/sub"} {
		t.Run("sub="+sub, func(t *testing.T) {
			defer test.MockVariableValue(&setting.AppSubURL, sub)()
			defer test.MockVariableValue(&setting.AppURL, "https://example.com"+sub+"/")()
			h := spaHandler(t, writeDist(t), innerMarker)

			// Assets: immutable, typed, compressed, conditional.
			rec := get(t, h, sub+"/-/next/assets/index-abc.js", "Accept-Encoding", "gzip, br")
			require.Equal(t, http.StatusOK, rec.Code)
			assert.Equal(t, "public, max-age=31536000, immutable", rec.Header().Get("Cache-Control"))
			assert.Equal(t, "text/javascript; charset=utf-8", rec.Header().Get("Content-Type"))
			assert.Equal(t, "br", rec.Header().Get("Content-Encoding"))
			assert.Contains(t, rec.Header().Values("Vary"), "Accept-Encoding")
			js, err := io.ReadAll(brotli.NewReader(rec.Body))
			require.NoError(t, err)
			assert.Contains(t, string(js), "const B=`"+sub+"/-/next/`;const C=\""+sub+"/-/next/\";")
			assert.Contains(t, string(js), `const D="/-/next/assets/x"`, "only the base literal is rewritten")
			etag := rec.Header().Get("ETag")
			require.NotEmpty(t, etag)
			assert.Equal(t, http.StatusNotModified, get(t, h, sub+"/-/next/assets/index-abc.js", "If-None-Match", etag).Code)
			plain := get(t, h, sub+"/-/next/assets/index-abc.js")
			assert.Empty(t, plain.Header().Get("Content-Encoding"))
			assert.Equal(t, js, plain.Body.Bytes())

			font := get(t, h, sub+"/-/next/assets/font.woff2")
			assert.Equal(t, http.StatusOK, font.Code)
			assert.Equal(t, "wOF2binary", font.Body.String())
			assert.Equal(t, "public, max-age=31536000, immutable", font.Header().Get("Cache-Control"))

			for _, p := range []string{"/-/next/assets/index-abc.js.map", "/-/next/assets/nope.js", "/-/next/.vite/manifest.json", "/-/next/assets/../index.html", "/-/next/nope.png", "/-/next/assets"} {
				assert.Equal(t, http.StatusNotFound, get(t, h, sub+p).Code, p)
			}

			// The service worker may control every page of the instance.
			rec = get(t, h, sub+"/-/next/sw.js")
			require.Equal(t, http.StatusOK, rec.Code)
			assert.Equal(t, sub+"/", rec.Header().Get("Service-Worker-Allowed"))
			assert.Equal(t, "no-cache", rec.Header().Get("Cache-Control"))
			assert.Contains(t, rec.Body.String(), "const base='"+sub+"/-/next/';")

			// Other root files.
			rec = get(t, h, sub+"/-/next/favicon.svg")
			assert.Equal(t, http.StatusOK, rec.Code)
			assert.Equal(t, "image/svg+xml", rec.Header().Get("Content-Type"))

			// The UI's own routes get the document.
			for _, p := range []string{"/-/next", "/-/next/", "/-/next/callback", "/-/next/gallery"} {
				rec = get(t, h, sub+p+"?code=x&state=y")
				require.Equal(t, http.StatusOK, rec.Code, p)
				assert.Equal(t, "no-cache", rec.Header().Get("Cache-Control"), p)
				checkDocument(t, rec, sub)
			}

			// Canonical routes: only opted-in document navigations.
			opted := []string{"Cookie", "ui=next", "Sec-Fetch-Dest", "document"}
			rec = get(t, h, sub+"/user2/repo1/issues/1", opted...)
			require.Equal(t, http.StatusOK, rec.Code)
			checkDocument(t, rec, sub)
			assert.Equal(t, "private, no-cache", rec.Header().Get("Cache-Control"))
			assert.ElementsMatch(t, []string{"Accept-Encoding", "Cookie", "Sec-Fetch-Dest"}, sortedVary(rec))
			assert.Equal(t, http.StatusOK, get(t, h, sub+"/", opted...).Code)
			if sub != "" {
				assert.Equal(t, http.StatusOK, get(t, h, sub, opted...).Code)
			}
			for name, header := range map[string][]string{
				"no cookie":       {"Sec-Fetch-Dest", "document"},
				"other cookie":    {"Cookie", "ui=classic", "Sec-Fetch-Dest", "document"},
				"fetch":           {"Cookie", "ui=next", "Sec-Fetch-Dest", "empty"},
				"no fetch header": {"Cookie", "ui=next"},
				"iframe":          {"Cookie", "ui=next", "Sec-Fetch-Dest", "iframe"},
			} {
				assert.Equal(t, 299, get(t, h, sub+"/user2/repo1/issues/1", header...).Code, name)
			}
			for _, p := range []string{"/user2/repo1/issues/new", "/api/v1/issues", "/user2/repo1"} {
				assert.Equal(t, 299, get(t, h, sub+p, opted...).Code, p)
			}
			req := httptest.NewRequest(http.MethodPost, sub+"/user2/repo1/issues/1", nil)
			req.Header.Set("Cookie", "ui=next")
			req.Header.Set("Sec-Fetch-Dest", "document")
			rec = httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			assert.Equal(t, 299, rec.Code, "only GET and HEAD")
		})
	}
}

func sortedVary(rec *httptest.ResponseRecorder) []string {
	var res []string
	for _, v := range rec.Header().Values("Vary") {
		for part := range strings.SplitSeq(v, ",") {
			res = append(res, strings.TrimSpace(part))
		}
	}
	return res
}

// checkDocument checks index.html as served: rewritten, with the config
// block and the CSP hashing exactly its inline script.
func checkDocument(t *testing.T, rec *httptest.ResponseRecorder, sub string) {
	t.Helper()
	body := rec.Body.String()
	assert.Equal(t, "text/html; charset=utf-8", rec.Header().Get("Content-Type"))
	assert.Contains(t, body, `src="`+sub+`/-/next/assets/index-abc.js"`)
	assert.Contains(t, body, `href="`+sub+`/-/next/assets/vendor-def.js"`)
	assert.Contains(t, body, `url(`+sub+`/-/next/assets/bg.svg)`)
	assert.Contains(t, body, `<link rel="icon" href="`+sub+`/assets/img/favicon.svg" type="image/svg+xml">`)
	m := regexp.MustCompile(`<script type="application/json" id="forgejo-next-config">(.*?)</script>`).FindStringSubmatch(body)
	require.NotNil(t, m, "config block")
	assert.Less(t, strings.Index(body, `<meta charset="utf-8">`), strings.Index(body, m[0]), "after the charset")
	var cfg protocol.NextConfig
	require.NoError(t, json.Unmarshal([]byte(m[1]), &cfg))
	assert.Equal(t, sub, cfg.AppSubURL)
	assert.Equal(t, sub+"/-/next/", cfg.Base)
	assert.Equal(t, protocol.ProtocolVersion, cfg.Protocol)
	boot := strings.ReplaceAll(bootScript, "`/-/next/`", "`"+sub+"/-/next/`")
	assert.Contains(t, body, "<script>"+boot+"</script>")
	sum := sha256.Sum256([]byte(boot))
	assert.Contains(t, rec.Header().Get("Content-Security-Policy"), "script-src 'self' 'sha256-"+base64.StdEncoding.EncodeToString(sum[:])+"';")
	assert.NotEmpty(t, rec.Header().Get("ETag"))
}

func TestSPANoBuild(t *testing.T) {
	h := spaHandler(t, "", innerMarker)
	assert.False(t, h.spa.available())
	for _, p := range []string{"/-/next", "/-/next/callback", "/-/next/assets/a.js", "/-/next/sw.js"} {
		assert.Equal(t, http.StatusNotFound, get(t, h, p).Code, p)
	}
	assert.Equal(t, 299, get(t, h, "/user2/repo1/issues/1", "Cookie", "ui=next", "Sec-Fetch-Dest", "document").Code,
		"without a build opted-in browsers get the classic UI")
	assert.Equal(t, http.StatusOK, get(t, h, "/-/next/config").Code, "the config is served anyway")

	missing := spaHandler(t, filepath.Join(t.TempDir(), "nope"), innerMarker)
	assert.False(t, missing.spa.available())
	empty := spaHandler(t, t.TempDir(), innerMarker)
	assert.False(t, empty.spa.available(), "a directory without index.html")
}

func TestOptInOut(t *testing.T) {
	for _, sub := range []string{"", "/sub"} {
		defer test.MockVariableValue(&setting.AppSubURL, sub)()
		defer test.MockVariableValue(&setting.AppURL, "https://example.com"+sub+"/")()
		h := spaHandler(t, "", innerMarker)
		rec := get(t, h, sub+"/-/next/opt-in?redirect="+sub+"/user2/repo1/issues/1")
		assert.Equal(t, http.StatusSeeOther, rec.Code)
		assert.Equal(t, sub+"/user2/repo1/issues/1", rec.Header().Get("Location"))
		cookie := rec.Result().Cookies()[0]
		assert.Equal(t, "ui", cookie.Name)
		assert.Equal(t, "next", cookie.Value)
		assert.Equal(t, sub+"/", cookie.Path)
		assert.True(t, cookie.Secure)
		assert.Equal(t, http.SameSiteLaxMode, cookie.SameSite)
		assert.Positive(t, cookie.MaxAge)

		req := httptest.NewRequest(http.MethodPost, sub+"/-/next/opt-out", nil)
		rec = httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusSeeOther, rec.Code)
		assert.Equal(t, sub+"/", rec.Header().Get("Location"))
		assert.Negative(t, rec.Result().Cookies()[0].MaxAge)
	}
	defer test.MockVariableValue(&setting.AppSubURL, "/sub")()
	for target, want := range map[string]string{
		"":                       "/sub/",
		"/sub/x?y=1":             "/sub/x?y=1",
		"/sub":                   "/sub",
		"/other":                 "/sub/",
		"//evil.example/x":       "/sub/",
		"https://evil.example/x": "/sub/",
		"/\\evil.example":        "/sub/",
		"x":                      "/sub/",
	} {
		assert.Equal(t, want, localRedirect(target), target)
	}
}

func TestInsertConfig(t *testing.T) {
	cfg := []byte(`{"a":"</script>"}`)
	assert.Equal(t, "<html><head><meta charset=\"utf-8\">\n<script type=\"application/json\" id=\"forgejo-next-config\">"+string(cfg)+"</script><title>x</title>",
		string(insertConfig([]byte(`<html><head><meta charset="utf-8"><title>x</title>`), cfg)))
	assert.Equal(t, "<HEAD>\n<script type=\"application/json\" id=\"forgejo-next-config\">"+string(cfg)+"</script><title>x</title>",
		string(insertConfig([]byte(`<HEAD><title>x</title>`), cfg)))
	out, err := json.Marshal(map[string]string{"a": "</script><b>&"})
	require.NoError(t, err)
	assert.False(t, bytes.Contains(out, []byte("</script>")), "the config JSON is HTML-safe: %s", out)
}
