// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"bytes"
	"net/http"
	"sort"
	"strings"

	"forgejo.org/models/unit"
	"forgejo.org/modules/actions"
	"forgejo.org/services/livesync/protocol"

	act_model "code.forgejo.org/forgejo/runner/v13/act/model"
	chi "github.com/go-chi/chi/v5"
)

type dispatchInput struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Type        string   `json:"type"`
	Required    bool     `json:"required"`
	Default     string   `json:"default"`
	Options     []string `json:"options"`
}

type dispatchWorkflow struct {
	File         string          `json:"file"`
	Dispatchable bool            `json:"dispatchable"`
	Inputs       []dispatchInput `json:"inputs,omitempty"`
}

func workflowDispatchSchema(file string, content []byte) (dispatchWorkflow, error) {
	result := dispatchWorkflow{File: file}
	wf, err := act_model.ReadWorkflow(bytes.NewReader(content), false)
	if err != nil {
		return result, err
	}
	config := wf.WorkflowDispatchConfig()
	if config == nil {
		return result, nil
	}
	result.Dispatchable = true
	for name, input := range config.Inputs {
		kind := input.Type
		if kind == "" {
			kind = "string"
		}
		result.Inputs = append(result.Inputs, dispatchInput{name, input.Description, kind, input.Required, input.Default, input.Options})
	}
	sort.Slice(result.Inputs, func(i, j int) bool { return result.Inputs[i].Name < result.Inputs[j].Name })
	return result, nil
}

// apiWorkflows lists workflow files on the default branch; the file route reads
// inputs at the chosen ref, using the same parser as workflow dispatch.
func apiWorkflows(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, "")
	if a == nil {
		return
	}
	repo, gitRepo := a.codeRepo()
	if gitRepo == nil {
		return
	}
	defer gitRepo.Close()
	if !a.readable(protocol.RepoGroup(repo.ID), protocol.UnitActions) {
		return
	}
	_, permission, ok := a.repoPermission(repo.ID)
	if !ok {
		return
	}
	ref := req.URL.Query().Get("ref")
	if ref == "" {
		ref = repo.DefaultBranch
	}
	commit, err := gitRepo.GetCommit(ref)
	if err != nil {
		a.notFound()
		return
	}
	_, entries, err := actions.ListWorkflows(commit)
	if err != nil {
		a.internal("list workflows", err)
		return
	}
	file := chi.URLParam(req, "file")
	if file != "" && (strings.ContainsAny(file, "/\\") || file == "." || file == "..") {
		a.notFound()
		return
	}
	workflows := make([]dispatchWorkflow, 0, len(entries))
	for _, entry := range entries {
		if file != "" && entry.Name() != file {
			continue
		}
		content, err := actions.GetContentFromEntry(entry)
		if err != nil {
			a.internal("read workflow", err)
			return
		}
		schema, err := workflowDispatchSchema(entry.Name(), content)
		if err != nil {
			if file != "" {
				a.error(http.StatusUnprocessableEntity, "The workflow could not be parsed.")
				return
			}
			workflows = append(workflows, dispatchWorkflow{File: entry.Name()})
			continue
		}
		if file != "" {
			a.json(http.StatusOK, schema)
			return
		}
		schema.Inputs = nil
		workflows = append(workflows, schema)
	}
	if file != "" {
		a.notFound()
		return
	}
	a.json(http.StatusOK, struct {
		Workflows   []dispatchWorkflow `json:"workflows"`
		CanDispatch bool               `json:"can_dispatch"`
	}{workflows, permission.CanWrite(unit.TypeActions) && !repo.IsArchived})
}
