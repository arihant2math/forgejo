// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	repo_model "forgejo.org/models/repo"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/json"
	"forgejo.org/modules/log"
	"forgejo.org/modules/setting"
	livesync_service "forgejo.org/services/livesync"
	"forgejo.org/services/livesync/protocol"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/gzip"
)

// Serving the Next UI (PLAN §4.10; the client contract is documented in
// services/livesync/protocol/next.go).
//
// The build (next/dist: index.html, assets/, optionally sw.js and other
// root files) comes from [livesync] ASSETS_DIR or, without it, from the
// copy embedded with the livesync_embed build tag (spa_embed.go). Without
// either, nothing below /-/next/ is served (404) and opted-in browsers get
// the classic UI.

// spaRoute is a canonical Forgejo URL the Next UI renders: a document
// navigation to it from a browser that opted in gets the UI's index.html.
// Segments: a literal, "{owner}" (a usable user or organization name),
// "{repo}" (a usable repository name) or "{index}" (a number). Extend this
// table when the UI supports a route (F3–F7).
var spaRoutes = [][]string{
	{},                // the dashboard
	{"notifications"}, // the inbox
	{"issues"},        // the viewer's issues
	{"pulls"},         // the viewer's pull requests
	{"{owner}", "{repo}", "issues"},
	{"{owner}", "{repo}", "issues", "{index}"},
	{"{owner}", "{repo}", "pulls"},
	{"{owner}", "{repo}", "pulls", "{index}"},
}

// spaRoute reports whether p (normalised, without the sub-path) is a
// route of spaRoutes.
func spaRoute(p string) bool {
	segs := strings.Split(strings.Trim(p, "/"), "/")
	if p == "/" || p == "" {
		segs = nil
	}
next:
	for _, route := range spaRoutes {
		if len(route) != len(segs) {
			continue
		}
		for i, want := range route {
			seg := segs[i]
			switch want {
			case "{owner}":
				if user_model.IsUsableUsername(seg) != nil {
					continue next
				}
			case "{repo}":
				if seg == "" || repo_model.IsUsableRepoName(seg) != nil {
					continue next
				}
			case "{index}":
				if n, err := strconv.ParseInt(seg, 10, 64); err != nil || n <= 0 {
					continue next
				}
			default:
				if seg != want {
					continue next
				}
			}
		}
		return true
	}
	return false
}

// optedIn reports whether req is a document navigation (Sec-Fetch-Dest:
// document, GET or HEAD) of a browser with the opt-in cookie.
func optedIn(req *http.Request) bool {
	if req.Method != http.MethodGet && req.Method != http.MethodHead {
		return false
	}
	if req.Header.Get("Sec-Fetch-Dest") != "document" {
		return false
	}
	c, err := req.Cookie(protocol.NextUICookie)
	return err == nil && c.Value == protocol.NextUICookieValue
}

// spa serves the build.
type spa struct {
	fsys   fs.FS // nil: no build
	source string

	mu      sync.Mutex
	index   *spaBody            // the last rendered index.html
	classic *spaBody            // the last rendered classic.js (classic.go)
	files   map[string]*spaBody // text files (rewritten for the sub-path), by path
	build   string              // index.html's version the cache was last warmed for

	warms sync.WaitGroup // running warm goroutines (tests wait for them)
}

// spaBody is a response body with its compressed variants.
//
// Compression never runs on the request path at the best quality (brotli
// q11 compresses about 0.5 MB/s): the variants come from the build's
// precompressed siblings (<file>.br, <file>.gz, when the file needs no
// sub-path rewrite), or are computed in the background (warm, or the first
// request), at most compressSlots at a time; until they are ready a request
// gets a fast on-the-fly compression (brotli q4, as bootstrap responses).
type spaBody struct {
	key   string // what it was made from (modification time, size, config)
	ctype string
	raw   []byte
	etag  string
	csp   string // index.html only

	once     sync.Once
	started  atomic.Bool                 // a request started compress
	variants atomic.Pointer[spaVariants] // nil until compressed
}

// spaVariants are a body's precompressed encodings (nil: not worth it).
type spaVariants struct {
	br, gz []byte
}

// compressSlots bounds the best-quality compressions running at once
// (after a deploy every file of the new build needs one).
var compressSlots = make(chan struct{}, 2)

