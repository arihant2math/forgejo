// Copyright 2024 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT

package structs

// Compare represents a comparison between two commits
type Compare struct {
	MergeBase    string                 `json:"merge_base"`
	HeadCommitID string                 `json:"head_commit_id"`
	HeadRepoID   int64                  `json:"head_repo_id"`
	TotalCommits int                    `json:"total_commits"` // Total number of commits in the comparison.
	Commits      []*Commit              `json:"commits"`       // List of commits in the comparison.
	Files        []*CommitAffectedFiles `json:"files"`         // Total files modified in this comparison.
}
