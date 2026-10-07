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

// writeIndex inserts rows into the index. With replace, existing rows are
// overwritten (the materializer's own upserts); without, existing rows are
// left alone (the backfill must never overwrite what the materializer
// wrote, which is newer).
func writeIndex(ctx context.Context, rows []livesync_model.Entity, replace bool) error {
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return err
	}
	for start := 0; start < len(rows); start += indexWriteChunk {
		chunk := rows[start:min(start+indexWriteChunk, len(rows))]
		var sb strings.Builder
		sb.WriteString("INSERT INTO livesync_entity (tbl, row_id, grp, unit, hash, last_sync_id) VALUES ")
		args := make([]any, 0, 6*len(chunk)+1)
		for i, r := range chunk {
			if i > 0 {
				sb.WriteString(", ")
			}
			sb.WriteString("(?, ?, ?, ?, ?, ?)")
			args = append(args, r.Tbl, r.RowID, r.Grp, r.Unit, r.Hash, r.LastSyncID)
		}
		switch {
		case setting.Database.Type.IsMySQL() && replace:
			sb.WriteString(" ON DUPLICATE KEY UPDATE grp = VALUES(grp), unit = VALUES(unit), hash = VALUES(hash), last_sync_id = VALUES(last_sync_id)")
		case setting.Database.Type.IsMySQL():
			sb.WriteString(" ON DUPLICATE KEY UPDATE tbl = tbl")
		case replace:
			sb.WriteString(" ON CONFLICT (tbl, row_id) DO UPDATE SET grp = excluded.grp, unit = excluded.unit, hash = excluded.hash, last_sync_id = excluded.last_sync_id")
		default:
			sb.WriteString(" ON CONFLICT (tbl, row_id) DO NOTHING")
		}
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
