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
// table (rows inserted while the trigger was missing are not indexed), and
// records the epoch as handled, all in one transaction.
//
// A table with no handled epoch yet (livesync's first start, or a table
// newly added to the catalog) is recorded without a marker: no client can
// hold entities of it from the log, and bootstraps read the tables
// directly.
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
	var entries []synclog.Entry
	var record, reset []string
	for _, t := range catalog.Tracked() {
		epoch := current[t.Name]
		done, ok := handled[t.Name]
		if ok && done == epoch {
			continue
		}
		record = append(record, t.Name)
		if !ok {
			continue
		}
		reset = append(reset, t.Name)
		payload, err := json.Marshal(protocol.RebootstrapMarker{Table: t.Name, Epoch: epoch})
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
	if err := m.inWriterTx(ctx, func(ctx context.Context) error {
		if _, err := m.writer.Append(ctx, entries); err != nil {
			return err
		}
		for _, table := range record {
			if err := livesync_model.SetMeta(ctx, MetaHandledEpochPrefix+table, strconv.FormatInt(current[table], 10)); err != nil {
				return err
			}
		}
		for _, table := range reset {
			if err := livesync_model.SetMeta(ctx, MetaBackfillPrefix+table, "0"); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return err
	}
	for _, table := range reset {
		m.backfill[table] = 0
	}
	if len(reset) > 0 {
		log.Info("livesync: the capture triggers of %s were repaired; appended re-bootstrap markers for their models", strings.Join(reset, ", "))
	}
	return nil
}
