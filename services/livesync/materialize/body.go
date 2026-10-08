// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"context"
	"fmt"

	repo_model "forgejo.org/models/repo"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/services/livesync/protocol"
)

// bodyTables are the tables of the entities with a markdown body, by model.
var bodyTables = map[protocol.Model]string{
	protocol.ModelIssueBody: "issue",
	protocol.ModelComment:   "comment",
	protocol.ModelReview:    "review",
	protocol.ModelRelease:   "release",
}

// FullBody is the complete body of an entity (GET /-/sync/api/bodies, for
// a payload with BodyTruncated): where the entity is (Group, Unit: the
// caller checks that the viewer may read them) and its source.
type FullBody struct {
	Group          string
	Unit           protocol.Unit
	Body           string
	ContentVersion int
	repo           *repo_model.Repository
}

// LoadBody returns the complete body of entity model/id (IssueBody,
// Comment, Review or Release), placed as the materializer places it; false
// when the model has no body, or the entity does not exist or is in no
// group.
func LoadBody(ctx context.Context, model protocol.Model, id int64) (FullBody, bool, error) {
	var res FullBody
	table, ok := bodyTables[model]
	if !ok {
		return res, false, nil
	}
	found := false
	err := capture.WithQuietTx(ctx, func(ctx context.Context) error {
		l := newLoader()
		defer l.close()
		loaded, err := specs[table].load(ctx, l, []int64{id}, true)
		if err != nil {
			return err
		}
		for _, e := range loaded[id] {
			if e.model != model || e.group == "" || e.err != nil || len(e.renders) != 1 {
				continue
			}
			r := e.renders[0]
			res, found = FullBody{Group: e.group, Unit: e.unit, Body: r.content, repo: r.repo}, true
			switch dto := e.dto.(type) {
			case *protocol.IssueBody:
				res.ContentVersion = dto.ContentVersion
			case *protocol.Comment:
				res.ContentVersion = dto.ContentVersion
			}
		}
		return nil
	})
	if err != nil {
		return res, false, fmt.Errorf("livesync: load the body of %s %d: %w", model, id, err)
	}
	return res, found, nil
}

// Render renders the body as the sync log renders body_html
// (renderMarkdown), without the size limits; complete is false when it
// could not be rendered within the render timeout.
func (b *FullBody) Render(ctx context.Context) (html string, complete bool) {
	l := newLoader()
	defer l.close()
	return l.renderMarkdown(ctx, b.repo, b.Body)
}
