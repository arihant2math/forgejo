// Copyright 2017 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT

package repo_test

import (
	"context"
	"testing"

	"forgejo.org/models/db"
	"forgejo.org/models/perm"
	repo_model "forgejo.org/models/repo"
	"forgejo.org/models/unittest"
	user_model "forgejo.org/models/user"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"xorm.io/builder"
)

func TestRepoAssignees(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())

	repo2 := unittest.AssertExistsAndLoadBean(t, &repo_model.Repository{ID: 2})
	users, err := repo_model.GetRepoAssignees(db.DefaultContext, repo2)
	require.NoError(t, err)
	assert.Len(t, users, 1)
	assert.Equal(t, int64(2), users[0].ID)

	repo21 := unittest.AssertExistsAndLoadBean(t, &repo_model.Repository{ID: 21})
	users, err = repo_model.GetRepoAssignees(db.DefaultContext, repo21)
	require.NoError(t, err)
	if assert.Len(t, users, 3) {
		assert.ElementsMatch(t, []int64{15, 16, 18}, []int64{users[0].ID, users[1].ID, users[2].ID})
	}

	// do not return deactivated users
	require.NoError(t, user_model.UpdateUserCols(db.DefaultContext, &user_model.User{ID: 15, IsActive: false}, "is_active"))
	users, err = repo_model.GetRepoAssignees(db.DefaultContext, repo21)
	require.NoError(t, err)
	if assert.Len(t, users, 2) {
		assert.NotContains(t, []int64{users[0].ID, users[1].ID}, 15)
	}
}

func TestRepoGetReviewers(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())

	// test public repo
	repo1 := unittest.AssertExistsAndLoadBean(t, &repo_model.Repository{ID: 1})

	ctx := db.DefaultContext
	reviewers, err := repo_model.GetReviewers(ctx, repo1, 2, 2)
	require.NoError(t, err)
	if assert.Len(t, reviewers, 3) {
		assert.ElementsMatch(t, []int64{1, 4, 11}, []int64{reviewers[0].ID, reviewers[1].ID, reviewers[2].ID})
	}

	// should include doer if doer is not PR poster.
	reviewers, err = repo_model.GetReviewers(ctx, repo1, 11, 2)
	require.NoError(t, err)
	assert.Len(t, reviewers, 3)

	// should not include PR poster, if PR poster would be otherwise eligible
	reviewers, err = repo_model.GetReviewers(ctx, repo1, 11, 4)
	require.NoError(t, err)
	assert.Len(t, reviewers, 2)

	// test private user repo
	repo2 := unittest.AssertExistsAndLoadBean(t, &repo_model.Repository{ID: 2})

	reviewers, err = repo_model.GetReviewers(ctx, repo2, 2, 4)
	require.NoError(t, err)
	assert.Len(t, reviewers, 1)
	assert.EqualValues(t, 2, reviewers[0].ID)

	// test private org repo
	repo3 := unittest.AssertExistsAndLoadBean(t, &repo_model.Repository{ID: 3})

	reviewers, err = repo_model.GetReviewers(ctx, repo3, 2, 1)
	require.NoError(t, err)
	assert.Len(t, reviewers, 2)

	reviewers, err = repo_model.GetReviewers(ctx, repo3, 2, 2)
	require.NoError(t, err)
	assert.Len(t, reviewers, 1)
}

func GetWatchedRepoIDsOwnedBy(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())

	user1 := unittest.AssertExistsAndLoadBean(t, &user_model.User{ID: 9})
	user2 := unittest.AssertExistsAndLoadBean(t, &user_model.User{ID: 1})

	repoIDs, err := repo_model.GetWatchedRepoIDsOwnedBy(db.DefaultContext, user1.ID, user2.ID)
	require.NoError(t, err)
	assert.Len(t, repoIDs, 1)
	assert.EqualValues(t, 1, repoIDs[0])
}

// allowAll is a RepositoryAuthorizationReducer that reduces nothing.
type allowAll struct{}

func (allowAll) ReduceRepoAccess(_ context.Context, _ *repo_model.Repository, mode perm.AccessMode) (perm.AccessMode, error) {
	return mode, nil
}
func (allowAll) RepoReadAccessFilter() builder.Cond { return builder.NewCond() }

func TestGetStarredReposOrder(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	ctx := db.DefaultContext
	// User 2 stars repositories 2 (star 1) and 4 (star 2) in the fixtures; and now repository 1.
	require.NoError(t, repo_model.StarRepo(ctx, 2, 1, true))
	setStarred := func(repoID, unix int64) {
		_, err := db.GetEngine(ctx).Exec("UPDATE `star` SET created_unix = ? WHERE uid = 2 AND repo_id = ?", unix, repoID)
		require.NoError(t, err)
	}
	ids := func(opts db.ListOptions) []int64 {
		repos, err := repo_model.GetStarredRepos(ctx, 2, true, opts, allowAll{})
		require.NoError(t, err)
		out := make([]int64, 0, len(repos))
		for _, r := range repos {
			out = append(out, r.ID)
		}
		return out
	}

	// Most recently starred first.
	setStarred(2, 300)
	setStarred(4, 100)
	setStarred(1, 200)
	assert.Equal(t, []int64{2, 1, 4}, ids(db.ListOptions{}))
	assert.Equal(t, []int64{2, 1}, ids(db.ListOptions{Page: 1, PageSize: 2}))
	assert.Equal(t, []int64{4}, ids(db.ListOptions{Page: 2, PageSize: 2}))

	// Starred at the same time: the later star first, so that pages are stable.
	setStarred(2, 100)
	setStarred(1, 100)
	assert.Equal(t, []int64{1, 4, 2}, ids(db.ListOptions{}))
	assert.Equal(t, []int64{1, 4}, ids(db.ListOptions{Page: 1, PageSize: 2}))
	assert.Equal(t, []int64{2}, ids(db.ListOptions{Page: 2, PageSize: 2}))
}
