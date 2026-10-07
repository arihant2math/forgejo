// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package bootstrap

import (
	"bufio"
	"bytes"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"

	"forgejo.org/models/db"
	issues_model "forgejo.org/models/issues"
	livesync_model "forgejo.org/models/livesync"
	access_model "forgejo.org/models/perm/access"
	repo_model "forgejo.org/models/repo"
	"forgejo.org/models/unittest"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/json"
	"forgejo.org/modules/structs"
	"forgejo.org/services/livesync/materialize"
	"forgejo.org/services/livesync/perm"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/services/livesync/synclog"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMain(m *testing.M) {
	unittest.MainTest(m)
}

// prepare resets livesync's tables over Forgejo's fixtures (SQLite), runs
// the entity index backfill to its end and returns a permission cache.
func prepare(t *testing.T) *perm.Cache {
	t.Helper()
	require.NoError(t, unittest.PrepareTestDatabase())
	ctx := t.Context()
	require.NoError(t, livesync_model.SyncTables(ctx))
	for _, table := range []string{"livesync_change", "livesync_log", "livesync_entity", "livesync_meta"} {
		_, err := db.GetEngine(ctx).Exec("DELETE FROM " + table)
		require.NoError(t, err)
	}
	w, err := synclog.AcquireWriter(ctx, nil)
	require.NoError(t, err)
	t.Cleanup(w.Release)
	m := materialize.New(materialize.Config{}, w, func() {})
	require.NoError(t, m.Prepare(ctx))
	for {
		more, err := m.BackfillStep(ctx)
		require.NoError(t, err)
		if !more {
			break
		}
	}
	return perm.NewCache(time.Minute, 0)
}

// response is a parsed bootstrap response.
type response struct {
	header  protocol.BootstrapHeader
	changes []protocol.Change
	end     *protocol.BootstrapEnd
	flushes int
}

func stream(t *testing.T, perms *perm.Cache, viewer int64, group string, edit func(*Request)) response {
	t.Helper()
	ctx := t.Context()
	d, ok, err := perms.Check(ctx, viewer, group)
	require.NoError(t, err)
	require.True(t, ok, "user %d may read %s", viewer, group)
	req := Request{Group: group, ViewerID: viewer, Units: d.Units, Tier: protocol.TierFull, Recent: time.Now().Add(-90 * 24 * time.Hour)}
	if strings.HasPrefix(group, "repo:") {
		req.Tier = protocol.TierSummary
	}
	if edit != nil {
		edit(&req)
	}
	prepared, pending, err := Prepare(ctx, req)
	require.NoError(t, err)
	require.Empty(t, pending)
	var buf bytes.Buffer
	var res response
	require.NoError(t, prepared.Stream(ctx, &buf, func() error { res.flushes++; return nil }, perms))

	sc := bufio.NewScanner(&buf)
	sc.Buffer(nil, 16<<20)
	require.True(t, sc.Scan())
	require.NoError(t, json.Unmarshal(sc.Bytes(), &res.header))
	assert.Equal(t, "header", res.header.Type)
	for sc.Scan() {
		require.Nil(t, res.end, "nothing after the end line")
		if bytes.HasPrefix(sc.Bytes(), []byte(`{"type":"end"`)) {
			res.end = &protocol.BootstrapEnd{}
			require.NoError(t, json.Unmarshal(sc.Bytes(), res.end))
			continue
		}
		var ch protocol.Change
		require.NoError(t, json.Unmarshal(sc.Bytes(), &ch), "%s", sc.Bytes())
		res.changes = append(res.changes, ch)
	}
	require.NotNil(t, res.end, "end line")
	return res
}

