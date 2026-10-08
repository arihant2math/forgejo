// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/json"
	"forgejo.org/modules/test"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/services/livesync/protocol"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Backend audit: one huge or expensive body must neither make sync log
// entries arbitrarily large nor stop the sync log.

func TestJSONLen(t *testing.T) {
	for _, s := range []string{
		"", "plain", "quote \" backslash \\ newline \n tab \t cr \r", "\x01\x02\x1f", "\b\f",
		"<a href=\"x\">&amp;</a>", "ünïcödé ✓ 😀", "  ", "bad \xff\xfe utf-8", "�",
	} {
		b, err := marshal(s)
		require.NoError(t, err)
		assert.GreaterOrEqual(t, jsonLen(s), len(b)-2, "%q: never less than the encoding", s)
		if !strings.ContainsAny(s, "\b\f\ufffd\u2028\u2029") {
			assert.Equal(t, len(b)-2, jsonLen(s), "%q", s)
		}
	}
}

func TestTruncateJSON(t *testing.T) {
	s, cut := truncateJSON("short", 64)
	assert.Equal(t, "short", s)
	assert.False(t, cut)

	for _, src := range []string{
		strings.Repeat("a", 100), strings.Repeat("\x01", 100), strings.Repeat("ü", 100), strings.Repeat("😀\"", 50),
		strings.Repeat("\xff", 100),
	} {
		got, cut := truncateJSON(src, 64)
		require.True(t, cut, "%q", src)
		assert.True(t, strings.HasPrefix(src, got))
		assert.LessOrEqual(t, jsonLen(got), 64)
		next, _ := utf8.DecodeRuneInString(src[len(got):])
		assert.Greater(t, jsonLen(got)+jsonRuneLen(next), 64, "the longest prefix")
		assert.True(t, utf8.ValidString(got) || !utf8.ValidString(src), "whole characters")
	}
}

func issueBodyOf(t *testing.T, entries []livesync_model.LogEntry) *protocol.IssueBody {
	t.Helper()
	for _, e := range entries {
		if e.Model == string(protocol.ModelIssueBody) {
			var body protocol.IssueBody
			require.NoError(t, json.Unmarshal([]byte(e.Payload), &body))
			return &body
		}
	}
	return nil
}

// A body longer than MaxBodyBytes is sent cut, without HTML; the full text
// is served by LoadBody (GET /-/sync/api/bodies). The cut body is still a
// change when only its tail changes.
func TestConsumeLongBody(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	var cursor int64
	// 70 000 control characters: 420 000 bytes of JSON.
	long := strings.Repeat("\x01", 70000)
	exec(t, "UPDATE issue SET content = ? WHERE id = 1", long+"a")
	before := renderCount.Load()
	consume(t, m, change(1, "issue", 1, "U"))
	_, entries := takeLog(t, &cursor)
	body := issueBodyOf(t, entries)
	require.NotNil(t, body)
	assert.True(t, body.BodyTruncated)
	assert.Empty(t, body.BodyHTML)
	assert.Len(t, body.Body, protocol.MaxBodyBytes/6)
	for _, e := range entries {
		assert.Less(t, len(e.Payload), protocol.MaxBodyBytes+1024)
	}
	assert.Equal(t, before, renderCount.Load(), "not rendered")

	full, found, err := LoadBody(t.Context(), protocol.ModelIssueBody, 1)
	require.NoError(t, err)
	require.True(t, found)
	assert.Equal(t, long+"a", full.Body)
	assert.Equal(t, "issue:1", full.Group)
	assert.Equal(t, protocol.UnitIssues, full.Unit)
	html, complete := full.Render(t.Context())
	assert.True(t, complete)
	assert.NotEmpty(t, html)

	exec(t, "UPDATE issue SET content = ? WHERE id = 1", long+"b")
	consume(t, m, change(2, "issue", 1, "U"))
	_, entries = takeLog(t, &cursor)
	assert.NotNil(t, issueBodyOf(t, entries), "a change of the cut tail is a change")

	_, found, err = LoadBody(t.Context(), protocol.ModelLabel, 1)
	require.NoError(t, err)
	assert.False(t, found, "no body")
}

