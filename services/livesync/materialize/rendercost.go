// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"bufio"
	"context"
	"io"
	"regexp"
	"strings"
	"time"

	"forgejo.org/modules/git"
	"forgejo.org/modules/references"
)

// The writer renders the bodies of the sync log one after the other, for
// everyone (upstream renders a body on the request of whoever views it).
// So what a body costs to render is what one poster can take from every
// reader's latency, and a body is cheap to post: API v1 has no rate limit
// by default and a 64 KiB body of @mentions took 1.45 s to render (backend
// audit, round 2). Three bounds keep the writer's rendering in proportion:
//
//   - renderCost estimates a body's rendering time from the markup
//     features that look something up, before rendering it; a body over
//     maxRenderCost is not rendered by the writer (or a snapshot) at all:
//     it is sent with body_truncated, and a client that shows it gets its
//     HTML from GET /-/sync/api/bodies, rendered on that request.
//   - prefillCommits answers the commit SHA lookups of a rendering with
//     one git process instead of one per missing SHA.
//   - renderShare bounds the share of the writer's time that rendering
//     takes, overall and per repository: once a share is used up, bodies
//     are sent with body_truncated until it is replenished, instead of the
//     sync log falling behind.

// Per-token costs of renderCost, measured with the markup service on
// SQLite (B-audit round 2; PostgreSQL and MySQL lookups are slower, which
// the margin of maxRenderCost absorbs).
const (
	// costPerByte: goldmark and the text processors.
	costPerByte = 500 * time.Nanosecond
	// costPerMention: services/markup's IsUsernameMentionable looks up
	// every @mention (each occurrence) in the database.
	costPerMention = 150 * time.Microsecond
	// costPerCommit: a distinct SHA-like word, answered by prefillCommits.
	costPerCommit = 70 * time.Microsecond
	// costPerRef: an issue reference (#1, !1) becomes a link.
	costPerRef = 10 * time.Microsecond
	// costPerPreview: a permalink of a file of this instance: the
	// preview reads the repository, the permission and the blob (the box
	// is then dropped, see stripFilePreviews).
	costPerPreview = 15 * time.Millisecond
	// costPerCrossRefSquared: owner/repo#1 references in one text node are
	// quadratic (1 000 on one line: 360 ms, 3 000: 3.6 s, and renderTimeout
	// does not interrupt it); the square of the body's count is a bound.
	costPerCrossRefSquared = 400 * time.Nanosecond
)

// maxRenderCost is the most a body may be estimated to cost for the writer
// to render it. Ordinary bodies cost a few milliseconds; it takes about
// 1 600 mentions, 16 file permalinks, 800 cross-repository references or
// 3 500 SHA-like words to exceed it; 64 KiB of plain text costs 33 ms,
// 64 KiB of #1 references 240 ms. A variable so that tests can change it.
var maxRenderCost = 250 * time.Millisecond

var (
	// commitCandidate is a superset of what modules/markup's
	// hashCurrentPattern checks with git: a run of 7 to 64 lowercase hex
	// digits between non-word characters.
	commitCandidate = regexp.MustCompile(`\b[0-9a-f]{7,64}\b`)
	// issueRef is a superset of references' issue references.
	issueRef = regexp.MustCompile(`[#!][0-9]+`)
	// crossRef is a superset of references' cross-repository issue
	// reference (owner/repo#1, owner/repo!1).
	crossRef = regexp.MustCompile(`[0-9A-Za-z_.-]+/[0-9A-Za-z_.-]+[#!][0-9]+`)
)

// renderCost estimates the time renderMarkdown takes to render content
// (see the cost constants). Over-estimates are safe: such a body is only
// rendered on request instead of by the writer.
func renderCost(content string) time.Duration {
	cost := time.Duration(len(content)) * costPerByte
	cost += time.Duration(len(references.FindAllMentionsBytes([]byte(content)))) * costPerMention
	cost += time.Duration(len(commitCandidates(content))) * costPerCommit
	// modules/markup's filePreviewPattern: https?://…/src/commit/{sha}/{path}#L…
	cost += time.Duration(strings.Count(content, "/src/commit/")) * costPerPreview
	cost += time.Duration(len(issueRef.FindAllStringIndex(content, -1))) * costPerRef
	refs := time.Duration(len(crossRef.FindAllStringIndex(content, -1)))
	cost += refs * refs * costPerCrossRefSquared
	return cost
}

