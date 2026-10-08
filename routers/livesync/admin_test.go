// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"forgejo.org/modules/setting"
	"forgejo.org/modules/test"
	"forgejo.org/services/livesync/metrics"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// probeInner answers the session probe like upstream would for a session
// of the given kind, and fails the test for anything else.
func probeInner(t *testing.T, kind string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != sessionProbePath {
			w.WriteHeader(299)
			return
		}
		assert.Equal(t, http.MethodGet, req.Method)
		assert.Empty(t, req.Header.Get("Authorization"))
		assert.Equal(t, "session=abc", req.Header.Get("Cookie"))
		switch kind {
		case "admin":
			_, _ = w.Write([]byte("\n<dl class=\"admin-dl-horizontal\">\n<dt>uptime</dt></dl>"))
		case "user":
			w.WriteHeader(http.StatusForbidden)
		case "anonymous":
			http.Redirect(w, req, "/user/login", http.StatusSeeOther)
		case "prohibited":
			// Upstream renders this page with 200 for a prohibited or
			// inactive account, on every route.
			_, _ = w.Write([]byte("<!DOCTYPE html><html><body>prohibited</body></html>"))
		case "password":
			http.Redirect(w, req, "/user/settings/change_password", http.StatusSeeOther)
		}
	})
}

func TestAdminSessionAuth(t *testing.T) {
	for kind, want := range map[string]int{
		"admin": http.StatusOK, "user": http.StatusForbidden, "anonymous": http.StatusSeeOther,
		"prohibited": http.StatusForbidden, "password": http.StatusForbidden,
	} {
		t.Run(kind, func(t *testing.T) {
			defer test.MockVariableValue(&setting.AppSubURL, "/sub")()
			h := newDegraded(probeInner(t, kind))
			rec := get(t, h, "/sub/-/sync/admin", "Cookie", "session=abc")
			assert.Equal(t, want, rec.Code)
			switch want {
			case http.StatusOK:
				assert.Equal(t, "text/html; charset=utf-8", rec.Header().Get("Content-Type"))
				assert.Contains(t, rec.Header().Get("Content-Security-Policy"), "default-src 'none'")
				assert.Equal(t, "DENY", rec.Header().Get("X-Frame-Options"))
				assert.Contains(t, rec.Body.String(), "<h1>Livesync")
			case http.StatusSeeOther:
				assert.Equal(t, "/sub/user/login?redirect_to=%2Fsub%2F-%2Fsync%2Fadmin", rec.Header().Get("Location"))
			}
			// JSON clients get 401 instead of a redirect.
			rec = get(t, h, "/sub/-/sync/admin?format=json", "Cookie", "session=abc")
			if want == http.StatusSeeOther {
				assert.Equal(t, http.StatusUnauthorized, rec.Code)
			} else {
				assert.Equal(t, want, rec.Code)
			}
		})
	}
	// Without a cookie or a token: sign in first, without asking upstream.
	h := newDegraded(probeInner(t, "none"))
	rec := get(t, h, "/-/sync/admin")
	assert.Equal(t, http.StatusSeeOther, rec.Code)
	assert.Equal(t, http.StatusUnauthorized, get(t, h, "/-/sync/admin", "Accept", "application/json").Code)
}

func TestDegradedHandler(t *testing.T) {
	h := newDegraded(innerMarker)
	rec := get(t, h, "/-/sync/health")
	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.JSONEq(t, `{"status":"degraded"}`, rec.Body.String())
	assert.Equal(t, http.StatusServiceUnavailable, get(t, h, "//-/sync/health/").Code)
	for _, p := range []string{"/-/sync/grants", "/-/sync/ws", "/-/next/", "/-/next/assets/a.js", "/api/v1/version", "/", "/-/sync/adminx"} {
		assert.Equal(t, 299, get(t, h, p).Code, p)
	}
	req := httptest.NewRequest(http.MethodPost, "/-/sync/admin", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusMethodNotAllowed, rec.Code)
}

func TestRUM(t *testing.T) {
	defer test.MockVariableValue(&rumLimit, newRateLimiter(1000, 1000, 1000, 1000))()
	h := newHandler(innerMarker)
	post := func(ct, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/-/sync/rum", strings.NewReader(body))
		if ct != "" {
			req.Header.Set("Content-Type", ct)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	caughtUp := metricValue(t, metrics.RUM, "caughtUp")
	before := metricValue(t, metrics.RUMEvents, "conflictMerged")
	invalid := metricValue(t, metrics.RUMRejected, "invalid")
	rec := post("application/json", `{"marks":{"caughtUp":120.5,"firstPaintFromCache":-1,"bogus":3},"events":{"conflictMerged":2,"intentFailed":5000,"nope":1}}`)
	assert.Equal(t, http.StatusNoContent, rec.Code)
	assert.InDelta(t, before+2, metricValue(t, metrics.RUMEvents, "conflictMerged"), 0)
	assert.InDelta(t, invalid+4, metricValue(t, metrics.RUMRejected, "invalid"), 0, "a negative timing, an unknown mark, a count out of range, an unknown event")
	assert.InDelta(t, caughtUp+1, metricValue(t, metrics.RUM, "caughtUp"), 0, "one observation")

	assert.Equal(t, http.StatusUnsupportedMediaType, post("text/plain", `{}`).Code)
	assert.Equal(t, http.StatusUnsupportedMediaType, post("", `{}`).Code)
	assert.Equal(t, http.StatusBadRequest, post("application/json", `{"marks":[1]}`).Code)
	assert.Equal(t, http.StatusRequestEntityTooLarge, post("application/json; charset=utf-8", `{"marks":{"x":`+strings.Repeat(" ", maxRUMBody)+`1}}`).Code)
	req := httptest.NewRequest(http.MethodGet, "/-/sync/rum", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusMethodNotAllowed, rec.Code)
}

func TestRateLimiter(t *testing.T) {
	now := time.Unix(1000, 0)
	l := newRateLimiter(1, 2, 100, 3)
	assert.True(t, l.allow("a", now))
	assert.True(t, l.allow("a", now))
	assert.False(t, l.allow("a", now), "burst of 2 per key")
	assert.True(t, l.allow("b", now))
	assert.False(t, l.allow("c", now), "global burst of 3")
	assert.True(t, l.allow("a", now.Add(time.Second)), "refilled at 1/s; the global bucket at 100/s")
	assert.False(t, l.allow("a", now.Add(time.Second)))

	l = newRateLimiter(1, 1, 1e9, 1e9)
	for i := range maxBuckets + 10 {
		require.True(t, l.allow(string(rune(i)), now))
	}
	assert.LessOrEqual(t, len(l.buckets), maxBuckets, "bounded")
}

// metricValue returns the value of a counter, or the sample count of a
// histogram, of collector c whose (only) label has the given value.
func metricValue(t *testing.T, c prometheus.Collector, label string) float64 {
	t.Helper()
	reg := prometheus.NewRegistry()
	require.NoError(t, reg.Register(c))
	families, err := reg.Gather()
	require.NoError(t, err)
	for _, f := range families {
		for _, m := range f.GetMetric() {
			for _, l := range m.GetLabel() {
				if l.GetValue() != label {
					continue
				}
				if h := m.GetHistogram(); h != nil {
					return float64(h.GetSampleCount())
				}
				return m.GetCounter().GetValue()
			}
		}
	}
	return 0
}