// minCompressed: smaller bodies are sent as they are.
const minCompressed = 512

func newSPA(dir string) *spa {
	s := &spa{files: map[string]*spaBody{}}
	switch {
	case dir != "":
		if st, err := os.Stat(dir); err != nil || !st.IsDir() {
			log.Warn("livesync: [livesync] ASSETS_DIR %q is not a directory; the Next UI is not served", dir)
			return s
		}
		s.fsys, s.source = os.DirFS(dir), dir
	case embeddedSPA() != nil:
		s.fsys, s.source = embeddedSPA(), "embedded"
	default:
		return s
	}
	if _, err := fs.Stat(s.fsys, "index.html"); err != nil {
		log.Warn("livesync: the Next UI build in %s has no index.html; the Next UI is not served", s.source)
		s.fsys = nil
		return s
	}
	s.startWarm()
	return s
}

// startWarm runs warm in the background.
func (s *spa) startWarm() {
	s.warms.Go(s.warm)
}

// buildVersion identifies the build on disk by its index.html (Vite
// writes it last; a deploy replaces it).
func (s *spa) buildVersion() (string, error) {
	st, err := fs.Stat(s.fsys, "index.html")
	if err != nil {
		return "", err
	}
	return st.ModTime().String() + "/" + strconv.FormatInt(st.Size(), 10), nil
}

// available reports whether there is a build to serve.
func (s *spa) available() bool { return s != nil && s.fsys != nil }

// warm renders index.html and compresses the build's text files, so that
// the first visitors do not wait for brotli; run at start and whenever the
// build changes (renderIndex notices). It also drops the cached files that
// are no longer in the build, so that the cache holds what is on disk
// (older builds' hashed files stay cached only as long as they are kept
// next to the new ones).
func (s *spa) warm() {
	if v, err := s.buildVersion(); err == nil {
		s.mu.Lock()
		s.build = v
		s.mu.Unlock()
	}
	seen := map[string]bool{}
	_ = fs.WalkDir(s.fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !servable(p) || !textType(p) {
			return nil
		}
		if info, err := d.Info(); err != nil || info.Size() > maxCachedFile {
			return nil
		}
		seen[p] = true
		if b, err := s.file(p); err == nil {
			b.compress()
		}
		return nil
	})
	s.mu.Lock()
	for p := range s.files {
		if !seen[p] {
			delete(s.files, p)
		}
	}
	s.mu.Unlock()
	if b, err := s.renderIndex(); err == nil {
		b.compress()
	}
}

// servable reports whether a build file may be served: not the Vite
// manifest, not source maps (written but not referenced, F1), not the
// precompressed siblings (served as the Content-Encoding of their file),
// no dot files.
func servable(p string) bool {
	switch path.Ext(p) {
	case ".map", ".br", ".gz":
		return false
	}
	if p == "index.html" {
		return false
	}
	for seg := range strings.SplitSeq(p, "/") {
		if strings.HasPrefix(seg, ".") {
			return false
		}
	}
	return true
}

// contentType returns the Content-Type of a build file.
func contentType(p string) string {
	switch path.Ext(p) {
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".html":
		return "text/html; charset=utf-8"
	case ".json":
		return "application/json"
	case ".webmanifest":
		return "application/manifest+json"
	case ".svg":
		return "image/svg+xml"
	case ".wasm":
		return "application/wasm"
	}
	if t := mime.TypeByExtension(path.Ext(p)); t != "" {
		return t
	}
	return "application/octet-stream"
}

// textType: files that are rewritten for the sub-path and compressed.
func textType(p string) bool {
	switch path.Ext(p) {
	case ".js", ".mjs", ".css", ".html", ".json", ".webmanifest", ".svg", ".txt", ".wasm":
		return true
	}
	return false
}

// maxCachedFile bounds the files kept in memory (rewritten, compressed).
const maxCachedFile = 8 << 20

const nextBase = nextPrefix + "/"

