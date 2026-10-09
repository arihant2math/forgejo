// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"context"
	"fmt"
	"html"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	auth_model "forgejo.org/models/auth"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/json"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/test"
	"forgejo.org/routers"
	livesync_router "forgejo.org/routers/livesync"
	web_routers "forgejo.org/routers/web"
	livesync_service "forgejo.org/services/livesync"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/tests"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// livesyncAdminView is the JSON of /-/sync/admin.
type livesyncAdminView struct {
	livesync_service.Status
	UI struct {
		Served bool   `json:"served"`
		Reason string `json:"reason"`
	} `json:"ui"`
}

// livesyncScopedToken creates an access token of user u with the given scope.
func livesyncScopedToken(t *testing.T, u int64, scope auth_model.AccessTokenScope) string {
	t.Helper()
	tok := &auth_model.AccessToken{UID: u, Name: fmt.Sprintf("livesync-admin-%d", time.Now().UnixNano()), Scope: scope, ResourceAllRepos: true}
	require.NoError(t, auth_model.NewAccessToken(t.Context(), tok))
	return tok.Token
}

func livesyncAdminJSON(t *testing.T, token string) livesyncAdminView {
	t.Helper()
	resp := MakeRequest(t, NewRequest(t, "GET", "/-/sync/admin?format=json").AddTokenAuth(token), http.StatusOK)
	var view livesyncAdminView
	require.NoError(t, json.Unmarshal(resp.Body.Bytes(), &view))
	return view
}

// livesyncMetric returns the value of a gauge or counter (or the sample
// count of a histogram) of the default registry — what /metrics serves —
// summed over the series whose labels include the given name=value pairs.
func livesyncMetric(t *testing.T, name string, labels ...string) (float64, bool) {
	t.Helper()
	families, err := prometheus.DefaultGatherer.Gather()
	require.NoError(t, err)
	total, found := 0.0, false
	for _, f := range families {
		if f.GetName() != name {
			continue
		}
	metrics:
		for _, m := range f.GetMetric() {
			for i := 0; i+1 < len(labels); i += 2 {
				ok := false
				for _, l := range m.GetLabel() {
					ok = ok || l.GetName() == labels[i] && l.GetValue() == labels[i+1]
				}
				if !ok {
					continue metrics
				}
			}
			found = true
			switch {
			case m.GetHistogram() != nil:
				total += float64(m.GetHistogram().GetSampleCount())
			case m.GetCounter() != nil:
				total += m.GetCounter().GetValue()
			default:
				total += m.GetGauge().GetValue()
			}
		}
	}
	return total, found
}

