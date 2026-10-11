// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	repo_model "forgejo.org/models/repo"
	"forgejo.org/models/unittest"
	"forgejo.org/services/livesync/protocol"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// livesyncAPIActivity: a repository's activity history and contributor
// statistics by commit (protocol/api.go). Runs after livesyncAPIGit, whose
// commits (by user2, through API v1) are repo1's newest.
func livesyncAPIActivity(t *testing.T, user2, user5 string) {
	repo1 := unittest.AssertExistsAndLoadBean(t, &repo_model.Repository{ID: 1})
	head := strings.TrimSpace(livesyncGit(t, repo1, "rev-parse", "HEAD"))
	headTime, err := strconv.ParseInt(strings.TrimSpace(livesyncGit(t, repo1, "show", "-s", "--format=%ct", head)), 10, 64)
	require.NoError(t, err)

	// The history: newest first, since a year and a day before the head,
	// authors by account, immutable by commit.
	var activity protocol.APICommitActivity
	resp := MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/activity/"+head, user2, nil), http.StatusOK)
	DecodeJSON(t, resp, &activity)
	assert.Equal(t, protocol.CacheImmutable, resp.Header().Get("Cache-Control"))
	assert.Equal(t, `"`+head+`"`, resp.Header().Get("ETag"))
	assert.Equal(t, head, activity.Commit)
	assert.Equal(t, time.Unix(headTime, 0).AddDate(-1, 0, -1).Unix(), activity.Since)
	require.NotEmpty(t, activity.Commits)
	assert.Equal(t, headTime, activity.Commits[0][0], "the head is the newest commit")
	for _, c := range activity.Commits {
		require.Len(t, c, 4)
		assert.GreaterOrEqual(t, c[0], activity.Since)
		require.Less(t, c[1], int64(len(activity.Authors)))
	}
	newest := activity.Authors[activity.Commits[0][1]]
	assert.Equal(t, "user2", newest.Login, "the commit made through API v1 is the token user's")
	assert.NotEmpty(t, newest.AvatarURL)
	assert.NotContains(t, resp.Body.String(), "@", "no email addresses")
	MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/activity/"+head, user2, nil).SetHeader("If-None-Match", `"`+head+`"`), http.StatusNotModified)
	// Again (from the server's cache): the same answer.
	var again protocol.APICommitActivity
	DecodeJSON(t, MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/activity/"+head, user2, nil), http.StatusOK), &again)
	assert.Equal(t, activity, again)

	// The contributor statistics: computed in the background (202 with
	// Retry-After meanwhile), then immutable by commit.
	var contributors protocol.APIContributors
	first := MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/contributors/"+head, user2, nil), NoExpectedStatus)
	if first.Code == http.StatusAccepted {
		assert.Equal(t, "2", first.Header().Get("Retry-After"))
		assert.Equal(t, "no-store", first.Header().Get("Cache-Control"))
		assert.Empty(t, first.Header().Get("ETag"))
	}
	assert.Eventually(t, func() bool {
		resp = MakeRequest(t, livesyncAPI(t, "GET", "/repos/1/contributors/"+head, user2, nil), NoExpectedStatus)
		return resp.Code == http.StatusOK
	}, livesyncWait, 50*time.Millisecond)
	DecodeJSON(t, resp, &contributors)
	assert.Equal(t, protocol.CacheImmutable, resp.Header().Get("Cache-Control"))
	assert.Equal(t, `"`+head+`"`, resp.Header().Get("ETag"))
	assert.Equal(t, head, contributors.Commit)
	require.NotEmpty(t, contributors.Total)
	require.NotEmpty(t, contributors.Contributors)
	var total int64
	for _, c := range contributors.Contributors {
		total += c.Commits
	}
	var weekly int
	for i, w := range contributors.Total {
		weekly += w.Commits
		if i > 0 {
			assert.Greater(t, w.Week, contributors.Total[i-1].Week, "weeks oldest first")
		}
	}
	assert.EqualValues(t, total, weekly, "every commit is in a week")
	assert.NotContains(t, resp.Body.String(), "@", "no email addresses")

	// Not content-addressed, unknown commits, other repositories.
	for _, path := range []string{"/activity/master", "/activity/" + head[:7], "/contributors/master", "/activity/" + strings.Repeat("0", 40), "/contributors/" + strings.Repeat("0", 40)} {
		MakeRequest(t, livesyncAPI(t, "GET", "/repos/1"+path, user2, nil), http.StatusNotFound)
	}
	// Private repo2: 404 for user5, readable by its owner.
	repo2 := unittest.AssertExistsAndLoadBean(t, &repo_model.Repository{ID: 2})
	head2 := strings.TrimSpace(livesyncGit(t, repo2, "rev-parse", "HEAD"))
	for _, path := range []string{"/activity/" + head2, "/contributors/" + head2} {
		MakeRequest(t, livesyncAPI(t, "GET", "/repos/2"+path, user5, nil), http.StatusNotFound)
		MakeRequest(t, livesyncAPI(t, "GET", "/repos/2"+path, "", nil), http.StatusUnauthorized)
	}
	MakeRequest(t, livesyncAPI(t, "GET", "/repos/2/activity/"+head2, user2, nil), http.StatusOK)
	MakeRequest(t, livesyncAPI(t, "GET", "/repos/999999/activity/"+head2, user2, nil), http.StatusNotFound)
}
