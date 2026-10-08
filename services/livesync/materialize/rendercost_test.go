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
	var readme strings.Builder // an ordinary long document
	for i := range 100 {
		fmt.Fprintf(&readme, "## Section %d\n\nSome *text* with a [link](https://example.com/%d) and `code`.\n\n- one\n- two\n  - nested\n\n```go\nfunc f%d() {}\n```\n\n| a | b |\n|---|:-:|\n| 1 | 2 |\n\n", i, i, i)
	}
	var changelog strings.Builder // an alphanumeric tracker's ordinary references
	for i := range 300 {
		fmt.Fprintf(&changelog, "* Fixes ABC-%d: something was wrong (see ABC-%d)\n", i+1, i+2)
	}
	numeric := map[string]string{"user": "user2", "repo": "repo1", "mode": "comment"}
	alphanumeric := map[string]string{"format": "https://tracker/{index}", "style": markup.IssueNameStyleAlphanumeric}
	regexpStyle := map[string]string{"format": "https://tracker/{index}", "style": markup.IssueNameStyleRegexp, "regexp": `T(\d+)`}
	for _, c := range []struct {
		name    string
		content string
		metas   map[string]string
		over    bool
	}{
		{"ordinary", "Fixes #1, see 65f1bf27 and user2/repo1#2. Thanks @user2!\n\n```go\nfunc main() {}\n```", nil, false},
		{"64 KiB of text", strings.Repeat("word ", 13000), nil, false},
		{"64 KiB of text on lines", strings.Repeat("some words on a line\n", 3000), nil, false},
		{"long document", readme.String(), numeric, false},
		{"100 mentions", strings.Repeat("@user2 ", 100), nil, false},
		// The audit's case: 9 000 mentions took 1.45 s.
		{"9000 mentions", strings.Repeat("@user2 ", 9000), nil, true},
		{"9000 mentions of nobody", strings.Repeat("@nobody ", 9000), nil, true},
		{"10 permalinks", strings.Repeat(permalink, 10), nil, false},
		{"20 permalinks", strings.Repeat(permalink, 20), nil, true},
		{"1000 cross references", strings.Repeat("user2/repo1#1 ", 1000), nil, true},
		{"5000 SHA-like words", shas.String(), nil, true},

		// Round 3: constructs whose rendering grows faster than the body
		// (the times measured on SQLite).
		{"13000 identical headings (17 s)", strings.Repeat("# a\n", 13000), nil, true},
		{"16000 empty headings (43 s)", strings.Repeat("#\n", 16000), nil, true},
		{"8000 setext headings (6 s)", strings.Repeat("a\n=\n", 8000), nil, true},
		{"5000 headings in list items (2 s)", strings.Repeat("- # a\n", 5000), nil, true},
		{"6000 setext headings with single dashes", strings.Repeat("a\n-\n", 6000), nil, true},
		{"1000 headings", strings.Repeat("# a\n", 1000), nil, false},
		{"8000 footnotes", strings.Repeat("[^a]: x\n", 8000), nil, true},
		{"32000 nested list markers (2 s)", strings.Repeat("- ", 32000) + "x", nil, true},
		{"32000 nested list markers with tabs (2.6 s)", strings.Repeat("-\t", 32000) + "x", nil, true},
		{"32000 nested quote markers (0.7 s)", strings.Repeat("> ", 32000) + "x", nil, true},
		{"21000 nested ordered list markers (0.5 s)", strings.Repeat("1. ", 21000) + "x", nil, true},
		{"padded table cells (31 s)", strings.Repeat("|a", 1000) + "\n" + strings.Repeat("|-", 1000) + "\n" + strings.Repeat("|\n", 30000), nil, true},
		{"10000 fenced code blocks (0.5 s)", strings.Repeat("```go\n{\n```\n", 5000), nil, true},
		{"unpaired emphasis (3.4 s)", "a**b" + strings.Repeat("c* ", 21000), nil, true},
		{"mismatched emphasis (2.4 s)", strings.Repeat("*a_ ", 16000), nil, true},
		{"unclosed links (1 s)", strings.Repeat("[a](b", 13000), nil, true},
		{"10900 alphanumeric references (43 s)", strings.Repeat("ABC-1 ", 10900), alphanumeric, true},
		{"5000 alphanumeric references with keywords (22 s)", strings.Repeat("closes ABC-1 ", 5000), alphanumeric, true},
		{"3000 alphanumeric references (3.3 s)", strings.Repeat("ABC-1 ", 3000), alphanumeric, true},
		{"alphanumeric references, one per line (0.16 s)", strings.Repeat("ABC-1\n", 10900), alphanumeric, false},
		{"alphanumeric changelog", changelog.String(), alphanumeric, false},
		{"alphanumeric references in a numeric repository", strings.Repeat("ABC-1 ", 10900), numeric, false},
		{"21000 numeric references in an alphanumeric repository (27 ms)", strings.Repeat("#1 ", 21000), alphanumeric, false},
		{"pull request references before an alphanumeric one (103 s)", strings.Repeat("!1 ", 20000) + "ABC-1", alphanumeric, true},
		{"5000 regexp references", strings.Repeat("T1 ", 5000), regexpStyle, true},
		{"regexp references, one per line", strings.Repeat("T1 and T2\n", 3000), regexpStyle, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			cost := renderCost(c.content, c.metas)
			assert.Equal(t, c.over, cost > maxRenderCost, "estimated %s", cost)
		})
	}
	assert.Less(t, renderCost("Fixes #1, thanks @user2", nil), time.Millisecond)

	// Without hard line breaks, a paragraph's lines are one text node.
	defer test.MockVariableValue(&setting.Markdown.EnableHardLineBreakInComments, false)()
	assert.Greater(t, renderCost(strings.Repeat("ABC-1\n", 10900), alphanumeric), maxRenderCost)
	assert.LessOrEqual(t, renderCost(strings.Repeat("ABC-1\n\n", 5400), alphanumeric), maxRenderCost)
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
	require.Greater(t, renderCost(mentions, nil), maxRenderCost)
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

