// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"bytes"
	"html/template"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	auth_model "forgejo.org/models/auth"
	"forgejo.org/modules/log"
	"forgejo.org/modules/setting"
	"forgejo.org/services/auth"
	livesync_service "forgejo.org/services/livesync"
)

// GET /-/sync/admin: livesync's operations page for site administrators
// (HTML, or JSON with ?format=json or Accept: application/json). It is
// served while livesync runs and while it is degraded (enabled but Init
// failed, e.g. capture triggers missing in INSTALL_MODE verify: Wrap then
// serves this page and /-/sync/health only, see degraded), and shows the
// state, the capture triggers with the DDL that installs or removes them
// (for DBAs), the pipeline positions and the sync sessions.
//
// Who may see it: a site administrator, signed in to the classic UI (the
// session is checked by asking upstream's admin-only /admin/system_status
// with the request's cookies — whatever the session provider, livesync
// never reads sessions itself), or with an access token with the
// read:admin scope in the Authorization header.

// adminPath is the page's path below the application root.
const adminPath = syncPrefix + "/admin"

// sessionProbePath is the upstream page used to check that the session's
// user is a site administrator: admin-only (else 403, or a redirect to the
// sign-in page) and small. Its body is a fragment starting with <dl
// (templates/admin/system_status.tmpl); any other answer — the
// "prohibited"/"activate" pages upstream renders with 200 for such
// accounts included — counts as not authorized. See SURFACE.md.
const sessionProbePath = "/admin/system_status"

// adminView is the page's data.
type adminView struct {
	*livesync_service.Status
	UI uiStatus `json:"ui"`
}

// uiStatus says whether and from where the Next UI is served.
type uiStatus struct {
	Served bool   `json:"served"`
	Source string `json:"source,omitempty"`
	Reason string `json:"reason,omitempty"`
	// ClassicHeader is the template that adds the Next UI's toggle and
	// prefetch hints to classic pages (classic.go).
	ClassicHeader string `json:"classic_header,omitempty"`
}

// serveAdmin returns the page's handler; inner is upstream's handler (for
// the session check), s the UI build (nil while degraded).
func serveAdmin(inner http.Handler, s *spa) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		if !adminAllowed(w, req, inner) {
			return
		}
		view := adminView{Status: livesync_service.CollectStatus(req.Context())}
		switch {
		case s.available():
			view.UI = uiStatus{Served: true, Source: s.source, ClassicHeader: classicHeader}
		case livesync_service.State() != livesync_service.StateRunning:
			view.UI = uiStatus{Reason: "livesync is not running"}
		default:
			view.UI = uiStatus{Reason: errNoBuild.Error()}
		}
		h := w.Header()
		h.Set("X-Frame-Options", "DENY")
		if wantsJSON(req) {
			writeJSON(w, http.StatusOK, view)
			return
		}
		var buf bytes.Buffer
		if err := adminTemplate.Execute(&buf, view); err != nil {
			log.Error("livesync: render the admin page: %v", err)
			writeJSON(w, http.StatusInternalServerError, errorResponse{Message: http.StatusText(http.StatusInternalServerError)})
			return
		}
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Cache-Control", "no-store")
		h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(buf.Bytes())
	}
}

func wantsJSON(req *http.Request) bool {
	if f := req.URL.Query().Get("format"); f != "" {
		return f == "json"
	}
	accept := req.Header.Get("Accept")
	return strings.Contains(accept, "application/json") && !strings.Contains(accept, "text/html")
}

// adminAllowed authorizes the request, or answers it (401/403, or a
// redirect to the sign-in page for a browser) and returns false.
func adminAllowed(w http.ResponseWriter, req *http.Request, inner http.Handler) bool {
	deny := func(status int, message string) bool {
		writeJSON(w, status, errorResponse{Message: message})
		return false
	}
	if req.Header.Get("Authorization") != "" {
		var result auth.AuthenticationResult
		switch out := authMethods.Verify(req, nil, nil).(type) {
		case *auth.AuthenticationSuccess:
			result = out.Result
		case *auth.AuthenticationError:
			log.Error("livesync: admin page authentication: %v", out.Error)
			return deny(http.StatusInternalServerError, http.StatusText(http.StatusInternalServerError))
		default:
			return deny(http.StatusUnauthorized, "a valid access token is required")
		}
		u := result.User()
		if u == nil {
			return deny(http.StatusUnauthorized, "a valid access token is required")
		}
		if aerr := checkAccount(req.Context(), u); aerr != nil {
			return deny(aerr.status, aerr.message)
		}
		if has, scope := result.Scope().Get(); has {
			if ok, err := scope.HasScope(auth_model.AccessTokenScopeReadAdmin); err != nil || !ok {
				return deny(http.StatusForbidden, "the token needs the read:admin scope")
			}
		}
		if !u.IsAdmin {
			return deny(http.StatusForbidden, "site administrators only")
		}
		return true
	}
	signIn := func() bool {
		if wantsJSON(req) {
			return deny(http.StatusUnauthorized, "sign in as a site administrator, or send an access token with the read:admin scope")
		}
		target := setting.AppSubURL + "/user/login?redirect_to=" + url.QueryEscape(setting.AppSubURL+adminPath)
		w.Header().Set("Cache-Control", "no-store")
		http.Redirect(w, req, target, http.StatusSeeOther)
		return false
	}
	if req.Header.Get("Cookie") == "" {
		return signIn()
	}
	switch status := sessionAdmin(req, inner); status {
	case http.StatusOK:
		return true
	case http.StatusUnauthorized:
		return signIn()
	default:
		return deny(http.StatusForbidden, "site administrators only")
	}
}

