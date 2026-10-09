// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package capture

import (
	"slices"
	"sort"
	"time"
)

// holes tracks outbox ids below the reader's high-water mark that have not
// been seen yet (PLAN §4.3 "commit-order gaps"). Auto-increment ids are
// assigned at insert time, not at commit time, so a transaction that commits
// after a later one leaves a temporary hole; a rolled-back one leaves a hole
// that never fills. Holes are kept as sorted, disjoint, inclusive ranges so
// that a long transaction holding thousands of ids costs one entry.
//
// Ranges are only ever added above everything already tracked (the reader
// adds them as its high-water mark advances), so they are also ordered by the
// time they were opened: the first range is the oldest.
type holes struct {
	r []holeRange
}

type holeRange struct {
	lo, hi int64
	since  time.Time // when the hole was first seen
}

// maxHoleRanges bounds memory. When exceeded, the oldest ranges are given up
// early; rows that commit later are still found by the reader's sweep.
const maxHoleRanges = 10000

// min returns the lowest id that is still a hole.
func (h *holes) min() (int64, bool) {
	if len(h.r) == 0 {
		return 0, false
	}
	return h.r[0].lo, true
}

// count returns the number of ids in all holes.
func (h *holes) count() int64 {
	var n int64
	for _, r := range h.r {
		n += r.hi - r.lo + 1
	}
	return n
}

func (h *holes) clone() holes {
	return holes{r: slices.Clone(h.r)}
}

// add records the ids lo..hi (inclusive) as a hole first seen at now.
func (h *holes) add(lo, hi int64, now time.Time) {
	if lo > hi {
		return
	}
	i := sort.Search(len(h.r), func(i int) bool { return h.r[i].lo > lo })
	h.r = slices.Insert(h.r, i, holeRange{lo: lo, hi: hi, since: now})
	if len(h.r) > maxHoleRanges {
		h.r = slices.Delete(h.r, 0, len(h.r)-maxHoleRanges)
	}
}

// index returns the index of the range containing id, or -1.
func (h *holes) index(id int64) int {
	i := sort.Search(len(h.r), func(i int) bool { return h.r[i].hi >= id })
	if i < len(h.r) && h.r[i].lo <= id {
		return i
	}
	return -1
}

// remove marks id as seen, splitting its range if needed.
func (h *holes) remove(id int64) {
	i := h.index(id)
	if i < 0 {
		return
	}
	r := h.r[i]
	switch {
	case r.lo == r.hi:
		h.r = slices.Delete(h.r, i, i+1)
	case id == r.lo:
		h.r[i].lo++
	case id == r.hi:
		h.r[i].hi--
	default:
		h.r[i].hi = id - 1
		h.r = slices.Insert(h.r, i+1, holeRange{lo: id + 1, hi: r.hi, since: r.since})
	}
}

// expire gives up the holes first seen before deadline and returns how many
// ids it gave up.
func (h *holes) expire(deadline time.Time) int64 {
	var n int64
	keep := h.r[:0]
	for _, r := range h.r {
		if r.since.Before(deadline) {
			n += r.hi - r.lo + 1
			continue
		}
		keep = append(keep, r)
	}
	h.r = keep
	return n
}
