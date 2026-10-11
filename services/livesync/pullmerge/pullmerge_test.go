// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package pullmerge

import (
	"testing"

	actions_model "forgejo.org/models/actions"
	"forgejo.org/models/db"
	git_model "forgejo.org/models/git"
	issues_model "forgejo.org/models/issues"
	"forgejo.org/models/perm"
	access_model "forgejo.org/models/perm/access"
	repo_model "forgejo.org/models/repo"
	"forgejo.org/models/unit"
	"forgejo.org/models/unittest"
	user_model "forgejo.org/models/user"
	repo_module "forgejo.org/modules/repository"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/test"
	actions_service "forgejo.org/services/actions"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMain(m *testing.M) {
	unittest.MainTest(m)
}

// check loads a pull request afresh (nothing cached between calls), a viewer and their permission in its repository.
func check(t *testing.T, pullID, userID int64) (*issues_model.PullRequest, access_model.Permission, *user_model.User) {
	t.Helper()
	pr := unittest.AssertExistsAndLoadBean(t, &issues_model.PullRequest{ID: pullID})
	repo := unittest.AssertExistsAndLoadBean(t, &repo_model.Repository{ID: pr.BaseRepoID})
	viewer := unittest.AssertExistsAndLoadBean(t, &user_model.User{ID: userID})
	p, err := access_model.GetUserRepoPermission(db.DefaultContext, repo, viewer)
	require.NoError(t, err)
	return pr, p, viewer
}

func TestCheckWithoutProtection(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	// user2 owns user2/repo1; pull request 2 is branch2 → master, open.
	pr, p, viewer := check(t, 2, 2)
	res, err := Check(db.DefaultContext, pr, viewer, p)
	require.NoError(t, err)
	assert.True(t, res.Mergeable)
	assert.True(t, res.AllowMerge)
	assert.Nil(t, res.Protection)
	assert.Equal(t, "user2/repo1", res.HeadRepo)
	assert.True(t, res.HeadBranchExists)
	assert.True(t, res.BranchDeletable)

	// A reader (user5 on the public repository) may neither merge nor delete the branch.
	pr, p, viewer = check(t, 2, 5)
	require.False(t, p.CanWrite(unit.TypeCode))
	res, err = Check(db.DefaultContext, pr, viewer, p)
	require.NoError(t, err)
	assert.False(t, res.AllowMerge)
	assert.False(t, res.BranchDeletable)
	assert.True(t, res.HeadBranchExists)

	// Pull request 1 was merged and its branch (branch1) is gone: nothing to delete.
	pr, p, viewer = check(t, 1, 2)
	res, err = Check(db.DefaultContext, pr, viewer, p)
	require.NoError(t, err)
	assert.False(t, res.HeadBranchExists)
	assert.False(t, res.BranchDeletable)
}

func TestCheckProtectionForWriters(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	repo := unittest.AssertExistsAndLoadBean(t, &repo_model.Repository{ID: 1})
	// user4: a writer, not an administrator (API v1's branch_protections answer them 403).
	writer := unittest.AssertExistsAndLoadBean(t, &user_model.User{ID: 4})
	require.NoError(t, repo_module.AddCollaborator(db.DefaultContext, repo, writer))
	require.NoError(t, repo_module.ChangeCollaborationAccessMode(db.DefaultContext, repo, writer.ID, perm.AccessModeWrite))
	require.NoError(t, git_model.UpdateProtectBranch(db.DefaultContext, repo, &git_model.ProtectedBranch{
		RepoID: repo.ID, RuleName: "master", RequiredApprovals: 2, BlockOnOutdatedBranch: true,
		EnableStatusCheck: true, StatusCheckContexts: []string{"ci/*"},
	}, git_model.WhitelistOptions{}))

	pr, p, viewer := check(t, 2, 4)
	require.True(t, p.CanWrite(unit.TypeCode))
	require.False(t, p.IsAdmin())
	res, err := Check(db.DefaultContext, pr, viewer, p)
	require.NoError(t, err)
	require.NotNil(t, res.Protection)
	assert.True(t, res.AllowMerge, "no merge allowlist: write access merges")
	assert.EqualValues(t, 2, res.Protection.RequiredApprovals)
	assert.EqualValues(t, 0, res.Protection.GrantedApprovals)
	assert.True(t, res.Protection.BlockedByApprovals)
	assert.False(t, res.Protection.BlockedByRejection)
	assert.Equal(t, []string{"ci/*"}, res.Protection.RequiredChecks)
	assert.Equal(t, []string{}, res.Protection.ChangedProtectedFiles)

	// An official approval counts.
	require.NoError(t, db.Insert(db.DefaultContext, &issues_model.Review{Type: issues_model.ReviewTypeApprove, ReviewerID: 1, IssueID: pr.IssueID, Official: true}))
	pr, p, viewer = check(t, 2, 4)
	res, err = Check(db.DefaultContext, pr, viewer, p)
	require.NoError(t, err)
	assert.EqualValues(t, 1, res.Protection.GrantedApprovals)
	assert.True(t, res.Protection.BlockedByApprovals)

	// A merge allowlist without the writer: they may not merge (they are told, not refused at the end).
	pb, err := git_model.GetFirstMatchProtectedBranchRule(db.DefaultContext, repo.ID, "master")
	require.NoError(t, err)
	pb.EnableMergeWhitelist = true
	require.NoError(t, git_model.UpdateProtectBranch(db.DefaultContext, repo, pb, git_model.WhitelistOptions{MergeUserIDs: []int64{2}}))
	pr, p, viewer = check(t, 2, 4)
	res, err = Check(db.DefaultContext, pr, viewer, p)
	require.NoError(t, err)
	assert.False(t, res.AllowMerge)
	// The branch itself is not protected: the writer may still delete it.
	assert.True(t, res.BranchDeletable)
}

func TestCheckActions(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	// user2/repo1 has the Actions unit.
	repo := unittest.AssertExistsAndLoadBean(t, &repo_model.Repository{ID: 1})

	pr, p, viewer := check(t, 2, 2)
	res, err := Check(db.DefaultContext, pr, viewer, p)
	require.NoError(t, err)
	require.NotNil(t, res.Actions)
	assert.False(t, res.Actions.NeedApproval)
	// Not a fork: the author is trusted implicitly.
	assert.Equal(t, string(actions_service.UserIsImplicitlyTrustedWithActions), res.Actions.PosterTrust)
	assert.True(t, res.Actions.CanDecide)

	require.NoError(t, db.Insert(db.DefaultContext, &actions_model.ActionRun{
		Title: "ci", RepoID: repo.ID, OwnerID: repo.OwnerID, WorkflowID: "ci.yml", Index: 9001, TriggerUserID: 1,
		Ref: "refs/pull/3/head", CommitSHA: "985f0301dba5e7b34be866819cd15ad3d8f508ee", Event: "pull_request",
		PullRequestID: pr.ID, IsForkPullRequest: true, NeedApproval: true, Status: actions_model.StatusBlocked,
	}))
	pr, p, viewer = check(t, 2, 2)
	res, err = Check(db.DefaultContext, pr, viewer, p)
	require.NoError(t, err)
	assert.True(t, res.Actions.NeedApproval)
	assert.True(t, CanDecide(pr, viewer, p))

	// A reader sees that runs wait, and that they may not decide.
	pr, p, viewer = check(t, 2, 5)
	res, err = Check(db.DefaultContext, pr, viewer, p)
	require.NoError(t, err)
	require.NotNil(t, res.Actions)
	assert.True(t, res.Actions.NeedApproval)
	assert.False(t, res.Actions.CanDecide)

	// Approving once releases the run.
	pr, _, viewer = check(t, 2, 2)
	require.NoError(t, actions_service.UpdateTrustedWithPullRequest(db.DefaultContext, viewer.ID, pr, Trusts["once"]))
	run := unittest.AssertExistsAndLoadBean(t, &actions_model.ActionRun{RepoID: repo.ID, Index: 9001})
	assert.False(t, run.NeedApproval)
	assert.Equal(t, viewer.ID, run.ApprovedBy)
}

func TestCheckActionsUnreadable(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	// Actions disabled on the instance: nothing about runs, no decision.
	defer test.MockVariableValue(&setting.Actions.Enabled, false)()
	pr, p, viewer := check(t, 2, 2)
	res, err := Check(db.DefaultContext, pr, viewer, p)
	require.NoError(t, err)
	assert.Nil(t, res.Actions)
	assert.False(t, CanDecide(pr, viewer, p))
	_, ok := Trusts["maybe"]
	assert.False(t, ok)
}
