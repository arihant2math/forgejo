// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package bootstrap

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"

	"forgejo.org/models/db"
	issues_model "forgejo.org/models/issues"
	livesync_model "forgejo.org/models/livesync"
	access_model "forgejo.org/models/perm/access"
	project_model "forgejo.org/models/project"
	repo_model "forgejo.org/models/repo"
	"forgejo.org/models/unittest"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/json"
	project_module "forgejo.org/modules/project"
	"forgejo.org/modules/structs"
	"forgejo.org/services/livesync/capture"
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
	return prepareWith(t, nil)
}

// prepareWith is prepare with setup run on the fixtures before the
// backfill.
func prepareWith(t *testing.T, setup func(ctx context.Context)) *perm.Cache {
	t.Helper()
	require.NoError(t, unittest.PrepareTestDatabase())
	ctx := t.Context()
	if setup != nil {
		setup(ctx)
	}
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
	assert.Contains(t, res.end.Refs, "owner:2", "the owner's projects")
	assert.Empty(t, res.end.Next)

	// An organization's repository: its profile is in org:3, embedded;
	// its labels and projects in owner:3, listed only.
	res = stream(t, perms, 2, "repo:3", nil)
	assert.Contains(t, res.end.Refs, "org:3")
	assert.Contains(t, res.end.Refs, "owner:3")
	for _, ch := range res.changes {
		assert.NotEqual(t, "owner:3", ch.G, "an owner group is not embedded")
	}
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
	assert.Equal(t, protocol.WorkspaceMember, reasons["owner:3"])
	assert.Equal(t, protocol.WorkspaceProfile, reasons["owner:2"])
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
	assert.Equal(t, protocol.WorkspaceRepoOwner, byGroup["owner:3"].Reason)
	assert.Equal(t, protocol.WorkspaceRepoOwner, byGroup["owner:2"].Reason, "user2's projects")
	assert.NotContains(t, byGroup, "org:2", "a user owns repository 1")
	// A member's organization is listed once, as member.
	ws, err = Workspace(ctx, perms, 2, 100)
	require.NoError(t, err)
	n := 0
	for _, g := range ws.Groups {
		if g.Group == "org:3" || g.Group == "owner:3" {
			n++
			assert.Equal(t, protocol.WorkspaceMember, g.Reason)
		}
	}
	assert.Equal(t, 2, n)

	// A viewer who may not sign in: empty.
	ws, err = Workspace(ctx, perms, 9, 100)
	require.NoError(t, err)
	assert.Empty(t, ws.Groups)
}

