// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"context"
	"fmt"
	"hash/fnv"
	"slices"
	"strconv"
	"strings"

	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/json"
	"forgejo.org/modules/log"
	"forgejo.org/modules/setting"
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
// public profiles moved from user:{id} to the profile groups. Version 1 of
// release (B6): tags without a release need the code unit, not releases.
// Version 1 of tracked_time (B6 review): a tracked time moved from its
// issue:{id} to its tracker's user:{id} (self), a deleted one to no group.
// Version 1 of reaction (B6 review): reactions of a type that is not
// allowed are in no group (see placementVersion). Version 1 of
// issue_dependency (B6 review): in no group, sent per viewer by issue
// loads (Conditionals). Version 1 of label and 2 of project (B6 review
// round 2): organization labels and user/organization projects moved from
// org:{id} / profile:{id} to owner:{id}, which readers of the owner's
// repositories' issues may read too (their columns stayed). Version 3 of
// project (B6 follow-up): the Project went back to org:{id} / profile:{id}
// (upstream shows an owner's project pages only to those who may see the
// owner) and owner:{id} holds a ProjectRef (title, open/closed, type)
// instead, a second entity of the row; the markers cover both models.
// Version 4 of project and 2 of project_board (backend audit): an
// organization's projects and their columns need the projects unit in
// org:{id}. Version 1 of team_user and team_repo (backend audit): who is in
// a team and its repositories moved from org:{id} (members) to team:{id}.
var placementVersions = map[string]int64{
	"label":            1,
	"user":             1,
	"project":          4,
	"project_board":    2,
	"release":          1,
	"tracked_time":     1,
	"reaction":         1,
	"issue_dependency": 1,
	"team_user":        1,
	"team_repo":        1,
}

// MetaContentPrefix + table name is the livesync_meta entry holding the
// content version (contentVersions) of the table's entities that clients
// were last told to re-bootstrap for.
const MetaContentPrefix = "materialized_content."

// contentVersions are the versions of what a table's DTOs carry (not where
// they are placed): when a change makes payloads that clients already hold
// wrong to keep — they show what must not be shown any more — the table's
// version is bumped and HandleEpochs writes re-bootstrap markers for its
// models (reason RebootstrapPlacementChanged), without an index walk (the
// index's groups and units stay right; bootstraps build the new payloads,
// renderVersion keeps them from reusing logged HTML). Absent tables are at
// version 0. Version 1 of issue, comment, review and release (backend
// audit): body_html without file previews (code of repositories that were
// public when the body was rendered). Version 1 of collaboration (backend
// audit): the permission no longer tells admin from write.
var contentVersions = map[string]int64{
	"issue":         1,
	"comment":       1,
	"review":        1,
	"release":       1,
	"collaboration": 1,
}

// placementVersion is the placement version of table: placementVersions,
// combined for reaction with the allowed reaction types ([ui] REACTIONS),
// which decide whether a reaction is placed at all (version 1, B6 review:
// upstream lists only reactions of an allowed type), so that changing them
// re-places the reactions like a code change of the rules.
func placementVersion(table string) int64 {
	v := placementVersions[table]
	if table == "reaction" {
		h := fnv.New32a()
		for _, r := range setting.UI.Reactions {
			_, _ = h.Write([]byte(r))
			_, _ = h.Write([]byte{0})
		}
		v = v<<32 | int64(h.Sum32())
	}
	return v
}

// markedTables are the tables whose models a re-bootstrap marker of table
// names: the table and the tables whose rows its rows place (spec.dependents,
// transitively; backend audit). A lost change of a release (published, or
// set back to draft) moves its attachments too, one of a comment its
// attachments, reactions and revisions.
func markedTables(table string) []string {
	res := []string{table}
	for i := 0; i < len(res); i++ {
		for _, dep := range specs[res[i]].dependents {
			if !slices.Contains(res, dep.table) {
				res = append(res, dep.table)
			}
		}
	}
	return res
}

// MetaPermPrefix + table name is the livesync_meta entry holding the
// version of the permission states (permVersion) the index rows of a
// permission table were written with.
const MetaPermPrefix = "materialized_perm."

