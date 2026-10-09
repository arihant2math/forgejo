// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"cmp"
	"context"
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

	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5/pgconn"
	"xorm.io/builder"
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
	sorted := make(map[int64]int64, len(body.ColumnIDs))
	for i, id := range body.ColumnIDs {
		sorted[int64(i)] = id
	}
	err := boardTx(a.ctx, func(ctx context.Context) error {
		// The project's columns, locked: the set compared is the set the
		// model orders (a column created or deleted meanwhile waits, or
		// is seen).
		var columns []*project_model.Column
		if err := db.GetEngine(ctx).Where("project_id = ?", p.ID).OrderBy("id").ForUpdate().Find(&columns); err != nil {
			return err
		}
		have := make([]int64, 0, len(columns))
		for _, c := range columns {
			have = append(have, c.ID)
		}
		want := slices.Clone(body.ColumnIDs)
		slices.Sort(want)
		if !slices.Equal(have, want) {
			return errStaleBoard
		}
		return project_model.MoveColumnsOnProject(ctx, p.ID, sorted)
	})
	if a.boardTxError(err, "column_ids must list every column of the project exactly once", "order the columns") {
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
	// The move is computed and written in one transaction from locked
	// rows: the moved cards (still on the board?) and the target column's
	// cards, so that a card another request moves out of the column
	// meanwhile is not written back into it (the model's
	// MoveIssuesOnProjectColumn rewrites every card it is given). They are
	// locked in one statement in id order, so that two moves between the
	// same columns lock their common cards in the same order (no deadlock
	// between them).
	err := boardTx(a.ctx, func(ctx context.Context) error {
		var rows []*project_model.ProjectIssue
		if err := db.GetEngine(ctx).Where("project_id = ?", p.ID).
			And(builder.Or(builder.In("issue_id", ids), builder.Eq{"project_board_id": c.ID})).
			OrderBy("id").ForUpdate().Find(&rows); err != nil {
			return err
		}
		on := 0
		var column []*project_model.ProjectIssue
		for _, pi := range rows {
			if slices.Contains(ids, pi.IssueID) {
				on++
			}
			if pi.ProjectColumnID == c.ID {
				column = append(column, pi)
			}
		}
		if on != len(ids) {
			return errStaleBoard
		}
		moved := cards
		if body.IssueID != 0 {
			var err error
			if moved, err = a.insertCard(ctx, column, body.IssueID, body.Position); err != nil {
				return err
			}
		}
		opt := &api.MovedIssuesOption{ProjectIssues: make([]api.ProjectIssue, 0, len(moved))}
		for _, card := range moved {
			opt.ProjectIssues = append(opt.ProjectIssues, api.ProjectIssue{IssueID: card.IssueID, Sorting: card.Sorting})
		}
		return project_service.MoveIssuesOnProjectColumn(ctx, c, opt)
	})
	if a.boardTxError(err, "the issue is not on the project's board", "move the cards") {
		return
	}
	a.noContent()
}

// cardIssues checks the issues of a card move like the classic board does
// (they belong to the project's repository, or to a repository of the
// project's owner) and, stricter than it, that the viewer may read them
// (404 otherwise). Whether they are on the board is checked in the move's
// transaction (409).
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
	return true
}

// insertCard computes the target column's order after moving issueID to
// position (nil or past the end: last) from current, the column's cards
// (locked in the transaction ctx). The position counts the cards the
// viewer may read (the classic board and the synced pool show those only);
// the cards the viewer may not read keep their places: the moved card goes
// right before the readable card at position (after the last card for the
// end).
func (a *apiRequest) insertCard(ctx context.Context, current []*project_model.ProjectIssue, issueID int64, position *int) ([]protocol.APICard, error) {
	slices.SortFunc(current, func(x, y *project_model.ProjectIssue) int {
		return cmp.Or(cmp.Compare(x.Sorting, y.Sorting), cmp.Compare(x.ID, y.ID))
	})
	order := make([]int64, 0, len(current)+1)
	for _, pi := range current {
		if pi.IssueID != issueID {
			order = append(order, pi.IssueID)
		}
	}
	at := len(order)
	if position != nil && *position < at {
		readable, err := a.readableCards(ctx, order)
		if err != nil {
			return nil, err
		}
		seen := 0
		for i, id := range order {
			if !readable[id] {
				continue
			}
			if seen == *position {
				at = i
				break
			}
			seen++
		}
	}
	order = slices.Insert(order, at, issueID)
	cards := make([]protocol.APICard, len(order))
	for i, id := range order {
		cards[i] = protocol.APICard{IssueID: id, Sorting: int64(i)}
	}
	return cards, nil
}

