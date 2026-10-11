// Copyright 2016 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT

package structs

// CreateForkOption options for creating a fork
type CreateForkOption struct {
	// organization name, if forking into an organization
	Organization *string `json:"organization"`
	// name of the forked repository
	Name *string `json:"name"`
	// description of the fork; defaults to the source repository's description
	Description *string `json:"description"`
	// copy only the source repository's default branch
	DefaultBranchOnly bool `json:"default_branch_only"`
}

// SyncForkInfo information about syncing a fork
type SyncForkInfo struct {
	Allowed       bool   `json:"allowed"`
	ForkCommit    string `json:"fork_commit"`
	BaseCommit    string `json:"base_commit"`
	CommitsBehind int    `json:"commits_behind"`
}
