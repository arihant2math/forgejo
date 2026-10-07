// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"context"
	"fmt"

	livesync_model "forgejo.org/models/livesync"
	user_model "forgejo.org/models/user"
	"forgejo.org/services/livesync/hub"
	"forgejo.org/services/livesync/materialize"
	"forgejo.org/services/livesync/protocol"
)

// Hub returns the running instance's sync hub (nil when livesync is not
// running). routers/livesync serves the sync sessions with it.
func Hub() *hub.Hub {
	mu.Lock()
	defer mu.Unlock()
	if current == nil || current.ctx.Err() != nil {
		return nil
	}
	return current.hub
}

// ownProfile is the viewer's User entity for the welcome message, with the
// sync id of the last entry the materializer wrote for it as its version.
func ownProfile(ctx context.Context, viewerID int64) (*protocol.Change, error) {
	u, err := user_model.GetUserByID(ctx, viewerID)
	if err != nil {
		return nil, err
	}
	dto, group := materialize.Profile(ctx, u)
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return nil, err
	}
	var entity livesync_model.Entity
	if _, err := e.Where("tbl = ? AND row_id = ?", "user", viewerID).Get(&entity); err != nil {
		return nil, fmt.Errorf("livesync: entity index of user %d: %w", viewerID, err)
	}
	return &protocol.Change{V: entity.LastSyncID, G: group, M: protocol.ModelUser, ID: u.ID, Op: protocol.OpUpsert, D: dto}, nil
}