// rewriteBase points the build's absolute "/-/next/" URLs at the sub-path:
// string literals that are exactly the base (Vite's base, BASE_URL) in
// scripts, attribute values and CSS urls starting with it in HTML and CSS,
// and JSON string values starting with it.
func rewriteBase(data []byte, p, sub string) []byte {
	if sub == "" || !bytes.Contains(data, []byte(nextBase)) {
		return data
	}
	var pairs []string
	lit := func(prefix, suffix string) {
		pairs = append(pairs, prefix+nextBase+suffix, prefix+sub+nextBase+suffix)
	}
	switch path.Ext(p) {
	case ".js", ".mjs":
		lit(`"`, `"`)
		lit(`'`, `'`)
		lit("`", "`")
	case ".html":
		lit(`="`, "")
		lit(`='`, "")
		lit(`"`, `"`)
		lit(`'`, `'`)
		lit("`", "`")
		lit("url(", "")
		lit(`url("`, "")
	case ".css":
		lit("url(", "")
		lit(`url("`, "")
		lit(`url('`, "")
	case ".json", ".webmanifest":
		lit(`"`, "")
	default:
		return data
	}
	return []byte(strings.NewReplacer(pairs...).Replace(string(data)))
}

// file returns a text file of the build, rewritten for the sub-path (cached
// until the file changes).
func (s *spa) file(p string) (*spaBody, error) {
	st, err := fs.Stat(s.fsys, p)
	if err != nil {
		return nil, err
	}
	if st.IsDir() {
		return nil, fs.ErrNotExist
	}
	key := st.ModTime().String() + "/" + strconv.FormatInt(st.Size(), 10) + "/" + setting.AppSubURL
	s.mu.Lock()
	b := s.files[p]
	s.mu.Unlock()
	if b != nil && b.key == key {
		return b, nil
	}
	data, err := fs.ReadFile(s.fsys, p)
	if err != nil {
		return nil, err
	}
	rewritten := rewriteBase(data, p, setting.AppSubURL)
	b = &spaBody{key: key, ctype: contentType(p), raw: rewritten, etag: etag(rewritten)}
	if bytes.Equal(rewritten, data) {
		s.precompressed(b, p, st.ModTime())
	}
	s.mu.Lock()
	s.files[p] = b
	s.mu.Unlock()
	return b, nil
}

func etag(data []byte) string {
	sum := sha256.Sum256(data)
	return `W/"` + hex.EncodeToString(sum[:16]) + `"`
}

// precompressed takes b's variants from the build's <p>.br and <p>.gz
// when both exist and are not older than the file (a build step may write
// them; F1/F5).
func (s *spa) precompressed(b *spaBody, p string, modTime time.Time) {
	var v spaVariants
	for _, enc := range []struct {
		ext string
		dst *[]byte
	}{{".br", &v.br}, {".gz", &v.gz}} {
		st, err := fs.Stat(s.fsys, p+enc.ext)
		if err != nil || st.IsDir() || st.ModTime().Before(modTime) || st.Size() > maxCachedFile {
			return
		}
		data, err := fs.ReadFile(s.fsys, p+enc.ext)
		if err != nil {
			return
		}
		*enc.dst = data
	}
	b.once.Do(func() { b.variants.Store(&v) })
}

// compress computes the best-quality variants (once; blocking).
func (b *spaBody) compress() {
	b.once.Do(func() {
		v := &spaVariants{}
		if len(b.raw) >= minCompressed {
			compressSlots <- struct{}{}
			defer func() { <-compressSlots }()
			var br bytes.Buffer
			bw := brotli.NewWriterLevel(&br, brotli.BestCompression)
			_, _ = bw.Write(b.raw)
			_ = bw.Close()
			var gz bytes.Buffer
			gw, _ := gzip.NewWriterLevel(&gz, gzip.BestCompression)
			_, _ = gw.Write(b.raw)
			_ = gw.Close()
			v.br, v.gz = br.Bytes(), gz.Bytes()
		}
		b.variants.Store(v)
	})
}

