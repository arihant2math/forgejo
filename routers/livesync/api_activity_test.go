// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"strings"
	"testing"
	"time"

	user_model "forgejo.org/models/user"
	"forgejo.org/services/livesync/protocol"
	repo_service "forgejo.org/services/repository"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The output of `git log --no-merges --numstat --format=---%n%ct%n%aN%n%aE`:
// a commit with files (one binary), a commit without (an empty commit), an
// author name with spaces and a file named like the separator's neighbours.
const activityLog = `---
1760000300
Ada Lovelace
Ada@Example.com

3	1	README.md
-	-	logo.png
10	0	src/a b.go
---
1760000200
Grace Hopper
grace@example.com
---
1760000100
Ada L.
ada@example.com

0	7	--- notes.txt
`

func TestParseActivityLog(t *testing.T) {
	commits, err := parseActivityLog(strings.NewReader(activityLog))
	require.NoError(t, err)
	assert.Equal(t, []activityCommit{
		{time: 1760000300, name: "Ada Lovelace", email: "ada@example.com", additions: 13, deletions: 1},
		{time: 1760000200, name: "Grace Hopper", email: "grace@example.com"},
		{time: 1760000100, name: "Ada L.", email: "ada@example.com", deletions: 7},
	}, commits)

	empty, err := parseActivityLog(strings.NewReader(""))
	require.NoError(t, err)
	assert.Empty(t, empty)

	_, err = parseActivityLog(strings.NewReader("---\nnot a time\nx\ny\n"))
	require.Error(t, err)
}

func TestActivityOf(t *testing.T) {
	since := time.Unix(1700000000, 0)
	users := map[string]*user_model.User{
		"ada@example.com":     {ID: 1, Name: "ada", FullName: "Ada Lovelace"},
		"ada@work.example":    {ID: 1, Name: "ada", FullName: "Ada Lovelace"},
		"grace@example.com":   {ID: 2, Name: "grace"},
		"unknown@example.com": nil,
	}
	looked := map[string]int{}
	user := func(email string) *user_model.User {
		looked[email]++
		return users[email]
	}
	avatar := func(u *user_model.User) string { return "/avatars/" + u.Name }
	commits := []activityCommit{
		{time: 50, name: "Ada", email: "ada@example.com", additions: 1, deletions: 2},
		{time: 40, name: "Someone", email: "unknown@example.com", additions: 3},
		{time: 30, name: "Ada (work)", email: "ada@work.example", deletions: 4},
		{time: 20, name: "Grace", email: "grace@example.com"},
		{time: 10, name: "Ada", email: "ada@example.com"},
	}
	res := activityOf("abc", since, commits, user, avatar)
	assert.Equal(t, &protocol.APICommitActivity{
		Commit: "abc",
		Since:  1700000000,
		Authors: []protocol.APIActivityAuthor{
			{Name: "Ada Lovelace", Login: "ada", AvatarURL: "/avatars/ada"},
			{Name: "Someone"}, // no account: the name in the commits, no avatar
			{Name: "grace", Login: "grace", AvatarURL: "/avatars/grace"},
		},
		// Two emails of one account are one author.
		Commits: [][]int64{{50, 0, 1, 2}, {40, 1, 3, 0}, {30, 0, 0, 4}, {20, 2, 0, 0}, {10, 0, 0, 0}},
	}, res)
	for email, n := range looked {
		assert.Equal(t, 1, n, "each email is looked up once: %s", email)
	}

	// Past the limit: the newest commits, marked truncated.
	many := make([]activityCommit, protocol.MaxCommitActivity+1)
	for i := range many {
		many[i] = activityCommit{time: int64(len(many) - i), email: "unknown@example.com"}
	}
	res = activityOf("abc", since, many, user, avatar)
	assert.True(t, res.Truncated)
	assert.Len(t, res.Commits, protocol.MaxCommitActivity)
	assert.Equal(t, int64(len(many)), res.Commits[0][0])

	// No commits: empty lists (JSON arrays), not null.
	res = activityOf("abc", since, nil, user, avatar)
	assert.NotNil(t, res.Authors)
	assert.NotNil(t, res.Commits)
	assert.False(t, res.Truncated)
}

func TestContributorsOf(t *testing.T) {
	week := func(w int64, c, a, d int) *repo_service.WeekData {
		return &repo_service.WeekData{Week: w, Commits: c, Additions: a, Deletions: d}
	}
	stats := map[string]*repo_service.ContributorData{
		"total": {Name: "Total", TotalCommits: 4, Weeks: map[int64]*repo_service.WeekData{2000: week(2000, 3, 30, 3), 1000: week(1000, 1, 10, 1)}},
		"ada@example.com": {
			Name: "Ada Lovelace", Login: "ada", AvatarLink: "/avatars/ada", TotalCommits: 3,
			Weeks: map[int64]*repo_service.WeekData{2000: week(2000, 2, 20, 2), 1000: week(1000, 1, 10, 1)},
		},
		"someone@example.com": {
			Name: "Someone", AvatarLink: "https://gravatar.example/avatar/hash-of-the-email", TotalCommits: 1,
			Weeks: map[int64]*repo_service.WeekData{2000: week(2000, 1, 10, 1)},
		},
	}
	res := contributorsOf("abc", stats)
	assert.Equal(t, &protocol.APIContributors{
		Commit: "abc",
		Total:  []protocol.APIWeek{{Week: 1000, Commits: 1, Additions: 10, Deletions: 1}, {Week: 2000, Commits: 3, Additions: 30, Deletions: 3}},
		Contributors: []protocol.APIContributor{
			{Name: "Ada Lovelace", Login: "ada", AvatarURL: "/avatars/ada", Commits: 3, Weeks: []protocol.APIWeek{
				{Week: 1000, Commits: 1, Additions: 10, Deletions: 1}, {Week: 2000, Commits: 2, Additions: 20, Deletions: 2},
			}},
			// Without an account: no avatar (the classic graph's is derived from the email).
			{Name: "Someone", Commits: 1, Weeks: []protocol.APIWeek{{Week: 2000, Commits: 1, Additions: 10, Deletions: 1}}},
		},
	}, res)

	empty := contributorsOf("abc", map[string]*repo_service.ContributorData{})
	assert.NotNil(t, empty.Total)
	assert.NotNil(t, empty.Contributors)
}
