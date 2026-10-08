// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"context"
	"errors"
	"maps"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	repo_model "forgejo.org/models/repo"
	"forgejo.org/modules/git"
	"forgejo.org/modules/gitrepo"
	"forgejo.org/modules/json"
	"forgejo.org/modules/log"
	"forgejo.org/modules/markup"
	"forgejo.org/modules/markup/markdown"
	"forgejo.org/services/livesync/metrics"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// renderMarkdown renders an issue/comment/review/release body to sanitized
// HTML with Forgejo's markup service, the way the issue page does (same
// links base and repository metas), but without a viewer, so that the
// result is the same for everyone who may read it (PLAN §4.4). complete is
// false when it did not finish within renderTimeout or failed (the HTML is
// then empty).
//
// Viewer-independence (checked against modules/markup and
// services/markup.ProcessorHelper, B3):
//   - @mentions: ProcessorHelper.IsUsernameMentionable checks the mentioned
//     user's visibility against the viewer only for a web request context
//     (*app_context.Context); with any other context it links public users
//     only. So limited/private users are never linked (for any reader) —
//     a safe subset of what the classic UI shows a signed-in viewer.
//   - permalink file previews: the markup service embeds the lines of a
//     file of any repository that is public when the body is rendered (as
//     anonymous). The HTML is rendered once and kept (log entries, snapshot
//     reuse, clients' stores), so the code would stay readable after the
//     repository became private or was deleted (backend audit). So no
//     previews: each preview box is replaced by the link it previews
//     (stripFilePreviews); the client may show the lines itself through the
//     permission-checked git endpoints (/-/sync/api/repos/{id}/raw/…).
//   - issue references (#1, owner/repo#1), commit SHAs, team mentions: the
//     links depend on the repository (metas, git repository) only; they are
//     rendered without checking whether the reader may see the target, as in
//     the classic UI (the text itself is in the body anyway).
//   - the " (comment)" suffix of a link to a comment is English (no locale
//     in the context); the classic UI translates it.
//
// The repository's git repository is opened once per batch (it verifies
// commit SHAs, all of a body's at once: prefillCommits; the answers are
// kept for the loader's other bodies). If it cannot be opened (missing on
// disk), SHAs are left as plain text instead of being looked up for every
// one of them.
//
// Cost (backend audit): the markup service looks every @mention up in the
// database, so a large body full of mentions takes seconds to render. The
// rendering runs with its own context, detached from ctx's transaction (its
// lookups use other connections, so cutting them off cannot abort the
// writer's transaction) and cancelled after renderTimeout: the lookups
// then fail at once and the result is discarded. The deadline does not
// interrupt work that looks nothing up (goldmark, the processors' regular
// expressions: 64 KiB of owner/repo#1 references on one line take
// minutes); what the writer and snapshots render at all is bounded by
// loader.render (rendercost.go).
//
// A rendering error is logged and yields an incomplete render (the raw body
// is still sent); it must not stop the sync log.
func (l *loader) renderMarkdown(ctx context.Context, repo *repo_model.Repository, content string) (string, bool) {
	if content == "" || repo == nil {
		return "", true
	}
	renderCount.Add(1)
	rc := &markup.RenderContext{
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
	rctx, cancel := renderContext(ctx)
	defer cancel()
	rc.Ctx = rctx
	if gitRepo != nil {
		rc.GitRepo = gitRepo
		known := l.commits[repo.ID]
		if known == nil {
			known = map[string]bool{}
			l.commits[repo.ID] = known
		}
		prefillCommits(rctx, gitRepo, content, known)
		rc.ShaExistCache = known
	} else {
		// Without repoPath the SHA processor does not try to open it.
		metas := maps.Clone(rc.Metas)
		delete(metas, "repoPath")
		rc.Metas = metas
	}
	html, err := markdown.RenderString(rc, content)
	if rctx.Err() != nil {
		metrics.RenderSkipped.WithLabelValues("timeout").Inc()
		log.Warn("livesync: rendering a body of %d bytes in %s took longer than %s; it is sent without HTML", len(content), repo.FullName(), renderTimeout)
		return "", false
	}
	if err != nil {
		log.Warn("livesync: render markdown of %s: %v", repo.FullName(), err)
		return "", false
	}
	return stripFilePreviews(string(html)), true
}

// renderTimeout bounds one rendering of a body (renderMarkdown). A
// variable so that tests can shorten it.
var renderTimeout = 5 * time.Second

// renderContext returns the context a body is rendered with: not derived
// from ctx (whose engine may be the writer's transaction: a lookup cut off
// on the transaction's session would abort it, and one on the session
// cannot be cut off by a deadline of a derived context at all), cancelled
// when ctx is done or after renderTimeout.
func renderContext(ctx context.Context) (context.Context, context.CancelFunc) {
	rctx, cancel := context.WithTimeout(context.Background(), renderTimeout)
	stop := context.AfterFunc(ctx, cancel)
	return rctx, func() {
		stop()
		cancel()
	}
}

// errRenderBudget is returned by loader.render when a strict loader's
// render budget is used up: the writer transaction gives up and the batch
// is materialized row by row (Materializer.isolate), each row with a budget
// of its own.
var errRenderBudget = errors.New("livesync: the markdown of the batch took longer to render than its time budget")

// render is renderMarkdown for a DTO of the sync log or of a snapshot,
// within bounds (rendercost.go); a body it does not render is incomplete
// (sent with body_truncated, its HTML rendered on request by GET
// /-/sync/api/bodies):
//   - a body whose renderCost exceeds maxRenderCost is not rendered (a
//     function of the body and so the same in the log and in snapshots);
//   - with l.share (the writer's loaders), a body is not rendered while
//     the writer's render share, overall or of the body's repository, is
//     used up, and the time each rendering takes is charged to it;
//   - once the time spent rendering with l reaches l.budget, a strict
//     loader returns errRenderBudget and a lenient one renders nothing
//     more.
func (l *loader) render(ctx context.Context, repo *repo_model.Repository, content string) (string, bool, error) {
	if l.budget > 0 && l.spent >= l.budget {
		if l.strict {
			return "", false, errRenderBudget
		}
		return "", false, nil
	}
	if content == "" || repo == nil {
		return "", true, nil
	}
	if cost := renderCost(content); cost > maxRenderCost {
		metrics.RenderSkipped.WithLabelValues("cost").Inc()
		log.Debug("livesync: not rendering a body of %d bytes in %s, estimated to take %s; it is sent without HTML", len(content), repo.FullName(), cost)
		return "", false, nil
	}
	if l.share != nil && !l.share.allow(repo.ID) {
		metrics.RenderSkipped.WithLabelValues("share").Inc()
		log.Debug("livesync: the writer's render share of %s is used up; a body is sent without HTML", repo.FullName())
		return "", false, nil
	}
	start := time.Now()
	html, complete := l.renderMarkdown(ctx, repo, content)
	took := time.Since(start)
	l.spent += took
	if l.share != nil {
		l.share.charge(repo.ID, took)
	}
	metrics.RenderSeconds.Add(took.Seconds())
	return html, complete, nil
}

// stripFilePreviews replaces each file preview box of rendered markdown
// (modules/markup file_preview.go: div.file-preview-box) by a paragraph
// with a link to the lines it previews (the box's file link), see
// renderMarkdown. Boxes without a link (written by hand in the markdown)
// are kept: they hold only what the author wrote.
func stripFilePreviews(s string) string {
	if !strings.Contains(s, "file-preview-box") {
		return s
	}
	body := &html.Node{Type: html.ElementNode, Data: "body", DataAtom: atom.Body}
	nodes, err := html.ParseFragment(strings.NewReader(s), body)
	if err != nil {
		return s
	}
	changed := false
	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		for c := n.FirstChild; c != nil; {
			next := c.NextSibling
			if isPreviewBox(c) {
				if href := previewLink(c); href != "" {
					n.InsertBefore(linkParagraph(href), c)
					n.RemoveChild(c)
					changed = true
				}
			} else {
				walk(c)
			}
			c = next
		}
	}
	root := &html.Node{Type: html.DocumentNode}
	for _, n := range nodes {
		root.AppendChild(n)
	}
	walk(root)
	if !changed {
		return s
	}
	var b strings.Builder
	for c := root.FirstChild; c != nil; c = c.NextSibling {
		if err := html.Render(&b, c); err != nil {
			return s
		}
	}
	return b.String()
}

