// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"context"
	"fmt"
	"net/http"

	"forgejo.org/modules/git"
	"forgejo.org/services/livesync/protocol"
)

// apiCommitRefs answers GET /-/sync/api/repos/{id}/refs/{commit}: the
// branches and tags that contain a commit (protocol.APICommitRefs), as the
// classic commit page's load-branches-and-tags (repo_service
// .LoadBranchesAndTags) lists them, for readers of the code. The commit is
// a full SHA (404 otherwise, or when the repository has no such commit).
func apiCommitRefs(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, "")
	if a == nil {
		return
	}
	_, gitRepo := a.codeRepo("commit")
	if gitRepo == nil {
		return
	}
	defer gitRepo.Close()
	commit := a.commit(gitRepo, "commit")
	if commit == nil {
		return
	}
	refs, err := commitRefs(a.ctx, gitRepo, commit.ID.String())
	if err != nil {
		a.internal("list the refs containing the commit", err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	a.json(http.StatusOK, refs)
}

// commitRefs lists the branches and tags of gitRepo that contain sha,
// newest first (never nil lists: JSON arrays).
func commitRefs(ctx context.Context, gitRepo *git.Repository, sha string) (*protocol.APICommitRefs, error) {
	branches, err := gitRepo.ListOccurrences(ctx, "branch", sha)
	if err != nil {
		return nil, fmt.Errorf("branches: %w", err)
	}
	tags, err := gitRepo.ListOccurrences(ctx, "tag", sha)
	if err != nil {
		return nil, fmt.Errorf("tags: %w", err)
	}
	if branches == nil {
		branches = []string{}
	}
	if tags == nil {
		tags = []string{}
	}
	return &protocol.APICommitRefs{Branches: branches, Tags: tags}, nil
}
