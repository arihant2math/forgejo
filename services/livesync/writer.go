// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"context"
	"errors"
	"time"

	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/log"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/services/livesync/materialize"
	"forgejo.org/services/livesync/synclog"
)

// Timings of the writer role. Variables so that tests can shorten them.
var (
	// leaseRetryInterval: how often an instance that is not the writer
	// tries to take the lease over.
	leaseRetryInterval = 2 * time.Second
	// leaseCheckInterval: how often the writer checks that it still holds
	// the lease.
	leaseCheckInterval = 2 * time.Second
	// epochCheckInterval: how often the writer looks for schema epochs
	// bumped by another instance's start.
	epochCheckInterval = 5 * time.Second
	// retentionInterval: how often the writer trims the sync log.
	retentionInterval = 10 * time.Minute
	// backfillPause: the pause between two entity index backfill steps.
	backfillPause = 10 * time.Millisecond
)

// runWriter is the writer role (PLAN §4.11 invariant 2): until ctx is done
// it competes for the sync log writer lease, and while it holds it, it runs
// the outbox reader with the materializer as consumer, the schema epoch
// check, the entity index backfill and the log retention. Every instance
// runs it; exactly one at a time is the writer (the others retry).
func runWriter(ctx context.Context, s Settings, tailer *synclog.Tailer, done chan<- struct{}) {
	defer close(done)
	for {
		err := lead(ctx, s, tailer)
		if ctx.Err() != nil {
			return
		}
		if err != nil && !errors.Is(err, synclog.ErrWriterHeld) {
			log.Error("livesync: sync log writer: %v; retrying in %s", err, leaseRetryInterval)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(leaseRetryInterval):
		}
	}
}

// lead acquires the writer lease and does the writer's work until the lease
// is lost or ctx is done.
func lead(ctx context.Context, s Settings, tailer *synclog.Tailer) error {
	w, err := synclog.AcquireWriter(ctx, tailer.Wake)
	if err != nil {
		return err
	}
	defer w.Release()
	log.Info("livesync: this instance is the sync log writer")

	leadCtx, stop := context.WithCancel(ctx)
	defer stop()
	m := materialize.New(materialize.Config{HotWindow: s.HotCoalesce}, w, stop)
	if err := m.Prepare(leadCtx); err != nil {
		return err
	}
	reader, err := capture.Start(leadCtx, capture.Config{
		PollInterval: s.PollInterval,
		HoleTimeout:  s.HoleTimeout,
	}, m)
	if err != nil {
		return err
	}
	defer func() {
		stop()
		if !reader.Wait(readerStopTimeout) {
			log.Warn("livesync: the outbox reader did not stop within %s", readerStopTimeout)
		}
	}()

	check := time.NewTicker(leaseCheckInterval)
	defer check.Stop()
	epochs := time.NewTicker(epochCheckInterval)
	defer epochs.Stop()
	retention := time.NewTimer(0)
	defer retention.Stop()
	backfill := time.NewTimer(0)
	defer backfill.Stop()
	for {
		select {
		case <-leadCtx.Done():
			if ctx.Err() == nil {
				log.Warn("livesync: another instance became the sync log writer; stepping down")
			}
			return nil
		case <-check.C:
			if err := w.Check(leadCtx); err != nil {
				return err
			}
		case <-epochs.C:
			if err := m.HandleEpochs(leadCtx); err != nil && leadCtx.Err() == nil {
				log.Error("livesync: handle schema epochs: %v", err)
			}
			// A handled epoch may have restarted a table's backfill.
			backfill.Reset(0)
		case <-retention.C:
			if floor, err := w.Trim(leadCtx, s.LogRetention, s.LogMaxRows); err != nil {
				if errors.Is(err, synclog.ErrNotWriter) {
					stop() // another instance is the writer: step down
				} else if leadCtx.Err() == nil {
					log.Error("livesync: sync log retention: %v", err)
				}
			} else {
				log.Debug("livesync: sync log retention done, oldest available cursor %d", floor)
			}
			retention.Reset(retentionInterval)
		case <-backfill.C:
			more, err := m.BackfillStep(leadCtx)
			switch {
			case err != nil && leadCtx.Err() == nil:
				log.Error("livesync: entity index backfill: %v; retrying", err)
				backfill.Reset(leaseRetryInterval)
			case more:
				backfill.Reset(backfillPause)
			}
		}
	}
}

// logSink is the tailer's sink until the WebSocket hub (B5) replaces it.
type logSink struct{}

func (logSink) Deliver(_ context.Context, entries []livesync_model.LogEntry) {
	log.Trace("livesync: sync log tailer: %d new entr(y/ies), up to %d", len(entries), entries[len(entries)-1].SyncID)
}

func (logSink) Skipped(context.Context, int64, int64) {}
