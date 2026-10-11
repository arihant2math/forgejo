// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package template

import (
	"testing"

	api "forgejo.org/modules/structs"

	"github.com/stretchr/testify/require"
)

func TestTemplateAssignees(t *testing.T) {
	for _, tt := range []struct {
		name, content string
	}{
		{"bug.md", "---\nname: Bug\nabout: Report a bug\nassignees: alice, bob\n---\nDescribe it"},
		{"bug.yaml", "name: Bug\nabout: Report a bug\nassignees: [alice, bob]\nbody:\n  - type: input\n    id: details\n    attributes:\n      label: Details\n"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			tmpl, err := Unmarshal(tt.name, []byte(tt.content))
			require.NoError(t, err)
			require.Equal(t, api.IssueTemplateLabels{"alice", "bob"}, tmpl.Assignees)
		})
	}
}