func TestStream(t *testing.T) {
	perms := prepare(t)
	head, err := synclog.Head(t.Context())
	require.NoError(t, err)

	res := stream(t, perms, 2, "repo:1", nil)
	h := res.header
	assert.Equal(t, "repo:1", h.Group)
	assert.Equal(t, head, h.Watermark)
	assert.Equal(t, protocol.TierSummary, h.Tier)
	require.NotNil(t, h.ClosedBefore)
	assert.Contains(t, h.Units, protocol.UnitIssues)
	assert.Equal(t, protocol.SchemaIssue, h.Schemas[protocol.ModelIssue])
	assert.NotContains(t, h.Schemas, protocol.ModelComment, "the models this group can hold")
	assert.Greater(t, res.flushes, 2, "streamed: header and chunks flushed")
	count := 0
	models := map[protocol.Model]int{}
	for _, ch := range res.changes {
		assert.Equal(t, h.Watermark, ch.V)
		assert.Equal(t, protocol.OpUpsert, ch.Op)
		require.NotNil(t, ch.D)
		if ch.G == "repo:1" {
			count++
			models[ch.M]++
		}
	}
	assert.Equal(t, count, res.end.Count)
	assert.Equal(t, 1, models[protocol.ModelRepository])
	assert.Positive(t, models[protocol.ModelLabel])
	assert.Contains(t, res.end.Refs, protocol.GroupProfilesPublic, "posters and owner are public users")
	assert.Empty(t, res.end.Next)

	// An organization's repository: its profile is in org:3, embedded.
	res = stream(t, perms, 2, "repo:3", nil)
	assert.Contains(t, res.end.Refs, "org:3")
	var org *protocol.Change
	for i, ch := range res.changes {
		if ch.G == "org:3" {
			org = &res.changes[i]
		}
	}
	require.NotNil(t, org, "the owner's profile is embedded")
	assert.Equal(t, protocol.ModelUser, org.M)
	assert.EqualValues(t, 3, org.ID)
	assert.Equal(t, res.header.Watermark, org.V)

	// A private user's profile: embedded for themselves, not for others.
	res = stream(t, perms, 31, "org:19", nil)
	assert.Contains(t, res.end.Refs, "profile:31")
	found := false
	for _, ch := range res.changes {
		if ch.G == "profile:31" && ch.ID == 31 {
			found = true
		}
	}
	assert.True(t, found, "own private profile embedded")
	res = stream(t, perms, 20, "org:19", nil)
	assert.NotContains(t, res.end.Refs, "profile:31")
	for _, ch := range res.changes {
		assert.NotEqual(t, "profile:31", ch.G, "another user's private profile")
	}

	// A model filter, and a viewer without units.
	res = stream(t, perms, 2, "repo:1", func(r *Request) { r.Models = []protocol.Model{protocol.ModelMilestone} })
	assert.Equal(t, []protocol.Model{protocol.ModelMilestone}, res.header.Models)
	assert.Equal(t, map[protocol.Model]int{protocol.ModelMilestone: protocol.SchemaMilestone, protocol.ModelUser: protocol.SchemaUser}, res.header.Schemas)
	for _, ch := range res.changes {
		if ch.G == "repo:1" {
			assert.Equal(t, protocol.ModelMilestone, ch.M)
		}
	}
	res = stream(t, perms, 2, "repo:1", func(r *Request) { r.Units = 0 })
	assert.Zero(t, res.end.Count, "no units: nothing (not even unit-less entities)")

	// The closed tier pages.
	res = stream(t, perms, 2, "repo:1", func(r *Request) {
		r.Tier, r.ClosedBefore, r.Limit = protocol.TierClosed, materialize.ClosedCursor{Updated: time.Now().Unix() + 3600}, 1
	})
	assert.Equal(t, protocol.TierClosed, res.header.Tier)
	assert.Nil(t, res.header.ClosedBefore)
	assert.Equal(t, strconv.FormatInt(time.Now().Unix()+3600, 10), res.header.Before, "the page's cursor")
	closed, err := db.GetEngine(t.Context()).Table("issue").Where("repo_id = 1 AND is_closed = ?", true).Count()
	require.NoError(t, err)
	require.Positive(t, closed)
	issues := 0
	for _, ch := range res.changes {
		if ch.M == protocol.ModelIssue {
			issues++
		}
	}
	assert.Equal(t, 1, issues, "a page of one")
	assert.Equal(t, closed > 1, res.end.Next != "")

	// The cutoff of a user:{id} bootstrap (read notifications); none in
	// the other full groups.
	res = stream(t, perms, 2, "user:2", nil)
	require.NotNil(t, res.header.ClosedBefore)
	assert.InDelta(t, time.Now().Add(-90*24*time.Hour).Unix(), *res.header.ClosedBefore, 60)
	assert.Empty(t, res.header.Before)
	res = stream(t, perms, 2, "issue:1", nil)
	assert.Nil(t, res.header.ClosedBefore)
}