// The admin page (site administrators only) while livesync is degraded —
// the capture trigger of one table is missing in INSTALL_MODE verify:
// Forgejo serves the classic UI, plus the page with the reason and the DDL,
// and the health check says "degraded".
func TestLivesyncAdminDegraded(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	ctx := context.Background()
	livesyncResetCapture(t)
	t.Cleanup(func() {
		livesync_service.Shutdown()
		livesyncUninstallTriggers(t)
		livesyncResetCapture(t)
	})
	livesyncConfig(t, map[string]string{"ENABLED": "true", "INSTALL_MODE": "auto"})
	require.NoError(t, livesync_service.Init(ctx))
	livesync_service.Shutdown()
	master := livesyncMaster(t)
	if setting.Database.Type.IsPostgreSQL() {
		_, err := master.Exec(`DROP TRIGGER livesync_capture ON label`)
		require.NoError(t, err)
	} else {
		_, err := master.Exec("DROP TRIGGER livesync_label_ai")
		require.NoError(t, err)
	}

	livesyncConfig(t, map[string]string{"INSTALL_MODE": "verify"})
	inner := routers.NormalRoutes()
	wrapped := livesync_router.Wrap(inner)
	require.NotSame(t, inner, wrapped)
	require.Equal(t, livesync_service.StateDegraded, livesync_service.State())
	defer test.MockVariableValue(&testWebRoutes, livesyncRoutes(wrapped))()

	resp := MakeRequest(t, NewRequest(t, "GET", "/-/sync/health"), http.StatusServiceUnavailable)
	assert.JSONEq(t, `{"status":"degraded"}`, resp.Body.String())
	MakeRequest(t, NewRequest(t, "GET", "/api/v1/version"), http.StatusOK)

	// Who may see it.
	resp = MakeRequest(t, NewRequest(t, "GET", "/-/sync/admin"), http.StatusSeeOther)
	assert.Equal(t, "/user/login?redirect_to=%2F-%2Fsync%2Fadmin", resp.Header().Get("Location"))
	loginUser(t, "user2").MakeRequest(t, NewRequest(t, "GET", "/-/sync/admin"), http.StatusForbidden)
	MakeRequest(t, NewRequest(t, "GET", "/-/sync/admin").AddTokenAuth(livesyncToken(t, &user_model.User{ID: 2})), http.StatusForbidden)
	MakeRequest(t, NewRequest(t, "GET", "/-/sync/admin").AddTokenAuth(livesyncScopedToken(t, 1, auth_model.AccessTokenScopeReadRepository)), http.StatusForbidden)
	MakeRequest(t, NewRequest(t, "GET", "/-/sync/admin").AddTokenAuth("nope"), http.StatusUnauthorized)

	// A site administrator signed in to the classic UI gets the page.
	resp = loginUser(t, "user1").MakeRequest(t, NewRequest(t, "GET", "/-/sync/admin"), http.StatusOK)
	page := resp.Body.String()
	assert.Contains(t, page, `<span class="state degraded">degraded</span>`)
	assert.Contains(t, page, "capture triggers not installed")
	st, err := capture.Inspect(ctx)
	require.NoError(t, err)
	stmts := st.Statements()
	require.NotEmpty(t, stmts)
	for _, stmt := range stmts {
		assert.Contains(t, page, html.EscapeString(stmt), "the repair DDL is on the page")
	}
	assert.Contains(t, page, html.EscapeString(st.UninstallStatements()[0]), "and the uninstall DDL")
	assert.Equal(t, "no-store", resp.Header().Get("Cache-Control"))

	// The same as JSON for a token with read:admin.
	view := livesyncAdminJSON(t, livesyncScopedToken(t, 1, auth_model.AccessTokenScopeReadAdmin))
	assert.Equal(t, livesync_service.StateDegraded, view.State)
	assert.Contains(t, view.Error, "capture triggers not installed")
	require.NotNil(t, view.Triggers)
	assert.False(t, view.Triggers.Healthy)
	assert.Equal(t, st.Script(), view.Triggers.InstallScript)
	assert.Equal(t, st.UninstallScript(), view.Triggers.UninstallScript)
	require.NotEmpty(t, view.Triggers.Problems)
	assert.Equal(t, "label", view.Triggers.Problems[0].Table)
	assert.Equal(t, capture.StateMissing, view.Triggers.Problems[0].State)
	assert.Equal(t, []string{"label"}, view.Triggers.Pending)
	assert.NotNil(t, view.Outbox)
	assert.NotNil(t, view.Log)
	assert.Nil(t, view.Hub)
	assert.False(t, view.UI.Served)

	// The metrics show it too.
	up, ok := livesyncMetric(t, "forgejo_livesync_up", "state", livesync_service.StateDegraded)
	assert.True(t, ok)
	assert.InDelta(t, 1.0, up, 0)
	_, ok = livesyncMetric(t, "forgejo_livesync_outbox_backlog")
	assert.True(t, ok)
}

