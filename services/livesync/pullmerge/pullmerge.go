// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Package pullmerge answers what the classic pull request page's merge box
// computes for its viewer (routers/web/repo/issue.go ViewIssue and
// PrepareViewPullInfoActionsTrust): the base branch's protection verdict,
// whether the viewer may merge or delete the head branch, and whether the
// pull request's workflow runs wait for a maintainer. API v1 has no such
// summary, and its protection rules are for repository administrators only
// (GET /repos/{owner}/{repo}/branch_protections/{name}).
package pullmerge

import (
	"context"
	"errors"
	"fmt"

	actions_model "forgejo.org/models/actions"
	git_model "forgejo.org/models/git"
	issues_model "forgejo.org/models/issues"
	access_model "forgejo.org/models/perm/access"
	"forgejo.org/models/unit"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/git"
	"forgejo.org/modules/gitrepo"
	"forgejo.org/modules/setting"
	actions_service "forgejo.org/services/actions"
	"forgejo.org/services/livesync/protocol"
	pull_service "forgejo.org/services/pull"
)

// Check computes the merge check of pr for viewer, whose permission in the
// pull request's base repository is perm.
func Check(ctx context.Context, pr *issues_model.PullRequest, viewer *user_model.User, perm access_model.Permission) (*protocol.APIMergeCheck, error) {
	if err := pr.LoadIssue(ctx); err != nil {
		return nil, err
	}
	if err := pr.LoadBaseRepo(ctx); err != nil {
		return nil, err
	}
	if err := pr.LoadHeadRepo(ctx); err != nil {
		return nil, err
	}
	res := &protocol.APIMergeCheck{Mergeable: pr.Mergeable(ctx)}
	allow, err := pull_service.IsUserAllowedToMerge(ctx, pr, perm, viewer)
	if err != nil {
		return nil, fmt.Errorf("IsUserAllowedToMerge: %w", err)
	}
	res.AllowMerge = allow && !pr.BaseRepo.IsArchived

	pb, err := git_model.GetFirstMatchProtectedBranchRule(ctx, pr.BaseRepoID, pr.BaseBranch)
	if err != nil {
		return nil, fmt.Errorf("GetFirstMatchProtectedBranchRule: %w", err)
	}
	if pb != nil {
		pb.Repo = pr.BaseRepo
		p := &protocol.APIMergeProtection{
			RequiredApprovals:               pb.RequiredApprovals,
			GrantedApprovals:                issues_model.GetGrantedApprovalsCount(ctx, pb, pr),
			BlockedByApprovals:              !issues_model.HasEnoughApprovals(ctx, pb, pr),
			BlockedByRejection:              issues_model.MergeBlockedByRejectedReview(ctx, pb, pr),
			BlockedByOfficialReviewRequests: issues_model.MergeBlockedByOfficialReviewRequests(ctx, pb, pr),
			BlockedByOutdatedBranch:         issues_model.MergeBlockedByOutdatedBranch(pb, pr),
			BlockedByProtectedFiles:         pb.MergeBlockedByProtectedFiles(pr.ChangedProtectedFiles),
			ChangedProtectedFiles:           append([]string{}, pr.ChangedProtectedFiles...),
			RequiredChecks:                  []string{},
		}
		if pb.EnableStatusCheck {
			p.RequiredChecks = append(p.RequiredChecks, pb.StatusCheckContexts...)
		}
		res.Protection = p
	}

	if err := headBranch(ctx, pr, viewer, res); err != nil {
		return nil, err
	}

	if ActionsReadable(perm) {
		need, err := actions_model.HasRunThatNeedApproval(ctx, pr.BaseRepoID, pr.ID)
		if err != nil {
			return nil, fmt.Errorf("HasRunThatNeedApproval: %w", err)
		}
		trust, err := actions_service.GetPullRequestPosterIsTrustedWithActions(ctx, pr)
		if err != nil && !errors.Is(err, issues_model.ErrNoPosterSetOnIssue) && !user_model.IsErrUserNotExist(err) {
			return nil, fmt.Errorf("GetPullRequestPosterIsTrustedWithActions: %w", err)
		}
		res.Actions = &protocol.APIMergeActions{NeedApproval: need, PosterTrust: string(trust), CanDecide: CanDecide(pr, viewer, perm)}
	}
	return res, nil
}