func TestWorkspace(t *testing.T) {
	perms := prepare(t)
	ctx := t.Context()
	ws, err := Workspace(ctx, perms, 2, 100)
	require.NoError(t, err)
	assert.EqualValues(t, 2, ws.ViewerID)
	reasons := map[string]string{}
	var repos []string
	for _, g := range ws.Groups {
		reasons[g.Group] = g.Reason
		if strings.HasPrefix(g.Group, "repo:") {
			repos = append(repos, g.Group)
		} else {
			assert.Empty(t, repos, "non-repository groups first")
		}
	}
	assert.Equal(t, protocol.WorkspaceSelf, reasons["user:2"])
	assert.Equal(t, protocol.WorkspaceProfile, reasons["profile:2"])
	assert.Equal(t, protocol.WorkspaceDirectory, reasons[protocol.GroupProfilesPublic])
	assert.Equal(t, protocol.WorkspaceMember, reasons["org:3"])
	assert.Equal(t, protocol.WorkspaceOwner, reasons["repo:1"])
	assert.Equal(t, protocol.WorkspaceAccess, reasons["repo:3"], "org repository")
	assert.False(t, ws.Truncated)

	// The cap keeps the most recently updated repositories.
	capped, err := Workspace(ctx, perms, 2, 2)
	require.NoError(t, err)
	assert.True(t, capped.Truncated)
	var cappedRepos []string
	for _, g := range capped.Groups {
		if strings.HasPrefix(g.Group, "repo:") {
			cappedRepos = append(cappedRepos, g.Group)
		}
	}
	assert.Equal(t, repos[:2], cappedRepos)

	// Watched public repositories without access: reason watch; the
	// organization owning one of them (public, user 5 is no member), whose
	// labels and projects its issues refer to: reason repo_owner.
	for _, repo := range []int64{1, 32} {
		_, err = db.GetEngine(ctx).Exec("INSERT INTO watch (user_id, repo_id, watch_selection_issues, watch_selection_pull_requests, watch_selection_releases, source, created_unix, updated_unix) VALUES (5, ?, ?, ?, ?, ?, 0, 0)", repo, true, true, true, false)
		require.NoError(t, err)
	}
	ws, err = Workspace(ctx, perms, 5, 100)
	require.NoError(t, err)
	byGroup := map[string]protocol.WorkspaceGroup{}
	for _, g := range ws.Groups {
		byGroup[g.Group] = g
		d, ok, err := perms.Check(ctx, 5, g.Group)
		require.NoError(t, err)
		require.True(t, ok, g.Group)
		assert.Equal(t, d.Units.Units(), g.Units, "%s: the grant's units", g.Group)
	}
	require.Contains(t, byGroup, "repo:1")
	assert.Equal(t, protocol.WorkspaceWatch, byGroup["repo:1"].Reason)
	assert.Contains(t, byGroup["repo:1"].Units, protocol.UnitIssues)
	assert.Equal(t, protocol.WorkspaceWatch, byGroup["repo:32"].Reason)
	assert.Equal(t, protocol.WorkspaceRepoOwner, byGroup["org:3"].Reason)
	assert.NotContains(t, byGroup, "org:2", "a user owns repository 1")
	// A member's organization is listed once, as member.
	ws, err = Workspace(ctx, perms, 2, 100)
	require.NoError(t, err)
	n := 0
	for _, g := range ws.Groups {
		if g.Group == "org:3" {
			n++
			assert.Equal(t, protocol.WorkspaceMember, g.Reason)
		}
	}
	assert.Equal(t, 1, n)

	// A viewer who may not sign in: empty.
	ws, err = Workspace(ctx, perms, 9, 100)
	require.NoError(t, err)
	assert.Empty(t, ws.Groups)
}

func TestAppendChange(t *testing.T) {
	line := appendChange(nil, 7, &materialize.SnapshotEntity{Group: "repo:1", Model: "Label", ID: 3, Payload: `{"id":3,"name":"<b>"}`})
	assert.JSONEq(t, `{"v":7,"g":"repo:1","m":"Label","id":3,"op":"U","d":{"id":3,"name":"<b>"}}`, string(line))
	assert.True(t, strings.HasSuffix(string(line), `"d":{"id":3,"name":"<b>"}}`+"\n"), "payload verbatim, one line")
	var ch protocol.Change
	require.NoError(t, json.Unmarshal(line, &ch))
	assert.Equal(t, protocol.Change{V: 7, G: "repo:1", M: "Label", ID: 3, Op: "U", D: map[string]any{"id": float64(3), "name": "<b>"}}, ch)
	assert.Equal(t, `"a\"b"`, string(appendJSONString(nil, `a"b`)))
}

