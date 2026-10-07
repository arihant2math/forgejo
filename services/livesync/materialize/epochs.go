// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/json"
	"forgejo.org/modules/log"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/services/livesync/catalog"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/services/livesync/synclog"
)

// MetaHandledEpochPrefix + table name is the livesync_meta entry holding the
// table's schema epoch (capture.MetaEpochPrefix) that the materializer has
// handled.
const MetaHandledEpochPrefix = "materialized_epoch."

// MetaPlacementPrefix + table name is the livesync_meta entry holding the
// placement version (placementVersions) the table's index was built with.
const MetaPlacementPrefix = "materialized_placement."

// placementVersions are the versions of the placement rules (which group
// and unit an entity goes to) of the tables whose rules changed since the
// first release; absent tables are at version 0. Bump a table's version
// whenever its rules change: HandleEpochs then treats it like a repaired
// trigger (re-bootstrap markers, repair backfill of the index), because
// clients hold its entities in the old places and the index would route
// deletes there. Version 1 of user, project and project_board (B4): the
// public profiles moved from user:{id} to the profile groups.
var placementVersions = map[string]int64{
	"user":          1,
	"project":       1,
	"project_board": 1,
}

// readMetaInts returns the numeric livesync_meta entries whose name starts
// with prefix, keyed by the rest of the name.
func readMetaInts(ctx context.Context, prefix string) (map[string]int64, error) {
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return nil, err
	}
	var metas []livesync_model.Meta
	if err := e.Where("name LIKE ?", prefix+"%").Find(&metas); err != nil {
		return nil, fmt.Errorf("livesync: read %s*: %w", prefix, err)
	}
	res := make(map[string]int64, len(metas))
	for _, m := range metas {
		v, err := strconv.ParseInt(m.Value, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("livesync_meta %s is %q, not a number", m.Name, m.Value)
		}
		res[strings.TrimPrefix(m.Name, prefix)] = v
	}
	return res, nil
}

// HandleEpochs consumes the capture schema epochs. capture.Ensure bumps a
// table's epoch whenever its trigger was missing or stale, i.e. when changes
// to the table may have been lost, and they cannot be recovered: a scan over
// updated_unix would miss deletes and the many writes that do not touch
// updated_unix (counters, NoAutoTime updates, tables without the column).
// So for every table whose epoch differs from the one handled, the
// materializer appends one re-bootstrap marker per model of the table to
// GroupAll (protocol.OpRebootstrap; B5 turns it into bootstrap_required for
// the groups a client holds), restarts the entity index backfill of the
// table in repair mode (rows inserted while the trigger was missing are not
// indexed, and the index rows of rows changed meanwhile have a stale group
// and hash; see the entity index backfill), and records the epoch as
// handled, all in one transaction.
//
// A table with no handled epoch yet (livesync's first start, or a table
// newly added to the catalog) is recorded without a marker: no client can
// hold entities of it from the log, and bootstraps read the tables
// directly.
//
// A table whose placement version (placementVersions) differs from the one
// recorded is handled the same way (markers with reason
// RebootstrapPlacementChanged, repair backfill). When a table with
// permission states (spec.perm) gets markers for a repaired trigger, the
// permission changes it lost are unknown, so a permission epoch for
// everything (PermissionChange.All) goes first.
func (m *Materializer) HandleEpochs(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	current, err := readMetaInts(ctx, capture.MetaEpochPrefix)
	if err != nil {
		return err
	}
	handled, err := readMetaInts(ctx, MetaHandledEpochPrefix)
	if err != nil {
		return err
	}
	placed, err := readMetaInts(ctx, MetaPlacementPrefix)
	if err != nil {
		return err
	}
	var entries []synclog.Entry
	var record, reset []string
	permLost := false
	for _, t := range catalog.Tracked() {
		epoch := current[t.Name]
		done, ok := handled[t.Name]
		repaired := ok && done != epoch
		moved := ok && placed[t.Name] != placementVersions[t.Name]
		if ok && !repaired && !moved {
			continue
		}
		record = append(record, t.Name)
		if !ok {
			continue
		}
		reset = append(reset, t.Name)
		marker := protocol.RebootstrapMarker{Table: t.Name, Epoch: epoch, Reason: protocol.RebootstrapPlacementChanged}
		if repaired {
			marker.Reason = protocol.RebootstrapTriggerRepaired
			permLost = permLost || specs[t.Name].perm
		}
		payload, err := json.Marshal(marker)
		if err != nil {
			return err
		}
		s := specs[t.Name]
		for i, model := range s.models {
			entries = append(entries, synclog.Entry{
				Group: protocol.GroupAll, Model: model, Op: protocol.OpRebootstrap,
				Payload: string(payload), SchemaVer: s.schemas[i],
			})
		}
	}
	if len(record) == 0 {
		return nil
	}
	if permLost {
		e, err := permEntry(protocol.PermissionChange{All: true})
		if err != nil {
			return err
		}
		entries = append([]synclog.Entry{e}, entries...)
	}
	if err := m.inWriterTx(ctx, func(ctx context.Context) error {
		if _, err := m.writer.Append(ctx, entries); err != nil {
			return err
		}
		for _, table := range record {
			if err := livesync_model.SetMeta(ctx, MetaHandledEpochPrefix+table, strconv.FormatInt(current[table], 10)); err != nil {
				return err
			}
			if err := livesync_model.SetMeta(ctx, MetaPlacementPrefix+table, strconv.FormatInt(placementVersions[table], 10)); err != nil {
				return err
			}
		}
		for _, table := range reset {
			if err := livesync_model.SetMeta(ctx, MetaBackfillPrefix+table, backfillValue(0, true)); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return err
	}
	for _, table := range reset {
		m.backfill[table] = 0
		m.repair[table] = true
	}
	if len(reset) > 0 {
		log.Info("livesync: the capture triggers or placement rules of %s changed; appended re-bootstrap markers for their models", strings.Join(reset, ", "))
	}
	return nil
}