// HTML too long for the payload, or not rendered in time: the body is
// complete, the HTML empty, BodyTruncated set.
func TestConsumeHTMLLimits(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	var cursor int64
	refs := strings.Repeat("#1 ", 20000) // 60 KB, every reference a link
	exec(t, "UPDATE issue SET content = ? WHERE id = 1", refs)
	consume(t, m, change(1, "issue", 1, "U"))
	_, entries := takeLog(t, &cursor)
	body := issueBodyOf(t, entries)
	require.NotNil(t, body)
	assert.Equal(t, refs, body.Body)
	assert.Empty(t, body.BodyHTML)
	assert.True(t, body.BodyTruncated)

	defer test.MockVariableValue(&renderTimeout, time.Nanosecond)()
	exec(t, "UPDATE issue SET content = 'quick *one*' WHERE id = 1")
	consume(t, m, change(2, "issue", 1, "U"))
	_, entries = takeLog(t, &cursor)
	body = issueBodyOf(t, entries)
	require.NotNil(t, body)
	assert.Equal(t, "quick *one*", body.Body)
	assert.Empty(t, body.BodyHTML, "timed out")
	assert.True(t, body.BodyTruncated)
}

// A batch whose markdown takes longer than the transaction's render budget
// is materialized row by row, each row with a budget of its own: nothing is
// cut.
func TestConsumeRenderBudget(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	defer test.MockVariableValue(&txRenderBudget, time.Nanosecond)()
	var cursor int64
	b := consume(t, m, change(1, "comment", 2, "U"), change(2, "comment", 3, "U"))
	assert.Equal(t, 2, b.Consumed())
	_, entries := takeLog(t, &cursor)
	var comments []protocol.Comment
	for _, e := range entries {
		if e.Model == string(protocol.ModelComment) {
			var c protocol.Comment
			require.NoError(t, json.Unmarshal([]byte(e.Payload), &c))
			comments = append(comments, c)
		}
	}
	require.Len(t, comments, 2)
	for _, c := range comments {
		assert.NotEmpty(t, c.BodyHTML, "comment %d", c.ID)
		assert.False(t, c.BodyTruncated)
	}
	assert.Zero(t, m.failures)

	// A strict loader whose budget is used up refuses; a lenient one
	// leaves the HTML out.
	l := newLoader()
	defer l.close()
	l.budget, l.spent, l.strict = time.Second, time.Second, true
	_, _, err := l.render(t.Context(), nil, "x")
	require.ErrorIs(t, err, errRenderBudget)
	l.strict = false
	html, complete, err := l.render(t.Context(), nil, "x")
	require.NoError(t, err)
	assert.False(t, complete)
	assert.Empty(t, html)
}

// A row that cannot be materialized (here: it cannot even be loaded) fails
// its batch once; the retry materializes the batch row by row, skips that
// row, acknowledges the batch and bumps the table's schema epoch, which
// HandleEpochs turns into re-bootstrap markers.
func TestConsumeIsolatesPoisonRow(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	ctx := t.Context()
	var cursor int64
	epoch := func() int64 {
		v, _, err := livesync_model.GetMeta(ctx, capture.MetaEpochPrefix+"label")
		require.NoError(t, err)
		n, _ := strconv.ParseInt(v, 10, 64)
		return n
	}
	before := epoch()
	exec(t, "UPDATE label SET num_issues = 'not a number' WHERE id = 2")
	changes := []livesync_model.Change{change(1, "label", 1, "U"), change(2, "label", 2, "U")}
	for _, c := range changes {
		require.NoError(t, db.Insert(ctx, &c))
	}
	b := &capture.Batch{Changes: changes, Cursor: 2}
	require.Error(t, m.Consume(ctx, b), "the batch fails as a whole")
	assert.Equal(t, 1, m.failures)
	rows, _ := takeLog(t, &cursor)
	assert.Empty(t, rows)

	b = &capture.Batch{Changes: changes, Cursor: 2}
	require.NoError(t, m.Consume(ctx, b), "the retry isolates the row")
	assert.Zero(t, m.failures)
	rows, _ = takeLog(t, &cursor)
	assert.Equal(t, []logRow{{"repo:1", "issues|pulls", "Label", "U", 1}}, rows)
	assert.Equal(t, before+1, epoch(), "the lost change bumps the epoch")
	var left int64
	_, err := db.GetEngine(ctx).SQL("SELECT COUNT(*) FROM livesync_change").Get(&left)
	require.NoError(t, err)
	assert.Zero(t, left, "the batch is acknowledged")

	require.NoError(t, m.HandleEpochs(ctx))
	rows, _ = takeLog(t, &cursor)
	assert.Equal(t, []logRow{{protocol.GroupAll, "", "Label", "B", 0}}, rows)
}

