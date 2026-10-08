// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"errors"
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"

	auth_model "forgejo.org/models/auth"
	"forgejo.org/models/db"
	org_model "forgejo.org/models/organization"
	perm_model "forgejo.org/models/perm"
	access_model "forgejo.org/models/perm/access"
	project_model "forgejo.org/models/project"
	"forgejo.org/models/unit"
	user_model "forgejo.org/models/user"
	project_module "forgejo.org/modules/project"
	api "forgejo.org/modules/structs"
	"forgejo.org/modules/util"
	"forgejo.org/services/livesync/protocol"
	project_service "forgejo.org/services/project"
)

// Project boards (protocol/api.go): columns create / edit / delete /
// order and card moves, through services/project (and the model functions
// the classic board calls where the service has none, SURFACE.md), with
// the classic board's permission checks (routers/web/repo/projects.go,
// routers/web/org/projects.go, routers/web/shared/project).

// boardWriteScope: board writes change issue tracking (API v1 has no
// projects API; cards are issues).
const boardWriteScope = auth_model.AccessTokenScopeWriteIssue

// maxColumnTitle is the classic form's limit (EditProjectColumnForm).
const maxColumnTitle = 100

// board loads the project of the {id} parameter and checks that the
// viewer may change its board; it answers the request itself (404 when
// the viewer may not see the project, 403 when they may see but not change
// it) and returns nil otherwise.
func (a *apiRequest) board() *project_model.Project {
	id, ok := a.id("id")
	if !ok {
		return nil
	}
	p, err := project_model.GetProjectByID(a.ctx, id)
	if err != nil {
		if project_model.IsErrProjectNotExist(err) {
			a.notFound()
		} else {
			a.internal("load the project", err)
		}
		return nil
	}
	switch {
	case p.RepoID != 0:
		// The repository's /projects routes: MustEnableProjects
		// (globally enabled, unit readable), reqRepoProjectsWriter and
		// RepoMustNotBeArchived.
		if unit.TypeProjects.UnitGlobalDisabled() {
			a.notFound()
			return nil
		}
		repo, perm, ok := a.repoPermission(p.RepoID)
		if !ok {
			return nil
		}
		if !perm.CanRead(unit.TypeProjects) {
			a.notFound()
			return nil
		}
		if !perm.CanWrite(unit.TypeProjects) {
			a.forbidden()
			return nil
		}
		if repo.IsArchived {
			a.error(http.StatusForbidden, "the repository is archived")
			return nil
		}
	case p.Type == project_module.TypeOrganization:
		// /{org}/-/projects: OrgAssignment (the organization is visible),
		// reqUnitAccess(projects, read / write, ignoreGlobal).
		org, err := org_model.GetOrgByID(a.ctx, p.OwnerID)
		if err != nil {
			if org_model.IsErrOrgNotExist(err) {
				a.notFound()
			} else {
				a.internal("load the organization", err)
			}
			return nil
		}
		if !org_model.HasOrgOrUserVisible(a.ctx, org.AsUser(), a.viewer) {
			a.notFound()
			return nil
		}
		mode := org.UnitPermission(a.ctx, a.viewer, unit.TypeProjects)
		if mode < perm_model.AccessModeRead {
			a.notFound()
			return nil
		}
		if mode < perm_model.AccessModeWrite {
			a.forbidden()
			return nil
		}
	default:
		// A user's project: only its owner changes it
		// (individualPermsChecker and the NewProject check).
		if p.OwnerID == a.viewer.ID {
			break
		}
		owner, err := user_model.GetUserByID(a.ctx, p.OwnerID)
		if err != nil {
			if user_model.IsErrUserNotExist(err) {
				a.notFound()
			} else {
				a.internal("load the project owner", err)
			}
			return nil
		}
		if !user_model.IsUserVisibleToViewer(a.ctx, owner, a.viewer) {
			a.notFound()
			return nil
		}
		a.forbidden()
		return nil
	}
	return p
}

// column loads the {column} parameter's column of project p (404 when it
// is not one of p's).
func (a *apiRequest) column(p *project_model.Project) *project_model.Column {
	id, ok := a.id("column")
	if !ok {
		return nil
	}
	c, err := project_service.GetValidProjectColumnByID(a.ctx, p.ID, id)
	if err != nil {
		if errors.Is(err, util.ErrNotExist) || errors.Is(err, util.ErrInvalidArgument) {
			a.notFound()
		} else {
			a.internal("load the column", err)
		}
		return nil
	}
	return c
}

// validColumn checks a column's title and colour like the classic form
// and the model do.
func (a *apiRequest) validColumn(title, color string) bool {
	return a.validTitle(title) && a.validColor(color)
}

func (a *apiRequest) validTitle(title string) bool {
	switch {
	case strings.TrimSpace(title) == "":
		a.error(http.StatusBadRequest, "title is required")
	case utf8.RuneCountInString(title) > maxColumnTitle:
		a.error(http.StatusBadRequest, "title is too long (100 characters at most)")
	default:
		return true
	}
	return false
}

