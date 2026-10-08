// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"fmt"
	"strings"
	"testing"
	"time"

	livesync_model "forgejo.org/models/livesync"
	repo_model "forgejo.org/models/repo"
	"forgejo.org/models/unittest"
	"forgejo.org/modules/gitrepo"
	"forgejo.org/modules/json"
	"forgejo.org/modules/markup"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/test"
	"forgejo.org/services/livesync/protocol"
	markup_service "forgejo.org/services/markup"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Backend audit, round 2: bodies that are cheap to post but expensive to
// render must not let one poster take the writer's time from everyone.

func TestRenderCost(t *testing.T) {
	permalink := setting.AppURL + "user2/repo1/src/commit/65f1bf27bc3bf70f64657658635e66094edbcb4d/README.md#L1-L2\n\n"
	var shas strings.Builder
	for i := range 5000 {
		fmt.Fprintf(&shas, "%07x ", 0xabc0000+i)
	}
	for _, c := range []struct {
		name    string
		content string
		over    bool
	}{
		{"ordinary", "Fixes #1, see 65f1bf27 and user2/repo1#2. Thanks @user2!\n\n```go\nfunc main() {}\n```", false},
		{"64 KiB of text", strings.Repeat("word ", 13000), false},
		{"100 mentions", strings.Repeat("@user2 ", 100), false},
		// The audit's case: 9 000 mentions took 1.45 s.
		{"9000 mentions", strings.Repeat("@user2 ", 9000), true},
		{"9000 mentions of nobody", strings.Repeat("@nobody ", 9000), true},
		{"10 permalinks", strings.Repeat(permalink, 10), false},
		{"20 permalinks", strings.Repeat(permalink, 20), true},
		{"1000 cross references", strings.Repeat("user2/repo1#1 ", 1000), true},
		{"5000 SHA-like words", shas.String(), true},
	} {
		t.Run(c.name, func(t *testing.T) {
			cost := renderCost(c.content)
			assert.Equal(t, c.over, cost > maxRenderCost, "estimated %s", cost)
		})
	}
	assert.Less(t, renderCost("Fixes #1, thanks @user2"), time.Millisecond)
}

// A body estimated to be too expensive is sent without HTML and is not
// rendered by the writer; GET /-/sync/api/bodies renders it on request.
// The other bodies of the batch are rendered.
func TestConsumeRenderCost(t *testing.T) {
	// The markup service as Forgejo installs it: every @mention is a
	// database lookup.
	defer test.MockVariableValue(&markup.DefaultProcessorHelper, *markup_service.ProcessorHelper())()
	resetLivesync(t)
	m, _ := testMaterializer(t)
	var cursor int64
	mentions := strings.Repeat("@user2 ", 2000)
	require.Greater(t, renderCost(mentions), maxRenderCost)
	exec(t, "UPDATE issue SET content = ? WHERE id = 1", mentions)
	exec(t, "UPDATE issue SET content = 'cheap @user2' WHERE id = 4")
	before := renderCount.Load()
	consume(t, m, change(1, "issue", 1, "U"), change(2, "issue", 4, "U"))
	assert.Equal(t, int64(1), renderCount.Load()-before, "only the cheap body is rendered")
	_, entries := takeLog(t, &cursor)
	bodies := issueBodies(t, entries)
	require.Contains(t, bodies, int64(1))
	require.Contains(t, bodies, int64(4))
	assert.Equal(t, mentions, bodies[1].Body)
	assert.Empty(t, bodies[1].BodyHTML)
	assert.True(t, bodies[1].BodyTruncated)
	assert.Contains(t, bodies[4].BodyHTML, `class="mention"`)
	assert.False(t, bodies[4].BodyTruncated)

	full, ok, err := LoadBody(t.Context(), protocol.ModelIssueBody, 1)
	require.NoError(t, err)
	require.True(t, ok)
	html, complete := full.Render(t.Context())
	assert.True(t, complete)
	assert.Equal(t, 2000, strings.Count(html, `class="mention"`))
}

