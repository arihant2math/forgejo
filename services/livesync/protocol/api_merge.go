// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package protocol

// APIMergeCheck is what the classic pull request page's merge box knows
// about a pull request for its viewer (GET /-/sync/api/issues/{id}/merge-check,
// the pull request's issue): whether Forgejo would merge it, what its base
// branch's protection rule still asks for, whether the viewer may merge or
// delete the head branch, and whether workflow runs wait for a maintainer's
// approval. It is readable by whoever may read the pull request, as the
// classic merge box is; the rule's allowlists are never listed, only
// whether they admit the viewer (AllowMerge).
type APIMergeCheck struct {
	// Mergeable is API v1's "mergeable": not being checked, no conflict,
	// no error and not a work in progress.
	Mergeable bool `json:"mergeable"`
	// AllowMerge: the viewer may merge into the base branch (write access to
	// the code, and the protection rule's merge allowlist when it has one).
	AllowMerge bool `json:"allow_merge"`
	// Protection is the base branch's protection rule as it applies to this
	// pull request, null when no rule protects the base branch.
	Protection *APIMergeProtection `json:"protection"`
	// HeadRepo is the head repository's "owner/name" ("" when it was
	// deleted); HeadBranchExists whether the head branch still exists.
	HeadRepo         string `json:"head_repo"`
	HeadBranchExists bool   `json:"head_branch_exists"`
	// BranchDeletable: the viewer may delete the head branch here (as the
	// classic page's "Delete branch": write access to the head repository,
	// not its default branch, not protected, it exists and, once merged,
	// nothing was pushed to it since and no other open pull request uses it).
	BranchDeletable bool `json:"branch_deletable"`
	// Actions is null when the viewer may not read the repository's
	// Actions (or Actions are disabled).
	Actions *APIMergeActions `json:"actions"`
}

// APIMergeProtection is a protection rule's verdict on a pull request
// (the classic merge box's IsBlockedBy* and the merge API's refusals).
type APIMergeProtection struct {
	RequiredApprovals               int64    `json:"required_approvals"`
	GrantedApprovals                int64    `json:"granted_approvals"`
	BlockedByApprovals              bool     `json:"blocked_by_approvals"`
	BlockedByRejection              bool     `json:"blocked_by_rejection"`
	BlockedByOfficialReviewRequests bool     `json:"blocked_by_official_review_requests"`
	BlockedByOutdatedBranch         bool     `json:"blocked_by_outdated_branch"`
	BlockedByProtectedFiles         bool     `json:"blocked_by_protected_files"`
	ChangedProtectedFiles           []string `json:"changed_protected_files"`
	// RequiredChecks are the status check contexts (glob patterns) that must
	// succeed, empty when the rule does not require status checks.
	RequiredChecks []string `json:"required_checks"`
}

// APIMergeActions says whether a pull request's workflow runs wait for a
// maintainer (runs of a fork's or AGit pull request by an author who is not
// trusted with Actions), as the classic page's trust panel.
type APIMergeActions struct {
	// NeedApproval: some runs of the pull request wait for approval.
	NeedApproval bool `json:"need_approval"`
	// PosterTrust is the author's trust: "no", "explicitly" (approved
	// always), "implicitly" (not a fork, or write access to Actions).
	PosterTrust string `json:"poster_trust"`
	// CanDecide: the viewer may approve, deny or (un)trust (POST
	// /-/sync/api/issues/{id}/action-trust).
	CanDecide bool `json:"can_decide"`
}

// APIActionTrust decides on a pull request's runs that wait for approval
// (POST /-/sync/api/issues/{id}/action-trust, write:repository): "once"
// approves them, "always" also trusts the author from now on, "deny"
// cancels them, "revoke" withdraws an "always".
type APIActionTrust struct {
	Trust string `json:"trust"`
}