// B6 review round 2: an outside collaborator of a private organization's
// repository (user4 on privated_org's repository 40) cannot see the
// organization, but upstream shows them its labels and projects on the
// repository's issues. The organization's labels and projects are in
// owner:23, which the repository's bootstrap refers to and the workspace
// lists, and which user4 may load; the projects' columns stay in org:23,
// which they may not read (upstream shows them the boards only through the
// organization).
func TestOwnerGroupReachable(t *testing.T) {
	var issue issues_model.Issue
	var label issues_model.Label
	var project project_model.Project
	var column project_model.Column
	perms := prepareWith(t, func(ctx context.Context) {
		e := db.GetEngine(ctx)
		issue = issues_model.Issue{RepoID: 40, Index: 1, PosterID: 2, Title: "contract work", Content: "body"}
		label = issues_model.Label{OrgID: 23, Name: "contract", Color: "#ee0701"}
		project = project_model.Project{Title: "roadmap", OwnerID: 23, Type: project_module.TypeOrganization, CreatorID: 2, TemplateType: project_module.TemplateTypeNone}
		for _, row := range []any{&issue, &label, &project} {
			_, err := e.Insert(row)
			require.NoError(t, err)
		}
		column = project_model.Column{ProjectID: project.ID, Title: "todo", CreatorID: 2}
		_, err := e.Insert(&column)
		require.NoError(t, err)
		_, err = e.Insert(&issues_model.IssueLabel{IssueID: issue.ID, LabelID: label.ID})
		require.NoError(t, err)
		_, err = e.Insert(&project_model.ProjectIssue{IssueID: issue.ID, ProjectID: project.ID, ProjectColumnID: column.ID})
		require.NoError(t, err)
	})
	ctx := t.Context()

	res := stream(t, perms, 4, "repo:40", nil)
	decode := func(d, v any) {
		b, err := json.Marshal(d)
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(b, v))
	}
	var labelRefs, projectRefs []int64
	for _, ch := range res.changes {
		switch ch.M {
		case protocol.ModelIssueLabel:
			var il protocol.IssueLabel
			decode(ch.D, &il)
			labelRefs = append(labelRefs, il.LabelID)
		case protocol.ModelProjectIssue:
			var pi protocol.ProjectIssue
			decode(ch.D, &pi)
			projectRefs = append(projectRefs, pi.ProjectID)
		}
	}
	assert.Equal(t, []int64{label.ID}, labelRefs)
	assert.Equal(t, []int64{project.ID}, projectRefs)
	assert.Contains(t, res.end.Refs, "owner:23")
	assert.NotContains(t, res.end.Refs, "org:23")

	res = stream(t, perms, 4, "owner:23", nil)
	got := map[string]bool{}
	for _, ch := range res.changes {
		assert.Equal(t, "owner:23", ch.G)
		got[fmt.Sprintf("%s %d", ch.M, ch.ID)] = true
	}
	assert.Equal(t, map[string]bool{
		fmt.Sprintf("Label %d", label.ID):     true,
		fmt.Sprintf("Project %d", project.ID): true,
	}, got)
	_, ok, err := perms.Check(ctx, 4, "org:23")
	require.NoError(t, err)
	assert.False(t, ok, "the columns are not readable")
	_, ok, err = perms.Check(ctx, 10, "owner:23")
	require.NoError(t, err)
	assert.False(t, ok, "user10 may read neither the organization nor its repositories")
	_, ok, err = perms.Check(ctx, 5, "owner:23")
	require.NoError(t, err)
	assert.True(t, ok, "user5 is a member")

	ws, err := Workspace(ctx, perms, 4, 100)
	require.NoError(t, err)
	reasons := map[string]string{}
	for _, g := range ws.Groups {
		reasons[g.Group] = g.Reason
	}
	assert.Equal(t, protocol.WorkspaceAccess, reasons["repo:40"])
	assert.Equal(t, protocol.WorkspaceRepoOwner, reasons["owner:23"])
	assert.NotContains(t, reasons, "org:23")
	assert.Equal(t, protocol.WorkspaceProfile, reasons["owner:4"])
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

// The watermark is read before the gate: a re-bootstrap marker and the
// restart of its table's walk ("repair:0", one transaction) that land
// between the two reads either are above the watermark (the client gets
// bootstrap_required after this bootstrap) or make the gate refuse — here
// both. Read in the other order, the gate would pass and the watermark
// would include the marker: the client would never re-bootstrap.
func TestPrepareOrder(t *testing.T) {
	prepare(t)
	ctx := t.Context()
	w, err := synclog.AcquireWriter(ctx, nil)
	require.NoError(t, err)
	defer w.Release()
	m := materialize.New(materialize.Config{}, w, func() {})
	require.NoError(t, m.Prepare(ctx))
	var marker int64
	betweenReads = func(ctx context.Context) {
		// The label table's trigger was repaired: HandleEpochs appends the
		// Label marker and restarts the walk in one writer transaction.
		require.NoError(t, livesync_model.SetMeta(ctx, capture.MetaEpochPrefix+"label", "2"))
		require.NoError(t, m.HandleEpochs(ctx))
		var err error
		marker, err = synclog.Head(ctx)
		require.NoError(t, err)
	}
	defer func() { betweenReads = nil }()
	p, pending, err := Prepare(ctx, Request{Group: "repo:1", ViewerID: 2, Units: ^perm.UnitSet(0), Tier: protocol.TierSummary})
	require.NoError(t, err)
	require.Positive(t, marker)
	assert.Equal(t, []string{"label"}, pending, "the gate sees the walk")
	assert.Nil(t, p)
	betweenReads = nil
	_, pending, err = Prepare(ctx, Request{Group: "issue:1", ViewerID: 2, Units: ^perm.UnitSet(0), Tier: protocol.TierFull})
	require.NoError(t, err)
	require.Empty(t, pending)
	// The watermark side, on a group the walk does not concern: read
	// before the marker.
	betweenReads = func(ctx context.Context) {
		require.NoError(t, livesync_model.SetMeta(ctx, capture.MetaEpochPrefix+"label", "3"))
		require.NoError(t, m.HandleEpochs(ctx))
		marker, err = synclog.Head(ctx)
		require.NoError(t, err)
	}
	p, pending, err = Prepare(ctx, Request{Group: "issue:1", ViewerID: 2, Units: ^perm.UnitSet(0), Tier: protocol.TierFull})
	require.NoError(t, err)
	require.Empty(t, pending)
	assert.Less(t, p.watermark, marker, "the watermark predates the marker")
}

