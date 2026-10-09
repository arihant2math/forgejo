// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package synclog

import (
	"context"
	"errors"
	"fmt"
	"math"
	"slices"

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
	return read(ctx, group, cursor, math.MaxInt64, limit, nil)
}

// keyColumns are the columns ReadKeys reads: everything but the payload.
var keyColumns = []string{"grp", "sync_id", "model", "entity_id", "op", "unit"}

// ReadKeys is ReadSince for the entries up to until, without their
// payloads (Payload is empty; ReadEntries loads them). The hub reads the
// keys of a replay first, to send only the newest state of each entity,
// and replays a group only up to the position its tailer has delivered,
// so that it never sends an entry before the permission epochs that
// precede it were applied.
func ReadKeys(ctx context.Context, group string, cursor, until int64, limit int) ([]livesync_model.LogEntry, error) {
	return read(ctx, group, cursor, until, limit, keyColumns)
}

// read returns up to limit entries in (cursor, until] (see ReadSince),
// with only the columns cols when not nil.
func read(ctx context.Context, group string, cursor, until int64, limit int, cols []string) ([]livesync_model.LogEntry, error) {
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return nil, err
	}
	query := func(grp string) ([]livesync_model.LogEntry, error) {
		cond := builder.Gt{"sync_id": cursor}.And(builder.Lte{"sync_id": until})
		if grp != "" {
			cond = cond.And(builder.Eq{"grp": grp})
		}
		sess := e.Where(cond)
		if cols != nil {
			sess = sess.Cols(cols...)
		}
		entries := make([]livesync_model.LogEntry, 0, min(limit, 256))
		if err := sess.OrderBy("sync_id").Limit(limit).Find(&entries); err != nil {
			return nil, fmt.Errorf("livesync: read the sync log: %w", err)
		}
		return entries, nil
	}
	var entries []livesync_model.LogEntry
	if group == "" || group == protocol.GroupAll {
		entries, err = query(group)
	} else {
		// Two range scans of the (grp, sync_id) index merged here: a
		// "grp IN (group, '*') ORDER BY sync_id" query is planned as a walk
		// of the primary key filtering every group's rows, whose cost grows
		// with the whole log's traffic instead of the group's.
		var own, all []livesync_model.LogEntry
		if own, err = query(group); err == nil {
			all, err = query(protocol.GroupAll)
		}
		entries = mergeBySyncID(own, all, limit)
	}
	if err != nil {
		return nil, err
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

// mergeBySyncID merges two lists ordered by sync id, keeping the first
// limit entries.
func mergeBySyncID(a, b []livesync_model.LogEntry, limit int) []livesync_model.LogEntry {
	if len(b) == 0 {
		return a
	}
	res := make([]livesync_model.LogEntry, 0, min(len(a)+len(b), limit))
	for len(res) < limit && (len(a) > 0 || len(b) > 0) {
		if len(b) == 0 || len(a) > 0 && a[0].SyncID < b[0].SyncID {
			res, a = append(res, a[0]), a[1:]
		} else {
			res, b = append(res, b[0]), b[1:]
		}
	}
	return res
}

// ReadEntries returns the entries with the given sync ids (ascending,
// payloads included). It returns a *TrimmedError when one of them was
// trimmed meanwhile.
func ReadEntries(ctx context.Context, ids []int64) ([]livesync_model.LogEntry, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return nil, err
	}
	entries := make([]livesync_model.LogEntry, 0, len(ids))
	if err := e.In("sync_id", ids).OrderBy("sync_id").Find(&entries); err != nil {
		return nil, fmt.Errorf("livesync: read the sync log: %w", err)
	}
	if len(entries) == len(ids) {
		return entries, nil
	}
	// Entries are only ever deleted by Trim, from the bottom up.
	floor, err := Floor(ctx)
	if err != nil {
		return nil, err
	}
	sorted := slices.Sorted(slices.Values(ids))
	missing := sorted[len(sorted)-1]
	for i, id := range sorted {
		if i >= len(entries) || entries[i].SyncID != id {
			missing = id
			break
		}
	}
	if missing > floor {
		return nil, fmt.Errorf("livesync: sync log entry %d is missing above the retention floor %d", missing, floor)
	}
	return nil, &TrimmedError{Cursor: missing - 1, Floor: floor}
}

// ReadGroups returns, for every group with entries in (cursor, until], the
// sync id of its last entry there. It reads every entry of the range (the
// primary key's): use it for short ranges only. The hub checks with it at
// once which of many groups resumed from the same position missed
// anything.
func ReadGroups(ctx context.Context, cursor, until int64) (map[string]int64, error) {
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return nil, err
	}
	var rows []struct {
		Grp  string
		Last int64
	}
	if err := e.Table(livesync_model.LogEntry{}).Select("grp, MAX(sync_id) AS last").
		Where(builder.Gt{"sync_id": cursor}.And(builder.Lte{"sync_id": until})).GroupBy("grp").Find(&rows); err != nil {
		return nil, fmt.Errorf("livesync: read the sync log: %w", err)
	}
	floor, err := Floor(ctx)
	if err != nil {
		return nil, err
	}
	if cursor < floor {
		return nil, &TrimmedError{Cursor: cursor, Floor: floor}
	}
	res := make(map[string]int64, len(rows))
	for _, r := range rows {
		res[r.Grp] = r.Last
	}
	return res, nil
}
