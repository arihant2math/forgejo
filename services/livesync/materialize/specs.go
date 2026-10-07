// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"context"
	"fmt"
	"time"

	actions_model "forgejo.org/models/actions"
	activities_model "forgejo.org/models/activities"
	git_model "forgejo.org/models/git"
	issues_model "forgejo.org/models/issues"
	org_model "forgejo.org/models/organization"
	access_model "forgejo.org/models/perm/access"
	project_model "forgejo.org/models/project"
	pull_model "forgejo.org/models/pull"
	repo_model "forgejo.org/models/repo"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/timeutil"
	"forgejo.org/services/livesync/catalog"
	"forgejo.org/services/livesync/protocol"
)

// spec materializes the rows of one tracked table.
type spec struct {
	table string
	// keys are the livesync_entity keys of the entities a row of the table
	// produces: the table itself, plus derived ones ("issue#body").
	keys []string
	// models and schemas are the models of those entities and their
	// schema versions (same order as keys).
	models  []protocol.Model
	schemas []int
	// load loads the rows with the given ids and returns the entities of
	// each existing row (DTOs only when full). Rows that do not exist are
	// absent from the result.
	load func(ctx context.Context, l *loader, ids []int64, full bool) (map[int64][]entity, error)
}

// rowSpec describes a table whose rows map to one entity each.
type rowSpec[T any] struct {
	model  protocol.Model
	schema int
	id     func(*T) int64
	// prepare loads the parents the rows need (optional).
	prepare func(ctx context.Context, l *loader, rows []*T) error
	// place returns the row's group and unit ("" group: none).
	place func(l *loader, r *T) (string, protocol.Unit)
	// dto builds the row's payload.
	dto func(ctx context.Context, l *loader, r *T) (any, error)
}

func (s rowSpec[T]) spec(table string) *spec {
	return &spec{
		table:   table,
		keys:    []string{table},
		models:  []protocol.Model{s.model},
		schemas: []int{s.schema},
		load: func(ctx context.Context, l *loader, ids []int64, full bool) (map[int64][]entity, error) {
			rows, err := findByIDs(ctx, ids, s.id)
			if err != nil {
				return nil, err
			}
			list := make([]*T, 0, len(rows))
			for _, r := range rows {
				list = append(list, r)
			}
			if s.prepare != nil {
				if err := s.prepare(ctx, l, list); err != nil {
					return nil, err
				}
			}
			res := make(map[int64][]entity, len(rows))
			for id, r := range rows {
				e := entity{key: table, model: s.model, schema: s.schema}
				e.group, e.unit = s.place(l, r)
				if full && e.group != "" {
					if e.dto, err = s.dto(ctx, l, r); err != nil {
						e.err = fmt.Errorf("build %s %d: %w", s.model, id, err)
					}
				}
				res[id] = []entity{e}
			}
			return res, nil
		},
	}
}

// ts converts a Forgejo timestamp to a UTC time.
func ts(t timeutil.TimeStamp) time.Time { return time.Unix(int64(t), 0).UTC() }

// optTS is ts for optional timestamps: nil when unset (0).
func optTS(t timeutil.TimeStamp) *time.Time {
	if t <= 0 {
		return nil
	}
	v := ts(t)
	return &v
}

func openClosed(closed bool) string {
	if closed {
		return "closed"
	}
	return "open"
}

// ids collects an id from each row.
func ids[T any](rows []*T, id func(*T) int64) []int64 {
	res := make([]int64, 0, len(rows))
	for _, r := range rows {
		res = append(res, id(r))
	}
	return res
}

// issueChild is the rowSpec prepare step of rows that hang off an issue.
func issueChild[T any](issueID func(*T) int64) func(context.Context, *loader, []*T) error {
	return func(ctx context.Context, l *loader, rows []*T) error {
		return l.loadIssues(ctx, ids(rows, issueID))
	}
}

