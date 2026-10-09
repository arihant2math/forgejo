// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"testing"

	issues_model "forgejo.org/models/issues"

	"github.com/stretchr/testify/assert"
)

// The wire names of a pull request's mergeability are the protocol's (lower case), not Go's String().
func TestPullStatus(t *testing.T) {
	assert.Equal(t, "conflict", pullStatus(issues_model.PullRequestStatusConflict))
	assert.Equal(t, "checking", pullStatus(issues_model.PullRequestStatusChecking))
	assert.Equal(t, "mergeable", pullStatus(issues_model.PullRequestStatusMergeable))
	assert.Equal(t, "manually_merged", pullStatus(issues_model.PullRequestStatusManuallyMerged))
	assert.Equal(t, "error", pullStatus(issues_model.PullRequestStatusError))
	assert.Equal(t, "empty", pullStatus(issues_model.PullRequestStatusEmpty))
	assert.Equal(t, "ancestor", pullStatus(issues_model.PullRequestStatusAncestor))
}
