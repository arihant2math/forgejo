// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package perm

import (
	"container/list"

	"forgejo.org/services/livesync/protocol"
)

// maxTouchedRows bounds the rows a cache's touch journal remembers; when
// more rows are touched while computations run, those computations are
// not cached (see Cache.Invalidate).
const maxTouchedRows = 1 << 16

// touchJournal remembers the touches (PermissionChange.Touched) that
// running grant computations may still have to be compared with, once per
// cache rather than once per computation: recording a touch costs O(1)
// whatever the number of running computations, and the memory is one
// record per distinct row touched since the oldest running computation
// started.
//
// Every invalidation that carries touches gets the next sequence number
// (seq); a computation remembers the seq at its start ("since") and, when
// it finishes, asks stale(basis, since): was a row it read touched after
// it started in a state other than the one it read? For that, a row's
// record keeps the seq and state of its last touch and the seq of its
// last touch in another state than that one: the touches after since all
// had the state of the last one exactly when that seq is <= since.
type touchJournal struct {
	seq   uint64
	rows  map[basisKey]*list.Element // of *touchRecord
	order *list.List                 // of *touchRecord, by last ascending
}

type touchRecord struct {
	key   basisKey
	last  uint64 // seq of the row's last touch
	state string // the state of that touch
	other uint64 // seq of the row's last touch in another state (0: none)
}

func newTouchJournal() touchJournal {
	return touchJournal{rows: map[basisKey]*list.Element{}, order: list.New()}
}

// next returns the seq of a new invalidation carrying touches.
func (j *touchJournal) next() uint64 {
	j.seq++
	return j.seq
}

// record remembers touched as the touches of invalidation seq (the
// latest one).
func (j *touchJournal) record(seq uint64, touched []protocol.PermissionTouch) {
	for _, t := range touched {
		k := basisKey{t.Kind, t.ID}
		el := j.rows[k]
		if el == nil {
			j.rows[k] = j.order.PushBack(&touchRecord{key: k, last: seq, state: t.State})
			continue
		}
		r := el.Value.(*touchRecord)
		if r.state != t.State {
			r.other, r.state = r.last, t.State
		}
		r.last = seq
		j.order.MoveToBack(el)
	}
}

// trim forgets the rows not touched after floor (no running computation
// started before floor needs them).
func (j *touchJournal) trim(floor uint64) {
	for el := j.order.Front(); el != nil && el.Value.(*touchRecord).last <= floor; el = j.order.Front() {
		delete(j.rows, el.Value.(*touchRecord).key)
		j.order.Remove(el)
	}
}

// clear forgets every row (and the memory of a spike of touches).
func (j *touchJournal) clear() {
	if len(j.rows) > 0 {
		j.rows = map[basisKey]*list.Element{}
		j.order.Init()
	}
}

// stale reports whether a row b recorded was touched after since in
// another state than b's (any touch of a row b recorded as basisConflict).
// The rows touched after since must still be in the journal.
func (j *touchJournal) stale(b Basis, since uint64) bool {
	if j.seq <= since {
		return false
	}
	staleRow := func(r *touchRecord, s string) bool {
		return r.last > since && (r.state != s || r.other > since)
	}
	if len(j.rows) < len(b) {
		for k, el := range j.rows {
			if s, ok := b[k]; ok && staleRow(el.Value.(*touchRecord), s) {
				return true
			}
		}
		return false
	}
	for k, s := range b {
		if el := j.rows[k]; el != nil && staleRow(el.Value.(*touchRecord), s) {
			return true
		}
	}
	return false
}
