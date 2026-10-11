// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"forgejo.org/modules/git"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/test"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCommitRefs(t *testing.T) {
	dir := t.TempDir()
	run := func(args ...string) string {
		cmd := exec.Command("git", append([]string{"-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"}, args...)...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null")
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
		return strings.TrimSpace(string(out))
	}
	commit := func(msg string) string {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "f.txt"), []byte(msg), 0o600))
		run("add", "f.txt")
		run("commit", "-m", msg)
		return run("rev-parse", "HEAD")
	}
	run("init", "-b", "main")
	first := commit("first")
	run("tag", "v1.0.0-rc.1")
	fix := commit("fix (#107)")
	run("tag", "-a", "v1.0.0", "-m", "One")
	run("checkout", "-b", "old", first)
	commit("elsewhere")
	run("checkout", "main")

	// modules/git runs with its own home directory (as Forgejo sets it up).
	defer test.MockVariableValue(&setting.Git.HomePath, t.TempDir())()
	require.NoError(t, git.InitSimple(context.Background()))
	gitRepo, err := git.OpenRepository(t.Context(), dir)
	require.NoError(t, err)
	defer gitRepo.Close()

	refs, err := commitRefs(t.Context(), gitRepo, fix)
	require.NoError(t, err)
	assert.Equal(t, []string{"main"}, refs.Branches)
	assert.Equal(t, []string{"v1.0.0"}, refs.Tags)

	refs, err = commitRefs(t.Context(), gitRepo, first)
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{"main", "old"}, refs.Branches)
	assert.ElementsMatch(t, []string{"v1.0.0", "v1.0.0-rc.1"}, refs.Tags)

	// Not contained anywhere but its own branch: empty lists, not null.
	other := run("rev-parse", "old")
	refs, err = commitRefs(t.Context(), gitRepo, other)
	require.NoError(t, err)
	assert.Equal(t, []string{"old"}, refs.Branches)
	assert.NotNil(t, refs.Tags)
	assert.Empty(t, refs.Tags)
}
