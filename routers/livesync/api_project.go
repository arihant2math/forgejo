// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"net/http"

	issues_model "forgejo.org/models/issues"
	org_model "forgejo.org/models/organization"
	perm_model "forgejo.org/models/perm"
	project_model "forgejo.org/models/project"
	"forgejo.org/models/unit"
	project_module "forgejo.org/modules/project"
	"forgejo.org/services/livesync/protocol"
	project_service "forgejo.org/services/project"
)

// An issue's project (protocol/api.go): the classic issue sidebar's
// project picker (UpdateIssueProject, routers/web/repo/issue.go:
// issues_model.IssueAssignOrRemoveProject, with the checks of
// context.ReqProjectIDAssignableToIssue). An issue is on one project at a
// time; putting it on another takes it off the first, and project 0 takes
// it off its project.

// apiIssueProject answers PUT /-/sync/api/issues/{id}/project.
func apiIssueProject(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, boardWriteScope)
	if a == nil {
		return
	}
	id, ok := a.id("id")
	if !ok {
		return
	}
	var body protocol.APIIssueProject
	if !a.decode(&body) {
		return
	}
	if body.ProjectID < 0 || body.ColumnID < 0 || (body.ProjectID == 0 && body.ColumnID != 0) {
		a.error(http.StatusBadRequest, "project_id and column_id must be >= 0, and column_id needs a project")
		return
	}
	issue, err := issues_model.GetIssueByID(a.ctx, id)
	if err != nil {
		if issues_model.IsErrIssueNotExist(err) {
			a.notFound()
		} else {
			a.internal("load the issue", err)
		}
		return
	}
	repo, perm, ok := a.repoPermission(issue.RepoID)
	if !ok {
		return
	}
	issue.Repo = repo
	if !canReadIssue(perm, issue) {
		a.notFound()
		return
	}
	// The sidebar's route: reqRepoIssuesOrPullsWriter, and the repository must not be archived.
	if !perm.CanWriteIssuesOrPulls(issue.IsPull) {
		a.forbidden()
		return
	}
	if repo.IsArchived {
		a.error(http.StatusForbidden, "the repository is archived")
		return
	}
	if body.ProjectID != 0 {
		p, err := project_model.GetProjectByID(a.ctx, body.ProjectID)
		if err != nil {
			if project_model.IsErrProjectNotExist(err) {
				a.notFound()
			} else {
				a.internal("load the project", err)
			}
			return
		}
		// reqValidAndConsistentProject: the repository's project, or one of its owner's.
		if p.RepoID != repo.ID && (p.RepoID != 0 || p.OwnerID != repo.OwnerID) {
			a.notFound()
			return
		}
		// reqPermissionToAssignProjectToIssue.
		switch p.Type {
		case project_module.TypeRepository:
			if !repo.UnitEnabled(a.ctx, unit.TypeProjects) || !perm.CanRead(unit.TypeProjects) {
				a.notFound()
				return
			}
		case project_module.TypeOrganization:
			org, err := org_model.GetOrgByID(a.ctx, p.OwnerID)
			if err != nil {
				a.internal("load the organization", err)
				return
			}
			if org.UnitPermission(a.ctx, a.viewer, unit.TypeProjects) < perm_model.AccessModeRead {
				a.notFound()
				return
			}
		}
		if !perm.CanWrite(unit.TypeIssues) {
			a.forbidden()
			return
		}
		if body.ColumnID != 0 {
			if _, err := project_service.GetValidProjectColumnByID(a.ctx, p.ID, body.ColumnID); err != nil {
				a.notFound()
				return
			}
		}
	}
	if err := issues_model.IssueAssignOrRemoveProject(a.ctx, issue, a.viewer, body.ProjectID, body.ColumnID); err != nil {
		a.internal("set the issue's project", err)
		return
	}
	a.noContent()
}