// write sends b (compressed when the client accepts it), answering
// If-None-Match with 304. Before the best-quality variants are ready it
// starts them in the background and compresses this response quickly.
func (b *spaBody) write(w http.ResponseWriter, req *http.Request) {
	h := w.Header()
	h.Set("Content-Type", b.ctype)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("ETag", b.etag)
	h.Add("Vary", "Accept-Encoding")
	if match := req.Header.Get("If-None-Match"); match != "" && etagMatches(match, b.etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	enc := negotiateEncoding(req.Header.Get("Accept-Encoding"))
	v := b.variants.Load()
	if v == nil {
		if b.started.CompareAndSwap(false, true) {
			go b.compress()
		}
		if len(b.raw) >= minCompressed && (enc == "br" || enc == "gzip") {
			h.Set("Content-Encoding", enc)
			w.WriteHeader(http.StatusOK)
			if req.Method == http.MethodHead {
				return
			}
			var cw io.WriteCloser
			if enc == "br" {
				cw = brotli.NewWriterOptions(w, brotli.WriterOptions{Quality: 4, LGWin: 18})
			} else {
				cw, _ = gzip.NewWriterLevel(w, gzip.DefaultCompression)
			}
			_, _ = cw.Write(b.raw)
			_ = cw.Close()
			return
		}
		v = &spaVariants{}
	}
	body := b.raw
	switch {
	case enc == "br" && v.br != nil:
		h.Set("Content-Encoding", "br")
		body = v.br
	case enc == "gzip" && v.gz != nil:
		h.Set("Content-Encoding", "gzip")
		body = v.gz
	}
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusOK)
	if req.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}

// etagMatches implements If-None-Match's weak comparison.
func etagMatches(header, tag string) bool {
	want := strings.TrimPrefix(tag, "W/")
	for part := range strings.SplitSeq(header, ",") {
		part = strings.TrimSpace(part)
		if part == "*" || strings.TrimPrefix(part, "W/") == want {
			return true
		}
	}
	return false
}

// nextConfig is the configuration inlined into index.html.
func nextConfig() *protocol.NextConfig {
	cfg := &protocol.NextConfig{
		AppURL: setting.AppURL, AppSubURL: setting.AppSubURL, Base: setting.AppSubURL + nextBase,
		AppName: setting.AppName, Version: setting.AppVer, Protocol: protocol.ProtocolVersion,
	}
	if app := livesync_service.OAuthApp(); app != nil {
		cfg.OAuth = &protocol.NextOAuth{
			ClientID: app.ClientID, RedirectURI: app.RedirectURI, Scope: app.Scope,
			AuthorizeURL: setting.AppSubURL + "/login/oauth/authorize",
			TokenURL:     setting.AppSubURL + "/login/oauth/access_token",
		}
	}
	return cfg
}

var (
	reScript    = regexp.MustCompile(`(?is)<script\b([^>]*)>(.*?)</script\s*>`)
	reSrcAttr   = regexp.MustCompile(`(?i)\ssrc\s*=`)
	reTypeAttr  = regexp.MustCompile(`(?i)\stype\s*=\s*["']?([^"'\s>]+)`)
	reMetaChars = regexp.MustCompile(`(?i)<meta\s+charset\s*=[^>]*>`)
)

// renderIndex renders index.html: rewritten for the sub-path, with
// Forgejo's favicon and the configuration block, and the CSP that allows
// exactly its inline scripts.
func (s *spa) renderIndex() (*spaBody, error) {
	st, err := fs.Stat(s.fsys, "index.html")
	if err != nil {
		return nil, err
	}
	cfg, err := json.Marshal(nextConfig())
	if err != nil {
		return nil, err
	}
	version := st.ModTime().String() + "/" + strconv.FormatInt(st.Size(), 10)
	key := version + "/" + setting.AppSubURL + "/" + string(cfg)
	s.mu.Lock()
	b := s.index
	if s.build != "" && s.build != version {
		// A new build was deployed into the directory: compress it in
		// the background and forget the files that are gone.
		s.build = version
		s.startWarm()
	}
	s.mu.Unlock()
	if b != nil && b.key == key {
		return b, nil
	}
	data, err := fs.ReadFile(s.fsys, "index.html")
	if err != nil {
		return nil, err
	}
	data = rewriteBase(data, "index.html", setting.AppSubURL)
	// F1 ships an empty icon (no request at boot); use Forgejo's.
	data = bytes.Replace(data, []byte(`<link rel="icon" href="data:,">`),
		[]byte(`<link rel="icon" href="`+setting.AppSubURL+`/assets/img/favicon.svg" type="image/svg+xml">`), 1)
	data = insertConfig(data, cfg)
	b = &spaBody{key: key, ctype: "text/html; charset=utf-8", raw: data, etag: etag(data), csp: documentCSP(data)}
	s.mu.Lock()
	s.index = b
	s.mu.Unlock()
	return b, nil
}

