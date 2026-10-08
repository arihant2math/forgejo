// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"runtime/debug"
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
// minutes); what the writer and snapshots render at all, and how long they
// wait for it, is bounded by loader.render (rendercost.go).
//
// A rendering error is logged and yields an incomplete render (the raw body
// is still sent); it must not stop the sync log.
func (l *loader) renderMarkdown(ctx context.Context, repo *repo_model.Repository, content string) (string, bool) {
	if content == "" || repo == nil {
		return "", true
	}
	j := l.prepareRender(ctx, repo, content)
	defer j.cancel()
	html, err := j.run()
	if err != nil {
		j.logFailure(err)
		return "", false
	}
	return html, true
}

// renderJob is one rendering of a body. prepareRender sets it up on the
// caller's goroutine, with everything that reads the loader, the
// repository or the caller's transaction; run uses only what the job
// holds, so that it can run on a goroutine of its own (renderBounded).
type renderJob struct {
	rc      *markup.RenderContext
	cancel  context.CancelFunc
	gitRepo *git.Repository // nil when the repository could not be opened
	known   map[string]bool // gitRepo's SHA cache (loader.commits)
	content string
	repoID  int64
	name    string // the repository's full name, for logs
}

func (l *loader) prepareRender(ctx context.Context, repo *repo_model.Repository, content string) *renderJob {
	renderCount.Add(1)
	j := &renderJob{content: content, repoID: repo.ID, name: repo.FullName()}
	j.rc = &markup.RenderContext{
		Links: markup.Links{Base: repo.Link()},
		// A copy: ComposeMetas returns the repository's cached map, which
		// renderEnv encodes, and issueIndexPatternProcessor writes
		// Metas["index"] for every external tracker reference it links
		// (an abandoned rendering would write it while the loader reads
		// it, and an earlier rendering's "index" would change renderEnv).
		Metas: maps.Clone(repo.ComposeMetas(ctx)),
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
	var rctx context.Context
	rctx, j.cancel = renderContext(ctx)
	j.rc.Ctx = rctx
	if gitRepo != nil {
		j.gitRepo, j.rc.GitRepo = gitRepo, gitRepo
		j.known = l.commits[repo.ID]
		if j.known == nil {
			j.known = map[string]bool{}
			l.commits[repo.ID] = j.known
		}
		j.rc.ShaExistCache = j.known
	} else {
		// Without repoPath the SHA processor does not try to open it.
		delete(j.rc.Metas, "repoPath")
	}
	return j
}

// errRenderTimeout: the rendering's context ended before it was done (its
// lookups failed, so its result is not used).
var errRenderTimeout = errors.New("livesync: rendering timed out")

// run renders the job's body. A panic of the markup service is an error
// (it may run on a goroutine of its own, where it would end the process).
func (j *renderJob) run() (html string, err error) {
	defer func() {
		if r := recover(); r != nil {
			html, err = "", fmt.Errorf("livesync: rendering panicked: %v\n%s", r, debug.Stack())
		}
	}()
	if j.gitRepo != nil {
		prefillCommits(j.rc.Ctx, j.gitRepo, j.content, j.known)
	}
	out, err := markdown.RenderString(j.rc, j.content)
	if j.rc.Ctx.Err() != nil {
		return "", errRenderTimeout
	}
	if err != nil {
		return "", err
	}
	return stripFilePreviews(string(out)), nil
}

func (j *renderJob) logFailure(err error) {
	if errors.Is(err, errRenderTimeout) {
		metrics.RenderSkipped.WithLabelValues("timeout").Inc()
		log.Warn("livesync: rendering a body of %d bytes in %s took longer than %s; it is sent without HTML", len(j.content), j.name, renderTimeout)
		return
	}
	log.Warn("livesync: render markdown of %s: %v", j.name, err)
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
//     function of the body and its repository's metas, and so the same in
//     the log and in snapshots);
//   - while maxAbandonedRenders abandoned renderings run, nothing is
//     rendered;
//   - with l.share (the writer's loaders), a body is not rendered while
//     the writer's render share, overall or of the body's repository, is
//     used up, and the time each rendering takes is charged to it;
//   - a rendering is waited for at most renderWait (renderBounded);
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
	if cost := renderCost(content, repo.ComposeMetas(ctx)); cost > maxRenderCost {
		metrics.RenderSkipped.WithLabelValues("cost").Inc()
		log.Debug("livesync: not rendering a body of %d bytes in %s, estimated to take %s; it is sent without HTML", len(content), repo.FullName(), cost)
		return "", false, nil
	}
	if n := abandonedRenders.Load(); n >= maxAbandonedRenders {
		metrics.RenderSkipped.WithLabelValues("busy").Inc()
		log.Debug("livesync: %d abandoned renderings still run; a body of %s is sent without HTML", n, repo.FullName())
		return "", false, nil
	}
	if l.share != nil && !l.share.allow(repo.ID) {
		metrics.RenderSkipped.WithLabelValues("share").Inc()
		log.Debug("livesync: the writer's render share of %s is used up; a body is sent without HTML", repo.FullName())
		return "", false, nil
	}
	html, complete, waited := l.renderBounded(ctx, repo, content)
	l.spent += waited
	if l.share != nil {
		l.share.charge(repo.ID, waited)
	}
	metrics.RenderSeconds.Add(waited.Seconds())
	return html, complete, nil
}

// renderWait is the longest loader.render waits for a rendering. A body
// estimated to render within maxRenderCost normally takes a few
// milliseconds; one that takes longer than renderWait is one the estimate
// does not know about. A variable so that tests can change it.
var renderWait = time.Second

// maxAbandonedRenders bounds the abandoned renderings (renderBounded) that
// run at a time, i.e. the CPU they take: while that many run, loader.render
// renders nothing (one abandoned per loader rendering at that moment may
// go beyond it: the writer and each snapshot being built). A variable so
// that tests can change it.
var maxAbandonedRenders int64 = 2

// abandonedRenders counts the abandoned renderings that still run.
var abandonedRenders atomic.Int64

// renderBounded is renderMarkdown on a goroutine of its own, waited for at
// most renderWait; waited is how long the caller waited. A rendering that
// takes longer is abandoned: its context is cancelled (its lookups fail at
// once from then on), the body is incomplete, and the goroutine runs to its
// end (goldmark and the post-processors cannot be interrupted) with the
// loader's git repository of the body's repository and its SHA cache,
// which the loader gives up (it opens another one if it needs one), and
// closes it. What it took beyond renderWait is charged to the repository's
// render share then (renderShare.chargeRepo).
func (l *loader) renderBounded(ctx context.Context, repo *repo_model.Repository, content string) (html string, complete bool, waited time.Duration) {
	j := l.prepareRender(ctx, repo, content)
	done := make(chan renderResult, 1)
	start := time.Now()
	go func() {
		html, err := j.run()
		done <- renderResult{html, err}
	}()
	timer := time.NewTimer(renderWait)
	defer timer.Stop()
	var r renderResult
	select {
	case r = <-done:
	case <-timer.C:
		select {
		case r = <-done: // done just in time
		default:
			return "", false, l.abandon(j, done, start)
		}
	}
	j.cancel()
	waited = time.Since(start)
	if r.err != nil {
		j.logFailure(r.err)
		return "", false, waited
	}
	return r.html, true, waited
}

type renderResult struct {
	html string
	err  error
}

// abandon leaves job j, still running, to a goroutine that waits for its
// end (done) and then releases what it holds (see renderBounded). It
// returns how long the caller waited.
func (l *loader) abandon(j *renderJob, done <-chan renderResult, start time.Time) time.Duration {
	j.cancel()
	waited := time.Since(start)
	if j.gitRepo != nil {
		delete(l.gitRepos, j.repoID)
		delete(l.commits, j.repoID)
	}
	abandonedRenders.Add(1)
	metrics.RenderSkipped.WithLabelValues("abandoned").Inc()
	log.Warn("livesync: rendering a body of %d bytes in %s takes longer than %s; it is sent without HTML", len(j.content), j.name, waited)
	share := l.share
	go func() {
		defer abandonedRenders.Add(-1)
		<-done
		took := time.Since(start)
		if j.gitRepo != nil {
			j.gitRepo.Close()
		}
		if share != nil {
			share.chargeRepo(j.repoID, took-waited)
		}
		metrics.RenderSeconds.Add((took - waited).Seconds())
		log.Info("livesync: an abandoned rendering of a body of %d bytes in %s ended after %s", len(j.content), j.name, took)
	}()
	return waited
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
