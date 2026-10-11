// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"forgejo.org/models/db"
	repo_model "forgejo.org/models/repo"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/optional"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/structs"
	"forgejo.org/services/livesync/protocol"
)

func discoveryOptions(q url.Values) (db.ListOptions, db.SearchOrderBy, bool) {
	page := 1
	if q.Get("page") != "" {
		n, err := strconv.Atoi(q.Get("page"))
		if err != nil || n < 1 || n > 100000 {
			return db.ListOptions{}, "", false
		}
		page = n
	}
	orders := map[string]db.SearchOrderBy{"": db.SearchOrderByRecentUpdated, "updated": db.SearchOrderByRecentUpdated, "created": db.SearchOrderByNewest, "alpha": db.SearchOrderByAlphabetically, "stars": db.SearchOrderBy("num_stars DESC, id DESC")}
	order, ok := orders[q.Get("sort")]
	return db.ListOptions{Page: page, PageSize: 50}, order, ok
}

func discoveryAllowed(kind string) bool {
	return (kind == "repositories") || (kind == "users" && !setting.Service.Explore.DisableUsersPage) || (kind == "organizations" && !setting.Service.Explore.DisableOrganizationsPage)
}

func apiDiscovery(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, "")
	if a == nil {
		return
	}
	q := req.URL.Query()
	kind := q.Get("type")
	if !discoveryAllowed(kind) {
		a.notFound()
		return
	}
	list, order, ok := discoveryOptions(q)
	if !ok {
		a.error(http.StatusBadRequest, "invalid page or sort")
		return
	}
	result := protocol.APIDiscovery{Rows: make([]protocol.APIDiscoveryRow, 0)}
	if kind == "repositories" {
		archived := optional.None[bool]()
		if value := q.Get("archived"); value != "" {
			if value != "true" && value != "false" {
				a.error(http.StatusBadRequest, "invalid archived filter")
				return
			}
			archived = optional.Some(value == "true")
		}
		repos, count, err := repo_model.SearchRepository(a.ctx, &repo_model.SearchRepoOptions{ListOptions: list, Actor: a.viewer, Keyword: strings.TrimSpace(q.Get("q")), OrderBy: order, Private: true, AllPublic: true, AllLimited: true, Archived: archived, Language: q.Get("language"), IncludeDescription: true})
		if err != nil {
			a.internal("search repositories", err)
			return
		}
		result.Total = count
		for _, repo := range repos {
			if err := repo.LoadOwner(a.ctx); err != nil {
				a.internal("load repository owner", err)
				return
			}
			name := repo.Owner.Name + "/" + repo.Name
			result.Rows = append(result.Rows, protocol.APIDiscoveryRow{ID: repo.ID, Title: name, Detail: repo.Description, Path: "/" + url.PathEscape(repo.Owner.Name) + "/" + url.PathEscape(repo.Name)})
		}
	} else {
		if q.Get("sort") == "stars" {
			a.error(http.StatusBadRequest, "stars sort is only available for repositories")
			return
		}
		userType := user_model.UserTypeIndividual
		if kind == "organizations" {
			userType = user_model.UserTypeOrganization
		}
		users, count, err := user_model.SearchUsers(a.ctx, &user_model.SearchUserOptions{ListOptions: list, Actor: a.viewer, Type: userType, Keyword: strings.TrimSpace(q.Get("q")), OrderBy: order, Visible: []structs.VisibleType{structs.VisibleTypePublic, structs.VisibleTypeLimited, structs.VisibleTypePrivate}})
		if err != nil {
			a.internal("search people", err)
			return
		}
		result.Total = count
		for _, user := range users {
			result.Rows = append(result.Rows, protocol.APIDiscoveryRow{ID: user.ID, Title: user.Name, Detail: user.FullName, Path: "/" + url.PathEscape(user.Name)})
		}
	}
	a.json(http.StatusOK, result)
}
