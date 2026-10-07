// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"context"
	"maps"

	repo_model "forgejo.org/models/repo"
	"forgejo.org/modules/gitrepo"
	"forgejo.org/modules/log"
	"forgejo.org/modules/markup"
	"forgejo.org/modules/markup/markdown"
)

// renderMarkdown renders an issue/comment/review/release body to sanitized
// HTML with Forgejo's markup service, the way the issue page does (same
// links base and repository metas), but without a viewer, so that the
// result is the same for everyone who may read it (PLAN §4.4).
//
// Viewer-independence (checked against modules/markup and
// services/markup.ProcessorHelper, B3):
//   - @mentions: ProcessorHelper.IsUsernameMentionable checks the mentioned
//     user's visibility against the viewer only for a web request context
//     (*app_context.Context); with any other context it links public users
//     only. So limited/private users are never linked (for any reader) —
//     a safe subset of what the classic UI shows a signed-in viewer.
//   - permalink file previews: ProcessorHelper.GetRepoFileBlob checks code
//     read access for the context's doer, which is nobody here, so only
//     code of public repositories is previewed (never private code; a
//     preview of the issue's own private repository is left out too).
//   - issue references (#1, owner/repo#1), commit SHAs, team mentions: the
//     links depend on the repository (metas, git repository) only; they are
//     rendered without checking whether the reader may see the target, as in
//     the classic UI (the text itself is in the body anyway).
//   - the " (comment)" suffix of a link to a comment is English (no locale
//     in the context); the classic UI translates it.
//
// The repository's git repository is opened once per batch (it verifies
// commit SHAs). If it cannot be opened (missing on disk), SHAs are left as
// plain text instead of being looked up for every one of them.
//
// A rendering error is logged and yields an empty body_html (the raw body
// is still sent); it must not stop the sync log.
func (l *loader) renderMarkdown(ctx context.Context, repo *repo_model.Repository, content string) string {
	if content == "" || repo == nil {
		return ""
	}
	rc := &markup.RenderContext{
		Ctx:   ctx,
		Links: markup.Links{Base: repo.Link()},
		Metas: repo.ComposeMetas(ctx),
	}
	gitRepo, ok := l.gitRepos[repo.ID]
	if !ok {
		var err error
		if gitRepo, err = gitrepo.OpenRepository(ctx, repo); err != nil {
			log.Debug("livesync: open %s for rendering: %v", repo.FullName(), err)
			gitRepo = nil
		}
		l.gitRepos[repo.ID] = gitRepo
	}
	if gitRepo != nil {
		rc.GitRepo = gitRepo
	} else {
		// Without repoPath the SHA processor does not try to open it.
		metas := maps.Clone(rc.Metas)
		delete(metas, "repoPath")
		rc.Metas = metas
	}
	html, err := markdown.RenderString(rc, content)
	if err != nil {
		log.Warn("livesync: render markdown of %s: %v", repo.FullName(), err)
		return ""
	}
	return string(html)
}

// close releases the git repositories opened for rendering.
func (l *loader) close() {
	for _, r := range l.gitRepos {
		if r != nil {
			r.Close()
		}
	}
	l.gitRepos = nil
}
