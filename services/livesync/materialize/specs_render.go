// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"context"
	"strings"

	activities_model "forgejo.org/models/activities"
	"forgejo.org/models/avatars"
	issues_model "forgejo.org/models/issues"
	repo_model "forgejo.org/models/repo"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/json"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/structs"
	"forgejo.org/services/livesync/perm"
	"forgejo.org/services/livesync/protocol"
)

// The specs of rows that need more than a field copy: markdown rendering,
// avatar links, derived entities.

func repositorySpec() *spec {
	return rowSpec[repo_model.Repository]{
		model: protocol.ModelRepository, schema: protocol.SchemaRepository,
		id: func(r *repo_model.Repository) int64 { return r.ID },
		place: func(_ *loader, r *repo_model.Repository) (string, protocol.Unit) {
			return protocol.RepoGroup(r.ID), protocol.UnitNone
		},
		dto: func(ctx context.Context, _ *loader, r *repo_model.Repository) (any, error) {
			topics := r.Topics
			if topics == nil {
				topics = []string{}
			}
			res := &protocol.Repository{
				ID: r.ID, OwnerID: r.OwnerID, OwnerName: r.OwnerName, Name: r.Name, FullName: r.FullName(),
				Description: r.Description, Website: r.Website, Private: r.IsPrivate, Fork: r.IsFork, ParentID: r.ForkID,
				Template: r.IsTemplate, Mirror: r.IsMirror, Archived: r.IsArchived, Empty: r.IsEmpty,
				DefaultBranch: r.DefaultBranch, StarsCount: r.NumStars, ForksCount: r.NumForks,
				WatchersCount: r.NumWatches, Topics: topics, ObjectFormatName: r.ObjectFormatName,
				AvatarURL: repoAvatarLink(ctx, r), CreatedAt: ts(r.CreatedUnix), UpdatedAt: ts(r.UpdatedUnix),
			}
			if r.IsArchived {
				res.ArchivedAt = optTS(r.ArchivedUnix)
			}
			return res, nil
		},
		// Visibility and owner decide who may read the repository; the
		// owner's grants list the repositories they own.
		perm: func(r *repo_model.Repository) string {
			return permState(fingerprint(r.IsPrivate, r.OwnerID), subject('r', r.ID), subject('u', r.OwnerID))
		},
	}.spec("repository")
}

func userSpec() *spec {
	return rowSpec[user_model.User]{
		model: protocol.ModelUser, schema: protocol.SchemaUser,
		id:    func(r *user_model.User) int64 { return r.ID },
		place: func(_ *loader, r *user_model.User) (string, protocol.Unit) { return userPlace(r) },
		dto: func(ctx context.Context, _ *loader, r *user_model.User) (any, error) {
			res := &protocol.User{
				ID: r.ID, Login: r.Name, FullName: r.FullName, AvatarURL: userAvatarLink(ctx, r), Type: userType(r.Type),
				Visibility: r.Visibility.String(), Description: r.Description, Website: r.Website,
				Location: r.Location, CreatedAt: ts(r.CreatedUnix),
			}
			if !r.KeepPronounsPrivate {
				res.Pronouns = r.Pronouns
			}
			return res, nil
		},
		// The user's own grants depend on these columns (a viewer who may
		// not sign in gets nothing, a restricted one less, …), and the
		// visibility decides who may see the user's or organization's
		// profile and repositories (organization.HasOrgOrUserVisible in
		// GetUserRepoPermission).
		perm: func(r *user_model.User) string {
			return permState(fingerprint(int(r.Visibility), r.IsActive, r.ProhibitLogin, r.IsAdmin, r.IsRestricted, int(r.Type)),
				subject('u', r.ID), subject('O', r.ID))
		},
	}.spec("user")
}

// userPlace is the group of a user's or organization's profile (the User
// entity, unit none): the organization's group, the shared profile
// directory of the user's visibility, or the private user's profile group.
// Changing the visibility moves the entity (a delete in the old directory,
// an upsert in the new place).
func userPlace(u *user_model.User) (string, protocol.Unit) {
	switch {
	case u.IsOrganization():
		return protocol.OrgGroup(u.ID), protocol.UnitNone
	case u.Visibility == structs.VisibleTypePublic:
		return protocol.GroupProfilesPublic, protocol.UnitNone
	case u.Visibility == structs.VisibleTypeLimited:
		return protocol.GroupProfilesLimited, protocol.UnitNone
	}
	return protocol.ProfileGroup(u.ID), protocol.UnitNone
}

