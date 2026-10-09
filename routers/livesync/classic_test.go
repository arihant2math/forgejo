// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"bytes"
	"html/template"
	"net/http"
	"regexp"
	"testing"

	"forgejo.org/modules/json"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/templates"
	"forgejo.org/modules/test"
	livesync_service "forgejo.org/services/livesync"
	"forgejo.org/services/livesync/oauthapp"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBootFiles(t *testing.T) {
	index := []byte(`<head><script>inline()</script><script type="module" crossorigin src="/-/next/assets/index-abc.js"></script>
<link rel="modulepreload" crossorigin href="/-/next/assets/vendor-def.js"><link href='/-/next/assets/app.css' rel=stylesheet>
<link rel="icon" href="/assets/img/favicon.svg"><script src="https://cdn.example/x.js"></script><link rel="modulepreload" href="//cdn.example/y.js"></head>`)
	assert.Equal(t, []string{"/-/next/assets/index-abc.js", "/-/next/assets/vendor-def.js", "/-/next/assets/app.css"}, bootFiles(index))
}

// The classic pages' script names the opt-in links and the build's boot
// files (with the sub-path); the header template loads it.
func TestClassicScript(t *testing.T) {
	for _, sub := range []string{"", "/sub"} {
		t.Run("sub="+sub, func(t *testing.T) {
			defer test.MockVariableValue(&setting.AppSubURL, sub)()
			h := spaHandler(t, writeDist(t), innerMarker)
			rec := get(t, h, sub+"/-/next/classic.js")
			require.Equal(t, http.StatusOK, rec.Code)
			assert.Equal(t, "text/javascript; charset=utf-8", rec.Header().Get("Content-Type"))
			assert.Equal(t, "no-cache", rec.Header().Get("Cache-Control"))
			m := regexp.MustCompile(`const c = (\{.*\});`).FindSubmatch(rec.Body.Bytes())
			require.NotNil(t, m, rec.Body.String())
			var cfg classicConfig
			require.NoError(t, json.Unmarshal(m[1], &cfg))
			assert.Equal(t, classicConfig{
				Cookie: "ui=next", Base: sub + "/-/next/", OptIn: sub + "/-/next/opt-in", OptOut: sub + "/-/next/opt-out",
				Prefetch: []string{sub + "/-/next/assets/index-abc.js", sub + "/-/next/assets/vendor-def.js"},
			}, cfg)
			assert.Equal(t, http.StatusNotModified, get(t, h, sub+"/-/next/classic.js", "If-None-Match", rec.Header().Get("ETag")).Code)

			tmpl, err := template.New("header").Funcs(templates.NewFuncMap()).Parse(classicHeader)
			require.NoError(t, err)
			var out bytes.Buffer
			require.NoError(t, tmpl.Execute(&out, nil))
			assert.Equal(t, `<script type="module" src="`+sub+`/-/next/classic.js"></script>`, string(bytes.TrimSpace(out.Bytes())))
		})
	}
	assert.Equal(t, http.StatusNotFound, get(t, spaHandler(t, "", innerMarker), "/-/next/classic.js").Code, "no build")
}

// The admin page shows the header template when the UI is served, and the
// kill-switch text names the OAuth2 application.
func TestAdminPageClassicAndOAuth(t *testing.T) {
	view := adminView{
		Status: &livesync_service.Status{
			State: livesync_service.StateRunning, InstallMode: "auto",
			Triggers: &livesync_service.TriggerStatus{Dialect: "postgres", Schema: "public", Healthy: true, UninstallScript: "DROP TRIGGER x;"},
			OAuth:    &oauthapp.App{ClientID: "cid", RedirectURI: "https://example.com/-/next/callback", Scope: oauthapp.Scope},
		},
		UI: uiStatus{Served: true, Source: "embedded", ClassicHeader: classicHeader},
	}
	var out bytes.Buffer
	require.NoError(t, adminTemplate.Execute(&out, view))
	page := out.String()
	assert.Contains(t, page, "templates/custom/header.tmpl")
	assert.Contains(t, page, `&lt;script type=&#34;module&#34; src=&#34;{{AppSubUrl}}/-/next/classic.js&#34;&gt;&lt;/script&gt;`)
	assert.Contains(t, page, `The Next UI's OAuth2 application (cid) is not removed`)
}
