// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package capture

import (
	"math/rand/v2"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHoles(t *testing.T) {
	t0 := time.Unix(1000, 0)
	var h holes
	assert.True(t, h.empty())
	_, ok := h.min()
	assert.False(t, ok)

	h.add(5, 4, t0) // empty range: ignored
	assert.True(t, h.empty())

	h.add(3, 3, t0)
	h.add(5, 9, t0.Add(time.Second))
	h.add(12, 12, t0.Add(2*time.Second))
	assert.Equal(t, [][2]int64{{3, 3}, {5, 9}, {12, 12}}, h.ranges())
	assert.EqualValues(t, 7, h.count())
	lo, _ := h.min()
	assert.EqualValues(t, 3, lo)

	for id, want := range map[int64]bool{2: false, 3: true, 4: false, 5: true, 7: true, 9: true, 10: false, 12: true, 13: false} {
		assert.Equal(t, want, h.contains(id), "id %d", id)
	}

	c := h.clone()
	h.remove(7) // split
	assert.Equal(t, [][2]int64{{3, 3}, {5, 6}, {8, 9}, {12, 12}}, h.ranges())
	assert.Equal(t, [][2]int64{{3, 3}, {5, 9}, {12, 12}}, c.ranges(), "clone is independent")
	h.remove(5) // low end
	h.remove(9) // high end
	h.remove(3) // whole range
	h.remove(100)
	assert.Equal(t, [][2]int64{{6, 6}, {8, 8}, {12, 12}}, h.ranges())
	lo, _ = h.min()
	assert.EqualValues(t, 6, lo)

	// The pieces of a split range keep its age.
	assert.EqualValues(t, 2, h.expire(t0.Add(1500*time.Millisecond)))
	assert.Equal(t, [][2]int64{{12, 12}}, h.ranges())
	assert.EqualValues(t, 0, h.expire(t0))
	assert.EqualValues(t, 1, h.expire(t0.Add(time.Hour)))
	assert.True(t, h.empty())
}

func TestHolesCap(t *testing.T) {
	t0 := time.Unix(1000, 0)
	var h holes
	for i := range int64(maxHoleRanges + 5) {
		h.add(2*i, 2*i, t0.Add(time.Duration(i)))
	}
	require.Len(t, h.ranges(), maxHoleRanges)
	lo, _ := h.min()
	assert.EqualValues(t, 10, lo, "the oldest ranges are given up first")
}

// Random add/remove sequences agree with a plain set.
func TestHolesMatchesSet(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	for range 200 {
		var h holes
		set := map[int64]bool{}
		next := int64(1)
		for range 50 {
			if rng.IntN(2) == 0 {
				n := int64(rng.IntN(6))
				h.add(next, next+n-1, time.Unix(0, 0))
				for id := next; id < next+n; id++ {
					set[id] = true
				}
				next += n + int64(rng.IntN(3))
			} else if next > 1 {
				id := 1 + rng.Int64N(next)
				h.remove(id)
				delete(set, id)
			}
		}
		var count int64
		for id := int64(0); id <= next+1; id++ {
			require.Equal(t, set[id], h.contains(id), "id %d", id)
			if set[id] {
				count++
			}
		}
		require.Equal(t, count, h.count())
		prev := int64(-1)
		for _, r := range h.ranges() {
			require.LessOrEqual(t, r[0], r[1])
			require.Greater(t, r[0], prev, "sorted and disjoint")
			prev = r[1]
		}
	}
}