// userAvatarLink is User.AvatarLink without its side effects. Upstream
// computes the link of a user without an avatar in local-avatar mode
// (OFFLINE_MODE, the default, or DISABLE_GRAVATAR) by generating a random
// PNG, saving it to avatar storage and updating the user row, and with
// federated avatars it records the email hash in the database: neither may
// happen inside the materializer's transaction (blocking storage I/O, a row
// lock on a hot upstream table, and a captured write that would materialize
// the user again). In those cases the DTO carries the user's fast avatar
// link (/user/avatar/{name}/0), which redirects to the real avatar and does
// that work in the web request that follows it, outside livesync.
func userAvatarLink(ctx context.Context, u *user_model.User) string {
	if u.IsGhost() || u.ID <= 0 || u.UseCustomAvatar {
		return u.AvatarLink(ctx) // no side effects on these paths
	}
	local := setting.OfflineMode || setting.Config().Picture.DisableGravatar.Value(ctx)
	switch {
	case local && u.Avatar != "":
		return u.AvatarLink(ctx)
	case local, setting.Config().Picture.EnableFederatedAvatar.Value(ctx):
		return setting.AppURL + strings.TrimPrefix(avatars.GenerateUserAvatarFastLink(u.Name, 0), setting.AppSubURL+"/")
	}
	return u.AvatarLink(ctx) // Gravatar: a URL computed from the email hash
}

// repoAvatarLink is Repository.AvatarLink without its side effect: with
// [repository] AVATAR_FALLBACK = random, upstream generates and stores a
// random avatar (and updates the repository row) for a repository without
// one. Such a repository has no avatar link here until it gets one.
func repoAvatarLink(ctx context.Context, r *repo_model.Repository) string {
	if r.Avatar == "" && setting.RepoAvatar.Fallback == "random" {
		return ""
	}
	return r.AvatarLink(ctx)
}

func userType(t user_model.UserType) string {
	switch t {
	case user_model.UserTypeIndividual:
		return "user"
	case user_model.UserTypeOrganization:
		return "organization"
	case user_model.UserTypeBot:
		return "bot"
	case user_model.UserTypeRemoteUser:
		return "remote"
	}
	return "reserved"
}

func repoUnitSpec() *spec {
	return rowSpec[repo_model.RepoUnit]{
		model: protocol.ModelRepoUnit, schema: protocol.SchemaRepoUnit,
		id: func(r *repo_model.RepoUnit) int64 { return r.ID },
		place: func(_ *loader, r *repo_model.RepoUnit) (string, protocol.Unit) {
			return protocol.RepoGroup(r.RepoID), protocol.UnitNone
		},
		dto: func(_ context.Context, _ *loader, r *repo_model.RepoUnit) (any, error) {
			config := map[string]any{}
			if r.Config != nil {
				b, err := r.Config.ToDB()
				if err != nil {
					return nil, err
				}
				if len(b) > 0 {
					if err := json.Unmarshal(b, &config); err != nil {
						return nil, err
					}
				}
			}
			res := &protocol.RepoUnit{ID: r.ID, RepoID: r.RepoID, Type: perm.UnitOf(r.Type), Config: config, CreatedAt: ts(r.CreatedUnix)}
			if r.DefaultPermissions == repo_model.UnitAccessModeWrite {
				res.DefaultPermissions = "write"
			}
			return res, nil
		},
		// Enabled units and their default permissions decide what readers
		// of the repository may read.
		perm: func(r *repo_model.RepoUnit) string {
			return permState(fingerprint(r.RepoID, int(r.Type), int(r.DefaultPermissions)), subject('r', r.RepoID))
		},
	}.spec("repo_unit")
}

// issueBodyKey is the livesync_entity key of the IssueBody derived from an
// issue row.
const issueBodyKey = "issue#body"

