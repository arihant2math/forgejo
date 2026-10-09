// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

//go:build livesync_embed

package livesync

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// With the livesync_embed tag the build in next_dist is served without
// ASSETS_DIR (run after copying next/dist, see spa_embed.go).
func TestSPAEmbedded(t *testing.T) {
	h := spaHandler(t, "", innerMarker)
	require.True(t, h.spa.available())
	assert.Equal(t, "embedded", h.spa.source)
	rec := get(t, h, "/-/next/callback")
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `id="forgejo-next-config"`)
	assert.Contains(t, rec.Header().Get("Content-Security-Policy"), "'sha256-")
}
