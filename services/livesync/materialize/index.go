// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"context"
	"fmt"
	"strings"

	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/setting"
)

// The entity index (livesync_entity): which group and unit each emitted
// entity is in, and the hash of its last payload.

// indexKey identifies an entity in the index.
type indexKey struct {
	key string // livesync_entity.tbl
	id  int64
}

// loadIndex returns the index rows of the entities key/ids.
func loadIndex(ctx context.Context, key string, ids []int64) (map[int64]*livesync_model.Entity, error) {
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return nil, err
	}
	res := make(map[int64]*livesync_model.Entity, len(ids))
	for start := 0; start < len(ids); start += inChunk {
		chunk := ids[start:min(start+inChunk, len(ids))]
		rows := make([]*livesync_model.Entity, 0, len(chunk))
		if err := e.Where("tbl = ?", key).In("row_id", chunk).Find(&rows); err != nil {
			return nil, fmt.Errorf("livesync: read the entity index: %w", err)
		}
		for _, r := range rows {
			res[r.RowID] = r
		}
	}
	return res, nil
}

// indexWriteChunk bounds the rows of one multi-row index statement.
const indexWriteChunk = 200

// indexWrite says how writeIndex treats existing index rows.
type indexWrite int

const (
	// indexUpsert overwrites them (the materializer's own upserts).
	indexUpsert indexWrite = iota
	// indexKeep leaves them alone: the initial backfill must never
	// overwrite what the materializer wrote, which tells where clients hold
	// the entity (a row whose move is still in the outbox is in its old
	// group until the materializer emits the move).
	indexKeep
	// indexRepair overwrites their group, unit and permission state and
	// clears their hash, keeping last_sync_id: the backfill after a
	// re-bootstrap marker, when the index may be stale (writes were lost)
	// and every client rebuilds its state from a bootstrap (see
	// HandleEpochs; lost permission changes are covered by the epoch for
	// everyone it writes).
	indexRepair
	// indexPerm overwrites only their permission state (a row the
	// materializer did not emit although its permission state changed, and
	// the permission walk of a table indexed before permission states
	// existed): their group, unit and hash, which tell where clients hold
	// the entity, stay. Missing rows are inserted as with indexKeep.
	indexPerm
)

// writeIndex inserts rows into the index; mode says what happens to
// existing rows.
func writeIndex(ctx context.Context, rows []livesync_model.Entity, mode indexWrite) error {
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return err
	}
	mysql := setting.Database.Type.IsMySQL()
	var conflict string
	switch {
	case mode == indexUpsert && mysql:
		conflict = " ON DUPLICATE KEY UPDATE grp = VALUES(grp), unit = VALUES(unit), hash = VALUES(hash), last_sync_id = VALUES(last_sync_id), perm = VALUES(perm)"
	case mode == indexUpsert:
		conflict = " ON CONFLICT (tbl, row_id) DO UPDATE SET grp = excluded.grp, unit = excluded.unit, hash = excluded.hash, last_sync_id = excluded.last_sync_id, perm = excluded.perm"
	case mode == indexRepair && mysql:
		conflict = " ON DUPLICATE KEY UPDATE grp = VALUES(grp), unit = VALUES(unit), hash = VALUES(hash), perm = VALUES(perm)"
	case mode == indexRepair:
		conflict = " ON CONFLICT (tbl, row_id) DO UPDATE SET grp = excluded.grp, unit = excluded.unit, hash = excluded.hash, perm = excluded.perm"
	case mode == indexPerm && mysql:
		conflict = " ON DUPLICATE KEY UPDATE perm = VALUES(perm)"
	case mode == indexPerm:
		conflict = " ON CONFLICT (tbl, row_id) DO UPDATE SET perm = excluded.perm"
	case mysql:
		conflict = " ON DUPLICATE KEY UPDATE tbl = tbl"
	default:
		conflict = " ON CONFLICT (tbl, row_id) DO NOTHING"
	}
	for start := 0; start < len(rows); start += indexWriteChunk {
		chunk := rows[start:min(start+indexWriteChunk, len(rows))]
		var sb strings.Builder
		sb.WriteString("INSERT INTO livesync_entity (tbl, row_id, grp, unit, hash, last_sync_id, perm) VALUES ")
		args := make([]any, 0, 7*len(chunk)+1)
		for i, r := range chunk {
			if i > 0 {
				sb.WriteString(", ")
			}
			sb.WriteString("(?, ?, ?, ?, ?, ?, ?)")
			args = append(args, r.Tbl, r.RowID, r.Grp, r.Unit, r.Hash, r.LastSyncID, r.Perm)
		}
		sb.WriteString(conflict)
		args = append([]any{sb.String()}, args...)
		if _, err := e.Exec(args...); err != nil {
			return fmt.Errorf("livesync: write the entity index: %w", err)
		}
	}
	return nil
}

// deleteIndex removes the index rows of deleted entities.
func deleteIndex(ctx context.Context, keys []indexKey) error {
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return err
	}
	byKey := map[string][]int64{}
	var order []string
	for _, k := range keys {
		if _, ok := byKey[k.key]; !ok {
			order = append(order, k.key)
		}
		byKey[k.key] = append(byKey[k.key], k.id)
	}
	for _, key := range order {
		ids := byKey[key]
		for start := 0; start < len(ids); start += inChunk {
			if _, err := e.Where("tbl = ?", key).In("row_id", ids[start:min(start+inChunk, len(ids))]).Delete(&livesync_model.Entity{}); err != nil {
				return fmt.Errorf("livesync: delete from the entity index: %w", err)
			}
		}
	}
	return nil
}