// insertConfig adds the JSON data block with the configuration right
// after <meta charset> (or <head>). The JSON is HTML-safe: Marshal
// escapes <, > and &.
func insertConfig(data, cfg []byte) []byte {
	block := []byte(`<script type="application/json" id="` + protocol.NextConfigElementID + `">` + string(cfg) + `</script>`)
	at := -1
	if loc := reMetaChars.FindIndex(data); loc != nil {
		at = loc[1]
	} else if i := bytes.Index(bytes.ToLower(data), []byte("<head>")); i >= 0 {
		at = i + len("<head>")
	}
	if at < 0 {
		return append(block, data...)
	}
	res := make([]byte, 0, len(data)+len(block)+1)
	res = append(res, data[:at]...)
	res = append(res, '\n')
	res = append(res, block...)
	return append(res, data[at:]...)
}

// documentCSP is the Content-Security-Policy of the UI's document (PLAN
// §4.9): scripts from the origin and the document's inline scripts by hash
// only; Trusted Types enforced. Styles may be inline (the boot script
// inserts a <style>; React sets style attributes). Images and media from
// anywhere (avatars, markdown); connections to the origin only (sync
// sessions, API).
func documentCSP(doc []byte) string {
	var hashes []string
	for _, m := range reScript.FindAllSubmatch(doc, -1) {
		attrs := m[1]
		if reSrcAttr.Match(attrs) {
			continue
		}
		if t := reTypeAttr.FindSubmatch(attrs); t != nil && strings.HasSuffix(strings.ToLower(string(t[1])), "json") {
			continue // a data block: never executed
		}
		sum := sha256.Sum256(m[2])
		hashes = append(hashes, "'sha256-"+base64.StdEncoding.EncodeToString(sum[:])+"'")
	}
	return strings.Join([]string{
		"default-src 'self'",
		"script-src 'self' " + strings.Join(hashes, " "),
		"style-src 'self' 'unsafe-inline'",
		"img-src * data: blob:",
		"media-src * data: blob:",
		"font-src 'self' data:",
		"connect-src 'self'",
		"worker-src 'self' blob:",
		"manifest-src 'self'",
		"frame-src 'self'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'self'",
		"require-trusted-types-for 'script'",
		"trusted-types " + protocol.TrustedTypesPolicy,
	}, "; ")
}

// serveIndex answers with the UI's document. Canonical URLs (canonical:
// the same URL serves the classic UI to other browsers) are private and
// vary with the cookie and the request's destination.
func (s *spa) serveIndex(w http.ResponseWriter, req *http.Request, canonical bool) {
	b, err := s.renderIndex()
	if err != nil {
		log.Error("livesync: render the Next UI's index.html: %v", err)
		writeJSON(w, http.StatusInternalServerError, errorResponse{Message: http.StatusText(http.StatusInternalServerError)})
		return
	}
	h := w.Header()
	h.Set("Content-Security-Policy", b.csp)
	h.Set("Referrer-Policy", "same-origin")
	if canonical {
		// The same URL is the classic page for other browsers: never
		// stored in a shared cache, and the cache key includes the
		// cookie and the destination.
		h.Set("Cache-Control", "private, no-cache")
		h.Add("Vary", "Cookie")
		h.Add("Vary", "Sec-Fetch-Dest")
	} else {
		// Revalidated every time (ETag): a deploy is picked up at once
		// (F1: a failed chunk load reloads the document once).
		h.Set("Cache-Control", "no-cache")
	}
	b.write(w, req)
}

// document reports whether req is an opted-in document navigation to a
// canonical route the UI supports (and there is a build): it gets the UI's
// document instead of the classic page.
func (s *spa) document(req *http.Request) bool {
	if !optedIn(req) || !s.available() {
		return false
	}
	p := normalizeSlashes(req.URL.Path)
	if sub := setting.AppSubURL; sub != "" {
		if p == sub {
			p = "/"
		} else if strings.HasPrefix(p, sub+"/") {
			p = p[len(sub):]
		}
	}
	return spaRoute(p)
}

