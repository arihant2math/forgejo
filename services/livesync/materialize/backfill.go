// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/log"
	"forgejo.org/services/livesync/catalog"
)

// MetaBackfillPrefix + table name is the livesync_meta entry holding the
// progress of the table's entity index backfill: the last row id indexed
// ("repair:<id>" for a repair backfill), or "done".
const MetaBackfillPrefix = "entity_backfill."

const (
	backfillDoneValue          = "done"
	backfillRepairPrefix       = "repair:"
	backfillDone         int64 = -1
	// backfillChunk is the number of rows indexed per BackfillStep.
	backfillChunk = 500
)

// The entity index routes deletes: the capture triggers only know (table,
// id), the deleted row is gone. Rows that existed before livesync was
// installed have no index row until they change, so the materializer walks
// every tracked table once and indexes them (group and unit only, no
// payload hash: their first change is always emitted), leaving the rows the
// materializer wrote alone (indexKeep).
//
// A delete of a row that is not indexed is not emitted anywhere (sending it
// to every client would broadcast ids of deleted private rows to everyone,
// against PLAN §4.4/§4.5). That is only correct if no client can hold such
// a row, so **bootstraps of a table's models must wait until the table's
// backfill is done** (livesync_meta entity_backfill.<table> = "done"; B6):
// a client then holds only rows that existed after the walk passed them
// (indexed by the walk) or that the materializer indexed.
//
// After a re-bootstrap marker (HandleEpochs, writes to the table may have
// been lost) the table is walked again in repair mode (indexRepair): every
// index row gets the row's current group and unit and loses its hash, so
// stale groups (a lost move) and stale hashes (a lost change that a later
// change undoes) cannot misroute or drop later changes. The marker resets
// the progress to "repair:0" in its own transaction, so bootstraps of the
// table wait for the repair too; every client that held the table's models
// re-bootstraps after the marker, so what the stale index routes in the
// meantime reaches nobody who keeps it.

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
	m.repair = map[string]bool{}
	for _, meta := range metas {
		table := meta.Name[len(MetaBackfillPrefix):]
		if meta.Value == backfillDoneValue {
			m.backfill[table] = backfillDone
			continue
		}
		value, repair := strings.CutPrefix(meta.Value, backfillRepairPrefix)
		v, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return fmt.Errorf("livesync_meta %s is %q, not a backfill progress", meta.Name, meta.Value)
		}
		m.backfill[table] = v
		m.repair[table] = repair
	}
	return nil
}

// backfillValue is the livesync_meta value of a backfill progress.
func backfillValue(last int64, repair bool) string {
	switch {
	case last == backfillDone:
		return backfillDoneValue
	case repair:
		return backfillRepairPrefix + strconv.FormatInt(last, 10)
	}
	return strconv.FormatInt(last, 10)
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
	after, repair := m.backfill[table], m.repair[table]
	mode := indexKeep
	if repair {
		mode = indexRepair
	}
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
		if err := writeIndex(ctx, rows, mode); err != nil {
			return err
		}
		next = backfillDone
		if len(ids) == backfillChunk {
			next = ids[len(ids)-1]
		}
		return livesync_model.SetMeta(ctx, MetaBackfillPrefix+table, backfillValue(next, repair))
	})
	if err != nil {
		return true, err
	}
	m.backfill[table] = next
	if next == backfillDone {
		delete(m.repair, table)
		log.Debug("livesync: entity index backfill of %s complete", table)
	}
	return true, nil
}
