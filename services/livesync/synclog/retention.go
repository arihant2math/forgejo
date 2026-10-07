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
// The writer runs it periodically; it needs no fencing (deleting old entries
// is the same whoever does it).
func Trim(ctx context.Context, maxAge time.Duration, maxRows int64) (int64, error) {
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
		next := min(floor+trimChunk, target)
		if err := db.WithTx(ctx, func(ctx context.Context) error {
			e, err := livesync_model.MasterEngine(ctx)
			if err != nil {
				return err
			}
			if _, err := e.Exec("DELETE FROM livesync_log WHERE sync_id <= ?", next); err != nil {
				return fmt.Errorf("livesync: trim the sync log: %w", err)
			}
			return livesync_model.SetMeta(ctx, MetaFloor, strconv.FormatInt(next, 10))
		}); err != nil {
			return floor, err
		}
		floor = next
	}
	return floor, nil
}
