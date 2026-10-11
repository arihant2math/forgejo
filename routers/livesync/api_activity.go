// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"bufio"
	"cmp"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	user_model "forgejo.org/models/user"
	"forgejo.org/modules/cache"
	"forgejo.org/modules/git"
	"forgejo.org/modules/json"
	"forgejo.org/services/livesync/protocol"
	repo_service "forgejo.org/services/repository"
)

// A repository's activity (protocol/api.go): the commit history behind the
// activity page's commit counts and top committers, and the classic
// contributors graphs' weekly statistics, both addressed by a commit SHA
// (the default branch's head, which the client knows from its synced
// Branch entities), so that every answer is cached forever and switching
// the page's period needs no request. They need the code unit, as the
// classic pages' commit data does (RequireRepoReaderOr(unit.TypeCode) on
// /activity/contributors/data and /activity_author_data).

// activityCacheKey is the server cache's key of a commit's APICommitActivity
// (computed once per commit for every viewer: it is the same for all).
const activityCacheKey = "livesync/activity/%d/%s"

// apiCommitActivity answers GET /-/sync/api/repos/{id}/activity/{commit}.
func apiCommitActivity(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, "")
	if a == nil {
		return
	}
	repo, gitRepo := a.codeRepo("commit")
	if gitRepo == nil {
		return
	}
	defer gitRepo.Close()
	commit := a.commit(gitRepo, "commit")
	if commit == nil {
		return
	}
	sha := commit.ID.String()
	if immutable(w, req, sha) {
		return
	}
	since := commit.Committer.When.AddDate(-1, 0, -1)
	body, err := cache.GetString(fmt.Sprintf(activityCacheKey, repo.ID, sha), func() (string, error) {
		res, err := commitActivity(a.ctx, gitRepo, sha, since)
		if err != nil {
			return "", err
		}
		b, err := json.Marshal(res)
		return string(b), err
	})
	if err != nil {
		w.Header().Del("ETag")
		w.Header().Del("Cache-Control")
		a.internal("read the history", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, body)
}

// activityCommit is a commit of `git log` as commitActivity reads it.
type activityCommit struct {
	time      int64
	name      string
	email     string
	additions int64
	deletions int64
}

// activityLogFormat is the --format of the log parseActivityLog reads: a
// separator line, the committer time, the author's name and email, then
// --numstat's lines ("added<TAB>deleted<TAB>path", "-" for binary files).
const activityLogFormat = "--format=---%n%ct%n%aN%n%aE"

// commitActivity reads the history of sha since `since` (see
// APICommitActivity) and names its authors.
func commitActivity(ctx context.Context, gitRepo *git.Repository, sha string, since time.Time) (*protocol.APICommitActivity, error) {
	cmd := git.NewCommand(ctx, "log", "--no-merges", "--numstat", "--no-renames", activityLogFormat).
		AddOptionFormat("--since=%s", since.UTC().Format("2006-01-02 15:04:05 +0000")).
		AddOptionFormat("--max-count=%d", protocol.MaxCommitActivity+1).
		AddDynamicArguments(sha)
	pr, pw := io.Pipe()
	var commits []activityCommit
	done := make(chan error, 1)
	go func() {
		var err error
		commits, err = parseActivityLog(pr)
		_ = pr.CloseWithError(err)
		done <- err
	}()
	stderr := new(strings.Builder)
	runErr := cmd.Run(&git.RunOpts{Dir: gitRepo.Path, Stdout: pw, Stderr: stderr})
	_ = pw.Close()
	parseErr := <-done
	if runErr != nil {
		return nil, fmt.Errorf("git log: %w (%s)", runErr, stderr)
	}
	if parseErr != nil {
		return nil, fmt.Errorf("parse git log: %w", parseErr)
	}
	return activityOf(sha, since, commits, func(email string) *user_model.User {
		u, err := user_model.GetUserByEmail(ctx, email)
		if err != nil {
			return nil
		}
		return u
	}, func(u *user_model.User) string { return u.AvatarLink(ctx) }), nil
}

// parseActivityLog reads `git log --numstat` in activityLogFormat.
func parseActivityLog(r io.Reader) ([]activityCommit, error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	var out []activityCommit
	var cur *activityCommit
	field := 0
	for sc.Scan() {
		line := sc.Text()
		if line == "---" {
			out = append(out, activityCommit{})
			cur = &out[len(out)-1]
			field = 1
			continue
		}
		if cur == nil {
			continue
		}
		switch field {
		case 1:
			t, err := strconv.ParseInt(strings.TrimSpace(line), 10, 64)
			if err != nil {
				return nil, fmt.Errorf("committer time %q: %w", line, err)
			}
			cur.time = t
			field++
		case 2:
			cur.name = strings.TrimSpace(line)
			field++
		case 3:
			cur.email = strings.ToLower(strings.TrimSpace(line))
			field++
		default:
			// A numstat line (a blank line comes before them).
			added, rest, ok := strings.Cut(line, "\t")
			if !ok {
				continue
			}
			deleted, _, ok := strings.Cut(rest, "\t")
			if !ok {
				continue
			}
			if n, err := strconv.ParseInt(added, 10, 64); err == nil {
				cur.additions += n
			}
			if n, err := strconv.ParseInt(deleted, 10, 64); err == nil {
				cur.deletions += n
			}
		}
	}
	return out, sc.Err()
}