// Once the writer's render share of a repository is used up, its bodies
// are sent without HTML (other repositories' are rendered); the share is
// replenished with time.
func TestConsumeRenderShare(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	var cursor int64
	now := time.Now()
	m.share.now = func() time.Time { return now }
	m.share.charge(1, shareRepoBurst+time.Second) // repository 1
	exec(t, "UPDATE issue SET content = 'one *1*' WHERE id = 1")
	exec(t, "UPDATE issue SET content = 'four *4*' WHERE id = 4")
	consume(t, m, change(1, "issue", 1, "U"), change(2, "issue", 4, "U"))
	_, entries := takeLog(t, &cursor)
	bodies := issueBodies(t, entries)
	require.Contains(t, bodies, int64(1))
	require.Contains(t, bodies, int64(4))
	assert.Empty(t, bodies[1].BodyHTML)
	assert.True(t, bodies[1].BodyTruncated)
	assert.Contains(t, bodies[4].BodyHTML, "<em>4</em>")

	now = now.Add(time.Duration(float64(2*time.Second) / shareRepo)) // 2 s of rendering
	exec(t, "UPDATE issue SET content = 'one again *1*' WHERE id = 1")
	consume(t, m, change(3, "issue", 1, "U"))
	_, entries = takeLog(t, &cursor)
	bodies = issueBodies(t, entries)
	require.Contains(t, bodies, int64(1))
	assert.Contains(t, bodies[1].BodyHTML, "<em>1</em>")
	assert.False(t, bodies[1].BodyTruncated)
}

func TestRenderShare(t *testing.T) {
	now := time.Unix(1000, 0)
	s := newRenderShare()
	s.now = func() time.Time { return now }
	s.all = renderBucket{level: shareAllBurst, at: now}

	assert.True(t, s.allow(1))
	s.charge(1, shareRepoBurst) // repository 1's burst is used up
	assert.False(t, s.allow(1))
	assert.True(t, s.allow(2))
	now = now.Add(time.Second)
	assert.True(t, s.allow(1), "replenished by %s", time.Duration(float64(time.Second)*shareRepo))
	s.charge(1, time.Second)
	assert.False(t, s.allow(1))

	// The overall share: repository 2 takes what is left and 1 s more.
	s.charge(2, s.all.level+time.Second)
	assert.False(t, s.allow(3), "the overall share is used up")
	assert.False(t, s.allow(1))
	now = now.Add(8 * time.Second) // 2 s overall
	assert.True(t, s.allow(3))

	// The per-repository buckets are bounded: full ones are dropped.
	now = now.Add(time.Hour)
	for id := int64(10); len(s.repos) < maxShareRepos; id++ {
		s.allow(id)
	}
	s.allow(-1)
	assert.Len(t, s.repos, 1)
}

// prefillCommits answers the SHA lookups of a rendering, as
// hashCurrentPatternProcessor would, with one git process.
func TestPrefillCommits(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	repo := unittest.AssertExistsAndLoadBean(t, &repo_model.Repository{ID: 1})
	gitRepo, err := gitrepo.OpenRepository(t.Context(), repo)
	require.NoError(t, err)
	defer gitRepo.Close()

	const commit = "65f1bf27bc3bf70f64657658635e66094edbcb4d"
	known := map[string]bool{"1234567": true} // kept as it is
	prefillCommits(t.Context(), gitRepo, "see "+commit+", 65f1bf2 and abcdef1 (deadbeefcafe) or 1234567; xyz", known)
	assert.Equal(t, map[string]bool{
		commit:         true,
		"65f1bf2":      true,
		"abcdef1":      false,
		"deadbeefcafe": false,
		"1234567":      true,
	}, known)
	assert.True(t, gitRepo.IsReferenceExist(commit), "the batch-check process still works")

	l := newLoader()
	defer l.close()
	html, complete := l.renderMarkdown(t.Context(), repo, "see "+commit+" and abcdef1")
	require.True(t, complete)
	assert.Contains(t, html, "/user2/repo1/commit/"+commit)
	assert.NotContains(t, html, "/commit/abcdef1")
	assert.Equal(t, map[string]bool{commit: true, "abcdef1": false}, l.commits[repo.ID])
}

func issueBodies(t *testing.T, entries []livesync_model.LogEntry) map[int64]protocol.IssueBody {
	t.Helper()
	res := map[int64]protocol.IssueBody{}
	for _, e := range entries {
		if e.Model == string(protocol.ModelIssueBody) {
			var body protocol.IssueBody
			require.NoError(t, json.Unmarshal([]byte(e.Payload), &body))
			res[body.ID] = body
		}
	}
	return res
}
