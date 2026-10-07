// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"context"
	"fmt"
	"strconv"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/log"
	"forgejo.org/services/livesync/catalog"
)

// MetaBackfillPrefix + table name is the livesync_meta entry holding the
// progress of the table's entity index backfill: the last row id indexed, or
// "done".
const MetaBackfillPrefix = "entity_backfill."

const (
	backfillDoneValue       = "done"
	backfillDone      int64 = -1
	// backfillChunk is the number of rows indexed per BackfillStep.
	backfillChunk = 500
)

// The entity index routes deletes: the capture triggers only know (table,
// id), the deleted row is gone. Rows that existed before livesync was
// installed (or were inserted while a capture trigger was missing) have no
// index row until they change, so the materializer walks every tracked
// table once and indexes them (group and unit only, no payload hash: their
// first change is always emitted). Until a table is complete, a delete of
// an unindexed row of it is sent to GroupAll (see materialize).

func (m *Materializer) loadBackfill(ctx context.Context) error {
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return err
	}
	var metas []livesync_model.Meta
	if err := e.Where("name LIKE ?", MetaBackfillPrefix+"%").Find(&metas); err != nil {
		return fmt.Errorf("livesync: read the backfill progress: %w", err)
	}
	m.backfill = map[string]int64{}
	for _, meta := range metas {
		table := meta.Name[len(MetaBackfillPrefix):]
		if meta.Value == backfillDoneValue {
			m.backfill[table] = backfillDone
			continue
		}
		v, err := strconv.ParseInt(meta.Value, 10, 64)
		if err != nil {
			return fmt.Errorf("livesync_meta %s is %q, not a number", meta.Name, meta.Value)
		}
		m.backfill[table] = v
	}
	return nil
}

func (m *Materializer) backfillComplete(table string) bool {
	return m.backfill[table] == backfillDone
}

// BackfillStep indexes the next backfillChunk rows of the first tracked
// table whose index is incomplete, in one writer transaction. It reports
// whether any table is still incomplete.
func (m *Materializer) BackfillStep(ctx context.Context) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var table string
	for _, t := range catalog.Tracked() {
		if !m.backfillComplete(t.Name) {
			table = t.Name
			break
		}
	}
	if table == "" {
		return false, nil
	}
	after := m.backfill[table]
	var next int64
	err := m.inWriterTx(ctx, func(ctx context.Context) error {
		// Fencing only: an old writer must not keep indexing.
		if _, err := m.writer.Append(ctx, nil); err != nil {
			return err
		}
		var ids []int64
		if err := db.GetEngine(ctx).Table(table).Cols("id").Where("id > ?", after).OrderBy("id").Limit(backfillChunk).Find(&ids); err != nil {
			return fmt.Errorf("livesync: backfill %s: %w", table, err)
		}
		s := specs[table]
		loaded, err := s.load(ctx, newLoader(), ids, false)
		if err != nil {
			return fmt.Errorf("livesync: backfill %s: %w", table, err)
		}
		var rows []livesync_model.Entity
		for _, id := range ids {
			for _, e := range loaded[id] {
				if e.group != "" {
					rows = append(rows, livesync_model.Entity{Tbl: e.key, RowID: id, Grp: e.group, Unit: string(e.unit)})
				}
			}
		}
		if err := writeIndex(ctx, rows, false); err != nil {
			return err
		}
		value := backfillDoneValue
		next = backfillDone
		if len(ids) == backfillChunk {
			next = ids[len(ids)-1]
			value = strconv.FormatInt(next, 10)
		}
		return livesync_model.SetMeta(ctx, MetaBackfillPrefix+table, value)
	})
	if err != nil {
		return true, err
	}
	m.backfill[table] = next
	if next == backfillDone {
		log.Debug("livesync: entity index backfill of %s complete", table)
	}
	return true, nil
}