// activityOf builds the response from the commits (newest first): authors
// by account (user looks an email up; nil: none) or else by email.
func activityOf(sha string, since time.Time, commits []activityCommit, user func(email string) *user_model.User, avatar func(*user_model.User) string) *protocol.APICommitActivity {
	res := &protocol.APICommitActivity{Commit: sha, Since: since.Unix(), Authors: []protocol.APIActivityAuthor{}, Commits: [][]int64{}}
	if len(commits) > protocol.MaxCommitActivity {
		commits = commits[:protocol.MaxCommitActivity]
		res.Truncated = true
	}
	byEmail := map[string]int64{}
	byUser := map[int64]int64{}
	for _, c := range commits {
		at, ok := byEmail[c.email]
		if !ok {
			author := protocol.APIActivityAuthor{Name: c.name}
			var u *user_model.User
			if c.email != "" {
				u = user(c.email)
			}
			if u != nil {
				if i, seen := byUser[u.ID]; seen {
					at = i
					byEmail[c.email] = at
					res.Commits = append(res.Commits, []int64{c.time, at, c.additions, c.deletions})
					continue
				}
				author = protocol.APIActivityAuthor{Name: u.DisplayName(), Login: u.Name, AvatarURL: avatar(u)}
			}
			at = int64(len(res.Authors))
			res.Authors = append(res.Authors, author)
			byEmail[c.email] = at
			if u != nil {
				byUser[u.ID] = at
			}
		}
		res.Commits = append(res.Commits, []int64{c.time, at, c.additions, c.deletions})
	}
	return res
}

// apiContributors answers GET /-/sync/api/repos/{id}/contributors/{commit}:
// the classic contributors graphs' statistics (GetContributorStats, which
// computes them in the background and caches them): 202 with Retry-After
// while they are computed.
func apiContributors(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, "")
	if a == nil {
		return
	}
	repo, gitRepo := a.codeRepo("commit")
	if gitRepo == nil {
		return
	}
	defer gitRepo.Close()
	// An unknown commit would be computed (and fail) in the background on
	// every request, answering 202 for ever.
	commit := a.commit(gitRepo, "commit")
	if commit == nil {
		return
	}
	sha := commit.ID.String()
	if immutable(w, req, sha) {
		return
	}
	stats, err := repo_service.GetContributorStats(a.ctx, cache.GetCache(), repo, sha)
	if err != nil {
		w.Header().Del("ETag")
		w.Header().Del("Cache-Control")
		if errors.Is(err, repo_service.ErrAwaitGeneration) {
			w.Header().Set("Retry-After", "2")
			a.json(http.StatusAccepted, errorResponse{Message: "the statistics are being computed; retry later"})
			return
		}
		a.internal("contributor statistics", err)
		return
	}
	writeImmutableJSON(w, contributorsOf(sha, stats))
}

// contributorsOf turns GetContributorStats' map (by email, plus "total")
// into the response: weeks oldest first, contributors most commits first,
// no email addresses (nor the avatar derived from one of an author without
// an account).
func contributorsOf(sha string, stats map[string]*repo_service.ContributorData) *protocol.APIContributors {
	res := &protocol.APIContributors{Commit: sha, Total: []protocol.APIWeek{}, Contributors: []protocol.APIContributor{}}
	for key, c := range stats {
		if c == nil {
			continue
		}
		weeks := weeksOf(c.Weeks)
		if key == "total" {
			res.Total = weeks
			continue
		}
		contributor := protocol.APIContributor{Name: c.Name, Login: c.Login, Commits: c.TotalCommits, Weeks: weeks}
		if c.Login != "" {
			contributor.AvatarURL = c.AvatarLink
		}
		res.Contributors = append(res.Contributors, contributor)
	}
	slices.SortFunc(res.Contributors, func(x, y protocol.APIContributor) int {
		return cmp.Or(cmp.Compare(y.Commits, x.Commits), strings.Compare(x.Name, y.Name), strings.Compare(x.Login, y.Login))
	})
	return res
}

func weeksOf(m map[int64]*repo_service.WeekData) []protocol.APIWeek {
	out := make([]protocol.APIWeek, 0, len(m))
	for _, w := range m {
		if w != nil {
			out = append(out, protocol.APIWeek{Week: w.Week, Commits: w.Commits, Additions: w.Additions, Deletions: w.Deletions})
		}
	}
	slices.SortFunc(out, func(x, y protocol.APIWeek) int { return cmp.Compare(x.Week, y.Week) })
	return out
}