// headBranch fills in the head repository and branch and whether the
// viewer may delete the branch (isPullBranchDeletable of the classic page).
func headBranch(ctx context.Context, pr *issues_model.PullRequest, viewer *user_model.User, res *protocol.APIMergeCheck) error {
	head := pr.HeadRepo
	if head == nil {
		return nil
	}
	res.HeadRepo = head.FullName()
	res.HeadBranchExists = pr.Flow == issues_model.PullRequestFlowGithub && git.IsBranchExist(ctx, head.RepoPath(), pr.HeadBranch)
	if !res.HeadBranchExists || head.IsArchived || pr.HeadBranch == head.DefaultBranch {
		return nil
	}
	headPerm, err := access_model.GetUserRepoPermission(ctx, head, viewer)
	if err != nil {
		return fmt.Errorf("GetUserRepoPermission: %w", err)
	}
	if !headPerm.CanWrite(unit.TypeCode) {
		return nil
	}
	protected, err := git_model.IsBranchProtected(ctx, head.ID, pr.HeadBranch)
	if err != nil {
		return fmt.Errorf("IsBranchProtected: %w", err)
	}
	if protected {
		return nil
	}
	if pr.HasMerged {
		// Only what was merged: a branch that moved on since holds unmerged work.
		moved, err := headMovedOn(ctx, pr)
		if err != nil || moved {
			return err
		}
		other, err := issues_model.HasUnmergedPullRequestsByHeadInfo(ctx, pr.HeadRepoID, pr.HeadBranch)
		if err != nil {
			return fmt.Errorf("HasUnmergedPullRequestsByHeadInfo: %w", err)
		}
		if other {
			return nil
		}
	}
	res.BranchDeletable = true
	return nil
}

// headMovedOn reports whether the head branch points elsewhere than the
// pull request's head (refs/pull/{index}/head in the base repository).
func headMovedOn(ctx context.Context, pr *issues_model.PullRequest) (bool, error) {
	baseGit, err := gitrepo.OpenRepository(ctx, pr.BaseRepo)
	if err != nil {
		return false, fmt.Errorf("open the base repository: %w", err)
	}
	defer baseGit.Close()
	sha, err := baseGit.GetRefCommitID(pr.GetGitRefName())
	if err != nil {
		// No head ref (a broken pull request): nothing proves the branch is what was merged.
		return true, nil
	}
	headGit := baseGit
	if pr.HeadRepoID != pr.BaseRepoID {
		if headGit, err = gitrepo.OpenRepository(ctx, pr.HeadRepo); err != nil {
			return false, fmt.Errorf("open the head repository: %w", err)
		}
		defer headGit.Close()
	}
	branchSHA, err := headGit.GetBranchCommitID(pr.HeadBranch)
	if err != nil {
		return true, nil
	}
	return branchSHA != sha, nil
}

// ActionsReadable reports whether Actions are enabled and the viewer may
// read them in the repository (MustEnableActions).
func ActionsReadable(perm access_model.Permission) bool {
	return setting.Actions.Enabled && !unit.TypeActions.UnitGlobalDisabled() && perm.CanRead(unit.TypeActions)
}

// CanDecide reports whether viewer may approve, deny or (un)trust the runs
// of pr (CheckRepoDelegateActionTrust; the classic route also refuses an
// archived repository).
func CanDecide(pr *issues_model.PullRequest, viewer *user_model.User, perm access_model.Permission) bool {
	if pr.BaseRepo == nil || pr.BaseRepo.IsArchived || !ActionsReadable(perm) {
		return false
	}
	return perm.IsAdmin() || viewer.IsAdmin || perm.CanWrite(unit.TypeActions)
}

// Trusts are the decisions APIActionTrust accepts.
var Trusts = map[string]actions_service.TrustUpdate{
	string(actions_service.UserTrustedOnce):   actions_service.UserTrustedOnce,
	string(actions_service.UserAlwaysTrusted): actions_service.UserAlwaysTrusted,
	string(actions_service.UserTrustDenied):   actions_service.UserTrustDenied,
	string(actions_service.UserTrustRevoked):  actions_service.UserTrustRevoked,
}