// readableCards reports which of the issues the viewer may read, as the
// synced pool decides it (livesync's permission cache: the issues or pull
// requests unit of the issue's repository group).
func (a *apiRequest) readableCards(ctx context.Context, ids []int64) (map[int64]bool, error) {
	issues, _, err := project_service.GetIssues(ctx, ids)
	if err != nil {
		return nil, err
	}
	groups := make([]string, 0, len(issues))
	for _, issue := range issues {
		if g := protocol.RepoGroup(issue.RepoID); !slices.Contains(groups, g) {
			groups = append(groups, g)
		}
	}
	decisions, err := a.perms.CheckGroups(a.ctx, a.viewer.ID, groups)
	if err != nil {
		return nil, err
	}
	res := make(map[int64]bool, len(issues))
	for _, issue := range issues {
		unit := protocol.UnitIssues
		if issue.IsPull {
			unit = protocol.UnitPulls
		}
		d, ok := decisions[protocol.RepoGroup(issue.RepoID)]
		res[issue.ID] = ok && d.Units.Allows(unit)
	}
	return res, nil
}

// errStaleBoard: the board is not what the request names (a card not on
// it, a column list that is not the project's): 409.
var errStaleBoard = errors.New("the board changed")

// boardTxAttempts bounds the attempts of a board transaction that a
// concurrent one made fail (deadlock, serialization failure, a sorting
// taken meanwhile).
const boardTxAttempts = 3

// boardTx runs a board change in a transaction, again when the database
// aborted it for a concurrent one (concurrent card moves lock overlapping
// cards in different orders; a classic board move does not lock the
// column's cards before it writes sortings).
func boardTx(ctx context.Context, f func(ctx context.Context) error) error {
	var err error
	for range boardTxAttempts {
		if err = db.WithTx(ctx, f); err == nil || !concurrencyFailure(err) && !uniqueViolation(err) || ctx.Err() != nil {
			return err
		}
	}
	return err
}

// boardTxError answers the error of a board transaction: 409 (with
// stale) for errStaleBoard, 503 + Retry-After for a transaction that
// concurrent ones kept failing or a unique key a concurrent change took,
// else 500. False when err is nil.
func (a *apiRequest) boardTxError(err error, stale, what string) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, errStaleBoard):
		a.error(http.StatusConflict, stale)
	case concurrencyFailure(err) || uniqueViolation(err):
		a.w.Header().Set("Retry-After", "1")
		a.error(http.StatusServiceUnavailable, "the board is being changed concurrently; retry")
	default:
		a.internal(what, err)
	}
	return true
}

// concurrencyFailure reports whether the database aborted a statement or
// transaction for a concurrent one: a deadlock, a serialization failure or
// a lock wait timeout (MySQL 1213 / 1205, PostgreSQL 40P01 / 40001).
func concurrencyFailure(err error) bool {
	if myErr, ok := errors.AsType[*mysql.MySQLError](err); ok {
		return myErr.Number == 1213 || myErr.Number == 1205
	}
	if pgErr, ok := errors.AsType[*pgconn.PgError](err); ok {
		return pgErr.Code == "40P01" || pgErr.Code == "40001"
	}
	return false
}

// uniqueViolation reports a duplicate key (MySQL 1062, PostgreSQL 23505):
// on a board, a sorting a concurrent change (one that does not lock the
// cards, as the classic board's) took meanwhile.
func uniqueViolation(err error) bool {
	if myErr, ok := errors.AsType[*mysql.MySQLError](err); ok {
		return myErr.Number == 1062
	}
	if pgErr, ok := errors.AsType[*pgconn.PgError](err); ok {
		return pgErr.Code == "23505"
	}
	return false
}
