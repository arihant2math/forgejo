// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"time"

	livesync_model "forgejo.org/models/livesync"
)

// rowKey identifies a changed row.
type rowKey struct {
	tbl string
	id  int64
}

// rowChanges is the coalesced set of outbox changes of one row.
type rowChanges struct {
	key rowKey
	// changeIDs are the outbox ids of the row's changes, ascending.
	changeIDs []int64
	// inserted: one of the changes is an insert, i.e. the row did not
	// exist before this batch (permission epochs need to know that a row
	// that is gone now existed in between, see materializeRows).
	inserted bool
	// permUpdated: one of the changes is an update of a permission column
	// (livesync_model.OpPermUpdate), so the row's permission state changed
	// in between even if its current state equals the materialized one.
	permUpdated bool
}

// last is the newest outbox id of the row.
func (r rowChanges) last() int64 { return r.changeIDs[len(r.changeIDs)-1] }

// coalesce merges the changes of a batch by (table, row id), keeping the
// rows in the order of their first change. The kinds of change (insert,
// update, delete) do not matter: the materializer loads each row's current
// state once, and a row that no longer exists is a delete whatever the
// changes said (an insert followed by a delete in the same batch produces
// no entry, if no client ever saw the row). Only whether the row was
// inserted and whether a permission column was updated is kept
// (rowChanges.inserted, rowChanges.permUpdated).
func coalesce(changes []livesync_model.Change) []rowChanges {
	index := make(map[rowKey]int, len(changes))
	res := make([]rowChanges, 0, len(changes))
	for _, c := range changes {
		k := rowKey{tbl: c.Tbl, id: c.RowID}
		i, ok := index[k]
		if !ok {
			i = len(res)
			index[k] = i
			res = append(res, rowChanges{key: k})
		}
		res[i].changeIDs = append(res[i].changeIDs, c.ID)
		switch c.Op {
		case livesync_model.OpInsert:
			res[i].inserted = true
		case livesync_model.OpPermUpdate:
			res[i].permUpdated = true
		}
	}
	return res
}

// hotLimiter coalesces bursts of changes to rows of hot tables
// (notifications, commit statuses, job states) across batches: a row
// materialized less than window ago is deferred until window has passed
// since then, so a row that changes many times a second is emitted at most
// once per window, with its latest state, while the first change after a
// quiet period is emitted at once.
type hotLimiter struct {
	window time.Duration
	last   map[rowKey]time.Time // when each hot row was last materialized
}

func newHotLimiter(window time.Duration) hotLimiter {
	return hotLimiter{window: window, last: map[rowKey]time.Time{}}
}

// admit reports whether row k may be materialized at now; if not, it also
// returns when it may.
func (h *hotLimiter) admit(k rowKey, now time.Time) (bool, time.Time) {
	if h.window <= 0 {
		return true, now
	}
	if last, ok := h.last[k]; ok {
		if until := last.Add(h.window); now.Before(until) {
			return false, until
		}
	}
	return true, now
}

// done records that row k was materialized at now.
func (h *hotLimiter) done(k rowKey, now time.Time) {
	if h.window > 0 {
		h.last[k] = now
	}
}

// maxHotRows bounds the limiter's memory; entries older than the window
// are useless and pruned once there are more.
const maxHotRows = 10000

// prune forgets rows materialized more than window ago.
func (h *hotLimiter) prune(now time.Time) {
	if len(h.last) <= maxHotRows {
		return
	}
	for k, t := range h.last {
		if now.Sub(t) >= h.window {
			delete(h.last, k)
		}
	}
}
