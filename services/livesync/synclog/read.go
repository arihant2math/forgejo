// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package synclog

import (
	"context"
	"errors"
	"fmt"

	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/services/livesync/protocol"

	"xorm.io/builder"
)

// ErrTrimmed is wrapped by the *TrimmedError ReadSince returns for a cursor
// older than the retention floor.
var ErrTrimmed = errors.New("livesync: cursor is older than the sync log retention")

// TrimmedError says that entries after a cursor have been trimmed by the
// retention policy: the reader must re-bootstrap (bootstrap_required).
type TrimmedError struct {
	Cursor int64
	// Floor is the oldest cursor the log can still serve.
	Floor int64
}

func (e *TrimmedError) Error() string {
	return fmt.Sprintf("%v (cursor %d, oldest available %d)", ErrTrimmed, e.Cursor, e.Floor)
}

func (e *TrimmedError) Unwrap() error { return ErrTrimmed }

// Head returns the last sync id assigned (0 for an empty log). Entries up to
// it are committed.
func Head(ctx context.Context) (int64, error) {
	return metaInt(ctx, MetaHead)
}

// Floor returns the retention floor: the oldest cursor ReadSince can serve
// (entries at or below it may have been trimmed).
func Floor(ctx context.Context) (int64, error) {
	return metaInt(ctx, MetaFloor)
}

// ReadSince returns up to limit entries with a sync id above cursor, in
// sync id order: the entries of group plus the GroupAll entries
// (re-bootstrap markers), or the entries of every group when group is
// empty. It returns a *TrimmedError if entries after cursor may have been
// trimmed.
func ReadSince(ctx context.Context, group string, cursor int64, limit int) ([]livesync_model.LogEntry, error) {
	return ReadRange(ctx, group, cursor, 0, limit)
}

// ReadRange is ReadSince limited to the entries up to until (0: no limit).
// The hub replays a group up to the position its tailer has delivered, so
// that it never sends an entry before the permission epochs that precede
// it were applied.
func ReadRange(ctx context.Context, group string, cursor, until int64, limit int) ([]livesync_model.LogEntry, error) {
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return nil, err
	}
	var cond builder.Cond = builder.Gt{"sync_id": cursor}
	if until > 0 {
		cond = cond.And(builder.Lte{"sync_id": until})
	}
	if group != "" {
		cond = cond.And(builder.In("grp", group, protocol.GroupAll))
	}
	sess := e.Where(cond)
	entries := make([]livesync_model.LogEntry, 0, min(limit, 256))
	if err := sess.OrderBy("sync_id").Limit(limit).Find(&entries); err != nil {
		return nil, fmt.Errorf("livesync: read the sync log: %w", err)
	}
	// The floor is read after the entries: it only grows (Trim moves it
	// under a row lock, never down, fenced by the writer token), and it is
	// moved in the transaction that trims, so if any entry above cursor was
	// gone when they were read, the floor read now is above cursor.
	floor, err := Floor(ctx)
	if err != nil {
		return nil, err
	}
	if cursor < floor {
		return nil, &TrimmedError{Cursor: cursor, Floor: floor}
	}
	return entries, nil
}