// issueSpec produces two entities per issue row: the Issue summary in
// repo:{repo_id} and its IssueBody in issue:{id}.
func issueSpec() *spec {
	return &spec{
		table:   "issue",
		keys:    []string{"issue", issueBodyKey},
		models:  []protocol.Model{protocol.ModelIssue, protocol.ModelIssueBody},
		schemas: []int{protocol.SchemaIssue, protocol.SchemaIssueBody},
		load: func(ctx context.Context, l *loader, idList []int64, full bool) (map[int64][]entity, error) {
			if err := l.loadIssues(ctx, idList); err != nil {
				return nil, err
			}
			res := map[int64][]entity{}
			var repoIDs []int64
			for _, id := range idList {
				if issue := l.issues[id]; issue != nil {
					repoIDs = append(repoIDs, issue.RepoID)
				}
			}
			if full {
				if err := l.loadRepos(ctx, repoIDs); err != nil {
					return nil, err
				}
			}
			for _, id := range idList {
				issue := l.issues[id]
				if issue == nil {
					continue
				}
				unit := issueUnit(issue)
				summary := entity{key: "issue", model: protocol.ModelIssue, schema: protocol.SchemaIssue, group: protocol.RepoGroup(issue.RepoID), unit: unit}
				body := entity{key: issueBodyKey, model: protocol.ModelIssueBody, schema: protocol.SchemaIssueBody, group: protocol.IssueGroup(issue.ID), unit: unit}
				if full {
					summary.dto = issueDTO(issue)
					dto := &protocol.IssueBody{ID: issue.ID, RepoID: issue.RepoID, Body: issue.Content, ContentVersion: issue.ContentVersion}
					l.markdown(l.repos[issue.RepoID], issue.Content, &dto.BodyHTML)
					body.dto, body.renders = dto, l.takeRenders()
				}
				res[id] = []entity{summary, body}
			}
			return res, nil
		},
	}
}

func issueDTO(r *issues_model.Issue) *protocol.Issue {
	res := &protocol.Issue{
		ID: r.ID, RepoID: r.RepoID, Number: r.Index, PosterID: r.PosterID, OriginalAuthor: r.OriginalAuthor,
		OriginalAuthorID: r.OriginalAuthorID, Title: r.Title, ContentVersion: r.ContentVersion,
		MilestoneID: r.MilestoneID, Priority: r.Priority, State: openClosed(r.IsClosed), IsPull: r.IsPull,
		Comments: r.NumComments, Ref: r.Ref, PinOrder: r.PinOrder, IsLocked: r.IsLocked,
		DueDate: optTS(r.DeadlineUnix), CreatedAt: ts(r.CreatedUnix), UpdatedAt: ts(r.UpdatedUnix),
	}
	if r.IsClosed {
		res.ClosedAt = optTS(r.ClosedUnix)
	}
	return res
}

// issueRepos loads the issues of rows and, for markdown rendering, their
// repositories.
func issueRepos(ctx context.Context, l *loader, issueIDs []int64) error {
	if err := l.loadIssues(ctx, issueIDs); err != nil {
		return err
	}
	var repoIDs []int64
	for _, id := range issueIDs {
		if issue := l.issues[id]; issue != nil {
			repoIDs = append(repoIDs, issue.RepoID)
		}
	}
	return l.loadRepos(ctx, repoIDs)
}

// issueRepo is the repository of an issue (nil if unknown).
func (l *loader) issueRepo(issueID int64) *repo_model.Repository {
	if issue := l.issues[issueID]; issue != nil {
		return l.repos[issue.RepoID]
	}
	return nil
}

func commentSpec() *spec {
	return rowSpec[issues_model.Comment]{
		model: protocol.ModelComment, schema: protocol.SchemaComment,
		id: func(r *issues_model.Comment) int64 { return r.ID },
		prepare: func(ctx context.Context, l *loader, rows []*issues_model.Comment) error {
			if err := l.loadCommentParents(ctx, rows); err != nil {
				return err
			}
			return issueRepos(ctx, l, ids(rows, func(r *issues_model.Comment) int64 { return r.IssueID }))
		},
		place: func(l *loader, r *issues_model.Comment) (string, protocol.Unit) { return l.commentPlace(r) },
		dependents: []dependent{
			{"attachment", "comment_id"}, {"reaction", "comment_id"}, {"issue_content_history", "comment_id"},
		},
		dto: func(_ context.Context, l *loader, r *issues_model.Comment) (any, error) {
			res := &protocol.Comment{
				ID: r.ID, IssueID: r.IssueID, Type: r.Type.String(), PosterID: r.PosterID,
				OriginalAuthor: r.OriginalAuthor, OriginalAuthorID: r.OriginalAuthorID, Body: r.Content,
				ContentVersion: r.ContentVersion, LabelID: r.LabelID, OldProjectID: r.OldProjectID, ProjectID: r.ProjectID,
				OldMilestoneID: r.OldMilestoneID, MilestoneID: r.MilestoneID, TimeID: r.TimeID,
				AssigneeID: r.AssigneeID, AssigneeTeamID: r.AssigneeTeamID, RemovedAssignee: r.RemovedAssignee,
				ResolveDoerID: r.ResolveDoerID, OldTitle: r.OldTitle, NewTitle: r.NewTitle, OldRef: r.OldRef,
				NewRef: r.NewRef, DependentIssueID: r.DependentIssueID, Line: r.Line, ExtraLinesCount: r.ExtraLinesCount,
				TreePath: r.TreePath, Patch: r.Patch, CommitSHA: r.CommitSHA, ReviewID: r.ReviewID,
				Invalidated: r.Invalidated, RefRepoID: r.RefRepoID, RefIssueID: r.RefIssueID,
				RefCommentID: r.RefCommentID, RefAction: int(r.RefAction), RefIsPull: r.RefIsPull,
				CreatedAt: ts(r.CreatedUnix), UpdatedAt: ts(r.UpdatedUnix),
			}
			l.markdown(l.issueRepo(r.IssueID), r.Content, &res.BodyHTML)
			return res, nil
		},
	}.spec("comment")
}

