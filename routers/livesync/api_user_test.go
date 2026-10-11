// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"testing"

	"forgejo.org/modules/translation"
	"forgejo.org/services/livesync/protocol"

	"github.com/stretchr/testify/assert"
)

func TestUserOptions(t *testing.T) {
	names := map[string]string{"themes.names.forgejo-auto": "Forgejo (follow system theme)", "themes.names.blank": " "}
	name := func(key string) (string, bool) {
		n, ok := names[key]
		return n, ok
	}
	got := userOptions([]string{"forgejo-auto", "custom", "blank"}, "forgejo-auto",
		[]*translation.LangType{{Lang: "de-DE", Name: "Deutsch"}, {Lang: "en-US", Name: "English"}}, name)
	assert.Equal(t, &protocol.APIUserOptions{
		Themes: []protocol.APIOption{
			{ID: "forgejo-auto", Name: "Forgejo (follow system theme)"},
			{ID: "custom", Name: "custom"}, // no translation: its id, as the classic page shows it
			{ID: "blank", Name: "blank"},
		},
		DefaultTheme: "forgejo-auto",
		Languages:    []protocol.APIOption{{ID: "de-DE", Name: "Deutsch"}, {ID: "en-US", Name: "English"}},
	}, got)

	// Never null lists on the wire.
	empty := userOptions(nil, "", nil, name)
	assert.NotNil(t, empty.Themes)
	assert.NotNil(t, empty.Languages)
}
