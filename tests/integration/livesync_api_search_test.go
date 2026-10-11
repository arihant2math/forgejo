// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/url"
	"testing"

	repo_model "forgejo.org/models/repo"

	user_model "forgejo.org/models/user"
	code_indexer "forgejo.org/modules/indexer/code"
	"forgejo.org/modules/setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLivesyncCodeSearch(t *testing.T) {
	livesyncSkipSQLite(t)
	livesyncServe(t)
	enabled := setting.Indexer.RepoIndexerEnabled
	setting.Indexer.RepoIndexerEnabled = false
	defer func() { setting.Indexer.RepoIndexerEnabled = enabled }()
	onApplicationRun(t, func(t *testing.T, u *url.URL) {
		livesyncWaitBackfill(t)
		owner := livesyncToken(t, &user_model.User{ID: 2})
		other := livesyncToken(t, &user_model.User{ID: 5})
		MakeRequest(t, NewRequestWithJSON(t, "POST", "/api/v1/repos/user2/repo2/contents/code-search.txt", map[string]any{"content": base64.StdEncoding.EncodeToString([]byte("privateSearchSymbol95\n")), "message": "add searchable code"}).AddTokenAuth(owner), http.StatusCreated)
		MakeRequest(t, livesyncAPI(t, "GET", "/repos/2/search?q=privateSearchSymbol95", other, nil), http.StatusNotFound)
		ids, err := repo_model.FindUserCodeAccessibleRepoIDs(context.Background(), &user_model.User{ID: 5})
		require.NoError(t, err)
		assert.NotContains(t, ids, int64(2), "global indexer searches must exclude private repositories")
		var result struct {
			Enabled bool
			Total   int
			Results code_indexer.Results
		}
		DecodeJSON(t, MakeRequest(t, livesyncAPI(t, "GET", "/repos/2/search?q=privateSearchSymbol95", owner, nil), http.StatusOK), &result)
		assert.False(t, result.Enabled)
		require.NotEmpty(t, result.Results)
		for _, r := range result.Results {
			assert.EqualValues(t, 2, r.RepoID)
			assert.NotEmpty(t, r.CommitID)
			assert.NotEmpty(t, r.Lines)
		}
		DecodeJSON(t, MakeRequest(t, livesyncAPI(t, "GET", "/search/code?q=Welcome", other, nil), http.StatusOK), &result)
		assert.False(t, result.Enabled)
		assert.Empty(t, result.Results)
	})
}
