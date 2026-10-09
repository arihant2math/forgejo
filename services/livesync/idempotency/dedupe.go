// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package idempotency

import (
	"context"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	issues_model "forgejo.org/models/issues"
	livesync_model "forgejo.org/models/livesync"
	repo_model "forgejo.org/models/repo"
	"forgejo.org/modules/json"
	api "forgejo.org/modules/structs"
	"forgejo.org/modules/timeutil"
	"forgejo.org/modules/util"
)

// dedupeSlack widens the crash window backwards: entities carry the clock
// of the instance that created them, the record the clock of the instance
// that reserved it.
const dedupeSlack = 5 * time.Second

// ErrNoDuplicate is returned by FindDuplicate when the request is not one of
// the creates it checks or nothing matches: the request runs again.
var ErrNoDuplicate = errors.New("livesync: no entity of an earlier attempt found")

// Duplicate is an entity an interrupted attempt created.
type Duplicate struct {
	// Status is the status the create answers with (201 for issues and
	// comments, 200 for reviews, as API v1 does).
	Status int
	// Path is the API v1 path, relative to /api/v1, that reads the entity
	// in the same representation the create returns.
	Path string
}

// FindDuplicate is the crash-window check of PLAN §4.8: when an earlier
// attempt with the same key may have committed its write (the record was
// found in flight with its instance gone, or the attempt ended with a server
// error), it looks for the entity that attempt would have created — same
// user, same target, same content, created since the record was first
// reserved — for the creates of issues (POST /repos/{o}/{r}/issues),
// comments (POST /repos/{o}/{r}/issues/{n}/comments) and reviews (POST
// /repos/{o}/{r}/pulls/{n}/reviews), with a JSON body. apiPath is the request
// path relative to /api/v1. It returns ErrNoDuplicate when the request is not
// one of these or nothing matches: the request then runs again.
//
// It is a heuristic ("prevented in practice"): an entity edited after its
// creation no longer matches, and the code comments of a review whose
// submission was interrupted are created again.
func FindDuplicate(ctx context.Context, userID int64, method, apiPath, contentType string, body []byte, since timeutil.TimeStamp) (*Duplicate, error) {
	if method != http.MethodPost || !isJSON(contentType) {
		return nil, ErrNoDuplicate
	}
	seg := strings.Split(strings.Trim(apiPath, "/"), "/")
	if len(seg) < 4 || seg[0] != "repos" {
		return nil, ErrNoDuplicate
	}
	owner, name := seg[1], seg[2]
	since -= timeutil.TimeStamp(dedupeSlack / time.Second)
	switch {
	case len(seg) == 4 && seg[3] == "issues":
		var opt api.CreateIssueOption
		if json.Unmarshal(body, &opt) != nil {
			return nil, ErrNoDuplicate
		}
		return findIssue(ctx, userID, owner, name, opt, since)
	case len(seg) == 6 && seg[3] == "issues" && seg[5] == "comments":
		var opt api.CreateIssueCommentOption
		index, err := strconv.ParseInt(seg[4], 10, 64)
		if err != nil || json.Unmarshal(body, &opt) != nil {
			return nil, ErrNoDuplicate
		}
		return findComment(ctx, userID, owner, name, index, opt, since)
	case len(seg) == 6 && seg[3] == "pulls" && seg[5] == "reviews":
		var opt api.CreatePullReviewOptions
		index, err := strconv.ParseInt(seg[4], 10, 64)
		if err != nil || json.Unmarshal(body, &opt) != nil {
			return nil, ErrNoDuplicate
		}
		return findReview(ctx, userID, owner, name, index, opt, since)
	}
	return nil, ErrNoDuplicate
}

func isJSON(contentType string) bool {
	mt, _, err := mime.ParseMediaType(contentType)
	return err == nil && (mt == "application/json" || strings.HasSuffix(mt, "+json"))
}

func repoPath(owner, name string) string {
	return "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(name)
}

func findRepo(ctx context.Context, owner, name string) (*repo_model.Repository, error) {
	repo, err := repo_model.GetRepositoryByOwnerAndName(ctx, owner, name)
	if repo_model.IsErrRepoNotExist(err) {
		return nil, ErrNoDuplicate
	}
	if err != nil {
		return nil, fmt.Errorf("livesync: dedupe: repository %s/%s: %w", owner, name, err)
	}
	return repo, nil
}

