// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package synclog

import (
	"context"
	"errors"
	"time"

	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/log"
	"forgejo.org/modules/setting"
	"forgejo.org/services/livesync/capture"
)

// Sink receives the entries a Tailer reads, in sync id order and without
// gaps (except after a jump over trimmed entries, see Skipped). The
// WebSocket hub (B5) is the real one. Its methods run on the tailer's
// goroutine; they must not block for long.
type Sink interface {
	Deliver(ctx context.Context, entries []livesync_model.LogEntry)
	// Skipped says that the entries after `from` up to `floor` were
	// trimmed before this instance read them (it fell behind the whole
	// retention window): anything derived from them (subscriptions,
	// cached permissions) must be rebuilt.
	Skipped(ctx context.Context, from, floor int64)
}

// TailerConfig configures a Tailer. Zero values mean the defaults.
type TailerConfig struct {
	// PollInterval: how often the tailer looks for new entries when not
	// woken (default 250 ms on PostgreSQL, which also has LISTEN, 100 ms on
	// MySQL, where polling is the cross-instance mechanism).
	PollInterval time.Duration
	// BatchSize bounds the entries per read and per Deliver (default 100:
	// with the payload limits of the materializer, a read holds a few MB in
	// the worst case).
	BatchSize int
}

// Tailer follows the sync log on every instance (PLAN §4.11 invariant 2:
// one writer, many tailers) and hands new entries to its Sink. It is woken
// by the local writer after each append (Wake), by NOTIFY on PostgreSQL
// (appends of any instance) and by polling.
type Tailer struct {
	cfg  TailerConfig
	sink Sink
	wake chan struct{}
	pos  int64 // last sync id delivered
	done chan struct{}
}

// StartTailer starts following the log after from (usually the current
// Head; earlier entries are served by ReadSince replays) until ctx is done.
func StartTailer(ctx context.Context, cfg TailerConfig, from int64, sink Sink) (*Tailer, error) {
	if cfg.PollInterval <= 0 {
		cfg.PollInterval = capture.DefaultPollInterval
		if setting.Database.Type.IsPostgreSQL() {
			cfg.PollInterval = capture.DefaultPollIntervalListen
		}
	}
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 100
	}
	t := &Tailer{cfg: cfg, sink: sink, wake: make(chan struct{}, 1), pos: from, done: make(chan struct{})}
	if setting.Database.Type.IsPostgreSQL() {
		schema, err := capture.CurrentSchema(ctx)
		if err != nil {
			return nil, err
		}
		go capture.Listen(ctx, pgNotifyChannel, schema, t.Wake)
	}
	go t.run(ctx)
	return t, nil
}

// Wake makes the tailer look for new entries now.
func (t *Tailer) Wake() {
	select {
	case t.wake <- struct{}{}:
	default:
	}
}

// Wait blocks until the tailer has stopped (its context is done) or timeout
// elapses, and reports whether it stopped.
func (t *Tailer) Wait(timeout time.Duration) bool {
	select {
	case <-t.done:
		return true
	case <-time.After(timeout):
		return false
	}
}

func (t *Tailer) run(ctx context.Context) {
	defer close(t.done)
	ticker := time.NewTicker(t.cfg.PollInterval)
	defer ticker.Stop()
	for {
		if err := t.read(ctx); err != nil && ctx.Err() == nil {
			log.Error("livesync: sync log tailer: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.wake:
		case <-ticker.C:
		}
	}
}

// read delivers everything after pos.
func (t *Tailer) read(ctx context.Context) error {
	for {
		entries, err := ReadSince(ctx, "", t.pos, t.cfg.BatchSize)
		if trimmed, ok := errors.AsType[*TrimmedError](err); ok {
			// Only possible if this instance fell behind by the whole
			// retention window; its subscribers re-bootstrap (B5).
			log.Warn("livesync: sync log tailer fell behind the retention floor (at %d, floor %d); skipping ahead", t.pos, trimmed.Floor)
			t.sink.Skipped(ctx, t.pos, trimmed.Floor)
			t.pos = trimmed.Floor
			continue
		}
		if err != nil || len(entries) == 0 {
			return err
		}
		t.pos = entries[len(entries)-1].SyncID
		t.sink.Deliver(ctx, entries)
		if len(entries) < t.cfg.BatchSize {
			return nil
		}
	}
}