// An issue's load carries the cross-references from other repositories that
// the viewer may see, decided like upstream's filterXRefComments.
func TestCrossReferences(t *testing.T) {
	perms := prepare(t)
	ctx := t.Context()
	// Repository 32 (org3) private: only org3's members see its references.
	_, err := db.GetEngine(ctx).Exec("UPDATE repository SET is_private = ? WHERE id = 32", true)
	require.NoError(t, err)
	var xrefs []*issues_model.Comment
	require.NoError(t, db.GetEngine(ctx).Where("issue_id = 1 AND ref_repo_id <> 0 AND ref_repo_id <> 1").Find(&xrefs))
	require.NotEmpty(t, xrefs)
	seen, hidden := 0, 0
	for _, viewer := range []int64{1, 2, 4, 5, 12} {
		u, err := user_model.GetUserByID(ctx, viewer)
		require.NoError(t, err)
		res := stream(t, perms, viewer, "issue:1", nil)
		got := map[int64]bool{}
		for _, ch := range res.changes {
			if ch.G == "issue:1" && ch.M == protocol.ModelComment {
				got[ch.ID] = true
			}
		}
		for _, c := range xrefs {
			if !issues_model.CommentTypeIsRef(c.Type) {
				continue
			}
			repo, err := repo_model.GetRepositoryByID(ctx, c.RefRepoID)
			require.NoError(t, err)
			p, err := access_model.GetUserRepoPermission(ctx, repo, u)
			require.NoError(t, err)
			want := p.CanReadIssuesOrPulls(c.RefIsPull)
			assert.Equal(t, want, got[c.ID], "viewer %d, comment %d from repo %d", viewer, c.ID, c.RefRepoID)
			if want {
				seen++
			} else {
				hidden++
			}
		}
	}
	assert.Positive(t, seen, "some cross-references are visible")
	assert.Positive(t, hidden, "some are not")
	res := stream(t, perms, 2, "issue:1", func(r *Request) { r.Models = []protocol.Model{protocol.ModelIssueBody} })
	for _, ch := range res.changes {
		assert.NotEqual(t, protocol.ModelComment, ch.M, "model filter")
	}
}

// The gate: a table whose index walk runs (here a repair after a
// re-bootstrap marker) makes the bootstrap wait.
func TestPrepareGate(t *testing.T) {
	prepare(t)
	ctx := t.Context()
	req := Request{Group: "repo:1", ViewerID: 2, Units: ^perm.UnitSet(0), Tier: protocol.TierSummary}
	p, pending, err := Prepare(ctx, req)
	require.NoError(t, err)
	require.Empty(t, pending)
	require.NotNil(t, p)
	require.NoError(t, livesync_model.SetMeta(ctx, materialize.MetaBackfillPrefix+"label", "repair:0"))
	p, pending, err = Prepare(ctx, req)
	require.NoError(t, err)
	assert.Equal(t, []string{"label"}, pending)
	assert.Nil(t, p)
	req.Models = []protocol.Model{protocol.ModelMilestone}
	_, pending, err = Prepare(ctx, req)
	require.NoError(t, err)
	assert.Empty(t, pending, "a model filter without labels does not wait for them")
}

// A response may refer to any number of per-user profile groups: they are
// decided in one batch, none is dropped (the first version checked at most
// 1000, one transaction each, and silently left out the rest).
func TestProfileRefsMany(t *testing.T) {
	perms := prepare(t)
	ctx := t.Context()
	const n = 1200
	users := make([]*user_model.User, 0, n)
	ids := make([]int64, 0, n)
	for i := range n {
		id := int64(100000 + i)
		name := fmt.Sprintf("private-%d", i)
		users = append(users, &user_model.User{ID: id, LowerName: name, Name: name, Email: name + "@example.com", Visibility: structs.VisibleTypePrivate, IsActive: true})
		ids = append(ids, id)
	}
	for start := 0; start < n; start += 20 {
		chunk := users[start:min(start+20, n)]
		_, err := db.GetEngine(ctx).NoAutoTime().Insert(&chunk)
		require.NoError(t, err)
	}

	// The admin may read every private profile; another user none of them.
	refs, embed, err := profileRefs(ctx, perms, Request{Group: "repo:1", ViewerID: 1}, append(ids, 2))
	require.NoError(t, err)
	assert.Len(t, embed, n)
	assert.Len(t, refs, n+1)
	assert.Contains(t, refs, protocol.GroupProfilesPublic)
	assert.Contains(t, refs, protocol.ProfileGroup(ids[n-1]))
	refs, embed, err = profileRefs(ctx, perms, Request{Group: "repo:1", ViewerID: 2}, append(ids, 2))
	require.NoError(t, err)
	assert.Empty(t, embed)
	assert.Equal(t, []string{protocol.GroupProfilesPublic}, refs)
}