func findIssueByIndex(ctx context.Context, owner, name string, index int64) (*issues_model.Issue, error) {
	repo, err := findRepo(ctx, owner, name)
	if err != nil {
		return nil, err
	}
	issue, err := issues_model.GetIssueByIndex(ctx, repo.ID, index)
	if issues_model.IsErrIssueNotExist(err) {
		return nil, ErrNoDuplicate
	}
	if err != nil {
		return nil, fmt.Errorf("livesync: dedupe: issue %s/%s#%d: %w", owner, name, index, err)
	}
	return issue, nil
}

// The candidates are read from the master (a replica may not have the
// interrupted attempt's write yet) and compared in Go: MySQL's default
// collations compare case- and trailing-space-insensitively.

func findIssue(ctx context.Context, userID int64, owner, name string, opt api.CreateIssueOption, since timeutil.TimeStamp) (*Duplicate, error) {
	repo, err := findRepo(ctx, owner, name)
	if err != nil {
		return nil, err
	}
	// NewIssue trims and truncates the title so.
	title, _ := util.SplitStringAtByteN(strings.TrimSpace(opt.Title), 255)
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return nil, err
	}
	var issues []issues_model.Issue
	if err := e.Where("repo_id = ? AND poster_id = ? AND is_pull = ? AND created_unix >= ?", repo.ID, userID, false, since).
		Asc("id").Find(&issues); err != nil {
		return nil, fmt.Errorf("livesync: dedupe: issues: %w", err)
	}
	for _, issue := range issues {
		if issue.Title == title && issue.Content == opt.Body {
			return &Duplicate{Status: http.StatusCreated, Path: repoPath(owner, name) + "/issues/" + strconv.FormatInt(issue.Index, 10)}, nil
		}
	}
	return nil, ErrNoDuplicate
}

func findComment(ctx context.Context, userID int64, owner, name string, index int64, opt api.CreateIssueCommentOption, since timeutil.TimeStamp) (*Duplicate, error) {
	issue, err := findIssueByIndex(ctx, owner, name, index)
	if err != nil {
		return nil, err
	}
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return nil, err
	}
	var comments []issues_model.Comment
	if err := e.Where("issue_id = ? AND poster_id = ? AND type = ? AND created_unix >= ?", issue.ID, userID, issues_model.CommentTypeComment, since).
		Asc("id").Find(&comments); err != nil {
		return nil, fmt.Errorf("livesync: dedupe: comments: %w", err)
	}
	for _, c := range comments {
		if c.Content == opt.Body {
			return &Duplicate{Status: http.StatusCreated, Path: repoPath(owner, name) + "/issues/comments/" + strconv.FormatInt(c.ID, 10)}, nil
		}
	}
	return nil, ErrNoDuplicate
}

// reviewTypes maps a review event to the type CreatePullReview gives the
// review (preparePullReviewType).
var reviewTypes = map[api.ReviewStateType]issues_model.ReviewType{
	api.ReviewStateApproved:       issues_model.ReviewTypeApprove,
	api.ReviewStateRequestChanges: issues_model.ReviewTypeReject,
	api.ReviewStateComment:        issues_model.ReviewTypeComment,
}

func findReview(ctx context.Context, userID int64, owner, name string, index int64, opt api.CreatePullReviewOptions, since timeutil.TimeStamp) (*Duplicate, error) {
	issue, err := findIssueByIndex(ctx, owner, name, index)
	if err != nil {
		return nil, err
	}
	if !issue.IsPull {
		return nil, ErrNoDuplicate
	}
	reviewType, ok := reviewTypes[opt.Event]
	if !ok {
		reviewType = issues_model.ReviewTypePending
	}
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return nil, err
	}
	// A submission may complete a pending review created earlier: its
	// updated_unix, not its created_unix, is the submission's time.
	var reviews []issues_model.Review
	if err := e.Where("issue_id = ? AND reviewer_id = ? AND type = ? AND updated_unix >= ?", issue.ID, userID, reviewType, since).
		Asc("id").Find(&reviews); err != nil {
		return nil, fmt.Errorf("livesync: dedupe: reviews: %w", err)
	}
	for _, r := range reviews {
		if r.Content == opt.Body {
			return &Duplicate{Status: http.StatusOK, Path: repoPath(owner, name) + "/pulls/" + strconv.FormatInt(index, 10) + "/reviews/" + strconv.FormatInt(r.ID, 10)}, nil
		}
	}
	return nil, ErrNoDuplicate
}