// serveAsset answers GET /-/next/assets/*: hashed, immutable files.
func (s *spa) serveAsset(w http.ResponseWriter, req *http.Request) {
	p := strings.TrimPrefix(req.URL.Path, nextBase)
	if !s.available() || !fs.ValidPath(p) || !servable(p) {
		notFound(w, req)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	s.serveFile(w, req, p)
}

// serveServiceWorker answers GET /-/next/sw.js (F5): revalidated on every
// update check, allowed to control every page of the instance.
func (s *spa) serveServiceWorker(w http.ResponseWriter, req *http.Request) {
	if !s.available() {
		notFound(w, req)
		return
	}
	w.Header().Set("Service-Worker-Allowed", setting.AppSubURL+"/")
	w.Header().Set("Cache-Control", "no-cache")
	s.serveFile(w, req, "sw.js")
}

// serveRoot answers every other path below /-/next: a file at the build's
// root (no-cache), else — for a path without an extension — the document
// (the UI's own routes, /-/next/callback included).
func (s *spa) serveRoot(w http.ResponseWriter, req *http.Request) {
	if !s.available() {
		notFound(w, req)
		return
	}
	p := strings.TrimPrefix(strings.TrimPrefix(req.URL.Path, nextPrefix), "/")
	if p != "" && !strings.Contains(p, "/") && servable(p) {
		if _, err := fs.Stat(s.fsys, p); err == nil {
			w.Header().Set("Cache-Control", "no-cache")
			s.serveFile(w, req, p)
			return
		}
	}
	if path.Ext(p) != "" {
		notFound(w, req)
		return
	}
	s.serveIndex(w, req, false)
}

// serveFile serves a build file: text files from the cache, others from
// the file system.
func (s *spa) serveFile(w http.ResponseWriter, req *http.Request, p string) {
	if textType(p) {
		if st, err := fs.Stat(s.fsys, p); err == nil && st.Size() <= maxCachedFile {
			b, err := s.file(p)
			if err == nil {
				b.write(w, req)
				return
			}
		}
	}
	f, err := s.fsys.Open(p)
	if err != nil {
		notFound(w, req)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	rs, ok := f.(io.ReadSeeker)
	if err != nil || st.IsDir() || !ok {
		notFound(w, req)
		return
	}
	w.Header().Set("Content-Type", contentType(p))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, req, path.Base(p), st.ModTime(), rs)
}

// serveConfig answers GET /-/next/config: the configuration inlined into
// index.html (for development servers that do not serve it).
func serveConfig(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	_ = json.NewEncoder(w).Encode(nextConfig())
}

// optCookieMaxAge: the opt-in is remembered for a year.
const optCookieMaxAge = 365 * 24 * time.Hour

// serveOptIn and serveOptOut answer GET|POST /-/next/opt-in and opt-out:
// they set or clear the opt-in cookie and redirect (303) to ?redirect= (a
// path on this site; default: the instance's root). The cookie only
// chooses the UI, so the toggles need no CSRF protection.
func serveOptIn(w http.ResponseWriter, req *http.Request) { setOptIn(w, req, true) }

func serveOptOut(w http.ResponseWriter, req *http.Request) { setOptIn(w, req, false) }

func setOptIn(w http.ResponseWriter, req *http.Request, on bool) {
	c := &http.Cookie{
		Name: protocol.NextUICookie, Value: protocol.NextUICookieValue,
		Path: setting.AppSubURL + "/", MaxAge: int(optCookieMaxAge / time.Second),
		Secure: strings.HasPrefix(strings.ToLower(setting.AppURL), "https://"), SameSite: http.SameSiteLaxMode,
	}
	if !on {
		c.Value, c.MaxAge = "", -1
	}
	http.SetCookie(w, c)
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, req, localRedirect(req.URL.Query().Get("redirect")), http.StatusSeeOther)
}

// localRedirect returns target when it is a path on this site below the
// sub-path, else the instance's root.
func localRedirect(target string) string {
	root := setting.AppSubURL + "/"
	if target == "" || !strings.HasPrefix(target, "/") || strings.HasPrefix(target, "//") || strings.ContainsAny(target, "\\\r\n\t") {
		return root
	}
	u, err := url.Parse(target)
	if err != nil || u.IsAbs() || u.Host != "" {
		return root
	}
	if sub := setting.AppSubURL; sub != "" && u.Path != sub && !strings.HasPrefix(u.Path, sub+"/") {
		return root
	}
	return target
}

// errNoBuild: the UI is not served (no ASSETS_DIR, not embedded).
var errNoBuild = errors.New("the Next UI is not served: set [livesync] ASSETS_DIR to the build (next/dist) or build Forgejo with the livesync_embed tag")
