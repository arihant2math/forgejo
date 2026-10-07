// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package protocol

import (
	"time"
)

// The entity DTOs, one per Model. Each is the full state of one row (the
// payload of an OpUpsert), the same for every reader of its group: nothing in
// them depends on who reads them (PLAN §4.4 viewer-independence rule).
// Viewer-specific facts live in per-user entities of the user:{id} group
// (Notification, Stopwatch, IssueWatch, Watch, Star, BlockedUser, Access,
// ReviewState), which only that user is granted. Markdown is rendered once by Forgejo's markup service without
// a viewer (see services/livesync/materialize/render.go for what that means).

// Repository is a repository (group repo:{id}, unit none).
type Repository struct {
	ID               int64      `json:"id"`
	OwnerID          int64      `json:"owner_id"`
	OwnerName        string     `json:"owner_name"`
	Name             string     `json:"name"`
	FullName         string     `json:"full_name"`
	Description      string     `json:"description"`
	Website          string     `json:"website"`
	Private          bool       `json:"private"`
	Fork             bool       `json:"fork"`
	ParentID         int64      `json:"parent_id"`
	Template         bool       `json:"template"`
	Mirror           bool       `json:"mirror"`
	Archived         bool       `json:"archived"`
	Empty            bool       `json:"empty"`
	DefaultBranch    string     `json:"default_branch"`
	StarsCount       int        `json:"stars_count"`
	ForksCount       int        `json:"forks_count"`
	WatchersCount    int        `json:"watchers_count"`
	Topics           []string   `json:"topics"`
	ObjectFormatName string     `json:"object_format_name"`
	AvatarURL        string     `json:"avatar_url"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
	ArchivedAt       *time.Time `json:"archived_at,omitempty"`
}

// User is the public profile of a user or organization: group
// profiles:public or profiles:limited for an individual user with that
// visibility, profile:{id} for a private one, org:{id} for an organization
// (unit none). Email addresses, admin/active/restricted flags and settings
// are never included.
type User struct {
	ID          int64  `json:"id"`
	Login       string `json:"login"`
	FullName    string `json:"full_name"`
	AvatarURL   string `json:"avatar_url"`
	Type        string `json:"type"`       // "user", "organization", "bot", "remote", "reserved"
	Visibility  string `json:"visibility"` // "public", "limited", "private"
	Description string `json:"description"`
	Website     string `json:"website"`
	Location    string `json:"location"`
	// Pronouns is empty when the user keeps them private.
	Pronouns  string    `json:"pronouns"`
	CreatedAt time.Time `json:"created_at"`
}

// OrgUser is an organization membership (group org:{org_id}; unit members
// for a concealed membership).
type OrgUser struct {
	ID     int64 `json:"id"`
	OrgID  int64 `json:"org_id"`
	UserID int64 `json:"user_id"`
	Public bool  `json:"public"`
}

// Team is an organization team (group org:{org_id}, unit members).
type Team struct {
	ID                      int64  `json:"id"`
	OrgID                   int64  `json:"org_id"`
	Name                    string `json:"name"`
	Description             string `json:"description"`
	Permission              string `json:"permission"` // "none", "read", "write", "admin", "owner"
	IncludesAllRepositories bool   `json:"includes_all_repositories"`
	CanCreateOrgRepo        bool   `json:"can_create_org_repo"`
	NumMembers              int    `json:"num_members"`
	NumRepos                int    `json:"num_repos"`
}

// TeamUser is a team membership (group org:{org_id}, unit members).
type TeamUser struct {
	ID     int64 `json:"id"`
	OrgID  int64 `json:"org_id"`
	TeamID int64 `json:"team_id"`
	UserID int64 `json:"user_id"`
}

// TeamRepo gives a team access to a repository (group org:{org_id}, unit
// members).
type TeamRepo struct {
	ID     int64 `json:"id"`
	OrgID  int64 `json:"org_id"`
	TeamID int64 `json:"team_id"`
	RepoID int64 `json:"repo_id"`
}

// TeamUnit is a team's access mode for one unit type (group org:{org_id},
// unit members).
type TeamUnit struct {
	ID         int64  `json:"id"`
	OrgID      int64  `json:"org_id"`
	TeamID     int64  `json:"team_id"`
	Type       Unit   `json:"type"`
	Permission string `json:"permission"`
}

// Collaboration makes a user a collaborator of a repository (group
// repo:{repo_id}).
type Collaboration struct {
	ID         int64     `json:"id"`
	RepoID     int64     `json:"repo_id"`
	UserID     int64     `json:"user_id"`
	Permission string    `json:"permission"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// Access is a user's computed access mode to a repository (group
// user:{user_id}, unit self).
type Access struct {
	ID         int64  `json:"id"`
	UserID     int64  `json:"user_id"`
	RepoID     int64  `json:"repo_id"`
	Permission string `json:"permission"`
}

// RepoUnit is an enabled unit of a repository with its configuration
// (group repo:{repo_id}).
type RepoUnit struct {
	ID     int64          `json:"id"`
	RepoID int64          `json:"repo_id"`
	Type   Unit           `json:"type"`
	Config map[string]any `json:"config"`
	// DefaultPermissions: "", "read" or "write" (for everyone signed in).
	DefaultPermissions string    `json:"default_permissions"`
	CreatedAt          time.Time `json:"created_at"`
}

// Label is a repository label (group repo:{repo_id}, unit issues|pulls) or
// an organization label (group org:{org_id}).
type Label struct {
	ID              int64      `json:"id"`
	RepoID          int64      `json:"repo_id"`
	OrgID           int64      `json:"org_id"`
	Name            string     `json:"name"`
	Exclusive       bool       `json:"exclusive"`
	Description     string     `json:"description"`
	Color           string     `json:"color"`
	NumIssues       int        `json:"num_issues"`
	NumClosedIssues int        `json:"num_closed_issues"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
	ArchivedAt      *time.Time `json:"archived_at,omitempty"`
}

// Milestone is a repository milestone (group repo:{repo_id}, unit
// issues|pulls).
type Milestone struct {
	ID           int64      `json:"id"`
	RepoID       int64      `json:"repo_id"`
	Title        string     `json:"title"`
	Description  string     `json:"description"`
	State        string     `json:"state"` // "open", "closed"
	OpenIssues   int        `json:"open_issues"`
	ClosedIssues int        `json:"closed_issues"`
	DueOn        *time.Time `json:"due_on,omitempty"`
	ClosedAt     *time.Time `json:"closed_at,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
}

// Project is a project board of a repository (group repo:{repo_id}, unit
// projects), of an organization (group org:{owner_id}) or of a user (group
// profile:{owner_id}).
type Project struct {
	ID           int64      `json:"id"`
	Title        string     `json:"title"`
	Description  string     `json:"description"`
	OwnerID      int64      `json:"owner_id"`
	RepoID       int64      `json:"repo_id"`
	CreatorID    int64      `json:"creator_id"`
	Closed       bool       `json:"closed"`
	TemplateType int        `json:"template_type"`
	CardType     int        `json:"card_type"`
	Type         int        `json:"type"` // 1 individual, 2 repository, 3 organization
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
	ClosedAt     *time.Time `json:"closed_at,omitempty"`
}

// ProjectColumn is a column of a project board (the project's group).
type ProjectColumn struct {
	ID        int64     `json:"id"`
	ProjectID int64     `json:"project_id"`
	Title     string    `json:"title"`
	Default   bool      `json:"default"`
	Sorting   int       `json:"sorting"`
	Color     string    `json:"color"`
	CreatorID int64     `json:"creator_id"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// ProjectIssue places an issue on a project board (group repo:{repo_id} of
// the issue, unit issues or pulls: a user or organization project can hold
// issues of repositories its readers cannot see).
type ProjectIssue struct {
	ID        int64 `json:"id"`
	IssueID   int64 `json:"issue_id"`
	ProjectID int64 `json:"project_id"`
	ColumnID  int64 `json:"column_id"`
	Sorting   int64 `json:"sorting"`
}

// Issue is the summary of an issue or pull request (group repo:{repo_id},
// unit issues or pulls). Its body is the IssueBody entity of issue:{id}.
type Issue struct {
	ID               int64      `json:"id"`
	RepoID           int64      `json:"repo_id"`
	Number           int64      `json:"number"`
	PosterID         int64      `json:"poster_id"`
	OriginalAuthor   string     `json:"original_author"`
	OriginalAuthorID int64      `json:"original_author_id"`
	Title            string     `json:"title"`
	ContentVersion   int        `json:"content_version"`
	MilestoneID      int64      `json:"milestone_id"`
	Priority         int        `json:"priority"`
	State            string     `json:"state"` // "open", "closed"
	IsPull           bool       `json:"is_pull"`
	Comments         int        `json:"comments"`
	Ref              string     `json:"ref"`
	PinOrder         int        `json:"pin_order"`
	IsLocked         bool       `json:"is_locked"`
	DueDate          *time.Time `json:"due_date,omitempty"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
	ClosedAt         *time.Time `json:"closed_at,omitempty"`
}

// IssueBody is the description of an issue or pull request (group
// issue:{id}, same id as the Issue).
type IssueBody struct {
	ID             int64  `json:"id"`
	RepoID         int64  `json:"repo_id"`
	Body           string `json:"body"`
	BodyHTML       string `json:"body_html"`
	ContentVersion int    `json:"content_version"`
}

// IssueLabel puts a label on an issue (the issue's repo:{repo_id} group).
type IssueLabel struct {
	ID      int64 `json:"id"`
	IssueID int64 `json:"issue_id"`
	LabelID int64 `json:"label_id"`
}

// IssueAssignee assigns a user to an issue (the issue's repo:{repo_id}
// group).
type IssueAssignee struct {
	ID         int64 `json:"id"`
	IssueID    int64 `json:"issue_id"`
	AssigneeID int64 `json:"assignee_id"`
}

// PullRequest is the pull-request part of an issue (group
// repo:{base_repo_id}, unit pulls).
type PullRequest struct {
	ID                  int64      `json:"id"`
	IssueID             int64      `json:"issue_id"`
	Number              int64      `json:"number"`
	Status              string     `json:"status"` // "conflict", "checking", "mergeable", "manually_merged", "error", "empty", "ancestor"
	HeadRepoID          int64      `json:"head_repo_id"`
	BaseRepoID          int64      `json:"base_repo_id"`
	HeadBranch          string     `json:"head_branch"`
	BaseBranch          string     `json:"base_branch"`
	MergeBase           string     `json:"merge_base"`
	AllowMaintainerEdit bool       `json:"allow_maintainer_edit"`
	Merged              bool       `json:"merged"`
	MergeCommitSHA      string     `json:"merge_commit_sha"`
	MergerID            int64      `json:"merger_id"`
	MergedAt            *time.Time `json:"merged_at,omitempty"`
	CommitsAhead        int        `json:"commits_ahead"`
	CommitsBehind       int        `json:"commits_behind"`
	ConflictedFiles     []string   `json:"conflicted_files"`
	Flow                int        `json:"flow"` // 0 branches, 1 AGit
}

// AutoMerge schedules a pull request to be merged when its checks pass (the
// pull request's group, unit pulls).
type AutoMerge struct {
	ID                     int64     `json:"id"`
	PullID                 int64     `json:"pull_id"`
	DoerID                 int64     `json:"doer_id"`
	MergeStyle             string    `json:"merge_style"`
	DeleteBranchAfterMerge bool      `json:"delete_branch_after_merge"`
	CreatedAt              time.Time `json:"created_at"`
}

// Branch is a branch and its head commit (group repo:{repo_id}, unit code).
type Branch struct {
	ID            int64      `json:"id"`
	RepoID        int64      `json:"repo_id"`
	Name          string     `json:"name"`
	CommitID      string     `json:"commit_id"`
	CommitMessage string     `json:"commit_message"`
	CommitTime    time.Time  `json:"commit_time"`
	PusherID      int64      `json:"pusher_id"`
	IsDeleted     bool       `json:"is_deleted"`
	DeletedByID   int64      `json:"deleted_by_id"`
	DeletedAt     *time.Time `json:"deleted_at,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

// Release is a release (group repo:{repo_id}, unit releases) or a tag
// without a release (is_tag; unit code, like API v1's /tags). Draft
// releases are in no group (upstream shows them to writers only): they
// appear when published.
type Release struct {
	ID               int64     `json:"id"`
	RepoID           int64     `json:"repo_id"`
	PublisherID      int64     `json:"publisher_id"`
	TagName          string    `json:"tag_name"`
	TargetCommitish  string    `json:"target_commitish"`
	Name             string    `json:"name"`
	SHA              string    `json:"sha"`
	Body             string    `json:"body"`
	BodyHTML         string    `json:"body_html"`
	Draft            bool      `json:"draft"`
	Prerelease       bool      `json:"prerelease"`
	IsTag            bool      `json:"is_tag"`
	NumCommits       int64     `json:"num_commits"`
	HideArchiveLinks bool      `json:"hide_archive_links"`
	OriginalAuthor   string    `json:"original_author"`
	CreatedAt        time.Time `json:"created_at"`
}

// CommitStatus is one status reported for a commit (group repo:{repo_id},
// unit code).
type CommitStatus struct {
	ID          int64     `json:"id"`
	RepoID      int64     `json:"repo_id"`
	Index       int64     `json:"index"`
	State       string    `json:"state"` // "pending", "success", "error", "failure", "warning"
	SHA         string    `json:"sha"`
	TargetURL   string    `json:"target_url"`
	Description string    `json:"description"`
	Context     string    `json:"context"`
	CreatorID   int64     `json:"creator_id"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// ActionRun is a workflow run (group repo:{repo_id}, unit actions).
type ActionRun struct {
	ID                int64      `json:"id"`
	RepoID            int64      `json:"repo_id"`
	OwnerID           int64      `json:"owner_id"`
	Title             string     `json:"title"`
	WorkflowID        string     `json:"workflow_id"`
	RunNumber         int64      `json:"run_number"`
	TriggerUserID     int64      `json:"trigger_user_id"`
	Ref               string     `json:"ref"`
	CommitSHA         string     `json:"commit_sha"`
	Event             string     `json:"event"`
	TriggerEvent      string     `json:"trigger_event"`
	Status            string     `json:"status"`
	IsForkPullRequest bool       `json:"is_fork_pull_request"`
	PullRequestID     int64      `json:"pull_request_id"`
	NeedApproval      bool       `json:"need_approval"`
	ApprovedBy        int64      `json:"approved_by"`
	Started           *time.Time `json:"started,omitempty"`
	Stopped           *time.Time `json:"stopped,omitempty"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
}

// ActionRunJob is a job of a workflow run (group repo:{repo_id}, unit
// actions).
type ActionRunJob struct {
	ID        int64      `json:"id"`
	RunID     int64      `json:"run_id"`
	RepoID    int64      `json:"repo_id"`
	OwnerID   int64      `json:"owner_id"`
	CommitSHA string     `json:"commit_sha"`
	Name      string     `json:"name"`
	Attempt   int64      `json:"attempt"`
	JobID     string     `json:"job_id"`
	Needs     []string   `json:"needs"`
	RunsOn    []string   `json:"runs_on"`
	TaskID    int64      `json:"task_id"`
	Status    string     `json:"status"`
	Started   *time.Time `json:"started,omitempty"`
	Stopped   *time.Time `json:"stopped,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
}

// Notification is an inbox entry of a user (group user:{user_id}, unit
// self).
type Notification struct {
	ID        int64     `json:"id"`
	UserID    int64     `json:"user_id"`
	RepoID    int64     `json:"repo_id"`
	Status    string    `json:"status"`  // "unread", "read", "pinned"
	Source    string    `json:"subject"` // "issue", "pull", "commit", "repository"
	IssueID   int64     `json:"issue_id"`
	CommentID int64     `json:"comment_id"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Stopwatch is a user's running time tracker on an issue (group
// user:{user_id}, unit self).
type Stopwatch struct {
	ID        int64     `json:"id"`
	UserID    int64     `json:"user_id"`
	IssueID   int64     `json:"issue_id"`
	CreatedAt time.Time `json:"created_at"`
}

// IssueWatch is a user's explicit (un)subscription to an issue (group
// user:{user_id}, unit self).
type IssueWatch struct {
	ID         int64     `json:"id"`
	UserID     int64     `json:"user_id"`
	IssueID    int64     `json:"issue_id"`
	IsWatching bool      `json:"is_watching"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// Watch is a user's watch settings for a repository (group user:{user_id},
// unit self).
type Watch struct {
	ID           int64     `json:"id"`
	UserID       int64     `json:"user_id"`
	RepoID       int64     `json:"repo_id"`
	Automatic    bool      `json:"automatic"`
	Issues       bool      `json:"issues"`
	PullRequests bool      `json:"pull_requests"`
	Releases     bool      `json:"releases"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// Star is a user's star on a repository (group user:{user_id}, unit self).
type Star struct {
	ID        int64     `json:"id"`
	UserID    int64     `json:"user_id"`
	RepoID    int64     `json:"repo_id"`
	CreatedAt time.Time `json:"created_at"`
}

// BlockedUser records that user_id blocked block_id (group user:{user_id},
// unit self).
type BlockedUser struct {
	ID        int64     `json:"id"`
	UserID    int64     `json:"user_id"`
	BlockID   int64     `json:"block_id"`
	CreatedAt time.Time `json:"created_at"`
}

// Comment is one timeline entry of an issue or pull request: a comment, a
// code review comment or an event (group issue:{issue_id}, unit issues or
// pulls). Code comments of a pending review are in the reviewer's group
// (user:{reviewer_id}, unit self) until the review is submitted;
// cross-references from another repository are in no group (upstream shows
// them only to readers of that repository's issues or pulls). Type is Forgejo's comment type name ("comment", "close", "label",
// "code", ...); the other fields are set as the type uses them.
type Comment struct {
	ID               int64     `json:"id"`
	IssueID          int64     `json:"issue_id"`
	Type             string    `json:"type"`
	PosterID         int64     `json:"poster_id"`
	OriginalAuthor   string    `json:"original_author"`
	OriginalAuthorID int64     `json:"original_author_id"`
	Body             string    `json:"body"`
	BodyHTML         string    `json:"body_html"`
	ContentVersion   int       `json:"content_version"`
	LabelID          int64     `json:"label_id"`
	OldProjectID     int64     `json:"old_project_id"`
	ProjectID        int64     `json:"project_id"`
	OldMilestoneID   int64     `json:"old_milestone_id"`
	MilestoneID      int64     `json:"milestone_id"`
	TimeID           int64     `json:"time_id"`
	AssigneeID       int64     `json:"assignee_id"`
	AssigneeTeamID   int64     `json:"assignee_team_id"`
	RemovedAssignee  bool      `json:"removed_assignee"`
	ResolveDoerID    int64     `json:"resolve_doer_id"`
	OldTitle         string    `json:"old_title"`
	NewTitle         string    `json:"new_title"`
	OldRef           string    `json:"old_ref"`
	NewRef           string    `json:"new_ref"`
	DependentIssueID int64     `json:"dependent_issue_id"`
	Line             int64     `json:"line"`
	ExtraLinesCount  int64     `json:"extra_lines_count"`
	TreePath         string    `json:"path"`
	Patch            string    `json:"diff_hunk"`
	CommitSHA        string    `json:"commit_id"`
	ReviewID         int64     `json:"review_id"`
	Invalidated      bool      `json:"invalidated"`
	RefRepoID        int64     `json:"ref_repo_id"`
	RefIssueID       int64     `json:"ref_issue_id"`
	RefCommentID     int64     `json:"ref_comment_id"`
	RefAction        int       `json:"ref_action"`
	RefIsPull        bool      `json:"ref_is_pull"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

// Reaction is an emoji reaction on an issue or comment (group
// issue:{issue_id}, or the group of its comment).
type Reaction struct {
	ID             int64     `json:"id"`
	IssueID        int64     `json:"issue_id"`
	CommentID      int64     `json:"comment_id"`
	UserID         int64     `json:"user_id"`
	OriginalAuthor string    `json:"original_author"`
	Content        string    `json:"content"`
	CreatedAt      time.Time `json:"created_at"`
}

// Review is a pull request review or review request (group
// issue:{issue_id}, unit pulls). A pending review is a draft only its
// reviewer sees: group user:{reviewer_id}, unit self, until submitted.
type Review struct {
	ID             int64     `json:"id"`
	IssueID        int64     `json:"issue_id"`
	State          string    `json:"state"` // "PENDING", "APPROVED", "COMMENT", "REQUEST_CHANGES", "REQUEST_REVIEW"
	ReviewerID     int64     `json:"reviewer_id"`
	ReviewerTeamID int64     `json:"reviewer_team_id"`
	OriginalAuthor string    `json:"original_author"`
	Body           string    `json:"body"`
	BodyHTML       string    `json:"body_html"`
	Official       bool      `json:"official"`
	CommitID       string    `json:"commit_id"`
	Stale          bool      `json:"stale"`
	Dismissed      bool      `json:"dismissed"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

// ReviewState holds a user's "viewed files" of a pull request at a commit
// (group user:{user_id}, unit self). Values: 0 unviewed, 1 changed since viewed,
// 2 viewed.
type ReviewState struct {
	ID           int64            `json:"id"`
	UserID       int64            `json:"user_id"`
	PullID       int64            `json:"pull_id"`
	CommitSHA    string           `json:"commit_sha"`
	UpdatedFiles map[string]uint8 `json:"updated_files"`
	UpdatedAt    time.Time        `json:"updated_at"`
}

// Attachment is a file attached to an issue (group issue:{issue_id}), a
// comment (the comment's group) or a release (the release's group: repo:{repo_id},
// unit releases, or none for a draft).
type Attachment struct {
	ID            int64     `json:"id"`
	UUID          string    `json:"uuid"`
	UploaderID    int64     `json:"uploader_id"`
	RepoID        int64     `json:"repo_id"`
	IssueID       int64     `json:"issue_id"`
	ReleaseID     int64     `json:"release_id"`
	CommentID     int64     `json:"comment_id"`
	Name          string    `json:"name"`
	Size          int64     `json:"size"`
	DownloadCount int64     `json:"download_count"`
	ExternalURL   string    `json:"external_url"`
	CreatedAt     time.Time `json:"created_at"`
}

// IssueDependency says issue_id is blocked by dependency_id (group
// issue:{issue_id}).
type IssueDependency struct {
	ID           int64     `json:"id"`
	UserID       int64     `json:"user_id"`
	IssueID      int64     `json:"issue_id"`
	DependencyID int64     `json:"dependency_id"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// TrackedTime is time a user logged on an issue (group issue:{issue_id}).
type TrackedTime struct {
	ID        int64     `json:"id"`
	IssueID   int64     `json:"issue_id"`
	UserID    int64     `json:"user_id"`
	Time      int64     `json:"time"` // seconds
	Deleted   bool      `json:"deleted"`
	CreatedAt time.Time `json:"created"`
}

// ContentHistory is one revision of an issue or comment body (group
// issue:{issue_id}, or the group of its comment). The catalog puts the table
// in the on-demand tier: the sync log carries the revision's metadata only,
// the text itself is fetched on request.
type ContentHistory struct {
	ID             int64     `json:"id"`
	PosterID       int64     `json:"poster_id"`
	IssueID        int64     `json:"issue_id"`
	CommentID      int64     `json:"comment_id"`
	EditedAt       time.Time `json:"edited_at"`
	IsFirstCreated bool      `json:"is_first_created"`
	IsDeleted      bool      `json:"is_deleted"`
}
