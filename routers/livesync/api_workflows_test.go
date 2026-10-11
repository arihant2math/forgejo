// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWorkflowDispatchSchema(t *testing.T) {
	for _, event := range []string{"workflow_dispatch", "[push, workflow_dispatch]", "{workflow_dispatch: {}}"} {
		schema, err := workflowDispatchSchema("deploy.yml", []byte("on: "+event+"\njobs: {}\n"))
		require.NoError(t, err)
		assert.True(t, schema.Dispatchable, event)
	}
	schema, err := workflowDispatchSchema("deploy.yml", []byte(`on:
  workflow_dispatch:
    inputs:
      target:
        description: Deployment target
        type: choice
        required: true
        default: staging
        options: [staging, production]
      dry_run:
        type: boolean
        default: true
      count:
        type: number
        default: 2
      message:
        default: hello
jobs: {}
`))
	require.NoError(t, err)
	assert.Equal(t, "deploy.yml", schema.File)
	assert.True(t, schema.Dispatchable)
	require.Len(t, schema.Inputs, 4)
	assert.Equal(t, dispatchInput{Name: "count", Type: "number", Default: "2"}, schema.Inputs[0])
	assert.Equal(t, dispatchInput{Name: "dry_run", Type: "boolean", Default: "true"}, schema.Inputs[1])
	assert.Equal(t, "string", schema.Inputs[2].Type)
	assert.Equal(t, dispatchInput{Name: "target", Description: "Deployment target", Type: "choice", Required: true, Default: "staging", Options: []string{"staging", "production"}}, schema.Inputs[3])
	schema, err = workflowDispatchSchema("ci.yml", []byte("on: push\njobs: {}\n"))
	require.NoError(t, err)
	assert.False(t, schema.Dispatchable)
	_, err = workflowDispatchSchema("bad.yml", []byte("on: ["))
	require.Error(t, err)
}