// While livesync runs: the admin page shows the pipeline and the sessions,
// and Forgejo's /metrics shows livesync's metrics (PLAN §4.11).
func TestLivesyncAdminRunning(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncServe(t)
	livesyncWaitBackfill(t)
	srv := httptest.NewServer(testWebRoutes)
	defer srv.Close()
	u, err := url.Parse(srv.URL)
	require.NoError(t, err)

	token := livesyncToken(t, &user_model.User{ID: 2})
	cl := livesyncDial(t, u, "ws")
	cl.send(livesyncHello(token, protocol.GroupRequest{Group: "repo:1"}))
	cl.waitType(protocol.MsgWelcome)
	cl.waitType(protocol.MsgCaughtUp)

	// Some traffic: a keyed write (delta), a bootstrap, a RUM report.
	req := NewRequestWithJSON(t, "POST", "/api/v1/repos/user2/repo1/labels", map[string]string{"name": "metrics", "color": "#abcdef"}).AddTokenAuth(token)
	req.SetHeader(protocol.HeaderIdempotencyKey, fmt.Sprintf("metrics-%d", time.Now().UnixNano()))
	MakeRequest(t, req, http.StatusCreated)
	cl.waitChange("the label", func(ch *protocol.Change) bool { return ch.M == protocol.ModelLabel })
	MakeRequest(t, NewRequest(t, "GET", "/-/sync/bootstrap?group=repo:1").AddTokenAuth(token), http.StatusOK)
	req = NewRequestWithBody(t, "POST", "/-/sync/rum", strings.NewReader(`{"marks":{"caughtUp":42},"events":{"intentFlushed":1}}`))
	req.SetHeader("Content-Type", "application/json")
	MakeRequest(t, req, http.StatusNoContent)

	view := livesyncAdminJSON(t, livesyncScopedToken(t, 1, auth_model.AccessTokenScopeReadAdmin))
	assert.Equal(t, livesync_service.StateRunning, view.State)
	assert.Empty(t, view.Error)
	assert.Empty(t, view.Errors)
	require.NotNil(t, view.Triggers)
	assert.True(t, view.Triggers.Healthy)
	assert.Empty(t, view.Triggers.InstallScript)
	assert.NotEmpty(t, view.Triggers.UninstallScript)
	assert.Eventually(t, func() bool {
		return livesyncAdminJSON(t, livesyncScopedToken(t, 1, auth_model.AccessTokenScopeReadAdmin)).Writer
	}, livesyncWait, 50*time.Millisecond, "this instance is the writer")
	require.NotNil(t, view.Log)
	assert.Positive(t, view.Log.Head)
	require.NotNil(t, view.Hub)
	assert.Equal(t, 1, view.Hub.Sessions["ws"])
	assert.Equal(t, 1, view.Hub.Subscriptions)
	require.Len(t, view.Hub.Users, 1)
	assert.EqualValues(t, 2, view.Hub.Users[0].ViewerID)
	require.NotNil(t, view.OAuth)
	assert.Equal(t, livesync_service.OAuthApp().ClientID, view.OAuth.ClientID)
	html := loginUser(t, "user1").MakeRequest(t, NewRequest(t, "GET", "/-/sync/admin"), http.StatusOK).Body.String()
	assert.Contains(t, html, `<span class="state running">running</span>`)
	assert.Contains(t, html, "1 subscription(s)")

	// /metrics (Forgejo's handler, default registry).
	rec := httptest.NewRecorder()
	web_routers.Metrics(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()
	for _, want := range []string{
		`forgejo_livesync_up{state="running"} 1`,
		`forgejo_livesync_sessions{transport="ws"} 1`,
		`forgejo_livesync_subscriptions 1`,
		`forgejo_livesync_writer 1`,
		`forgejo_livesync_outbox_backlog `,
		`forgejo_livesync_log_head `,
		`forgejo_livesync_hub_position `,
		`forgejo_livesync_materialize_lag_seconds_count `,
		`forgejo_livesync_fanout_seconds_count `,
		`forgejo_livesync_frames_total `,
		`forgejo_livesync_sessions_opened_total{transport="ws"} `,
		`forgejo_livesync_bootstrap_requests_total{endpoint="bootstrap",status="200"} `,
		`forgejo_livesync_bootstrap_bytes_total{endpoint="bootstrap"} `,
		`forgejo_livesync_bootstrap_seconds_count{endpoint="bootstrap"} `,
		`forgejo_livesync_idempotency_requests_total{outcome="run"} `,
		`forgejo_livesync_idempotency_sync_wait_seconds_count `,
		`forgejo_livesync_rum_seconds_count{mark="caughtUp"} `,
		`forgejo_livesync_rum_events_total{event="intentFlushed"} `,
	} {
		assert.Contains(t, body, want)
	}
	// A replayed write counts as a replay.
	before, _ := livesyncMetric(t, "forgejo_livesync_idempotency_requests_total", "outcome", "replay")
	key := fmt.Sprintf("metrics-replay-%d", time.Now().UnixNano())
	for range 2 {
		req := NewRequestWithJSON(t, "POST", "/api/v1/repos/user2/repo1/labels", map[string]string{"name": key, "color": "#abcdef"}).AddTokenAuth(token)
		req.SetHeader(protocol.HeaderIdempotencyKey, key)
		MakeRequest(t, req, http.StatusCreated)
	}
	after, _ := livesyncMetric(t, "forgejo_livesync_idempotency_requests_total", "outcome", "replay")
	assert.InDelta(t, before+1, after, 0)
}
