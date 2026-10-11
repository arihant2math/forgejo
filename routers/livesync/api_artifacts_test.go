// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestArtifactTicket(t *testing.T) {
	ticket := artifactTicket{User: 2, Repo: 3, Artifact: 4, Expires: 160}
	signed := signArtifactTicket(ticket)
	got, ok := parseArtifactTicket(signed, 100)
	require.True(t, ok)
	assert.Equal(t, ticket, got)
	_, ok = parseArtifactTicket(signed, 160)
	assert.False(t, ok, "expired at the boundary")
	parts := strings.Split(signed, ".")
	forged := signArtifactTicket(artifactTicket{User: 2, Repo: 99, Artifact: 4, Expires: 160})
	_, ok = parseArtifactTicket(strings.Split(forged, ".")[0]+"."+parts[1], 100)
	assert.False(t, ok, "cannot change the repository")
	for _, invalid := range []string{"", "bad.bad", signed + ".extra", signArtifactTicket(artifactTicket{User: 0, Repo: 3, Artifact: 4, Expires: 160})} {
		_, ok := parseArtifactTicket(invalid, 100)
		assert.False(t, ok)
	}
}

func TestArtifactDownloadRejectsInvalidTicket(t *testing.T) {
	w := httptest.NewRecorder()
	apiArtifactDownload(w, httptest.NewRequest("GET", "/-/sync/api/artifact-download?ticket=invalid", nil))
	assert.Equal(t, 404, w.Code)
	assert.Equal(t, "no-store", w.Header().Get("Cache-Control"))
	assert.Equal(t, "no-referrer", w.Header().Get("Referrer-Policy"))
}