func (a *apiRequest) validColor(color string) bool {
	if color != "" && !project_model.ColumnColorPattern.MatchString(color) {
		a.error(http.StatusBadRequest, "color must be empty or #rrggbb")
		return false
	}
	return true
}

// apiColumnCreate answers POST /-/sync/api/projects/{id}/columns.
func apiColumnCreate(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, boardWriteScope)
	if a == nil {
		return
	}
	p := a.board()
	if p == nil {
		return
	}
	var body protocol.APIColumnCreate
	if !a.decode(&body) || !a.validColumn(body.Title, body.Color) {
		return
	}
	columns, err := db.Find[project_model.Column](a.ctx, project_model.FindColumnOptions{ListOptions: db.ListOptionsAll, ProjectID: p.ID})
	if err != nil {
		a.internal("list the columns", err)
		return
	}
	if len(columns) >= maxColumns {
		a.error(http.StatusUnprocessableEntity, "the project has the maximum number of columns")
		return
	}
	c := &project_model.Column{ProjectID: p.ID, Title: body.Title, Color: body.Color, CreatorID: a.viewer.ID}
	if err := project_service.CreateColumnInProject(a.ctx, c); err != nil {
		a.internal("create the column", err)
		return
	}
	a.json(http.StatusCreated, protocol.APICreated{ID: c.ID})
}

// maxColumns is the model's limit of columns per project
// (project_model.maxProjectColumns, unexported; SURFACE.md).
const maxColumns = 20

// apiColumnEdit answers PATCH /-/sync/api/projects/{id}/columns/{column}.
func apiColumnEdit(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, boardWriteScope)
	if a == nil {
		return
	}
	p := a.board()
	if p == nil {
		return
	}
	c := a.column(p)
	if c == nil {
		return
	}
	var body protocol.APIColumnEdit
	if !a.decode(&body) {
		return
	}
	title, color := c.Title, c.Color
	if body.Title != nil {
		title = *body.Title
	}
	if body.Color != nil {
		color = *body.Color
	}
	// Only what the request changes is validated (a column created
	// elsewhere may have an empty title).
	if body.Title != nil && !a.validTitle(title) || body.Color != nil && !a.validColor(color) {
		return
	}
	if title != c.Title || color != c.Color {
		c.Title, c.Color = title, color
		if err := project_service.EditColumnInProject(a.ctx, c); err != nil {
			a.internal("edit the column", err)
			return
		}
	}
	if body.Default != nil && *body.Default && !c.Default {
		if err := project_service.SetDefaultColumn(a.ctx, p.ID, c.ID); err != nil {
			a.internal("set the default column", err)
			return
		}
	}
	a.json(http.StatusOK, protocol.APICreated{ID: c.ID})
}

// apiColumnDelete answers DELETE /-/sync/api/projects/{id}/columns/{column}:
// its cards move to the default column (the model does that).
func apiColumnDelete(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, boardWriteScope)
	if a == nil {
		return
	}
	p := a.board()
	if p == nil {
		return
	}
	c := a.column(p)
	if c == nil {
		return
	}
	if c.Default {
		a.error(http.StatusUnprocessableEntity, "the default column cannot be deleted")
		return
	}
	if err := project_service.DeleteColumnInProject(a.ctx, c.ID); err != nil {
		a.internal("delete the column", err)
		return
	}
	a.noContent()
}

// apiColumnOrder answers PUT /-/sync/api/projects/{id}/column-order.
func apiColumnOrder(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, boardWriteScope)
	if a == nil {
		return
	}
	p := a.board()
	if p == nil {
		return
	}
	var body protocol.APIColumnOrder
	if !a.decode(&body) {
		return
	}
	columns, err := db.Find[project_model.Column](a.ctx, project_model.FindColumnOptions{ListOptions: db.ListOptionsAll, ProjectID: p.ID})
	if err != nil {
		a.internal("list the columns", err)
		return
	}
	have := make([]int64, 0, len(columns))
	for _, c := range columns {
		have = append(have, c.ID)
	}
	want := slices.Clone(body.ColumnIDs)
	slices.Sort(have)
	slices.Sort(want)
	if !slices.Equal(have, want) {
		a.error(http.StatusConflict, "column_ids must list every column of the project exactly once")
		return
	}
	sorted := make(map[int64]int64, len(body.ColumnIDs))
	for i, id := range body.ColumnIDs {
		sorted[int64(i)] = id
	}
	if err := project_model.MoveColumnsOnProject(a.ctx, p.ID, sorted); err != nil {
		a.internal("order the columns", err)
		return
	}
	a.noContent()
}