func TestStripFilePreviews(t *testing.T) {
	plain := "<p>no preview <a href=\"/x\">x</a></p>\n"
	assert.Equal(t, plain, stripFilePreviews(plain))

	box := `<p>see</p><div class="file-preview-box"><div class="header"><div><a href="http://localhost/o/r" rel="nofollow">o/r</a> – <a href="http://localhost/o/r/src/commit/abc/main.go#L1-L2" class="muted" rel="nofollow">main.go</a></div><span class="text grey">Lines 1 to 2 in <a href="http://localhost/o/r/src/commit/abc" class="text black" rel="nofollow">abc</a></span></div><div class="ui table"><table class="file-preview"><tbody><tr><td class="lines-num"><span data-line-number="1"></span></td><td class="lines-code chroma"><code class="code-inner">SECRET</code></td></tr></tbody></table></div></div><p>after</p>`
	got := stripFilePreviews(box)
	assert.NotContains(t, got, "SECRET")
	assert.NotContains(t, got, "file-preview")
	assert.Contains(t, got, `<p><a href="http://localhost/o/r/src/commit/abc/main.go#L1-L2" rel="nofollow">http://localhost/o/r/src/commit/abc/main.go#L1-L2</a></p>`)
	assert.True(t, strings.HasPrefix(got, "<p>see</p>"))
	assert.True(t, strings.HasSuffix(got, "<p>after</p>"))

	handWritten := `<div class="file-preview-box">my own text</div>`
	assert.Equal(t, handWritten, stripFilePreviews(handWritten))
}

// Backend audit: every reader of a repository gets its collaborators, and
// whether they may write, but not who administers it.
func TestCollaboratorPermission(t *testing.T) {
	resetLivesync(t)
	m, _ := testMaterializer(t)
	var cursor int64
	exec(t, "UPDATE collaboration SET mode = ? WHERE id = 1", 3) // admin
	consume(t, m, change(1, "collaboration", 1, "U"))
	_, entries := takeLog(t, &cursor)
	require.Len(t, entries, 2, "the permission epoch and the entity")
	var c protocol.Collaboration
	require.NoError(t, json.Unmarshal([]byte(entries[1].Payload), &c))
	assert.Equal(t, "write", c.Permission)
	assert.Equal(t, "read", collaboratorPermission(1))
	assert.Equal(t, "write", collaboratorPermission(2))
	assert.Equal(t, "write", collaboratorPermission(4))
}

// Backend audit: the repair walk after a re-bootstrap marker removes the
// index rows of entities that are in no group now (a release set back to
// draft while its change was lost), so that their return is emitted
// although it equals what was emitted before.
func TestRepairDropsGrouplessIndexRows(t *testing.T) {
	resetLivesync(t)
	ctx := t.Context()
	require.NoError(t, livesync_model.SetMeta(ctx, capture.MetaEpochPrefix+"release", "1"))
	m, _ := testMaterializer(t)
	var cursor int64
	consume(t, m, change(1, "release", 1, "U"))
	rows, _ := takeLog(t, &cursor)
	require.Equal(t, []logRow{{"repo:1", "releases", "Release", "U", 1}, {"repo:1", "releases", "Attachment", "U", 9}}, rows)

	exec(t, "UPDATE `release` SET is_draft = ? WHERE id = 1", true) // not captured
	require.NoError(t, livesync_model.SetMeta(ctx, capture.MetaEpochPrefix+"release", "2"))
	require.NoError(t, m.HandleEpochs(ctx))
	rows, _ = takeLog(t, &cursor)
	assert.Equal(t, []logRow{{"*", "", "Release", "B", 0}, {"*", "", "Attachment", "B", 0}}, rows,
		"the attachments a release places are concerned too")
	for {
		more, err := m.BackfillStep(ctx)
		require.NoError(t, err)
		if !more {
			break
		}
	}
	assert.Nil(t, indexRow(t, "release", 1), "in no group: unindexed")
	assert.Nil(t, indexRow(t, "attachment", 9), "and its attachment")

	exec(t, "UPDATE `release` SET is_draft = ? WHERE id = 1", false)
	consume(t, m, change(2, "release", 1, "U"))
	rows, _ = takeLog(t, &cursor)
	assert.Equal(t, []logRow{
		{"repo:1", "releases", "Release", "U", 1},
		{"repo:1", "releases", "Attachment", "U", 9},
	}, rows, "published again: emitted, with its attachment")
}