func isPreviewBox(n *html.Node) bool {
	return n.Type == html.ElementNode && n.DataAtom == atom.Div && hasClass(n, "file-preview-box")
}

// previewLink returns the href of a preview box's file link: the last link
// of the title (the first div of the box's div.header; the first link is
// the repository's when the preview is of another repository, the subtitle
// after the title links the commit).
func previewLink(box *html.Node) string {
	var header, title *html.Node
	for c := box.FirstChild; c != nil && header == nil; c = c.NextSibling {
		if c.Type == html.ElementNode && c.DataAtom == atom.Div && hasClass(c, "header") {
			header = c
		}
	}
	if header == nil {
		return ""
	}
	for c := header.FirstChild; c != nil && title == nil; c = c.NextSibling {
		if c.Type == html.ElementNode && c.DataAtom == atom.Div {
			title = c
		}
	}
	if title == nil {
		return ""
	}
	href := ""
	var find func(n *html.Node)
	find = func(n *html.Node) {
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.ElementNode && c.DataAtom == atom.A {
				for _, a := range c.Attr {
					if a.Key == "href" {
						href = a.Val
					}
				}
			}
			find(c)
		}
	}
	find(title)
	return href
}

func hasClass(n *html.Node, class string) bool {
	for _, a := range n.Attr {
		if a.Key == "class" && slices.Contains(strings.Fields(a.Val), class) {
			return true
		}
	}
	return false
}

