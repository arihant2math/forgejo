// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Package catalog is livesync's table catalog (PLAN §4.3): which upstream
// tables are captured by database triggers, which model and tier each one
// maps to, and which tables are deliberately ignored.
//
// Every table Forgejo registers (db.RegisterModel) must be listed either as
// tracked or as ignored; services/livesync.CheckCatalog enforces it at start
// (warning) and the TestLivesyncCatalogContract integration test enforces it
// in CI (failure), so a table added upstream is a conscious decision.
//
// The package is pure data and logic: it has no database access.
package catalog

import (
	"slices"
	"sort"
)

// Tier says when clients load a table's entities (PLAN §4.4, §4.7).
type Tier int

const (
	// TierSummary tables are part of the structure/summary bootstrap of
	// their group (user:, org:, repo:).
	TierSummary Tier = iota
	// TierLazy tables belong to the per-issue group issue:{id}, loaded when
	// an issue is opened.
	TierLazy
	// TierOnDemand tables are captured like lazy ones but only fetched on
	// explicit request (e.g. issue_content_history).
	TierOnDemand
)

// Table describes one tracked table.
type Table struct {
	// Name is the SQL table name.
	Name string
	// Model is the protocol model name written to livesync_log.model.
	Model string
	// Tier is the load tier of the table's entities.
	Tier Tier
	// Hot tables receive bursts of writes (notifications, statuses, job
	// state); the materializer coalesces them more aggressively.
	Hot bool
	// PermColumns are the columns of a permission table (one that decides
	// who may read what) that its rows' permission state depends on
	// (services/livesync/materialize/perm.go; TestPermColumns there checks
	// that the two agree). The update trigger compares them and writes
	// livesync_model.OpPermUpdate instead of OpUpdate when one changed, so
	// that an update undone before the materializer reads the row still
	// tells it that the permission state changed in between. Empty for the
	// other tables.
	PermColumns []string
}

// tracked is the list of captured tables. Every tracked table must have an
// auto-increment primary key named id: the triggers reference only that
// column, plus the permission columns of permission tables
// (services/livesync.CheckCatalog verifies that they exist).
var tracked = []Table{
	// Structure/summary tier.
	{Name: "repository", Model: "Repository", PermColumns: []string{"owner_id", "is_private"}},
	{Name: "user", Model: "User", PermColumns: []string{"type", "visibility", "is_active", "prohibit_login", "is_admin", "is_restricted"}},
	{Name: "org_user", Model: "OrgUser", PermColumns: []string{"uid", "org_id"}},
	{Name: "team", Model: "Team", PermColumns: []string{"authorize", "includes_all_repositories"}},
	{Name: "team_user", Model: "TeamUser", PermColumns: []string{"uid", "team_id"}},
	{Name: "team_repo", Model: "TeamRepo", PermColumns: []string{"team_id", "repo_id"}},
	{Name: "team_unit", Model: "TeamUnit", PermColumns: []string{"team_id", "type", "access_mode"}},
	{Name: "collaboration", Model: "Collaboration", PermColumns: []string{"user_id", "repo_id", "mode"}},
	{Name: "access", Model: "Access", PermColumns: []string{"user_id", "repo_id", "mode"}},
	{Name: "repo_unit", Model: "RepoUnit", PermColumns: []string{"repo_id", "type", "default_permissions"}},
	{Name: "label", Model: "Label"},
	{Name: "milestone", Model: "Milestone"},
	{Name: "project", Model: "Project"},
	{Name: "project_board", Model: "ProjectColumn"},
	{Name: "project_issue", Model: "ProjectIssue"},
	{Name: "issue", Model: "Issue"},
	{Name: "issue_label", Model: "IssueLabel"},
	{Name: "issue_assignees", Model: "IssueAssignee"},
	{Name: "pull_request", Model: "PullRequest"},
	{Name: "pull_auto_merge", Model: "AutoMerge"},
	{Name: "branch", Model: "Branch"},
	{Name: "release", Model: "Release"},
	{Name: "commit_status", Model: "CommitStatus", Hot: true},
	{Name: "action_run", Model: "ActionRun"},
	{Name: "action_run_job", Model: "ActionRunJob", Hot: true},
	{Name: "notification", Model: "Notification", Hot: true},
	{Name: "stopwatch", Model: "Stopwatch"},
	{Name: "issue_watch", Model: "IssueWatch"},
	{Name: "watch", Model: "Watch"},
	{Name: "star", Model: "Star"},
	{Name: "forgejo_blocked_user", Model: "BlockedUser", PermColumns: []string{"user_id", "block_id"}},

	// Lazy tier (per-issue group).
	{Name: "comment", Model: "Comment", Tier: TierLazy},
	{Name: "reaction", Model: "Reaction", Tier: TierLazy},
	{Name: "review", Model: "Review", Tier: TierLazy},
	{Name: "review_state", Model: "ReviewState", Tier: TierLazy},
	{Name: "attachment", Model: "Attachment", Tier: TierLazy},
	{Name: "issue_dependency", Model: "IssueDependency", Tier: TierLazy},
	{Name: "tracked_time", Model: "TrackedTime", Tier: TierLazy},
	{Name: "issue_content_history", Model: "ContentHistory", Tier: TierOnDemand},
}

