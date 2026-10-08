// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"forgejo.org/models/db"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/setting"
	api "forgejo.org/modules/structs"
	"forgejo.org/services/livesync/protocol"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Backend audit, round 1: bodies in the sync log.
//   - A body longer than protocol.MaxBodyBytes is cut, without HTML; the
//     full text and its HTML come from GET /-/sync/api/bodies (round 0: a
//     comment of tens of MB of control characters made the append exceed
//     MySQL's max_allowed_packet, and the batch was retried forever).
//   - body_html embeds no file previews (round 0: the code of a public
//     repository was kept in the log, snapshots and clients after the
//     repository became private), while upstream's renderers do.
//
// Round 2: a body that is cheap to post but expensive to render (each
// @mention is a database lookup: 9 000 took 1.45 s of the writer's time)
// is not rendered by the writer: it is sent without HTML and rendered on
// request by GET /-/sync/api/bodies. Rounds 3 and 4: neither does a body
// whose rendering (or its estimate) is slow hold the writer up.
func TestLivesyncAuditBodies(t *testing.T) {
	livesyncSkipSQLite(t)
	livesyncServe(t)
	onApplicationRun(t, func(t *testing.T, u *url.URL) {
		livesyncWaitBackfill(t)
		livesyncSettle(t)
		user2 := livesyncToken(t, &user_model.User{ID: 2})
		user5 := livesyncToken(t, &user_model.User{ID: 5})
		comment := func(repo string, issue int64, body string) int64 {
			t.Helper()
			req := NewRequestWithJSON(t, "POST", fmt.Sprintf("/api/v1/repos/%s/issues/%d/comments", repo, issue), map[string]string{"body": body}).AddTokenAuth(user2)
			var c api.Comment
			DecodeJSON(t, MakeRequest(t, req, http.StatusCreated), &c)
			return c.ID
		}
		fullBody := func(token, model string, id int64, status int) *protocol.APIBody {
			t.Helper()
			resp := MakeRequest(t, NewRequest(t, "GET", fmt.Sprintf("/-/sync/api/bodies/%s/%d", model, id)).AddTokenAuth(token), status)
			if status != http.StatusOK {
				return nil
			}
			var b protocol.APIBody
			DecodeJSON(t, resp, &b)
			return &b
		}

		t.Run("long body", func(t *testing.T) {
			cursor := livesyncLogHead(t)
			// 300 KiB of control characters: 1.8 MB of JSON.
			long := strings.Repeat("\x01", 300<<10) + " the **end**"
			id := comment("user2/repo1", 1, long)
			e := livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelComment, id, protocol.OpUpsert))
			assert.Less(t, len(e.Payload), protocol.MaxBodyBytes+4096, "the payload is bounded")
			c := livesyncPayload[protocol.Comment](t, e)
			assert.True(t, c.BodyTruncated)
			assert.Empty(t, c.BodyHTML)
			assert.True(t, strings.HasPrefix(long, c.Body))
			assert.Len(t, c.Body, protocol.MaxBodyBytes/6)

			b := fullBody(user5, "Comment", id, http.StatusOK) // a reader of the public repository
			assert.Equal(t, long, b.Body)
			assert.Contains(t, b.BodyHTML, "<strong>end</strong>")
			assert.False(t, b.Truncated)
			fullBody(user2, "Comment", 999999, http.StatusNotFound)
			fullBody(user2, "Label", 1, http.StatusNotFound)

			// A body of a private repository's issue: only its readers.
			cursor = livesyncLogHead(t)
			private := comment("user2/repo2", 1, strings.Repeat("secret ", 20000))
			livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelComment, private, protocol.OpUpsert))
			fullBody(user5, "Comment", private, http.StatusNotFound)
			assert.NotEmpty(t, fullBody(user2, "Comment", private, http.StatusOK).Body)
		})

		t.Run("expensive body", func(t *testing.T) {
			cursor := livesyncLogHead(t)
			mentions := strings.Repeat("@user2 ", 2000)
			id := comment("user2/repo1", 1, mentions)
			cheap := comment("user2/repo1", 1, "thanks @user2")
			e := livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelComment, id, protocol.OpUpsert))
			c := livesyncPayload[protocol.Comment](t, e)
			assert.Equal(t, mentions, c.Body)
			assert.Empty(t, c.BodyHTML)
			assert.True(t, c.BodyTruncated)
			e = livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelComment, cheap, protocol.OpUpsert))
			c = livesyncPayload[protocol.Comment](t, e)
			assert.Contains(t, c.BodyHTML, `class="mention"`)
			assert.False(t, c.BodyTruncated)

			b := fullBody(user5, "Comment", id, http.StatusOK)
			assert.Equal(t, mentions, b.Body)
			assert.Equal(t, 2000, strings.Count(b.BodyHTML, `class="mention"`))
			assert.False(t, b.Truncated)
		})

		// Round 3: a body whose rendering grows faster than the body (13 000
		// identical headings: 17 s of CPU that no deadline interrupts) is not
		// rendered by the writer either: a comment written right after it is
		// not held up. (The body is written with SQL: upstream's own
		// mention and reference parsing take half a minute to post it.)
		t.Run("superlinear body", func(t *testing.T) {
			id := comment("user2/repo1", 1, "soon slow")
			livesyncSettle(t)
			cursor := livesyncLogHead(t)
			headings := strings.Repeat("# a\n", 13000)
			_, err := db.GetEngine(t.Context()).Exec("UPDATE `comment` SET content = ? WHERE id = ?", headings, id)
			require.NoError(t, err)
			start := time.Now()
			cheap := comment("user2/repo1", 1, "thanks *again*")
			e := livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelComment, cheap, protocol.OpUpsert))
			assert.Less(t, time.Since(start), 5*time.Second)
			c := livesyncPayload[protocol.Comment](t, e)
			assert.Contains(t, c.BodyHTML, "<em>again</em>")
			assert.False(t, c.BodyTruncated)
			e = livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelComment, id, protocol.OpUpsert))
			c = livesyncPayload[protocol.Comment](t, e)
			assert.Equal(t, headings, c.Body)
			assert.Empty(t, c.BodyHTML)
			assert.True(t, c.BodyTruncated)
		})

		t.Run("no file previews", func(t *testing.T) {
			var branch api.Branch
			DecodeJSON(t, MakeRequest(t, NewRequest(t, "GET", "/api/v1/repos/user2/repo1/branches/master").AddTokenAuth(user2), http.StatusOK), &branch)
			link := setting.AppURL + "user2/repo1/src/commit/" + branch.Commit.ID + "/README.md#L1-L2"
			// Upstream's renderer embeds the lines (API v1 renders as
			// anonymous: any public repository's file)...
			req := NewRequestWithJSON(t, "POST", "/api/v1/repos/user2/repo1/markdown", map[string]string{"text": link, "mode": "comment"}).AddTokenAuth(user2)
			require.Contains(t, MakeRequest(t, req, http.StatusOK).Body.String(), "file-preview-box", "upstream previews the file")

			// ...the synced HTML links them.
			cursor := livesyncLogHead(t)
			id := comment("user2/repo1", 1, "see "+link)
			e := livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelComment, id, protocol.OpUpsert))
			c := livesyncPayload[protocol.Comment](t, e)
			assert.NotContains(t, c.BodyHTML, "file-preview")
			// The box's file link: the source view of the same lines.
			assert.Contains(t, c.BodyHTML, `href="`+strings.TrimSuffix(link, "#L1-L2")+`?display=source#L1-L2"`)
			assert.False(t, c.BodyTruncated)

			// So does the preview of what the log will carry.
			req = NewRequestWithJSON(t, "POST", "/-/sync/api/markdown", protocol.APIMarkdownRequest{RepoID: 1, Items: []string{"see " + link}}).AddTokenAuth(user2)
			var out protocol.APIMarkdownResponse
			DecodeJSON(t, MakeRequest(t, req, http.StatusOK), &out)
			assert.Equal(t, c.BodyHTML, out.HTML[0])
		})

		// Round 4: round 3's estimate ran the repository owner's external
		// tracker regexp over the body on the writer, before any bound
		// (a 111-byte pattern: 13 s over 64 KiB, on every edit). The
		// estimate is part of the rendering, which the writer waits for at
		// most renderWait (1 s), and it does not run such a pattern over
		// the body at all.
		t.Run("owner regexp", func(t *testing.T) {
			admin := livesyncToken(t, &user_model.User{ID: 1})
			hasIssues := true
			req := NewRequestWithJSON(t, "PATCH", "/api/v1/repos/org26/repo_external_tracker_alpha", api.EditRepoOption{
				HasIssues: &hasIssues,
				ExternalTracker: &api.ExternalTracker{
					ExternalTrackerURL:           "https://tracker.com",
					ExternalTrackerFormat:        "https://tracker.com/{user}/{repo}/issues/{index}",
					ExternalTrackerStyle:         "regexp",
					ExternalTrackerRegexpPattern: "(" + strings.Repeat(`\w{1,999}Z|`, 9) + `\w{1,999}Z)`,
				},
			}).AddTokenAuth(admin)
			MakeRequest(t, req, http.StatusOK)
			livesyncSettle(t)
			cursor := livesyncLogHead(t)
			// The body of the repository's pull request 9, written with SQL
			// (upstream's notifications of an edit render it with the
			// pattern too, for as long).
			body := strings.Repeat("abcdefghijklmnop", 4000)
			_, err := db.GetEngine(t.Context()).Exec("UPDATE `issue` SET content = ? WHERE id = 9", body)
			require.NoError(t, err)
			start := time.Now()
			cheap := comment("user2/repo1", 1, "thanks *once more*")
			e := livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelComment, cheap, protocol.OpUpsert))
			assert.Less(t, time.Since(start), 5*time.Second)
			c := livesyncPayload[protocol.Comment](t, e)
			assert.Contains(t, c.BodyHTML, "<em>once more</em>")
			e = livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelIssueBody, 9, protocol.OpUpsert))
			b := livesyncPayload[protocol.IssueBody](t, e)
			assert.Equal(t, body, b.Body)
			assert.Empty(t, b.BodyHTML)
			assert.True(t, b.BodyTruncated)
		})
	})
}