// sessionAdmin asks upstream whether the request's session belongs to a
// site administrator: 200 yes, 401 not signed in, 403 otherwise.
func sessionAdmin(req *http.Request, inner http.Handler) int {
	probe := req.Clone(req.Context())
	probe.Method = http.MethodGet
	probe.URL = &url.URL{Path: sessionProbePath}
	probe.RequestURI = sessionProbePath
	probe.Body, probe.ContentLength = http.NoBody, 0
	probe.Header.Del("Authorization")
	probe.Header.Del("Accept-Encoding")
	probe.Header.Set("Accept", "text/html")
	rec := &probeRecorder{header: http.Header{}}
	inner.ServeHTTP(rec, probe)
	switch {
	case rec.status == http.StatusOK && bytes.HasPrefix(bytes.TrimSpace(rec.body.Bytes()), []byte("<dl")):
		return http.StatusOK
	case rec.status >= 300 && rec.status < 400 && strings.Contains(rec.header.Get("Location"), "/user/login"):
		return http.StatusUnauthorized
	}
	return http.StatusForbidden
}

// probeRecorder keeps the status, headers and the beginning of the body of
// the session probe.
type probeRecorder struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (r *probeRecorder) Header() http.Header { return r.header }

func (r *probeRecorder) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
}

func (r *probeRecorder) Write(p []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	if room := 256 - r.body.Len(); room > 0 {
		r.body.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

// degraded is Wrap's handler while livesync is enabled but not serving:
// the admin page and the health check (503 "degraded") are livesync's,
// everything else is upstream's.
type degraded struct {
	inner http.Handler
	own   http.Handler
}

func newDegraded(inner http.Handler) *degraded {
	r := newRouter()
	r.Get(adminPath, serveAdmin(inner, nil))
	r.Get(syncPrefix+"/health", degradedHealth)
	return &degraded{inner: inner, own: r}
}

func (d *degraded) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	p, ok := ownPath(req.URL.Path)
	if !ok || (p != adminPath && p != syncPrefix+"/health") {
		d.inner.ServeHTTP(w, req)
		return
	}
	if p != req.URL.Path {
		req = withPath(req, p)
	}
	d.own.ServeHTTP(w, req)
}

// degradedHealth answers GET /-/sync/health while degraded.
func degradedHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusServiceUnavailable, healthResponse{Status: livesync_service.StateDegraded})
}

// adminUserName is the template helper that names a viewer.
func adminUserName(id int64) string {
	return "#" + strconv.FormatInt(id, 10)
}