// ignored lists the registered upstream tables livesync deliberately does not
// capture, grouped by reason. Adding a table here is a decision: it means
// clients never see changes to it through the sync engine.
var ignored = []string{
	// Credentials, secrets and authentication state: never synced.
	"access_token", "access_token_resource_repo", "authorized_integration",
	"authorized_integ_resource_repo", "external_login_user", "forgejo_auth_token",
	"gpg_key", "gpg_key_import", "login_source", "oauth2_application",
	"oauth2_authorization_code", "oauth2_grant", "public_key", "deploy_key",
	"secret", "session", "two_factor", "user_open_id", "webauthn_credential",
	"action_runner_token", "action_variable", "email_address", "email_hash",

	// Actions internals (runs and jobs are tracked; their tasks, steps,
	// runners, schedules and artifacts are not in Phase 1 scope).
	"action", "action_artifact", "action_run_index", "action_runner",
	"action_schedule", "action_schedule_spec", "action_task", "action_task_output",
	"action_task_step", "action_task_step_summary", "action_tasks_version",
	"action_user",

	// Counters, indexes and caches derived from tracked tables.
	"commit_status_index", "commit_status_summary", "issue_index", "issue_user",
	"language_stat", "repo_indexer_status", "repo_archive_download_count",

	// Federation.
	"federated_user", "federated_user_activity", "federated_user_follower",
	"federation_host", "following_repo",

	// Packages, LFS, storage.
	"package", "package_blob", "package_blob_upload", "package_cleanup_rule",
	"package_file", "package_property", "package_version", "lfs_lock",
	"lfs_meta_object", "dbfs_data", "dbfs_meta", "upload", "repo_archiver",

	// Repository settings and administration (classic UI only for now).
	"mirror", "push_mirror", "protected_branch", "protected_tag", "renamed_branch",
	"repo_redirect", "repo_topic", "topic", "repo_transfer", "forgejo_repo_flag",
	"webhook", "hook_task", "task",

	// Users, orgs and site administration.
	"badge", "user_badge", "follow", "user_redirect", "user_setting", "team_invite",
	"system_setting", "notice", "app_state", "forgejo_sem_ver", "abuse_report",
	"abuse_report_shadow_copy", "quota_group", "quota_group_mapping",
	"quota_group_rule_mapping", "quota_rule",
}

var (
	trackedByName = func() map[string]Table {
		m := make(map[string]Table, len(tracked))
		for _, t := range tracked {
			m[t.Name] = t
		}
		return m
	}()
	ignoredSet = func() map[string]bool {
		m := make(map[string]bool, len(ignored))
		for _, name := range ignored {
			m[name] = true
		}
		return m
	}()
)

// Lookup returns the tracked table with the given name.
func Lookup(name string) (Table, bool) {
	t, ok := trackedByName[name]
	return t, ok
}

// Tracked returns the tracked tables, sorted by name. The slice is a copy
// (their PermColumns are shared: do not modify them).
func Tracked() []Table {
	ts := slices.Clone(tracked)
	sort.Slice(ts, func(i, j int) bool { return ts[i].Name < ts[j].Name })
	return ts
}

// Classify compares the catalog with the tables Forgejo registers. It returns
// the registered tables that are neither tracked nor ignored (unclassified)
// and the catalogued tables, tracked or ignored, that are not registered any
// more (vanished, e.g. dropped by an upstream migration). Both are sorted.
func Classify(registered []string) (unclassified, vanished []string) {
	seen := make(map[string]bool, len(registered))
	for _, name := range registered {
		seen[name] = true
		if _, ok := trackedByName[name]; !ok && !ignoredSet[name] {
			unclassified = append(unclassified, name)
		}
	}
	for _, t := range tracked {
		if !seen[t.Name] {
			vanished = append(vanished, t.Name)
		}
	}
	for _, name := range ignored {
		if !seen[name] {
			vanished = append(vanished, name)
		}
	}
	sort.Strings(unclassified)
	sort.Strings(vanished)
	return unclassified, vanished
}
