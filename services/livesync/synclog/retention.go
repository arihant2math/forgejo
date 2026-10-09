// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package synclog

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
)

// trimChunk bounds the entries deleted per transaction.
const trimChunk = 5000

// Trim applies the retention policy: it deletes the entries older than
// maxAge and those beyond the newest maxRows (0 disables either limit) and
// returns the new floor (see Floor). Each chunk's deletion and the floor
// move are one transaction, so the floor always covers every missing entry.
//
// Trimming is writer work: each chunk is fenced like an append (it returns
// ErrNotWriter once another instance has become the writer), and the floor
// only ever moves up (it is read locked in the chunk's transaction), so a
// writer that lost its lease in the middle of a long trim cannot move the
// floor below what the new writer trimmed — ReadSince relies on that to
// report every gap.
func (w *Writer) Trim(ctx context.Context, maxAge time.Duration, maxRows int64) (int64, error) {
	floor, err := Floor(ctx)
	if err != nil {
		return 0, err
	}
	head, err := Head(ctx)
	if err != nil {
		return 0, err
	}
	target := floor
	if maxRows > 0 {
		target = max(target, head-maxRows)
	}
	if maxAge > 0 {
		e, err := livesync_model.MasterEngine(ctx)
		if err != nil {
			return 0, err
		}
		var old int64
		cutoff := time.Now().Add(-maxAge).Unix()
		if _, err := e.SQL("SELECT COALESCE(MAX(sync_id), 0) FROM livesync_log WHERE created_unix < ?", cutoff).Get(&old); err != nil {
			return 0, fmt.Errorf("livesync: find expired sync log entries: %w", err)
		}
		target = max(target, old)
	}
	target = min(target, head)
	for floor < target {
		if floor, err = w.trimTo(ctx, min(floor+trimChunk, target)); err != nil {
			return floor, err
		}
	}
	return floor, nil
}

// trimTo deletes the entries up to next and moves the floor there, in one
// fenced transaction; a floor that is already higher stays. It returns the
// floor.
func (w *Writer) trimTo(ctx context.Context, next int64) (int64, error) {
	floor := next
	err := db.WithTx(ctx, func(ctx context.Context) error {
		if _, err := w.Append(ctx, nil); err != nil {
			return err
		}
		values, err := lockMeta(ctx, MetaFloor)
		if err != nil {
			return err
		}
		if cur := values[MetaFloor]; cur >= next {
			floor = cur
			return nil
		}
		e, err := livesync_model.MasterEngine(ctx)
		if err != nil {
			return err
		}
		if _, err := e.Exec("DELETE FROM livesync_log WHERE sync_id <= ?", next); err != nil {
			return fmt.Errorf("livesync: trim the sync log: %w", err)
		}
		return livesync_model.SetMeta(ctx, MetaFloor, strconv.FormatInt(next, 10))
	})
	return floor, err
}
