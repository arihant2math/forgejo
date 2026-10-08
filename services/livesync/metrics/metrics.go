// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Package metrics holds livesync's Prometheus metrics (PLAN §4.11). They
// are registered with the default registry, which Forgejo's /metrics
// endpoint ([metrics] ENABLED = true) serves, when livesync is enabled
// (Register). The event metrics below are updated by the packages that
// see the events; the state gauges (backlog, positions, sessions) are
// read at scrape time by a collector of services/livesync.
//
// Every name starts with forgejo_livesync_. Labels have small, fixed value
// sets (transports, reasons, outcomes, endpoints, RUM marks), never ids.
package metrics

import (
	"errors"
	"sync"

	"forgejo.org/modules/log"

	"github.com/prometheus/client_golang/prometheus"
)

const namespace = "forgejo_livesync"

// Buckets of the latency histograms (seconds).
var (
	lagBuckets       = []float64{.001, .0025, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 30, 60}
	bootstrapBuckets = []float64{.01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 30, 60, 120}
	rumBuckets       = []float64{.008, .016, .05, .1, .2, .3, .5, 1, 2, 5, 10, 30}
)

var (
	// MaterializeLag: from the outbox reader first seeing a change (or the
	// gap a late transaction's change fills) until the materializer
	// committed its sync log entries. Together with the outbox backlog
	// gauge this is the capture/materialize lag.
	MaterializeLag = prometheus.NewHistogram(prometheus.HistogramOpts{
		Namespace: namespace, Name: "materialize_lag_seconds",
		Help:    "Time from the outbox reader seeing a captured change until its sync log entries were committed.",
		Buckets: lagBuckets,
	})
	// Materialized counts the outbox rows the materializer consumed
	// (deleted from the outbox; a hot row it defers counts once, when it
	// is consumed later).
	Materialized = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: namespace, Name: "materialized_changes_total",
		Help: "Outbox rows consumed by the materializer of this instance (deferred rows count when consumed).",
	})
	// LogEntries counts the sync log entries this instance's writer appended.
	LogEntries = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: namespace, Name: "log_entries_total",
		Help: "Sync log entries appended by this instance's writer.",
	})

	// RenderSeconds counts the time this instance's writer and snapshots
	// spent rendering markdown bodies for the sync log.
	RenderSeconds = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: namespace, Name: "render_seconds_total",
		Help: "Time spent rendering markdown bodies for the sync log and snapshots.",
	})
	// RenderSkipped counts the bodies sent without HTML (body_truncated)
	// because rendering them was estimated to be too expensive (cost), the
	// writer's render share was used up (share), or the rendering timed
	// out (timeout; also counted for bodies rendered on request).
	RenderSkipped = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace, Name: "render_skipped_total",
		Help: "Markdown bodies not rendered for the sync log, by reason (cost, share, timeout).",
	}, []string{"reason"})

	// FanOut: the time the hub takes to apply one batch of log entries
	// from the tailer (fan-out to the subscriptions, epochs, markers).
	FanOut = prometheus.NewHistogram(prometheus.HistogramOpts{
		Namespace: namespace, Name: "fanout_seconds",
		Help:    "Time the hub took to fan out one batch of sync log entries.",
		Buckets: lagBuckets,
	})
	// Delivered counts the log entries the hub received from the tailer.
	Delivered = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: namespace, Name: "delivered_entries_total",
		Help: "Sync log entries delivered to this instance's hub by the tailer.",
	})
	// SessionsOpened counts sync sessions by transport (ws, sse).
	SessionsOpened = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace, Name: "sessions_opened_total",
		Help: "Sync sessions opened, by transport.",
	}, []string{"transport"})
	// SlowConsumers counts sessions closed with resume_from_cursor because
	// they did not keep up: their queued messages waited longer than
	// DRAIN_TIMEOUT without the client reading a frame, or their control
	// messages overflowed SEND_BUFFER.
	SlowConsumers = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: namespace, Name: "slow_consumer_disconnects_total",
		Help: "Sync sessions closed with resume_from_cursor because they did not read fast enough ([livesync] DRAIN_TIMEOUT, SEND_BUFFER).",
	})
	// CatchUps counts subscriptions whose live changes did not fit in their
	// session's send buffer (a burst) and that caught up from the sync log
	// instead.
	CatchUps = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: namespace, Name: "send_buffer_catch_ups_total",
		Help: "Subscriptions whose live changes did not fit in the session's send buffer and that caught up from the sync log.",
	})
	// Frames counts the delta frames written, FrameBytes their size
	// (before WebSocket compression).
	Frames = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: namespace, Name: "frames_total",
		Help: "Delta frames written to sync sessions.",
	})
	FrameBytes = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: namespace, Name: "frame_bytes_total",
		Help: "Bytes of the delta frames written to sync sessions (uncompressed).",
	})
	// Replays counts subscriptions that read the sync log to catch up.
	Replays = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: namespace, Name: "replays_total",
		Help: "Subscriptions caught up from the sync log (resumes and re-checks).",
	})
	// BootstrapRequired counts bootstrap_required messages sent, by reason.
	BootstrapRequired = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace, Name: "bootstrap_required_total",
		Help: "bootstrap_required messages sent to sync sessions, by reason.",
	}, []string{"reason"})
	// GroupsRevoked counts group_revoked messages sent.
	GroupsRevoked = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: namespace, Name: "group_revoked_total",
		Help: "group_revoked messages sent to sync sessions.",
	})

	// Bootstraps counts GET /-/sync/bootstrap and /-/sync/load requests
	// by endpoint and status code.
	Bootstraps = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace, Name: "bootstrap_requests_total",
		Help: "Bootstrap and load requests, by endpoint and HTTP status.",
	}, []string{"endpoint", "status"})
	// BootstrapBytes counts the bytes of bootstrap responses as sent
	// (after compression).
	BootstrapBytes = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace, Name: "bootstrap_bytes_total",
		Help: "Bytes of bootstrap and load responses sent (after compression), by endpoint.",
	}, []string{"endpoint"})
	// BootstrapDuration: the time to stream one successful response.
	BootstrapDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: namespace, Name: "bootstrap_seconds",
		Help:    "Time to stream a bootstrap or load response, by endpoint.",
		Buckets: bootstrapBuckets,
	}, []string{"endpoint"})

	// Idempotency counts the API v1 writes sent with an Idempotency-Key,
	// by outcome: run (first attempt), recovered (retry of an interrupted
	// attempt), duplicate (the crash-window check found the entity),
	// replay, in_flight (409), mismatch (422), refused (any other answer
	// of the layer itself: 400/401/403/413/503).
	Idempotency = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace, Name: "idempotency_requests_total",
		Help: "API v1 writes with an Idempotency-Key, by outcome.",
	}, []string{"outcome"})
	// SyncWait: how long a keyed write waited for its changes to reach the
	// sync log; SyncWaitTimeouts counts the waits that gave up (the
	// response then has no X-Livesync-Sync-Id).
	SyncWait = prometheus.NewHistogram(prometheus.HistogramOpts{
		Namespace: namespace, Name: "idempotency_sync_wait_seconds",
		Help:    "Time a keyed API v1 write waited for its changes to reach the sync log.",
		Buckets: lagBuckets,
	})
	SyncWaitTimeouts = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: namespace, Name: "idempotency_sync_wait_timeouts_total",
		Help: "Keyed API v1 writes answered without X-Livesync-Sync-Id because the wait timed out.",
	})

	// RUM: the browser timings posted to /-/sync/rum, by mark, and the
	// counted client events (offline queue outcomes), by event.
	RUM = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: namespace, Name: "rum_seconds",
		Help:    "Browser timings reported by the Next UI, by mark.",
		Buckets: rumBuckets,
	}, []string{"mark"})
	RUMEvents = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace, Name: "rum_events_total",
		Help: "Client events reported by the Next UI (offline queue outcomes), by event.",
	}, []string{"event"})
	RUMRejected = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace, Name: "rum_rejected_total",
		Help: "RUM reports rejected, by reason (invalid, rate_limited, too_large).",
	}, []string{"reason"})
)

var registerOnce sync.Once

// Register registers the metrics above and extra (the state collector)
// with the default registry, once per process.
func Register(extra ...prometheus.Collector) {
	registerOnce.Do(func() {
		all := []prometheus.Collector{
			MaterializeLag, Materialized, LogEntries, RenderSeconds, RenderSkipped, FanOut, Delivered, SessionsOpened, SlowConsumers, CatchUps, Frames, FrameBytes,
			Replays, BootstrapRequired, GroupsRevoked, Bootstraps, BootstrapBytes, BootstrapDuration,
			Idempotency, SyncWait, SyncWaitTimeouts, RUM, RUMEvents, RUMRejected,
		}
		for _, c := range append(all, extra...) {
			if err := prometheus.Register(c); err != nil {
				if are, ok := errors.AsType[prometheus.AlreadyRegisteredError](err); !ok || are.ExistingCollector != c {
					log.Error("livesync: register a metric: %v", err)
				}
			}
		}
	})
}
