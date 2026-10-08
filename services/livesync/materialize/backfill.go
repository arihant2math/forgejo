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
// ("repair:<id>" for a repair backfill, "perm:<id>" for a permission walk),
// or "done".
const MetaBackfillPrefix = "entity_backfill."

const (
	backfillDoneValue          = "done"
	backfillRepairPrefix       = "repair:"
	backfillPermPrefix         = "perm:"
	backfillDone         int64 = -1
	// backfillChunk is the number of rows indexed per BackfillStep.
	backfillChunk = 500
)

// The entity index routes deletes: the capture triggers only know (table,
// id), the deleted row is gone. Rows that existed before livesync was
// installed have no index row until they change, so the materializer walks
// every tracked table once and indexes them (group, unit and permission
// state, no payload hash: their first change is always emitted), leaving
// the rows the materializer wrote alone (indexKeep).
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
//
// A permission walk (indexPerm, "perm:<id>") records the permission states
// of a permission table whose index rows were written before permission
// states existed (B3; HandleEpochs starts it when the table's
// materialized_perm version is behind permVersion): it only fills the perm
// column, so it needs no markers. Until it has passed a row, the row's
// empty state is unknown (see permSubjects.transition).
//
// Every walk records the permission state of a row that still has changes
// in the outbox as unverified (permUnverified): the walk reads the row's
// current state, which may already include them, and recording it as known
// would make the materializer see no change when it consumes them.

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
	m.walk = map[string]indexWrite{}
	for _, meta := range metas {
		table := meta.Name[len(MetaBackfillPrefix):]
		if meta.Value == backfillDoneValue {
			m.backfill[table] = backfillDone
			continue
		}
		value, mode := meta.Value, indexKeep
		if v, ok := strings.CutPrefix(value, backfillRepairPrefix); ok {
			value, mode = v, indexRepair
		} else if v, ok := strings.CutPrefix(value, backfillPermPrefix); ok {
			value, mode = v, indexPerm
		}
		v, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return fmt.Errorf("livesync_meta %s is %q, not a backfill progress", meta.Name, meta.Value)
		}
		m.backfill[table] = v
		m.walk[table] = mode
	}
	return nil
}

// backfillValue is the livesync_meta value of a backfill progress.
func backfillValue(last int64, mode indexWrite) string {
	switch {
	case last == backfillDone:
		return backfillDoneValue
	case mode == indexRepair:
		return backfillRepairPrefix + strconv.FormatInt(last, 10)
	case mode == indexPerm:
		return backfillPermPrefix + strconv.FormatInt(last, 10)
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
	after := m.backfill[table]
	mode, ok := m.walk[table]
	if !ok {
		mode = indexKeep // the initial backfill
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
		// Read after the rows: a change committed in between is pending
		// here, so its row is recorded as unverified.
		var pending map[int64]bool
		if s.perm {
			if pending, err = pendingRows(ctx, table, ids); err != nil {
				return err
			}
		}
		var rows []livesync_model.Entity
		var stale []indexKey
		var groupless []int64
		for _, id := range ids {
			for i, e := range loaded[id] {
				if e.group == "" && mode == indexRepair {
					if i == 0 {
						groupless = append(groupless, id)
					}
					// In no group now (e.g. a release set back to draft
					// while its change was lost): an index row left from
					// before would make the row's return look unchanged
					// (same group, unit and hash), so that it would never
					// be emitted again (backend audit). Clients re-bootstrap
					// the table anyway, so none holds it.
					stale = append(stale, indexKey{e.key, id})
					continue
				}
				if e.group == "" || (mode == indexPerm && e.perm == "") {
					continue
				}
				perm := e.perm
				if perm != "" && pending[id] {
					perm = permUnverified + perm
				}
				rows = append(rows, livesync_model.Entity{Tbl: e.key, RowID: id, Grp: e.group, Unit: string(e.unit), Perm: perm})
			}
		}
		if err := writeIndex(ctx, rows, mode); err != nil {
			return err
		}
		if len(groupless) > 0 {
			deps, err := grouplessDependents(ctx, table, groupless)
			if err != nil {
				return err
			}
			stale = append(stale, deps...)
		}
		if err := deleteIndex(ctx, stale); err != nil {
			return err
		}
		next = backfillDone
		if len(ids) == backfillChunk {
			next = ids[len(ids)-1]
		}
		return livesync_model.SetMeta(ctx, MetaBackfillPrefix+table, backfillValue(next, mode))
	})
	if err != nil {
		return true, err
	}
	m.backfill[table] = next
	if next == backfillDone {
		delete(m.walk, table)
		log.Debug("livesync: entity index backfill of %s complete", table)
	}
	return true, nil
}

// grouplessDependents returns the index keys of the rows placed by the
// given rows of table (spec.dependents, transitively: a release's
// attachments, a comment's reactions) that are in no group now either: the
// repair walk removes their index rows with their parents' (BackfillStep),
// so that they are emitted again when their parent returns (a release
// published again moves its attachments back in).
func grouplessDependents(ctx context.Context, table string, ids []int64) ([]indexKey, error) {
	var res []indexKey
	moved := map[string][]int64{table: ids}
	done := map[rowKey]bool{}
	for _, id := range ids {
		done[rowKey{table, id}] = true
	}
	for round := 0; len(moved) > 0 && round < maxDependentRounds; round++ {
		deps, err := dependentRows(ctx, moved, done)
		if err != nil {
			return nil, err
		}
		byTable := map[string][]int64{}
		for _, k := range deps {
			byTable[k.tbl] = append(byTable[k.tbl], k.id)
		}
		moved = map[string][]int64{}
		for _, tbl := range sortedKeys(byTable) {
			loaded, err := specs[tbl].load(ctx, newLoader(), byTable[tbl], false)
			if err != nil {
				return nil, fmt.Errorf("livesync: backfill %s: dependents: %w", table, err)
			}
			for _, id := range byTable[tbl] {
				ents := loaded[id]
				if len(ents) == 0 || ents[0].group != "" {
					continue // gone (its delete is routed by its index row), or placed
				}
				for _, e := range ents {
					res = append(res, indexKey{e.key, id})
				}
				moved[tbl] = append(moved[tbl], id)
			}
		}
	}
	return res, nil
}

// pendingRows returns which of the rows of table have changes in the
// outbox (not consumed yet, or deferred).
func pendingRows(ctx context.Context, table string, ids []int64) (map[int64]bool, error) {
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return nil, err
	}
	res := map[int64]bool{}
	for start := 0; start < len(ids); start += inChunk {
		var found []int64
		if err := e.Table("livesync_change").Distinct("row_id").Where("tbl = ?", table).In("row_id", ids[start:min(start+inChunk, len(ids))]).Find(&found); err != nil {
			return nil, fmt.Errorf("livesync: backfill %s: pending changes: %w", table, err)
		}
		for _, id := range found {
			res[id] = true
		}
	}
	return res, nil
}
