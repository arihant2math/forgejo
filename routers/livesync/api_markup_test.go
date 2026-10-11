// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"bytes"
	"strings"
	"testing"

	"forgejo.org/modules/markup/markdown"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A wiki page renders as the classic wiki page: links to other pages and
// images resolve in the wiki, not in the repository's code.
func TestWikiRenderContext(t *testing.T) {
	var out bytes.Buffer
	text := "[a](Other-Page) [[Home]] [d](sub/Deep) ![i](logo.png) [x](https://example.com/)"
	require.NoError(t, markdown.Render(wikiRenderContext(t.Context(), "/user2/repo1", nil), strings.NewReader(text), &out))
	html := out.String()
	assert.Contains(t, html, `href="/user2/repo1/wiki/Other-Page"`)
	assert.Contains(t, html, `href="/user2/repo1/wiki/Home"`)
	assert.Contains(t, html, `href="/user2/repo1/wiki/sub/Deep"`)
	assert.Contains(t, html, `src="/user2/repo1/wiki/raw/logo.png"`)
	assert.Contains(t, html, `href="https://example.com/"`)
	assert.NotContains(t, html, "/src/")
}
