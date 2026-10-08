// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"io"
	"math"
	"mime"
	"net"
	"net/http"
	"sync"
	"time"

	"forgejo.org/modules/json"
	"forgejo.org/services/livesync/metrics"
	"forgejo.org/services/livesync/protocol"
)

// POST /-/sync/rum: the Next UI's real-user measurements (PLAN §5.8; the
// contract is protocol.RUMReport). Anonymous (the boot shell reports before
// sign-in), validated against fixed sets of marks and events, rate-limited
// per client address, and turned into Prometheus metrics only: nothing is
// stored or logged.

// maxRUMBody bounds a report.
const maxRUMBody = 8 << 10

// rumMarks and rumEvents are the accepted names.
var (
	rumMarks = map[protocol.RUMMark]bool{
		protocol.RUMFirstPaintFromCache: true, protocol.RUMDataOpen: true, protocol.RUMWSOpen: true,
		protocol.RUMCaughtUp: true, protocol.RUMHydrateRoute: true, protocol.RUMHydrateAll: true,
		protocol.RUMMutationLocal: true, protocol.RUMMutationAcked: true, protocol.RUMMutationConfirmed: true,
		protocol.RUMInteraction: true,
	}
	rumEvents = map[protocol.RUMEvent]bool{
		protocol.RUMIntentFlushed: true, protocol.RUMIntentRetried: true, protocol.RUMIntentFailed: true,
		protocol.RUMConflictMerged: true, protocol.RUMConflictOverride: true, protocol.RUMConflictDiscarded: true,
	}
)

// Limits of a report's values.
const (
	maxRUMMillis = 10 * 60 * 1000 // 10 minutes
	maxRUMCount  = 1000
)

// rumLimit is the reports' rate limiter.
var rumLimit = newRateLimiter(rumPerClient, rumClientBurst, rumGlobal, rumGlobalBurst)

// Rates: 10 reports a minute per client address (bursts of 10), 200 a
// second for the instance.
const (
	rumPerClient   = 10.0 / 60
	rumClientBurst = 10
	rumGlobal      = 200.0
	rumGlobalBurst = 400
)

// serveRUM answers POST /-/sync/rum: 204, or 400 (not a report), 413 (too
// large), 415 (not JSON), 429 (rate-limited, with Retry-After).
func serveRUM(w http.ResponseWriter, req *http.Request) {
	reject := func(status int, reason, message string) {
		metrics.RUMRejected.WithLabelValues(reason).Inc()
		writeJSON(w, status, errorResponse{Message: message})
	}
	// JSON only: a cross-site form cannot post it without a CORS preflight,
	// which is not answered.
	if ct, _, _ := mime.ParseMediaType(req.Header.Get("Content-Type")); ct != "application/json" {
		reject(http.StatusUnsupportedMediaType, "invalid", "the report must be application/json")
		return
	}
	if !rumLimit.allow(clientAddr(req), time.Now()) {
		w.Header().Set("Retry-After", "60")
		reject(http.StatusTooManyRequests, "rate_limited", http.StatusText(http.StatusTooManyRequests))
		return
	}
	body, err := io.ReadAll(io.LimitReader(req.Body, maxRUMBody+1))
	if err != nil {
		reject(http.StatusBadRequest, "invalid", "could not read the report")
		return
	}
	if len(body) > maxRUMBody {
		reject(http.StatusRequestEntityTooLarge, "too_large", "the report is too large")
		return
	}
	var report protocol.RUMReport
	if err := json.Unmarshal(body, &report); err != nil {
		reject(http.StatusBadRequest, "invalid", "not a RUM report")
		return
	}
	for mark, ms := range report.Marks {
		if !rumMarks[mark] || math.IsNaN(ms) || ms < 0 || ms > maxRUMMillis {
			metrics.RUMRejected.WithLabelValues("invalid").Inc()
			continue
		}
		metrics.RUM.WithLabelValues(string(mark)).Observe(ms / 1000)
	}
	for event, n := range report.Events {
		if !rumEvents[event] || n < 0 || n > maxRUMCount {
			metrics.RUMRejected.WithLabelValues("invalid").Inc()
			continue
		}
		metrics.RUMEvents.WithLabelValues(string(event)).Add(float64(n))
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

// clientAddr is the client's address without the port (Forgejo's
// middlewares have applied the trusted proxies' X-Forwarded-For).
func clientAddr(req *http.Request) string {
	if host, _, err := net.SplitHostPort(req.RemoteAddr); err == nil {
		return host
	}
	return req.RemoteAddr
}

// rateLimiter is a token bucket per key plus one for everybody. It keeps
// at most maxBuckets keys (when full, it forgets them all: a burst of new
// addresses still meets the global bucket).
type rateLimiter struct {
	mu            sync.Mutex
	rate, burst   float64
	global        bucket
	gRate, gBurst float64
	buckets       map[string]*bucket
}

type bucket struct {
	tokens float64
	at     time.Time
}

const maxBuckets = 10000

func newRateLimiter(rate, burst, globalRate, globalBurst float64) *rateLimiter {
	return &rateLimiter{
		rate: rate, burst: burst, gRate: globalRate, gBurst: globalBurst,
		global: bucket{tokens: globalBurst}, buckets: map[string]*bucket{},
	}
}

// take refills b at rate up to burst and takes a token if there is one.
func (b *bucket) take(now time.Time, rate, burst float64) bool {
	if !b.at.IsZero() {
		b.tokens = math.Min(burst, b.tokens+now.Sub(b.at).Seconds()*rate)
	}
	b.at = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func (l *rateLimiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.buckets[key]
	if b == nil {
		if len(l.buckets) >= maxBuckets {
			clear(l.buckets)
		}
		b = &bucket{tokens: l.burst}
		l.buckets[key] = b
	}
	if !b.take(now, l.rate, l.burst) {
		return false
	}
	return l.global.take(now, l.gRate, l.gBurst)
}