// commitCandidates returns the distinct SHA-like words of content.
func commitCandidates(content string) []string {
	var res []string
	seen := map[string]bool{}
	for _, m := range commitCandidate.FindAllString(content, -1) {
		if !seen[m] {
			seen[m] = true
			res = append(res, m)
		}
	}
	return res
}

// prefillCommits fills known (the RenderContext's ShaExistCache) with
// whether each SHA-like word of content names an object of gitRepo, all
// through the repository's one `git cat-file --batch-check` process.
// modules/markup's hashCurrentPatternProcessor looks up every word it does
// not find in that cache with git.Repository.IsReferenceExist, whose error
// on a missing object discards the process: one new git process per
// missing SHA (4 ms each; 64 KiB of them took over a minute). The answers
// are the same (the object name as cat-file resolves it). Words it misses
// are left to the processor; it stops early when ctx is done.
func prefillCommits(ctx context.Context, gitRepo *git.Repository, content string, known map[string]bool) {
	var todo []string
	for _, c := range commitCandidates(content) {
		if _, ok := known[c]; !ok {
			todo = append(todo, c)
		}
	}
	if len(todo) == 0 {
		return
	}
	// The process belongs to the repository (it is reused after this
	// rendering): it runs with the repository's context, as in
	// IsReferenceExist, not with the rendering's deadline.
	_ = gitRepo.WithCatFileBatchCheck(gitRepo.Ctx, func(wr io.Writer, rd *bufio.Reader) error {
		for _, name := range todo {
			if ctx.Err() != nil {
				return nil
			}
			if _, err := wr.Write([]byte(name + "\n")); err != nil {
				return err
			}
			_, _, _, err := git.ReadBatchLine(rd)
			if err != nil && !git.IsErrNotExist(err) {
				return err // the pipe is in an unknown state: the process is discarded
			}
			known[name] = err == nil
		}
		return nil
	})
}

// renderShare bounds the time the writer spends rendering (see the top of
// this file) with token buckets of render time that fill with wall time:
// one for all rendering and one per repository, so that one repository's
// bodies cannot use up everyone's share. A rendering is allowed while both
// of its buckets hold time; what it took is then taken from both (they
// may go below zero by one rendering, which renderTimeout bounds). Not
// safe for concurrent use: the Materializer's mutex guards it.
type renderShare struct {
	now   func() time.Time
	all   renderBucket
	repos map[int64]*renderBucket
}

// The shares: rendering takes at most a quarter of the writer's time over
// time, and the bodies of one repository a tenth, with bursts of 20 s and
// 10 s of rendering (a migration of a few thousand comments).
const (
	shareAll       = 0.25
	shareAllBurst  = 20 * time.Second
	shareRepo      = 0.1
	shareRepoBurst = 10 * time.Second
	// maxShareRepos bounds the per-repository buckets kept; full ones
	// (equal to a new bucket) are dropped first.
	maxShareRepos = 1000
)

type renderBucket struct {
	level time.Duration // render time available
	at    time.Time     // when level was computed
}

func (b *renderBucket) fill(now time.Time, share float64, burst time.Duration) {
	if elapsed := now.Sub(b.at); elapsed > 0 {
		b.level = min(burst, b.level+time.Duration(float64(elapsed)*share))
	}
	b.at = now
}

func newRenderShare() *renderShare {
	return &renderShare{
		now:   time.Now,
		all:   renderBucket{level: shareAllBurst, at: time.Now()},
		repos: map[int64]*renderBucket{},
	}
}

// allow says whether a body of repository repo may be rendered now.
func (s *renderShare) allow(repo int64) bool {
	now := s.now()
	s.all.fill(now, shareAll, shareAllBurst)
	b := s.repo(repo, now)
	b.fill(now, shareRepo, shareRepoBurst)
	return s.all.level > 0 && b.level > 0
}

// charge takes the time a rendering of repository repo took from its
// buckets.
func (s *renderShare) charge(repo int64, took time.Duration) {
	now := s.now()
	s.all.fill(now, shareAll, shareAllBurst)
	s.all.level -= took
	b := s.repo(repo, now)
	b.fill(now, shareRepo, shareRepoBurst)
	b.level -= took
}

func (s *renderShare) repo(id int64, now time.Time) *renderBucket {
	if b, ok := s.repos[id]; ok {
		return b
	}
	if len(s.repos) >= maxShareRepos {
		for k, b := range s.repos {
			if b.fill(now, shareRepo, shareRepoBurst); b.level >= shareRepoBurst {
				delete(s.repos, k)
			}
		}
	}
	b := &renderBucket{level: shareRepoBurst, at: now}
	s.repos[id] = b
	return b
}
