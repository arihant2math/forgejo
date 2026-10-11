// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"net/http"
	"strings"
	"unicode/utf8"

	project_model "forgejo.org/models/project"
	repo_model "forgejo.org/models/repo"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/optional"
	project_module "forgejo.org/modules/project"
	api "forgejo.org/modules/structs"
	"forgejo.org/services/livesync/protocol"
	project_service "forgejo.org/services/project"
)

// Project lifecycle writes use the same authorization and idempotency layer as columns.
type projectCreateBody struct {
	RepoID       int64  `json:"repo_id"`
	OwnerID      int64  `json:"owner_id"`
	Title        string `json:"title"`
	Description  string `json:"description"`
	TemplateType string `json:"template_type"`
	CardType     string `json:"card_type"`
}

type projectEditBody struct {
	Title       *string `json:"title"`
	Description *string `json:"description"`
	CardType    *string `json:"card_type"`
}

func validProjectTitle(title string) bool {
	return strings.TrimSpace(title) != "" && utf8.ValidString(title) && len(title) <= 255
}

func apiProjectCreate(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, boardWriteScope)
	if a == nil {
		return
	}
	var body projectCreateBody
	if !a.decode(&body) {
		return
	}
	if !validProjectTitle(body.Title) || body.RepoID < 0 || body.OwnerID < 0 || (body.RepoID == 0) == (body.OwnerID == 0) {
		a.error(http.StatusUnprocessableEntity, "a title of at most 255 bytes and exactly one repo_id or owner_id are required")
		return
	}
	var owner *user_model.User
	var repo *repo_model.Repository
	var err error
	kind := project_module.APIOwnerTypeIndividual
	if body.RepoID != 0 {
		var ok bool
		repo, _, ok = a.repoPermission(body.RepoID)
		if !ok {
			return
		}
		kind = project_module.APIOwnerTypeRepository
	} else {
		owner, err = user_model.GetUserByID(a.ctx, body.OwnerID)
		if err != nil {
			if user_model.IsErrUserNotExist(err) {
				a.notFound()
			} else {
				a.internal("load the owner", err)
			}
			return
		}
		if owner.IsOrganization() {
			kind = project_module.APIOwnerTypeOrganization
		}
	}
	if !a.boardWritable(&project_model.Project{RepoID: body.RepoID, OwnerID: body.OwnerID, Type: kind.ToOwnerType()}) {
		return
	}
	if body.CardType == "" {
		body.CardType = "text_only"
	}
	p, err := project_service.NewProject(&api.CreateOrUpdateProjectOptions{Title: strings.TrimSpace(body.Title), Description: body.Description, TemplateType: body.TemplateType, CardType: body.CardType}, owner, repo, kind)
	if err != nil {
		a.error(http.StatusUnprocessableEntity, err.Error())
		return
	}
	p.CreatorID = a.viewer.ID
	if err := project_service.CreateProject(a.ctx, p); err != nil {
		a.internal("create the project", err)
		return
	}
	a.json(http.StatusCreated, protocol.APICreated{ID: p.ID})
}

func apiProjectEdit(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, boardWriteScope)
	if a == nil {
		return
	}
	p := a.board()
	if p == nil {
		return
	}
	var body projectEditBody
	if !a.decode(&body) {
		return
	}
	if body.Title != nil {
		if !validProjectTitle(*body.Title) {
			a.error(http.StatusUnprocessableEntity, "title must contain text and be at most 255 bytes")
			return
		}
		p.Title = strings.TrimSpace(*body.Title)
	}
	if body.Description != nil {
		p.Description = *body.Description
	}
	if body.CardType != nil {
		ct := project_module.APICardType(*body.CardType)
		if len(ct.Validate()) != 0 {
			a.error(http.StatusUnprocessableEntity, "invalid card_type")
			return
		}
		p.CardType = ct.ToCardType()
	}
	// The service skips empty descriptions; the model update also permits clearing one.
	if err := project_model.UpdateProject(a.ctx, p); err != nil {
		a.internal("edit the project", err)
		return
	}
	a.noContent()
}

func apiProjectState(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, boardWriteScope)
	if a == nil {
		return
	}
	p := a.board()
	if p == nil {
		return
	}
	var body struct {
		Closed *bool `json:"closed"`
	}
	if !a.decode(&body) {
		return
	}
	if body.Closed == nil {
		a.error(http.StatusUnprocessableEntity, "closed is required")
		return
	}
	if err := project_service.ChangeProjectStatus(a.ctx, p, *body.Closed); err != nil {
		a.internal("change the project state", err)
		return
	}
	a.noContent()
}

func apiProjectDelete(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, boardWriteScope)
	if a == nil {
		return
	}
	p := a.board()
	if p == nil {
		return
	}
	repoID := optional.None[int64]()
	if p.RepoID != 0 {
		repoID = optional.Some(p.RepoID)
	}
	if err := project_service.DeleteProjectByID(a.ctx, p.ID, repoID); err != nil {
		a.internal("delete the project", err)
		return
	}
	a.noContent()
}