// apiCardMove answers POST /-/sync/api/projects/{id}/columns/{column}/cards.
func apiCardMove(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, boardWriteScope)
	if a == nil {
		return
	}
	p := a.board()
	if p == nil {
		return
	}
	c := a.column(p)
	if c == nil {
		return
	}
	var body protocol.APICardMove
	if !a.decode(&body) {
		return
	}
	cards := body.Cards
	switch {
	case (body.IssueID != 0) == (len(cards) != 0):
		a.error(http.StatusBadRequest, "send either issue_id (and position) or cards")
		return
	case body.Position != nil && *body.Position < 0:
		a.error(http.StatusBadRequest, "position must be >= 0")
		return
	}
	ids := make([]int64, 0, max(len(cards), 1))
	if body.IssueID != 0 {
		ids = append(ids, body.IssueID)
	}
	seen := make(map[int64]bool, len(cards))
	sortings := make(map[int64]bool, len(cards))
	for _, card := range cards {
		if seen[card.IssueID] || sortings[card.Sorting] || card.IssueID <= 0 || card.Sorting < 0 {
			a.error(http.StatusBadRequest, "cards must name distinct issues with distinct sorting values >= 0")
			return
		}
		seen[card.IssueID], sortings[card.Sorting] = true, true
		ids = append(ids, card.IssueID)
	}
	if !a.cardIssues(p, ids) {
		return
	}
	if body.IssueID != 0 {
		var ok bool
		if cards, ok = a.insertCard(c, body.IssueID, body.Position); !ok {
			return
		}
	}
	opt := &api.MovedIssuesOption{ProjectIssues: make([]api.ProjectIssue, 0, len(cards))}
	for _, card := range cards {
		opt.ProjectIssues = append(opt.ProjectIssues, api.ProjectIssue{IssueID: card.IssueID, Sorting: card.Sorting})
	}
	if err := project_service.MoveIssuesOnProjectColumn(a.ctx, c, opt); err != nil {
		a.internal("move the cards", err)
		return
	}
	a.noContent()
}

// cardIssues checks the issues of a card move like the classic board does
// (they belong to the project's repository, or to a repository of the
// project's owner) and, stricter than it, that the viewer may read them
// (404 otherwise) and that they are on the board (409 otherwise: the
// client's view is stale).
func (a *apiRequest) cardIssues(p *project_model.Project, ids []int64) bool {
	issues, complete, err := project_service.GetIssues(a.ctx, ids)
	if err != nil {
		a.internal("load the issues", err)
		return false
	}
	if !complete {
		a.notFound()
		return false
	}
	if p.RepoID == 0 {
		if err := project_service.ValidIssueIDs(a.ctx, p.OwnerID, issues); err != nil {
			a.notFound()
			return false
		}
	}
	perms := map[int64]access_model.Permission{}
	for _, issue := range issues {
		if p.RepoID != 0 && issue.RepoID != p.RepoID {
			a.notFound()
			return false
		}
		perm, ok := perms[issue.RepoID]
		if !ok {
			if err := issue.LoadRepo(a.ctx); err != nil {
				a.internal("load the issue's repository", err)
				return false
			}
			if perm, err = access_model.GetUserRepoPermission(a.ctx, issue.Repo, a.viewer); err != nil {
				a.internal("repository permission", err)
				return false
			}
			perms[issue.RepoID] = perm
		}
		if !perm.CanReadIssuesOrPulls(issue.IsPull) {
			a.notFound()
			return false
		}
	}
	on, err := db.Find[project_model.ProjectIssue](a.ctx, project_model.FindProjectIssueOptions{ListOptions: db.ListOptionsAll, ProjectID: p.ID})
	if err != nil {
		a.internal("load the board", err)
		return false
	}
	onBoard := make(map[int64]bool, len(on))
	for _, pi := range on {
		onBoard[pi.IssueID] = true
	}
	for _, id := range ids {
		if !onBoard[id] {
			a.error(http.StatusConflict, "the issue is not on the project's board")
			return false
		}
	}
	return true
}

// insertCard computes the target column's order after moving issueID to
// position (nil or past the end: last), from the column's current cards.
func (a *apiRequest) insertCard(c *project_model.Column, issueID int64, position *int) ([]protocol.APICard, bool) {
	current, err := db.Find[project_model.ProjectIssue](a.ctx, project_model.FindProjectIssueOptions{ListOptions: db.ListOptionsAll, ProjectID: c.ProjectID, ProjectColumnID: c.ID})
	if err != nil {
		a.internal("load the column's cards", err)
		return nil, false
	}
	order := make([]int64, 0, len(current)+1)
	for _, pi := range current {
		if pi.IssueID != issueID {
			order = append(order, pi.IssueID)
		}
	}
	at := len(order)
	if position != nil && *position < at {
		at = *position
	}
	order = slices.Insert(order, at, issueID)
	cards := make([]protocol.APICard, len(order))
	for i, id := range order {
		cards[i] = protocol.APICard{IssueID: id, Sorting: int64(i)}
	}
	return cards, true
}