// specs is the materializer's table registry, keyed by table name. It
// covers exactly the catalog's tracked tables (TestSpecsCoverCatalog).
var specs = func() map[string]*spec {
	list := []*spec{
		repositorySpec(),
		userSpec(),
		rowSpec[org_model.OrgUser]{
			model: protocol.ModelOrgUser, schema: protocol.SchemaOrgUser,
			id: func(r *org_model.OrgUser) int64 { return r.ID },
			place: func(_ *loader, r *org_model.OrgUser) (string, protocol.Unit) {
				return protocol.OrgGroup(r.OrgID), protocol.UnitNone
			},
			dto: func(_ context.Context, _ *loader, r *org_model.OrgUser) (any, error) {
				return &protocol.OrgUser{ID: r.ID, OrgID: r.OrgID, UserID: r.UID, Public: r.IsPublic}, nil
			},
		}.spec("org_user"),
		rowSpec[org_model.Team]{
			model: protocol.ModelTeam, schema: protocol.SchemaTeam,
			id: func(r *org_model.Team) int64 { return r.ID },
			place: func(_ *loader, r *org_model.Team) (string, protocol.Unit) {
				return protocol.OrgGroup(r.OrgID), protocol.UnitNone
			},
			dto: func(_ context.Context, _ *loader, r *org_model.Team) (any, error) {
				return &protocol.Team{
					ID: r.ID, OrgID: r.OrgID, Name: r.Name, Description: r.Description,
					Permission: r.AccessMode.String(), IncludesAllRepositories: r.IncludesAllRepositories,
					CanCreateOrgRepo: r.CanCreateOrgRepo, NumMembers: r.NumMembers, NumRepos: r.NumRepos,
				}, nil
			},
		}.spec("team"),
		rowSpec[org_model.TeamUser]{
			model: protocol.ModelTeamUser, schema: protocol.SchemaTeamUser,
			id: func(r *org_model.TeamUser) int64 { return r.ID },
			place: func(_ *loader, r *org_model.TeamUser) (string, protocol.Unit) {
				return protocol.OrgGroup(r.OrgID), protocol.UnitNone
			},
			dto: func(_ context.Context, _ *loader, r *org_model.TeamUser) (any, error) {
				return &protocol.TeamUser{ID: r.ID, OrgID: r.OrgID, TeamID: r.TeamID, UserID: r.UID}, nil
			},
		}.spec("team_user"),
		rowSpec[org_model.TeamRepo]{
			model: protocol.ModelTeamRepo, schema: protocol.SchemaTeamRepo,
			id: func(r *org_model.TeamRepo) int64 { return r.ID },
			place: func(_ *loader, r *org_model.TeamRepo) (string, protocol.Unit) {
				return protocol.OrgGroup(r.OrgID), protocol.UnitNone
			},
			dto: func(_ context.Context, _ *loader, r *org_model.TeamRepo) (any, error) {
				return &protocol.TeamRepo{ID: r.ID, OrgID: r.OrgID, TeamID: r.TeamID, RepoID: r.RepoID}, nil
			},
		}.spec("team_repo"),
		rowSpec[org_model.TeamUnit]{
			model: protocol.ModelTeamUnit, schema: protocol.SchemaTeamUnit,
			id: func(r *org_model.TeamUnit) int64 { return r.ID },
			place: func(_ *loader, r *org_model.TeamUnit) (string, protocol.Unit) {
				return protocol.OrgGroup(r.OrgID), protocol.UnitNone
			},
			dto: func(_ context.Context, _ *loader, r *org_model.TeamUnit) (any, error) {
				return &protocol.TeamUnit{ID: r.ID, OrgID: r.OrgID, TeamID: r.TeamID, Type: unitName(r.Type), Permission: r.AccessMode.String()}, nil
			},
		}.spec("team_unit"),
		rowSpec[repo_model.Collaboration]{
			model: protocol.ModelCollaboration, schema: protocol.SchemaCollaboration,
			id: func(r *repo_model.Collaboration) int64 { return r.ID },
			place: func(_ *loader, r *repo_model.Collaboration) (string, protocol.Unit) {
				return protocol.RepoGroup(r.RepoID), protocol.UnitNone
			},
			dto: func(_ context.Context, _ *loader, r *repo_model.Collaboration) (any, error) {
				return &protocol.Collaboration{
					ID: r.ID, RepoID: r.RepoID, UserID: r.UserID, Permission: r.Mode.String(),
					CreatedAt: ts(r.CreatedUnix), UpdatedAt: ts(r.UpdatedUnix),
				}, nil
			},
		}.spec("collaboration"),
		rowSpec[access_model.Access]{
			model: protocol.ModelAccess, schema: protocol.SchemaAccess,
			id: func(r *access_model.Access) int64 { return r.ID },
			place: func(_ *loader, r *access_model.Access) (string, protocol.Unit) {
				return protocol.UserGroup(r.UserID), protocol.UnitNone
			},
			dto: func(_ context.Context, _ *loader, r *access_model.Access) (any, error) {
				return &protocol.Access{ID: r.ID, UserID: r.UserID, RepoID: r.RepoID, Permission: r.Mode.String()}, nil
			},
		}.spec("access"),
		repoUnitSpec(),
		rowSpec[issues_model.Label]{
			model: protocol.ModelLabel, schema: protocol.SchemaLabel,
			id: func(r *issues_model.Label) int64 { return r.ID },
			place: func(_ *loader, r *issues_model.Label) (string, protocol.Unit) {
				switch {
				case r.RepoID != 0:
					return protocol.RepoGroup(r.RepoID), protocol.UnitIssuesOrPulls
				case r.OrgID != 0:
					return protocol.OrgGroup(r.OrgID), protocol.UnitNone
				}
				return "", protocol.UnitNone
			},
			dto: func(_ context.Context, _ *loader, r *issues_model.Label) (any, error) {
				return &protocol.Label{
					ID: r.ID, RepoID: r.RepoID, OrgID: r.OrgID, Name: r.Name, Exclusive: r.Exclusive,
					Description: r.Description, Color: r.Color, NumIssues: r.NumIssues, NumClosedIssues: r.NumClosedIssues,
					CreatedAt: ts(r.CreatedUnix), UpdatedAt: ts(r.UpdatedUnix), ArchivedAt: optTS(r.ArchivedUnix),
				}, nil
			},
		}.spec("label"),
		rowSpec[issues_model.Milestone]{
			model: protocol.ModelMilestone, schema: protocol.SchemaMilestone,
			id: func(r *issues_model.Milestone) int64 { return r.ID },
			place: func(_ *loader, r *issues_model.Milestone) (string, protocol.Unit) {
				return protocol.RepoGroup(r.RepoID), protocol.UnitIssuesOrPulls
			},
			dto: func(_ context.Context, _ *loader, r *issues_model.Milestone) (any, error) {
				m := &protocol.Milestone{
					ID: r.ID, RepoID: r.RepoID, Title: r.Name, Description: r.Content, State: openClosed(r.IsClosed),
					OpenIssues: r.NumIssues - r.NumClosedIssues, ClosedIssues: r.NumClosedIssues,
					CreatedAt: ts(r.CreatedUnix), UpdatedAt: ts(r.UpdatedUnix),
				}
				if r.DeadlineUnix.Year() != 9999 { // Forgejo's "no deadline"
					m.DueOn = optTS(r.DeadlineUnix)
				}
				if r.IsClosed {
					m.ClosedAt = optTS(r.ClosedDateUnix)
				}
				return m, nil
			},
		}.spec("milestone"),
		rowSpec[project_model.Project]{
			model: protocol.ModelProject, schema: protocol.SchemaProject,
			id: func(r *project_model.Project) int64 { return r.ID },
			prepare: func(_ context.Context, l *loader, rows []*project_model.Project) error {
				for _, p := range rows {
					l.projects[p.ID] = p
				}
				return nil
			},
			place: func(l *loader, r *project_model.Project) (string, protocol.Unit) { return l.projectPlace(r.ID) },
			dto: func(_ context.Context, _ *loader, r *project_model.Project) (any, error) {
				p := &protocol.Project{
					ID: r.ID, Title: r.Title, Description: r.Description, OwnerID: r.OwnerID, RepoID: r.RepoID,
					CreatorID: r.CreatorID, Closed: r.IsClosed, TemplateType: int(r.TemplateType), CardType: int(r.CardType),
					Type: int(r.Type), CreatedAt: ts(r.CreatedUnix), UpdatedAt: ts(r.UpdatedUnix),
				}
				if r.IsClosed {
					p.ClosedAt = optTS(r.ClosedDateUnix)
				}
				return p, nil
			},
		}.spec("project"),
		rowSpec[project_model.Column]{
			model: protocol.ModelProjectColumn, schema: protocol.SchemaProjectColumn,
			id: func(r *project_model.Column) int64 { return r.ID },
			prepare: func(ctx context.Context, l *loader, rows []*project_model.Column) error {
				return l.loadProjects(ctx, ids(rows, func(r *project_model.Column) int64 { return r.ProjectID }))
			},
			place: func(l *loader, r *project_model.Column) (string, protocol.Unit) { return l.projectPlace(r.ProjectID) },
			dto: func(_ context.Context, _ *loader, r *project_model.Column) (any, error) {
				return &protocol.ProjectColumn{
					ID: r.ID, ProjectID: r.ProjectID, Title: r.Title, Default: r.Default, Sorting: int(r.Sorting),
					Color: r.Color, CreatorID: r.CreatorID, CreatedAt: ts(r.CreatedUnix), UpdatedAt: ts(r.UpdatedUnix),
				}, nil
			},
		}.spec("project_board"),
		rowSpec[project_model.ProjectIssue]{
			model: protocol.ModelProjectIssue, schema: protocol.SchemaProjectIssue,
			id: func(r *project_model.ProjectIssue) int64 { return r.ID },
			prepare: func(ctx context.Context, l *loader, rows []*project_model.ProjectIssue) error {
				return l.loadProjects(ctx, ids(rows, func(r *project_model.ProjectIssue) int64 { return r.ProjectID }))
			},
			place: func(l *loader, r *project_model.ProjectIssue) (string, protocol.Unit) {
				return l.projectPlace(r.ProjectID)
			},
			dto: func(_ context.Context, _ *loader, r *project_model.ProjectIssue) (any, error) {
				return &protocol.ProjectIssue{ID: r.ID, IssueID: r.IssueID, ProjectID: r.ProjectID, ColumnID: r.ProjectColumnID, Sorting: r.Sorting}, nil
			},
		}.spec("project_issue"),
		issueSpec(),
		rowSpec[issues_model.IssueLabel]{
			model: protocol.ModelIssueLabel, schema: protocol.SchemaIssueLabel,
			id:      func(r *issues_model.IssueLabel) int64 { return r.ID },
			prepare: issueChild(func(r *issues_model.IssueLabel) int64 { return r.IssueID }),
			place: func(l *loader, r *issues_model.IssueLabel) (string, protocol.Unit) {
				return l.issueRepoPlace(r.IssueID)
			},
			dto: func(_ context.Context, _ *loader, r *issues_model.IssueLabel) (any, error) {
				return &protocol.IssueLabel{ID: r.ID, IssueID: r.IssueID, LabelID: r.LabelID}, nil
			},
		}.spec("issue_label"),
		rowSpec[issues_model.IssueAssignees]{
			model: protocol.ModelIssueAssignee, schema: protocol.SchemaIssueAssignee,
			id:      func(r *issues_model.IssueAssignees) int64 { return r.ID },
			prepare: issueChild(func(r *issues_model.IssueAssignees) int64 { return r.IssueID }),
			place: func(l *loader, r *issues_model.IssueAssignees) (string, protocol.Unit) {
				return l.issueRepoPlace(r.IssueID)
			},
			dto: func(_ context.Context, _ *loader, r *issues_model.IssueAssignees) (any, error) {
				return &protocol.IssueAssignee{ID: r.ID, IssueID: r.IssueID, AssigneeID: r.AssigneeID}, nil
			},
		}.spec("issue_assignees"),
		rowSpec[issues_model.PullRequest]{
			model: protocol.ModelPullRequest, schema: protocol.SchemaPullRequest,
			id: func(r *issues_model.PullRequest) int64 { return r.ID },
			place: func(_ *loader, r *issues_model.PullRequest) (string, protocol.Unit) {
				return protocol.RepoGroup(r.BaseRepoID), protocol.UnitPulls
			},
			dto: func(_ context.Context, _ *loader, r *issues_model.PullRequest) (any, error) {
				p := &protocol.PullRequest{
					ID: r.ID, IssueID: r.IssueID, Number: r.Index, Status: r.Status.String(),
					HeadRepoID: r.HeadRepoID, BaseRepoID: r.BaseRepoID, HeadBranch: r.HeadBranch, BaseBranch: r.BaseBranch,
					MergeBase: r.MergeBase, AllowMaintainerEdit: r.AllowMaintainerEdit, Merged: r.HasMerged,
					MergeCommitSHA: r.MergedCommitID, MergerID: r.MergerID, CommitsAhead: r.CommitsAhead,
					CommitsBehind: r.CommitsBehind, ConflictedFiles: r.ConflictedFiles, Flow: int(r.Flow),
				}
				if r.HasMerged {
					p.MergedAt = optTS(r.MergedUnix)
				}
				return p, nil
			},
		}.spec("pull_request"),
		rowSpec[pull_model.AutoMerge]{
			model: protocol.ModelAutoMerge, schema: protocol.SchemaAutoMerge,
			id: func(r *pull_model.AutoMerge) int64 { return r.ID },
			prepare: func(ctx context.Context, l *loader, rows []*pull_model.AutoMerge) error {
				return l.loadPulls(ctx, ids(rows, func(r *pull_model.AutoMerge) int64 { return r.PullID }))
			},
			place: func(l *loader, r *pull_model.AutoMerge) (string, protocol.Unit) {
				if pr := l.pulls[r.PullID]; pr != nil {
					return protocol.RepoGroup(pr.BaseRepoID), protocol.UnitPulls
				}
				return "", protocol.UnitNone
			},
			dto: func(_ context.Context, _ *loader, r *pull_model.AutoMerge) (any, error) {
				return &protocol.AutoMerge{
					ID: r.ID, PullID: r.PullID, DoerID: r.DoerID, MergeStyle: string(r.MergeStyle),
					DeleteBranchAfterMerge: r.DeleteBranchAfterMerge, CreatedAt: ts(r.CreatedUnix),
				}, nil
			},
		}.spec("pull_auto_merge"),
		rowSpec[git_model.Branch]{
			model: protocol.ModelBranch, schema: protocol.SchemaBranch,
			id: func(r *git_model.Branch) int64 { return r.ID },
			place: func(_ *loader, r *git_model.Branch) (string, protocol.Unit) {
				return protocol.RepoGroup(r.RepoID), protocol.UnitCode
			},
			dto: func(_ context.Context, _ *loader, r *git_model.Branch) (any, error) {
				b := &protocol.Branch{
					ID: r.ID, RepoID: r.RepoID, Name: r.Name, CommitID: r.CommitID, CommitMessage: r.CommitMessage,
					CommitTime: ts(r.CommitTime), PusherID: r.PusherID, IsDeleted: r.IsDeleted, DeletedByID: r.DeletedByID,
					CreatedAt: ts(r.CreatedUnix), UpdatedAt: ts(r.UpdatedUnix),
				}
				if r.IsDeleted {
					b.DeletedAt = optTS(r.DeletedUnix)
				}
				return b, nil
			},
		}.spec("branch"),
		releaseSpec(),
		rowSpec[git_model.CommitStatus]{
			model: protocol.ModelCommitStatus, schema: protocol.SchemaCommitStatus,
			id: func(r *git_model.CommitStatus) int64 { return r.ID },
			place: func(_ *loader, r *git_model.CommitStatus) (string, protocol.Unit) {
				return protocol.RepoGroup(r.RepoID), protocol.UnitCode
			},
			dto: func(_ context.Context, _ *loader, r *git_model.CommitStatus) (any, error) {
				return &protocol.CommitStatus{
					ID: r.ID, RepoID: r.RepoID, Index: r.Index, State: string(r.State), SHA: r.SHA, TargetURL: r.TargetURL,
					Description: r.Description, Context: r.Context, CreatorID: r.CreatorID,
					CreatedAt: ts(r.CreatedUnix), UpdatedAt: ts(r.UpdatedUnix),
				}, nil
			},
		}.spec("commit_status"),
		rowSpec[actions_model.ActionRun]{
			model: protocol.ModelActionRun, schema: protocol.SchemaActionRun,
			id: func(r *actions_model.ActionRun) int64 { return r.ID },
			place: func(_ *loader, r *actions_model.ActionRun) (string, protocol.Unit) {
				return protocol.RepoGroup(r.RepoID), protocol.UnitActions
			},
			dto: func(_ context.Context, _ *loader, r *actions_model.ActionRun) (any, error) {
				return &protocol.ActionRun{
					ID: r.ID, RepoID: r.RepoID, OwnerID: r.OwnerID, Title: r.Title, WorkflowID: r.WorkflowID,
					RunNumber: r.Index, TriggerUserID: r.TriggerUserID, Ref: r.Ref, CommitSHA: r.CommitSHA,
					Event: string(r.Event), TriggerEvent: r.TriggerEvent, Status: r.Status.String(),
					IsForkPullRequest: r.IsForkPullRequest, PullRequestID: r.PullRequestID,
					NeedApproval: r.NeedApproval, ApprovedBy: r.ApprovedBy,
					Started: optTS(r.Started), Stopped: optTS(r.Stopped), CreatedAt: ts(r.Created), UpdatedAt: ts(r.Updated),
				}, nil
			},
		}.spec("action_run"),
		rowSpec[actions_model.ActionRunJob]{
			model: protocol.ModelActionRunJob, schema: protocol.SchemaActionRunJob,
			id: func(r *actions_model.ActionRunJob) int64 { return r.ID },
			place: func(_ *loader, r *actions_model.ActionRunJob) (string, protocol.Unit) {
				return protocol.RepoGroup(r.RepoID), protocol.UnitActions
			},
			dto: func(_ context.Context, _ *loader, r *actions_model.ActionRunJob) (any, error) {
				needs := make([]string, 0, len(r.Needs))
				for _, n := range r.Needs {
					needs = append(needs, string(n))
				}
				return &protocol.ActionRunJob{
					ID: r.ID, RunID: r.RunID, RepoID: r.RepoID, OwnerID: r.OwnerID, CommitSHA: r.CommitSHA, Name: r.Name,
					Attempt: r.Attempt, JobID: string(r.JobID), Needs: needs, RunsOn: r.RunsOn, TaskID: r.TaskID,
					Status: r.Status.String(), Started: optTS(r.Started), Stopped: optTS(r.Stopped),
					CreatedAt: ts(r.Created), UpdatedAt: ts(r.Updated),
				}, nil
			},
		}.spec("action_run_job"),
		rowSpec[activities_model.Notification]{
			model: protocol.ModelNotification, schema: protocol.SchemaNotification,
			id: func(r *activities_model.Notification) int64 { return r.ID },
			place: func(_ *loader, r *activities_model.Notification) (string, protocol.Unit) {
				return protocol.UserGroup(r.UserID), protocol.UnitNone
			},
			dto: func(_ context.Context, _ *loader, r *activities_model.Notification) (any, error) {
				return &protocol.Notification{
					ID: r.ID, UserID: r.UserID, RepoID: r.RepoID, Status: notificationStatus(r.Status),
					Source: notificationSource(r.Source), IssueID: r.IssueID, CommentID: r.CommentID,
					CreatedAt: ts(r.CreatedUnix), UpdatedAt: ts(r.UpdatedUnix),
				}, nil
			},
		}.spec("notification"),
		rowSpec[issues_model.Stopwatch]{
			model: protocol.ModelStopwatch, schema: protocol.SchemaStopwatch,
			id: func(r *issues_model.Stopwatch) int64 { return r.ID },
			place: func(_ *loader, r *issues_model.Stopwatch) (string, protocol.Unit) {
				return protocol.UserGroup(r.UserID), protocol.UnitNone
			},
			dto: func(_ context.Context, _ *loader, r *issues_model.Stopwatch) (any, error) {
				return &protocol.Stopwatch{ID: r.ID, UserID: r.UserID, IssueID: r.IssueID, CreatedAt: ts(r.CreatedUnix)}, nil
			},
		}.spec("stopwatch"),
		rowSpec[issues_model.IssueWatch]{
			model: protocol.ModelIssueWatch, schema: protocol.SchemaIssueWatch,
			id: func(r *issues_model.IssueWatch) int64 { return r.ID },
			place: func(_ *loader, r *issues_model.IssueWatch) (string, protocol.Unit) {
				return protocol.UserGroup(r.UserID), protocol.UnitNone
			},
			dto: func(_ context.Context, _ *loader, r *issues_model.IssueWatch) (any, error) {
				return &protocol.IssueWatch{
					ID: r.ID, UserID: r.UserID, IssueID: r.IssueID, IsWatching: r.IsWatching,
					CreatedAt: ts(r.CreatedUnix), UpdatedAt: ts(r.UpdatedUnix),
				}, nil
			},
		}.spec("issue_watch"),
		rowSpec[repo_model.Watch]{
			model: protocol.ModelWatch, schema: protocol.SchemaWatch,
			id: func(r *repo_model.Watch) int64 { return r.ID },
			place: func(_ *loader, r *repo_model.Watch) (string, protocol.Unit) {
				return protocol.UserGroup(r.UserID), protocol.UnitNone
			},
			dto: func(_ context.Context, _ *loader, r *repo_model.Watch) (any, error) {
				return &protocol.Watch{
					ID: r.ID, UserID: r.UserID, RepoID: r.RepoID, Automatic: bool(r.Source),
					Issues: r.WatchSelectionIssues, PullRequests: r.WatchSelectionPullRequests, Releases: r.WatchSelectionReleases,
					CreatedAt: ts(r.CreatedUnix), UpdatedAt: ts(r.UpdatedUnix),
				}, nil
			},
		}.spec("watch"),
		rowSpec[repo_model.Star]{
			model: protocol.ModelStar, schema: protocol.SchemaStar,
			id: func(r *repo_model.Star) int64 { return r.ID },
			place: func(_ *loader, r *repo_model.Star) (string, protocol.Unit) {
				return protocol.UserGroup(r.UID), protocol.UnitNone
			},
			dto: func(_ context.Context, _ *loader, r *repo_model.Star) (any, error) {
				return &protocol.Star{ID: r.ID, UserID: r.UID, RepoID: r.RepoID, CreatedAt: ts(r.CreatedUnix)}, nil
			},
		}.spec("star"),
		rowSpec[user_model.BlockedUser]{
			model: protocol.ModelBlockedUser, schema: protocol.SchemaBlockedUser,
			id: func(r *user_model.BlockedUser) int64 { return r.ID },
			place: func(_ *loader, r *user_model.BlockedUser) (string, protocol.Unit) {
				return protocol.UserGroup(r.UserID), protocol.UnitNone
			},
			dto: func(_ context.Context, _ *loader, r *user_model.BlockedUser) (any, error) {
				return &protocol.BlockedUser{ID: r.ID, UserID: r.UserID, BlockID: r.BlockID, CreatedAt: ts(r.CreatedUnix)}, nil
			},
		}.spec("forgejo_blocked_user"),
		commentSpec(),
		rowSpec[issues_model.Reaction]{
			model: protocol.ModelReaction, schema: protocol.SchemaReaction,
			id:      func(r *issues_model.Reaction) int64 { return r.ID },
			prepare: issueChild(func(r *issues_model.Reaction) int64 { return r.IssueID }),
			place:   func(l *loader, r *issues_model.Reaction) (string, protocol.Unit) { return l.issuePlace(r.IssueID) },
			dto: func(_ context.Context, _ *loader, r *issues_model.Reaction) (any, error) {
				return &protocol.Reaction{
					ID: r.ID, IssueID: r.IssueID, CommentID: r.CommentID, UserID: r.UserID,
					OriginalAuthor: r.OriginalAuthor, Content: r.Type, CreatedAt: ts(r.CreatedUnix),
				}, nil
			},
		}.spec("reaction"),
		reviewSpec(),
		rowSpec[pull_model.ReviewState]{
			model: protocol.ModelReviewState, schema: protocol.SchemaReviewState,
			id: func(r *pull_model.ReviewState) int64 { return r.ID },
			place: func(_ *loader, r *pull_model.ReviewState) (string, protocol.Unit) {
				return protocol.UserGroup(r.UserID), protocol.UnitNone
			},
			dto: func(_ context.Context, _ *loader, r *pull_model.ReviewState) (any, error) {
				files := make(map[string]uint8, len(r.UpdatedFiles))
				for path, state := range r.UpdatedFiles {
					files[path] = uint8(state)
				}
				return &protocol.ReviewState{
					ID: r.ID, UserID: r.UserID, PullID: r.PullID, CommitSHA: r.CommitSHA,
					UpdatedFiles: files, UpdatedAt: ts(r.UpdatedUnix),
				}, nil
			},
		}.spec("review_state"),
		rowSpec[repo_model.Attachment]{
			model: protocol.ModelAttachment, schema: protocol.SchemaAttachment,
			id:      func(r *repo_model.Attachment) int64 { return r.ID },
			prepare: issueChild(func(r *repo_model.Attachment) int64 { return r.IssueID }),
			place: func(l *loader, r *repo_model.Attachment) (string, protocol.Unit) {
				switch {
				case r.IssueID != 0:
					return l.issuePlace(r.IssueID)
				case r.ReleaseID != 0:
					return protocol.RepoGroup(r.RepoID), protocol.UnitReleases
				}
				return "", protocol.UnitNone // uploaded, not attached yet
			},
			dto: func(_ context.Context, _ *loader, r *repo_model.Attachment) (any, error) {
				return &protocol.Attachment{
					ID: r.ID, UUID: r.UUID, UploaderID: r.UploaderID, RepoID: r.RepoID, IssueID: r.IssueID,
					ReleaseID: r.ReleaseID, CommentID: r.CommentID, Name: r.Name, Size: r.Size,
					DownloadCount: r.DownloadCount, ExternalURL: r.ExternalURL, CreatedAt: ts(r.CreatedUnix),
				}, nil
			},
		}.spec("attachment"),
		rowSpec[issues_model.IssueDependency]{
			model: protocol.ModelIssueDependency, schema: protocol.SchemaIssueDependency,
			id:      func(r *issues_model.IssueDependency) int64 { return r.ID },
			prepare: issueChild(func(r *issues_model.IssueDependency) int64 { return r.IssueID }),
			place: func(l *loader, r *issues_model.IssueDependency) (string, protocol.Unit) {
				return l.issuePlace(r.IssueID)
			},
			dto: func(_ context.Context, _ *loader, r *issues_model.IssueDependency) (any, error) {
				return &protocol.IssueDependency{
					ID: r.ID, UserID: r.UserID, IssueID: r.IssueID, DependencyID: r.DependencyID,
					CreatedAt: ts(r.CreatedUnix), UpdatedAt: ts(r.UpdatedUnix),
				}, nil
			},
		}.spec("issue_dependency"),
		rowSpec[issues_model.TrackedTime]{
			model: protocol.ModelTrackedTime, schema: protocol.SchemaTrackedTime,
			id:      func(r *issues_model.TrackedTime) int64 { return r.ID },
			prepare: issueChild(func(r *issues_model.TrackedTime) int64 { return r.IssueID }),
			place:   func(l *loader, r *issues_model.TrackedTime) (string, protocol.Unit) { return l.issuePlace(r.IssueID) },
			dto: func(_ context.Context, _ *loader, r *issues_model.TrackedTime) (any, error) {
				return &protocol.TrackedTime{
					ID: r.ID, IssueID: r.IssueID, UserID: r.UserID, Time: r.Time, Deleted: r.Deleted,
					CreatedAt: ts(timeutil.TimeStamp(r.CreatedUnix)),
				}, nil
			},
		}.spec("tracked_time"),
		rowSpec[issues_model.ContentHistory]{
			model: protocol.ModelContentHistory, schema: protocol.SchemaContentHistory,
			id:      func(r *issues_model.ContentHistory) int64 { return r.ID },
			prepare: issueChild(func(r *issues_model.ContentHistory) int64 { return r.IssueID }),
			place: func(l *loader, r *issues_model.ContentHistory) (string, protocol.Unit) {
				return l.issuePlace(r.IssueID)
			},
			dto: func(_ context.Context, _ *loader, r *issues_model.ContentHistory) (any, error) {
				return &protocol.ContentHistory{
					ID: r.ID, PosterID: r.PosterID, IssueID: r.IssueID, CommentID: r.CommentID, EditedAt: ts(r.EditedUnix),
					ContentText: r.ContentText, IsFirstCreated: r.IsFirstCreated, IsDeleted: r.IsDeleted,
				}, nil
			},
		}.spec("issue_content_history"),
	}
	m := make(map[string]*spec, len(list))
	for _, s := range list {
		m[s.table] = s
	}
	return m
}()

// hotTables are the catalog's hot tables (coalesced across batches).
var hotTables = func() map[string]bool {
	m := map[string]bool{}
	for _, t := range catalog.Tracked() {
		if t.Hot {
			m[t.Name] = true
		}
	}
	return m
}()