// An issue's load carries its dependencies as API v1 lists them: only when
// the repository has dependencies enabled, and only those whose issue the
// viewer may read; they are never in the sync log.
func TestDependencies(t *testing.T) {
	perms := prepare(t)
	ctx := t.Context()
	// Issue 1 (user2/repo1, public) is blocked by pull request 2 (repo1) and
	// by issue 4 (user2/repo2, private).
	for i, dep := range []int64{2, 4} {
		_, err := db.GetEngine(ctx).Exec("INSERT INTO issue_dependency (id, user_id, issue_id, dependency_id, created_unix, updated_unix) VALUES (?, 2, 1, ?, 0, 0)", 1000+i, dep)
		require.NoError(t, err)
	}
	deps := func(viewer int64) []int64 {
		var res []int64
		for _, ch := range stream(t, perms, viewer, "issue:1", nil).changes {
			if ch.M == protocol.ModelIssueDependency {
				assert.Equal(t, "issue:1", ch.G)
				res = append(res, int64(ch.D.(map[string]any)["dependency_id"].(float64)))
			}
		}
		return res
	}
	// The fixture's issues config of repo1 has dependencies disabled.
	assert.Empty(t, deps(2), "disabled: none")
	_, err := db.GetEngine(ctx).Exec("UPDATE repo_unit SET config = ? WHERE repo_id = 1 AND type = 2", `{"EnableTimetracker":true,"EnableDependencies":true}`)
	require.NoError(t, err)
	shown := 0
	for _, viewer := range []int64{1, 2, 4, 5} {
		u, err := user_model.GetUserByID(ctx, viewer)
		require.NoError(t, err)
		var want []int64
		for _, dep := range []int64{2, 4} {
			issue, err := issues_model.GetIssueByID(ctx, dep)
			require.NoError(t, err)
			repo, err := repo_model.GetRepositoryByID(ctx, issue.RepoID)
			require.NoError(t, err)
			p, err := access_model.GetUserRepoPermission(ctx, repo, u)
			require.NoError(t, err)
			if p.CanReadIssuesOrPulls(issue.IsPull) {
				want = append(want, dep)
			}
		}
		assert.Equal(t, want, deps(viewer), "viewer %d", viewer)
		shown += len(want)
	}
	assert.Greater(t, shown, 4, "some viewers see both, some one")
	res := stream(t, perms, 2, "issue:1", func(r *Request) { r.Models = []protocol.Model{protocol.ModelIssueBody} })
	for _, ch := range res.changes {
		assert.NotEqual(t, protocol.ModelIssueDependency, ch.M, "model filter")
	}
	assert.Contains(t, stream(t, perms, 2, "issue:1", nil).header.Schemas, protocol.ModelIssueDependency)
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
	refs, embed, err := profileRefs(ctx, perms, Request{Group: "repo:1", ViewerID: 1}, append(ids, 2), nil)
	require.NoError(t, err)
	assert.Len(t, embed, n)
	assert.Len(t, refs, n+1)
	assert.Contains(t, refs, protocol.GroupProfilesPublic)
	assert.Contains(t, refs, protocol.ProfileGroup(ids[n-1]))
	refs, embed, err = profileRefs(ctx, perms, Request{Group: "repo:1", ViewerID: 2}, append(ids, 2), nil)
	require.NoError(t, err)
	assert.Empty(t, embed)
	assert.Equal(t, []string{protocol.GroupProfilesPublic}, refs)
}
