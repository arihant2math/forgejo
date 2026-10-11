// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestProjectTitle(t *testing.T) {
	for _, title := range []string{"Planning", " A board ", strings.Repeat("x", 255)} {
		assert.True(t, validProjectTitle(title))
	}
	for _, title := range []string{"", " \n", strings.Repeat("x", 256), string([]byte{0xff})} {
		assert.False(t, validProjectTitle(title))
	}
}

func TestProjectLifecycleWrites(t *testing.T) {
	assert.True(t, apiWrite(http.MethodPost, "/-/sync/api/projects"))
	assert.True(t, apiWrite(http.MethodPatch, "/-/sync/api/projects/1"))
	assert.True(t, apiWrite(http.MethodPut, "/-/sync/api/projects/1/state"))
	assert.True(t, apiWrite(http.MethodDelete, "/-/sync/api/projects/1"))
}
