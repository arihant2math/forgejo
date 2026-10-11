// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"testing"

	"forgejo.org/modules/setting"
	"github.com/stretchr/testify/assert"
)

func TestCodeSearchPage(t *testing.T) {
	for _, value := range []string{"", "bad", "-1", "0", "99999999999999999999"} {
		assert.Equal(t, 1, codeSearchPage(value))
	}
	assert.Equal(t, 2, codeSearchPage("2"))
	assert.Equal(t, 100, codeSearchPage("100000"))
}

func TestCodeSearchConfig(t *testing.T) {
	old := setting.Indexer.RepoIndexerEnabled
	t.Cleanup(func() { setting.Indexer.RepoIndexerEnabled = old })
	for _, enabled := range []bool{true, false} {
		setting.Indexer.RepoIndexerEnabled = enabled
		assert.Equal(t, enabled, nextConfig().CodeIndexerEnabled)
	}
}