func linkParagraph(href string) *html.Node {
	p := &html.Node{Type: html.ElementNode, Data: "p", DataAtom: atom.P}
	a := &html.Node{Type: html.ElementNode, Data: "a", DataAtom: atom.A, Attr: []html.Attribute{
		{Key: "href", Val: href}, {Key: "rel", Val: "nofollow"},
	}}
	a.AppendChild(&html.Node{Type: html.TextNode, Data: href})
	p.AppendChild(a)
	return p
}

// renderCount counts markdown renders (tests check that unchanged bodies
// are not rendered again).
var renderCount atomic.Int64

// renderVersion is the version of livesync's own rendering rules
// (renderMarkdown); it is part of renderEnv, so that a change re-renders
// every body at its next change and keeps snapshots from reusing the HTML
// of earlier entries. Version 1 (backend audit): no file previews.
const renderVersion = "1"

// renderEnv describes what renderMarkdown's output depends on besides the
// content: the repository's link and markup metas (owner and name, external
// tracker settings, …) and renderVersion. See entity.changeHash.
func (l *loader) renderEnv(ctx context.Context, repo *repo_model.Repository) string {
	if repo == nil {
		return ""
	}
	if env, ok := l.envs[repo.ID]; ok {
		return env
	}
	metas, err := json.Marshal(repo.ComposeMetas(ctx)) // map keys are sorted
	if err != nil {
		metas = nil // then only the link counts
	}
	env := renderVersion + "\x00" + repo.Link() + "\x00" + string(metas)
	l.envs[repo.ID] = env
	return env
}

// close releases the git repositories opened for rendering.
func (l *loader) close() {
	closeGitRepos(l.gitRepos)
	l.gitRepos = nil
}

// closeGitRepos closes the git repositories of a loader (or of the loaders
// of one snapshot, which share them).
func closeGitRepos(repos map[int64]*git.Repository) {
	for _, r := range repos {
		if r != nil {
			r.Close()
		}
	}
}

// RenderPreview renders markdown previews (the gap endpoint POST
// /-/sync/api/markdown) exactly as the materializer renders the body_html
// of an issue or comment of repo with that text (renderMarkdown: the same
// links base and metas, without a viewer, no file previews), so that a
// preview equals what the sync log will carry. Without repo the texts are
// rendered as plain markdown (no repository links or metas). A text that
// takes longer than the render timeout to render gets an empty preview.
func RenderPreview(ctx context.Context, repo *repo_model.Repository, texts []string) []string {
	res := make([]string, len(texts))
	if repo == nil {
		for i, text := range texts {
			if text == "" {
				continue
			}
			rctx, cancel := renderContext(ctx)
			html, err := markdown.RenderString(&markup.RenderContext{Ctx: rctx}, text)
			timedOut := rctx.Err() != nil
			cancel()
			if err != nil || timedOut {
				log.Warn("livesync: render a markdown preview: %v (timed out: %t)", err, timedOut)
				continue
			}
			res[i] = string(html)
		}
		return res
	}
	l := newLoader()
	defer l.close()
	for i, text := range texts {
		res[i], _ = l.renderMarkdown(ctx, repo, text)
	}
	return res
}
