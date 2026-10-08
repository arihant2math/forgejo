// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"time"

	"forgejo.org/modules/log"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/services/livesync/idempotency"
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
// check, the entity index backfill, the log retention and the cleanup of
// expired idempotency records. Every instance
// runs it; exactly one at a time is the writer (the others retry).
func runWriter(ctx context.Context, s Settings, tailer *synclog.Tailer, idem *idempotency.Service, writing *atomic.Bool, done chan<- struct{}) {
	defer close(done)
	for {
		err := lead(ctx, s, tailer, idem, writing)
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
func lead(ctx context.Context, s Settings, tailer *synclog.Tailer, idem *idempotency.Service, writing *atomic.Bool) error {
	w, err := synclog.AcquireWriter(ctx, tailer.Wake)
	if err != nil {
		return err
	}
	defer w.Release()
	log.Info("livesync: this instance is the sync log writer")
	writing.Store(true)
	defer writing.Store(false)

	leadCtx, stop := context.WithCancel(ctx)
	defer stop()
	m := materialize.New(materialize.Config{HotWindow: s.HotCoalesce, Consumed: idem.Notify}, w, stop)
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
	watcher := make(chan struct{})
	go watchTriggers(leadCtx, s, watcher)
	defer func() {
		stop()
		if !reader.Wait(readerStopTimeout) {
			log.Warn("livesync: the outbox reader did not stop within %s", readerStopTimeout)
		}
		<-watcher
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
			if n, err := idempotency.Cleanup(leadCtx, s.IdempotencyTTL); err != nil && leadCtx.Err() == nil {
				log.Error("livesync: idempotency records cleanup: %v", err)
			} else if n > 0 {
				log.Debug("livesync: deleted %d expired idempotency records", n)
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

// watchTriggers checks the capture triggers every TRIGGER_CHECK_INTERVAL
// while this instance is the writer (capture.Ensure, which is what Init
// does): a trigger can go while livesync runs — another instance started
// with ENABLED = false and removed them (Disable), a DBA dropped them, an
// upgrade recreated a table. With INSTALL_MODE auto they are reinstalled at
// once; either way the schema epochs of the tables found broken are bumped
// once they are healthy again, and the writer's epoch check turns them into
// re-bootstrap markers (the changes in between were not captured).
func watchTriggers(ctx context.Context, s Settings, done chan<- struct{}) {
	defer close(done)
	if s.TriggerCheckInterval <= 0 {
		return
	}
	ticker := time.NewTicker(s.TriggerCheckInterval)
	defer ticker.Stop()
	var reported string // the last broken state logged, to log it once
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		report, err := capture.Ensure(ctx, s.InstallMode == InstallModeAuto)
		if ctx.Err() != nil {
			return
		}
		var notInstalled *capture.NotInstalledError
		switch {
		case errors.As(err, &notInstalled):
			if msg := err.Error(); msg != reported {
				reported = msg
				log.Warn("livesync: the capture triggers are missing or stale while livesync runs; changes of those tables are not synced until they are repaired: %v; the DDL:\n%s", err, notInstalled.Status.Script())
			}
		case err != nil:
			log.Warn("livesync: check the capture triggers: %v", err)
		case len(report.Repaired) > 0:
			reported = ""
			log.Warn("livesync: the capture triggers of %d table(s) were missing or stale while livesync ran (another instance with ENABLED = false, a DBA, or a migration removed them); they are installed again and their schema epochs bumped (clients re-bootstrap): %s",
				len(report.Repaired), strings.Join(report.Repaired, ", "))
		default:
			reported = ""
		}
	}
}
