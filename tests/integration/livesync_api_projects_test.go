// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"fmt"
	"net/http"
	"testing"

	auth_model "forgejo.org/models/auth"
	"forgejo.org/models/db"
	project_model "forgejo.org/models/project"
	"forgejo.org/services/livesync/protocol"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func livesyncAPIProjects(t *testing.T, user2, user5, read2 string) {
	replay := func(method, path string, body any, status int, key string) *protocol.APICreated {
		t.Helper()
		request := func() *RequestWrapper {
			return livesyncAPI(t, method, path, user2, body).SetHeader(protocol.HeaderIdempotencyKey, "project-lifecycle-"+key)
		}
		first := MakeRequest(t, request(), status)
		second := MakeRequest(t, request(), status)
		assert.Equal(t, first.Body.String(), second.Body.String())
		assert.Equal(t, first.Header().Get(protocol.HeaderSyncID), second.Header().Get(protocol.HeaderSyncID))
		if status == http.StatusCreated {
			var made protocol.APICreated
			DecodeJSON(t, first, &made)
			return &made
		}
		return nil
	}
	create := map[string]any{"repo_id": 1, "title": "Lifecycle board", "description": "Planning", "template_type": "basic_kanban", "card_type": "text_only"}
	MakeRequest(t, livesyncAPI(t, "POST", "/projects", user5, create), http.StatusForbidden)
	MakeRequest(t, livesyncAPI(t, "POST", "/projects", read2, create), http.StatusForbidden)
	MakeRequest(t, livesyncAPI(t, "POST", "/projects", user2, map[string]any{"owner_id": 5, "title": "Not mine"}), http.StatusForbidden)
	MakeRequest(t, livesyncAPI(t, "POST", "/projects", user2, map[string]any{"repo_id": 1, "owner_id": 2, "title": "Ambiguous"}), http.StatusUnprocessableEntity)
	made := replay("POST", "/projects", create, http.StatusCreated, "create")
	path := fmt.Sprintf("/projects/%d", made.ID)
	p, err := project_model.GetProjectByID(t.Context(), made.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), p.CreatorID)
	columns, err := db.Find[project_model.Column](t.Context(), project_model.FindColumnOptions{ListOptions: db.ListOptionsAll, ProjectID: made.ID})
	require.NoError(t, err)
	assert.Greater(t, len(columns), 1, "Forgejo's template columns are created")
	for _, endpoint := range []struct {
		method, suffix string
		body           any
	}{
		{"PATCH", "", map[string]any{"title": "Changed"}},
		{"PUT", "/state", map[string]any{"closed": true}},
		{"DELETE", "", nil},
	} {
		MakeRequest(t, livesyncAPI(t, endpoint.method, path+endpoint.suffix, user5, endpoint.body), http.StatusForbidden)
		MakeRequest(t, livesyncAPI(t, endpoint.method, path+endpoint.suffix, read2, endpoint.body), http.StatusForbidden)
	}
	replay("PATCH", path, map[string]any{"title": "Renamed", "description": "", "card_type": "images_and_text"}, http.StatusNoContent, "edit")
	p, err = project_model.GetProjectByID(t.Context(), made.ID)
	require.NoError(t, err)
	assert.Equal(t, "Renamed", p.Title)
	assert.Empty(t, p.Description)
	assert.EqualValues(t, 1, p.CardType)
	for i, closed := range []bool{true, false} {
		replay("PUT", path+"/state", map[string]any{"closed": closed}, http.StatusNoContent, fmt.Sprintf("state-%d", i))
		p, err = project_model.GetProjectByID(t.Context(), made.ID)
		require.NoError(t, err)
		assert.Equal(t, closed, p.IsClosed)
	}
	MakeRequest(t, livesyncAPI(t, "PATCH", path, user2, map[string]any{"title": " "}), http.StatusUnprocessableEntity)
	MakeRequest(t, livesyncAPI(t, "PUT", path+"/state", user2, map[string]any{}), http.StatusUnprocessableEntity)
	replay("DELETE", path, nil, http.StatusNoContent, "delete")
	_, err = project_model.GetProjectByID(t.Context(), made.ID)
	assert.True(t, project_model.IsErrProjectNotExist(err))
	// Next's token writes issue tracking, not organizations; membership still decides org project writes.
	token := &auth_model.AccessToken{
		UID: 2, Name: "project-lifecycle-next", ResourceAllRepos: true,
		Scope: "read:repository,write:issue,read:organization,read:user,read:notification",
	}
	require.NoError(t, auth_model.NewAccessToken(t.Context(), token))
	for _, owner := range []int64{2, 3} {
		resp := MakeRequest(t, livesyncAPI(t, "POST", "/projects", token.Token, map[string]any{"owner_id": owner, "title": "Owner board", "template_type": "bug_triage"}), http.StatusCreated)
		var board protocol.APICreated
		DecodeJSON(t, resp, &board)
		MakeRequest(t, livesyncAPI(t, "DELETE", fmt.Sprintf("/projects/%d", board.ID), user2, nil), http.StatusNoContent)
	}
}