var adminTemplate = template.Must(template.New("admin").Funcs(template.FuncMap{"user": adminUserName}).Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Livesync · Forgejo</title>
<style>
:root{--fg:#1d1d1f;--muted:#6b6b70;--line:#e3e3e6;--bg:#fff;--panel:#f7f7f8;--ok:#1a7f37;--bad:#c62828;--warn:#9a6700;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);background:var(--bg)}
@media (prefers-color-scheme:dark){:root{--fg:#e8e8ea;--muted:#9a9aa0;--line:#2c2c30;--bg:#151517;--panel:#1c1c1f;--ok:#4ac26b;--bad:#ff6b6b;--warn:#d29922}}
body{margin:0 auto;max-width:960px;padding:24px 16px}
h1{font-size:16px;margin:0 0 16px}h2{font-size:13px;margin:24px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}td,th{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500;width:220px}
pre{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:8px;overflow:auto;font-size:12px;white-space:pre}
.state{display:inline-block;border:1px solid var(--line);border-radius:4px;padding:0 6px}.running,.ok{color:var(--ok)}.degraded,.missing,.stale,.bad{color:var(--bad)}.stopped,.extra,.warn{color:var(--warn)}
p{margin:4px 0}.muted{color:var(--muted)}
</style>
</head>
<body>
<h1>Livesync <span class="state {{.State}}">{{.State}}</span></h1>
{{if .Error}}<p class="bad">{{.Error}}</p>{{end}}
{{range .Errors}}<p class="warn">Could not read {{.}}</p>{{end}}
<table>
<tr><th>Install mode</th><td>{{.InstallMode}}</td></tr>
<tr><th>Sync log writer</th><td>{{if .Writer}}this instance{{else}}another instance (or none){{end}}</td></tr>
<tr><th>Next UI</th><td>{{if .UI.Served}}served from {{.UI.Source}}{{else}}not served: {{.UI.Reason}}{{end}}</td></tr>
{{with .OAuth}}<tr><th>OAuth2 client</th><td>{{.ClientID}} · {{.RedirectURI}}<br><span class="muted">{{.Scope}}</span></td></tr>{{end}}
</table>

{{with .Triggers}}
<h2>Capture triggers</h2>
<table>
<tr><th>Database</th><td>{{.Dialect}} · {{.Schema}}{{if .User}} · as {{.User}}{{end}}</td></tr>
<tr><th>Health</th><td>{{if .Healthy}}<span class="ok">healthy</span>{{else}}<span class="bad">missing or stale triggers: changes of those tables are not captured</span>{{end}}</td></tr>
<tr><th>Objects</th><td>{{range $state, $n := .Counts}}<span class="{{$state}}">{{$n}} {{$state}}</span> {{end}}</td></tr>
{{if .Pending}}<tr><th>Pending epoch bumps</th><td>{{range .Pending}}{{.}} {{end}}</td></tr>{{end}}
</table>
{{if .Problems}}<table><tr><th>Object</th><td>State</td></tr>{{range .Problems}}<tr><th>{{.Kind}} {{if .Table}}{{.Table}}.{{end}}{{.Name}}</th><td class="{{.State}}">{{.State}}{{if .Detail}} ({{.Detail}}){{end}}</td></tr>{{end}}</table>{{end}}
{{range .Warnings}}<p class="warn">{{.}}</p>{{end}}
{{if .InstallScript}}<h2>DDL that installs or repairs the triggers</h2>
<p class="muted">Run it as a privileged database user (it says which), then restart Forgejo. (While livesync runs, the writer checks the triggers every TRIGGER_CHECK_INTERVAL and reinstalls them itself in INSTALL_MODE auto.)</p>
<pre>{{.InstallScript}}</pre>{{end}}
{{if .UninstallScript}}<h2>Kill switch</h2>
<p class="muted">To turn livesync off, set <code>[livesync] ENABLED = false</code> on every instance and restart: with INSTALL_MODE = auto Forgejo removes the triggers and empties the outbox at start; with verify, a DBA runs this script. Enabling livesync again reinstalls the triggers and makes clients re-bootstrap. The Next UI's OAuth2 application{{with $.OAuth}} ({{.ClientID}}){{end}} is not removed: browsers that signed in keep refreshing API tokens; to revoke them, delete the application "Forgejo Next" in Site administration &gt; Applications (livesync creates a new one when enabled again).</p>
<pre>{{.UninstallScript}}</pre>{{end}}
{{end}}

{{if .UI.ClassicHeader}}<h2>Classic pages</h2>
<p class="muted">To add the "Try Forgejo Next" toggle and prefetch hints for the Next UI to every classic page (sign-in included), install this as <code>templates/custom/header.tmpl</code> in Forgejo's custom directory (or add its last line to yours) and restart Forgejo.</p>
<pre>{{.UI.ClassicHeader}}</pre>{{end}}

<h2>Pipeline</h2>
<table>
{{with .Outbox}}<tr><th>Outbox</th><td>backlog {{.Backlog}} (last assigned {{.LastAssigned}}, cursor {{.Cursor}})</td></tr>{{end}}
{{with .Log}}<tr><th>Sync log</th><td>head {{.Head}} · floor {{.Floor}} · writer token {{.WriterToken}}{{if .HubPosition}} · hub {{.HubPosition}} (lag {{.Lag}}){{end}}</td></tr>{{end}}
<tr><th>Entity index backfill</th><td>{{if .BackfillPending}}<span class="warn">running: {{range .BackfillPending}}{{.}} {{end}}</span>{{else}}done{{end}}</td></tr>
</table>

{{with .Hub}}
<h2>Sync sessions</h2>
<table>
<tr><th>Sessions</th><td>{{range $t, $n := .Sessions}}{{$n}} {{$t}} {{end}}</td></tr>
<tr><th>Subscriptions</th><td>{{.Subscriptions}}</td></tr>
{{range .Users}}<tr><th>user {{user .ViewerID}}</th><td>{{.Sessions}} session(s), {{.Subscriptions}} subscription(s)</td></tr>{{end}}
</table>
{{end}}
</body>
</html>
`))
