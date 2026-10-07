// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package catalog

import (
	"regexp"
	"sort"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The catalog itself is consistent: unique names and models, no table both
// tracked and ignored, names that are plain SQL identifiers short enough for
// the MySQL trigger names derived from them (capture: "livesync_<tbl>_ai").
func TestCatalogConsistent(t *testing.T) {
	ident := regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	model := regexp.MustCompile(`^[A-Z][A-Za-z0-9]*$`)
	names := map[string]bool{}
	models := map[string]bool{}
	for _, tbl := range tracked {
		assert.Regexp(t, ident, tbl.Name)
		assert.Regexp(t, model, tbl.Model)
		assert.LessOrEqual(t, len("livesync_")+len(tbl.Name)+len("_ai"), 64, tbl.Name)
		assert.False(t, names[tbl.Name], "duplicate tracked table %s", tbl.Name)
		assert.False(t, models[tbl.Model], "duplicate model %s", tbl.Model)
		assert.False(t, ignoredSet[tbl.Name], "%s is both tracked and ignored", tbl.Name)
		names[tbl.Name] = true
		models[tbl.Model] = true
	}
	seen := map[string]bool{}
	for _, name := range ignored {
		assert.Regexp(t, ident, name)
		assert.False(t, seen[name], "duplicate ignored table %s", name)
		assert.NotRegexp(t, `^livesync_`, name, "livesync's own tables are not registered upstream tables")
		seen[name] = true
	}

	// The tables PLAN §4.3 names, with their tiers and hot flags.
	assert.Len(t, tracked, 39)
	hot := []string{}
	lazy := []string{}
	for _, tbl := range tracked {
		if tbl.Hot {
			hot = append(hot, tbl.Name)
		}
		if tbl.Tier != TierSummary {
			lazy = append(lazy, tbl.Name)
		}
	}
	sort.Strings(hot)
	sort.Strings(lazy)
	assert.Equal(t, []string{"action_run_job", "commit_status", "notification"}, hot)
	assert.Equal(t, []string{"attachment", "comment", "issue_content_history", "issue_dependency", "reaction", "review", "review_state", "tracked_time"}, lazy)
}

func TestTrackedSortedCopy(t *testing.T) {
	ts := Tracked()
	require.Len(t, ts, len(tracked))
	assert.True(t, sort.SliceIsSorted(ts, func(i, j int) bool { return ts[i].Name < ts[j].Name }))
	ts[0].Name = "changed"
	assert.NotEqual(t, "changed", Tracked()[0].Name, "Tracked must return a copy")
}

func TestClassify(t *testing.T) {
	all := append([]string{}, ignored...)
	for _, tbl := range tracked {
		all = append(all, tbl.Name)
	}
	unclassified, vanished := Classify(all)
	assert.Empty(t, unclassified)
	assert.Empty(t, vanished)

	registered := append([]string{"zz_new_upstream_table", "aa_other"}, all[2:]...)
	registered = registered[:len(registered)-1] // drop the last tracked table
	unclassified, vanished = Classify(registered)
	assert.Equal(t, []string{"aa_other", "zz_new_upstream_table"}, unclassified)
	want := []string{all[0], all[1], all[len(all)-1]}
	sort.Strings(want)
	assert.Equal(t, want, vanished)
}
