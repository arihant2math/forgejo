// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"net/http"
	"strconv"
	"strings"

	"forgejo.org/models/db"
	repo_model "forgejo.org/models/repo"
	"forgejo.org/modules/git"
	code_indexer "forgejo.org/modules/indexer/code"
	"forgejo.org/modules/setting"
	chi "github.com/go-chi/chi/v5"
)

func codeSearchPage(value string) int {
	page, err := strconv.Atoi(value)
	if err != nil || page < 1 {
		return 1
	}
	return min(page, 100)
}

func apiCodeSearch(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, "")
	if a == nil {
		return
	}
	q := strings.TrimSpace(req.URL.Query().Get("q"))
	page := codeSearchPage(req.URL.Query().Get("page"))
	if len(q) > 1000 {
		a.error(http.StatusBadRequest, "Search query is too long")
		return
	}
	results := code_indexer.Results{}
	total := 0
	enabled := setting.Indexer.RepoIndexerEnabled
	var ids []int64
	if chi.URLParam(req, "id") != "" {
		repo, gr := a.codeRepo()
		if gr == nil {
			return
		}
		defer gr.Close()
		ids = []int64{repo.ID}
		if !enabled && q != "" {
			ref := req.URL.Query().Get("ref")
			if ref == "" {
				ref = repo.DefaultBranch
			}
			commit, err := gr.GetCommit(ref)
			if err != nil {
				a.notFound()
				return
			}
			found, err := git.GrepSearch(a.ctx, gr, q, git.GrepOptions{RefName: commit.ID.String(), MaxResultLimit: 5000, MatchesPerFile: 20, ContextLineNumber: 1, Mode: git.FixedGrepMode})
			if err != nil {
				a.internal("search code", err)
				return
			}
			total = len(found)
			start, end := min((page-1)*50, total), min(page*50, total)
			for _, r := range found[start:end] {
				results = append(results, &code_indexer.Result{RepoID: repo.ID, Filename: r.Filename, CommitID: commit.ID.String(), Lines: code_indexer.HighlightSearchResultCode(r.Filename, r.LineNumbers, r.HighlightedRanges, strings.Join(r.LineCodes, "\n"))})
			}
		}
	} else {
		if !enabled || setting.Service.Explore.DisableCodePage {
			a.json(http.StatusOK, map[string]any{"enabled": false, "total": 0, "results": results})
			return
		}
		var err error
		ids, err = repo_model.FindUserCodeAccessibleRepoIDs(a.ctx, a.viewer)
		if err != nil {
			a.internal("find readable repositories", err)
			return
		}
	}
	if enabled && q != "" && len(ids) > 0 {
		mode := code_indexer.SearchModeExact
		if req.URL.Query().Get("fuzzy") == "true" && setting.Indexer.RepoIndexerEnableFuzzy {
			mode = code_indexer.SearchModeFuzzy
		}
		var err error
		total, results, _, err = code_indexer.PerformSearch(a.ctx, &code_indexer.SearchOptions{RepoIDs: ids, Keyword: q, Mode: mode, Paginator: &db.ListOptions{Page: page, PageSize: 50}})
		if err != nil {
			a.error(http.StatusServiceUnavailable, "Code indexer is unavailable")
			return
		}
	}
	repos, err := repo_model.GetRepositoriesMapByIDs(a.ctx, results.RepoIDs())
	if err != nil {
		a.internal("load repositories", err)
		return
	}
	names := map[int64]string{}
	for id, r := range repos {
		names[id] = r.FullName()
	}
	a.json(http.StatusOK, map[string]any{"enabled": enabled, "total": total, "results": results, "repositories": names})
}