// Backend audit, round 3: renderCost cannot know every slow input, and
// CPU work cannot be interrupted, so the writer waits for a rendering for
// at most renderWait; a slower one is abandoned to its goroutine, whose
// number is bounded.
func TestConsumeRenderAbandoned(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	var cursor int64
	// A body the estimate does not catch (any repository): 5 000 empty
	// headings take seconds.
	defer test.MockVariableValue(&maxRenderCost, time.Hour)()
	defer test.MockVariableValue(&renderWait, 100*time.Millisecond)()
	slow := strings.Repeat("#\n", 5000)
	exec(t, "UPDATE issue SET content = ? WHERE id = 1", slow)
	exec(t, "UPDATE issue SET content = 'cheap *x*' WHERE id = 4")
	start := time.Now()
	consume(t, m, change(1, "issue", 1, "U"), change(2, "issue", 4, "U"))
	took := time.Since(start)
	require.Equal(t, int64(1), abandonedRenders.Load(), "the slow rendering still runs")
	assert.Less(t, took, time.Second, "the writer did not wait for it")
	_, entries := takeLog(t, &cursor)
	bodies := issueBodies(t, entries)
	require.Contains(t, bodies, int64(1))
	require.Contains(t, bodies, int64(4))
	assert.Empty(t, bodies[1].BodyHTML)
	assert.True(t, bodies[1].BodyTruncated)
	assert.Equal(t, slow, bodies[1].Body)
	assert.Contains(t, bodies[4].BodyHTML, "<em>x</em>")

	// While maxAbandonedRenders abandoned renderings run, nothing is
	// rendered.
	restore := test.MockVariableValue(&maxAbandonedRenders, 1)
	exec(t, "UPDATE issue SET content = 'cheap again *y*' WHERE id = 4")
	before := renderCount.Load()
	consume(t, m, change(3, "issue", 4, "U"))
	assert.Equal(t, before, renderCount.Load())
	_, entries = takeLog(t, &cursor)
	bodies = issueBodies(t, entries)
	require.Contains(t, bodies, int64(4))
	assert.Empty(t, bodies[4].BodyHTML)
	assert.True(t, bodies[4].BodyTruncated)
	restore()

	// The abandoned rendering runs to its end; the time it took beyond
	// the wait is charged to its repository's share.
	require.Eventually(t, func() bool { return abandonedRenders.Load() == 0 }, 2*time.Minute, 10*time.Millisecond)
	m.share.mu.Lock()
	level := m.share.repos[1].level
	m.share.mu.Unlock()
	assert.Less(t, level, shareRepoBurst-500*time.Millisecond)

	exec(t, "UPDATE issue SET content = 'cheap at last *z*' WHERE id = 4")
	consume(t, m, change(4, "issue", 4, "U"))
	_, entries = takeLog(t, &cursor)
	bodies = issueBodies(t, entries)
	require.Contains(t, bodies, int64(4))
	assert.Contains(t, bodies[4].BodyHTML, "<em>z</em>")
}

// An abandoned rendering keeps the loader's git repository and SHA cache
// of its repository; the loader opens another one.
func TestRenderBounded(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	defer test.MockVariableValue(&renderWait, 50*time.Millisecond)()
	repo := unittest.AssertExistsAndLoadBean(t, &repo_model.Repository{ID: 1})
	l := newLoader()
	defer l.close()
	const commit = "65f1bf27bc3bf70f64657658635e66094edbcb4d"

	html, complete, waited := l.renderBounded(t.Context(), repo, "see "+commit)
	require.True(t, complete)
	assert.Contains(t, html, "/user2/repo1/commit/"+commit)
	assert.Less(t, waited, renderWait)
	first := l.gitRepos[repo.ID]
	require.NotNil(t, first)

	html, complete, waited = l.renderBounded(t.Context(), repo, strings.Repeat("#\n", 5000)+commit)
	assert.False(t, complete)
	assert.Empty(t, html)
	assert.Less(t, waited, time.Second)
	assert.Equal(t, int64(1), abandonedRenders.Load())
	assert.NotContains(t, l.gitRepos, repo.ID, "the abandoned rendering has it")
	assert.NotContains(t, l.commits, repo.ID)

	html, complete, _ = l.renderBounded(t.Context(), repo, "again "+commit)
	require.True(t, complete)
	assert.Contains(t, html, "/user2/repo1/commit/"+commit)
	assert.NotSame(t, first, l.gitRepos[repo.ID])

	require.Eventually(t, func() bool { return abandonedRenders.Load() == 0 }, 2*time.Minute, 10*time.Millisecond)
}

// Rendering does not write the repository's cached metas (which renderEnv
// encodes): issueIndexPatternProcessor sets Metas["index"] for each
// external tracker reference.
func TestRenderKeepsMetas(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	repo := unittest.AssertExistsAndLoadBean(t, &repo_model.Repository{ID: 48}) // alphanumeric external tracker
	l := newLoader()
	defer l.close()
	env := l.renderEnv(t.Context(), repo)
	html, complete := l.renderMarkdown(t.Context(), repo, "Fixes ABC-123")
	require.True(t, complete)
	assert.Contains(t, html, "https://tracker.com/org26/repo_external_tracker_alpha/issues/ABC-123")
	assert.NotContains(t, repo.ComposeMetas(t.Context()), "index")
	assert.Equal(t, env, newLoader().renderEnv(t.Context(), repo))
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
