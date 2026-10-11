// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWhitespaceDiff(t *testing.T) {
	dir := t.TempDir()
	run := func(args ...string) string {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null")
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
		return string(out)
	}
	run("init")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "space.txt"), []byte("one two\nthree four\n"), 0o600))
	run("add", "space.txt")
	run("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "Source")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "space.txt"), []byte("one  two\nthree four  \n"), 0o600))
	assert.NotEmpty(t, run("diff", "HEAD"))
	for _, value := range []string{"ignore-all", "ignore-change"} {
		flag, valid := diffWhitespaceFlag(value)
		require.True(t, valid)
		assert.Empty(t, run("diff", flag, "HEAD"))
	}
	flag, _ := diffWhitespaceFlag("ignore-eol")
	out := run("diff", flag, "HEAD")
	assert.Contains(t, out, "+one  two")
	assert.NotContains(t, out, "+three four")
}

func TestDiffWhitespaceFlag(t *testing.T) {
	for _, tc := range []struct {
		value string
		flag  string
		valid bool
	}{
		{"", "", true},
		{"ignore-all", "-w", true},
		{"ignore-change", "-b", true},
		{"ignore-eol", "--ignore-space-at-eol", true},
		{"invalid", "", false},
		{"--output=/tmp/diff", "", false},
	} {
		t.Run(tc.value, func(t *testing.T) {
			flag, valid := diffWhitespaceFlag(tc.value)
			assert.Equal(t, tc.flag, flag)
			assert.Equal(t, tc.valid, valid)
		})
	}
}
