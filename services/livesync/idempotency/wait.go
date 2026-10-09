// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package idempotency

import (
	"context"
	"fmt"
	"sync"
	"time"

	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/services/livesync/synclog"
)

// Signal is a broadcast: C returns a channel that is closed at the next
// Broadcast.
type Signal struct {
	mu sync.Mutex
	ch chan struct{}
}

// C returns the channel the next Broadcast closes.
func (s *Signal) C() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ch == nil {
		s.ch = make(chan struct{})
	}
	return s.ch
}

// Broadcast wakes everyone waiting on a channel C returned.
func (s *Signal) Broadcast() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ch != nil {
		close(s.ch)
		s.ch = nil
	}
}

// Position returns the outbox position: the last livesync_change id
// assigned. Read before and after a write, it brackets the write's outbox
// rows: (before, after].
func Position(ctx context.Context) (int64, error) {
	pos, err := capture.LastAssignedID(ctx)
	if err != nil {
		return 0, fmt.Errorf("livesync: read the outbox position: %w", err)
	}
	return pos, nil
}

// Wait timings: the first re-check comes soon (a local materializer usually
// needs a few milliseconds), later ones back off; a local commit or a
// delivered log entry wakes the waiters at once.
const (
	firstPoll = 5 * time.Millisecond
	maxPoll   = 100 * time.Millisecond
)

// WaitSynced waits, at most the configured SyncWait, until the outbox holds
// no row with an id in (low, high] that the materializer has not handled —
// every such row that was committed when WaitSynced was called has been
// consumed, in the transaction that appended its entries, or deferred — and
// returns the sync log head read afterwards: every entry produced from the
// consumed rows has a sync id at or below it. ok is false when the wait
// timed out, ctx ended or the database failed.
//
// Rows of transactions that were not committed yet are invisible and do not
// hold the wait up (they are not the caller's write: its transaction
// committed before high was read). Rows the materializer deferred (a row of a
// hot table changed again within HOT_COALESCE, marked Deferred) do not
// either: they may be anyone's, and their entry follows within HOT_COALESCE;
// waiting for them would hold up unrelated writes that overlap them.
func (s *Service) WaitSynced(ctx context.Context, low, high int64) (int64, bool) {
	return s.waitSynced(ctx, low, high, s.cfg.SyncWait)
}

// SyncedNow is WaitSynced without the wait: one check. The HTTP layer uses
// it for error responses (status >= 400), which normally commit nothing and
// are not worth holding up for other writes' rows.
func (s *Service) SyncedNow(ctx context.Context, low, high int64) (int64, bool) {
	return s.waitSynced(ctx, low, high, 0)
}

func (s *Service) waitSynced(ctx context.Context, low, high int64, wait time.Duration) (int64, bool) {
	deadline := time.Now().Add(wait)
	poll := firstPoll
	for {
		woken := s.signal.C() // before the check: a commit after it wakes us
		pending, err := outboxPending(ctx, low, high)
		if err != nil {
			return 0, false
		}
		if !pending {
			head, err := synclog.Head(ctx)
			if err != nil {
				return 0, false
			}
			return head, true
		}
		left := time.Until(deadline)
		if left <= 0 {
			return 0, false
		}
		t := time.NewTimer(min(poll, left))
		select {
		case <-ctx.Done():
			t.Stop()
			return 0, false
		case <-woken:
			t.Stop()
		case <-t.C:
			poll = min(2*poll, maxPoll)
		}
	}
}

// outboxPending reports whether the outbox holds a committed row with an id
// in (low, high] that the materializer has not deferred.
func outboxPending(ctx context.Context, low, high int64) (bool, error) {
	if high <= low {
		return false, nil
	}
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return false, err
	}
	var id int64
	has, err := e.SQL("SELECT id FROM livesync_change WHERE id > ? AND id <= ? AND deferred = ? ORDER BY id LIMIT 1", low, high, false).Get(&id)
	if err != nil {
		return false, fmt.Errorf("livesync: read the outbox: %w", err)
	}
	return has, nil
}