// permVersion is the version of the permission states (spec.perm) stored
// in the entity index. Version 1 (B4) introduced them: index rows written
// before have none. When a permission table's recorded version differs,
// HandleEpochs starts a permission walk of it (see the entity index
// backfill), which stores the states without touching groups (no markers
// needed). Bump it when the states of existing rows must be recomputed.
const permVersion = 1

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
// RebootstrapPlacementChanged, repair backfill); one whose content version
// (contentVersions) differs gets the markers only. The materializer also
// bumps a table's schema epoch itself when it had to skip a change it could
// not write (Materializer.isolate): a lost change like any other. When a table with
// permission states (spec.perm) gets markers for a repaired trigger, the
// permission changes it lost are unknown, so a permission epoch for
// everything (PermissionChange.All) goes first. A permission table whose
// permission state version (permVersion) differs from the one recorded
// gets a permission walk (no markers, no epoch), unless a repair walk,
// which records the states too, is running or starting.
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
	permDone, err := readMetaInts(ctx, MetaPermPrefix)
	if err != nil {
		return err
	}
	contents, err := readMetaInts(ctx, MetaContentPrefix)
	if err != nil {
		return err
	}
	var entries []synclog.Entry
	var record, reset, permWalk, repairWalk, recontented []string
	permLost := false
	markers := func(t catalog.Table, marker protocol.RebootstrapMarker) error {
		payload, err := json.Marshal(marker)
		if err != nil {
			return err
		}
		for _, tbl := range markedTables(t.Name) {
			s := specs[tbl]
			for i, model := range s.models {
				entries = append(entries, synclog.Entry{
					Group: protocol.GroupAll, Model: model, Op: protocol.OpRebootstrap,
					Payload: string(payload), SchemaVer: s.schemas[i],
				})
			}
		}
		return nil
	}
	for _, t := range catalog.Tracked() {
		epoch := current[t.Name]
		done, ok := handled[t.Name]
		repaired := ok && done != epoch
		moved := ok && placed[t.Name] != placementVersion(t.Name)
		permStale := ok && specs[t.Name].perm && permDone[t.Name] != permVersion
		recontent := ok && contents[t.Name] != contentVersions[t.Name]
		if ok && !repaired && !moved && !permStale && !recontent {
			continue
		}
		record = append(record, t.Name)
		if !ok {
			continue
		}
		if !repaired && !moved {
			if recontent {
				if err := markers(t, protocol.RebootstrapMarker{Table: t.Name, Epoch: epoch, Reason: protocol.RebootstrapPlacementChanged}); err != nil {
					return err
				}
				recontented = append(recontented, t.Name)
			}
			if !permStale {
				continue
			}
			switch mode := m.walk[t.Name]; {
			case m.backfillComplete(t.Name) || mode == indexPerm:
				permWalk = append(permWalk, t.Name)
			case mode == indexRepair:
				// The repair walk records the states too.
			default:
				// The initial walk has not passed every row yet. A
				// permission walk from the start would take its place
				// and leave the rows it has not reached unindexed, while
				// bootstraps take a table in a permission walk for
				// indexed (BackfillPending). A repair walk indexes every
				// row and records the states; no markers: no client can
				// hold the table's entities before its first walk is
				// done.
				repairWalk = append(repairWalk, t.Name)
			}
			continue
		}
		reset = append(reset, t.Name)
		marker := protocol.RebootstrapMarker{Table: t.Name, Epoch: epoch, Reason: protocol.RebootstrapPlacementChanged}
		if repaired {
			marker.Reason = protocol.RebootstrapTriggerRepaired
			permLost = permLost || specs[t.Name].perm
		}
		if err := markers(t, marker); err != nil {
			return err
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
			if err := livesync_model.SetMeta(ctx, MetaPlacementPrefix+table, strconv.FormatInt(placementVersion(table), 10)); err != nil {
				return err
			}
			if err := livesync_model.SetMeta(ctx, MetaContentPrefix+table, strconv.FormatInt(contentVersions[table], 10)); err != nil {
				return err
			}
			if specs[table].perm {
				if err := livesync_model.SetMeta(ctx, MetaPermPrefix+table, strconv.Itoa(permVersion)); err != nil {
					return err
				}
			}
		}
		for _, table := range slices.Concat(reset, repairWalk) {
			if err := livesync_model.SetMeta(ctx, MetaBackfillPrefix+table, backfillValue(0, indexRepair)); err != nil {
				return err
			}
		}
		for _, table := range permWalk {
			if err := livesync_model.SetMeta(ctx, MetaBackfillPrefix+table, backfillValue(0, indexPerm)); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return err
	}
	for _, table := range slices.Concat(reset, repairWalk) {
		m.backfill[table] = 0
		m.walk[table] = indexRepair
	}
	for _, table := range permWalk {
		m.backfill[table] = 0
		m.walk[table] = indexPerm
	}
	if len(permWalk) > 0 {
		log.Info("livesync: recording the permission states of %s", strings.Join(permWalk, ", "))
	}
	if len(reset) > 0 {
		log.Info("livesync: the capture triggers or placement rules of %s changed; appended re-bootstrap markers for their models", strings.Join(reset, ", "))
	}
	if len(recontented) > 0 {
		log.Info("livesync: what the entities of %s carry changed; appended re-bootstrap markers for their models", strings.Join(recontented, ", "))
	}
	return nil
}