// reviewState is API v1's name of a review type (convert.ToPullReview).
func reviewState(t issues_model.ReviewType) string {
	switch t {
	case issues_model.ReviewTypePending:
		return "PENDING"
	case issues_model.ReviewTypeApprove:
		return "APPROVED"
	case issues_model.ReviewTypeReject:
		return "REQUEST_CHANGES"
	case issues_model.ReviewTypeRequest:
		return "REQUEST_REVIEW"
	}
	return "COMMENT"
}

func reviewSpec() *spec {
	return rowSpec[issues_model.Review]{
		model: protocol.ModelReview, schema: protocol.SchemaReview,
		id: func(r *issues_model.Review) int64 { return r.ID },
		prepare: func(ctx context.Context, l *loader, rows []*issues_model.Review) error {
			return issueRepos(ctx, l, ids(rows, func(r *issues_model.Review) int64 { return r.IssueID }))
		},
		place: func(l *loader, r *issues_model.Review) (string, protocol.Unit) { return l.reviewPlace(r) },
		// Submitting a pending review changes the review row only: its
		// code comments (and their attachments) move with it.
		dependents: []dependent{{"comment", "review_id"}},
		dto: func(_ context.Context, l *loader, r *issues_model.Review) (any, error) {
			res := &protocol.Review{
				ID: r.ID, IssueID: r.IssueID, State: reviewState(r.Type), ReviewerID: r.ReviewerID,
				ReviewerTeamID: r.ReviewerTeamID, OriginalAuthor: r.OriginalAuthor, Body: r.Content,
				Official: r.Official, CommitID: r.CommitID, Stale: r.Stale, Dismissed: r.Dismissed,
				CreatedAt: ts(r.CreatedUnix), UpdatedAt: ts(r.UpdatedUnix),
			}
			l.markdown(l.issueRepo(r.IssueID), r.Content, &res.BodyHTML)
			return res, nil
		},
	}.spec("review")
}

func releaseSpec() *spec {
	return rowSpec[repo_model.Release]{
		model: protocol.ModelRelease, schema: protocol.SchemaRelease,
		id: func(r *repo_model.Release) int64 { return r.ID },
		prepare: func(ctx context.Context, l *loader, rows []*repo_model.Release) error {
			return l.loadRepos(ctx, ids(rows, func(r *repo_model.Release) int64 { return r.RepoID }))
		},
		place: func(_ *loader, r *repo_model.Release) (string, protocol.Unit) { return releasePlace(r) },
		// Publishing a draft changes the release row only: its
		// attachments appear with it.
		dependents: []dependent{{"attachment", "release_id"}},
		dto: func(_ context.Context, l *loader, r *repo_model.Release) (any, error) {
			res := &protocol.Release{
				ID: r.ID, RepoID: r.RepoID, PublisherID: r.PublisherID, TagName: r.TagName, TargetCommitish: r.Target,
				Name: r.Title, SHA: r.Sha1, Body: r.Note,
				Draft: r.IsDraft, Prerelease: r.IsPrerelease, IsTag: r.IsTag, NumCommits: r.NumCommits,
				HideArchiveLinks: r.HideArchiveLinks, OriginalAuthor: r.OriginalAuthor, CreatedAt: ts(r.CreatedUnix),
			}
			l.markdown(l.repos[r.RepoID], r.Note, &res.BodyHTML)
			return res, nil
		},
	}.spec("release")
}

func notificationStatus(s activities_model.NotificationStatus) string {
	switch s {
	case activities_model.NotificationStatusRead:
		return "read"
	case activities_model.NotificationStatusPinned:
		return "pinned"
	}
	return "unread"
}

func notificationSource(s activities_model.NotificationSource) string {
	switch s {
	case activities_model.NotificationSourcePullRequest:
		return "pull"
	case activities_model.NotificationSourceCommit:
		return "commit"
	case activities_model.NotificationSourceRepository:
		return "repository"
	}
	return "issue"
}
