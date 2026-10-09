// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"context"

	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/log"
	"forgejo.org/services/livesync/perm"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/services/livesync/synclog"
)

// permSink applies the permission epochs (protocol.OpPermission entries)
// that the tailer reads to the instance's grant cache, then hands the
// entries on. Every instance runs it, so a permission change committed on
// any instance invalidates the cached grants everywhere; entries are passed
// on only after the epochs among them were applied, so the next sink (the
// hub, B5) never checks a later entry against grants older than an epoch
// that precedes it.
type permSink struct {
	cache *perm.Cache
	next  synclog.Sink
	// delivered, if not nil, is called after every batch: idempotent
	// writes waiting for the materializer re-check (B7; a remote writer's
	// progress shows up here).
	delivered func()
}

func (s permSink) Deliver(ctx context.Context, entries []livesync_model.LogEntry) {
	for i := range entries {
		ch, ok, err := perm.DecodeChange(&entries[i])
		if !ok {
			continue
		}
		if err != nil {
			log.Error("%v; dropping every cached grant", err)
			ch = protocol.PermissionChange{All: true}
		}
		s.cache.Invalidate(ch)
	}
	s.next.Deliver(ctx, entries)
	if s.delivered != nil {
		s.delivered()
	}
}

// Skipped drops every cached grant: epochs among the trimmed entries are
// unknown.
func (s permSink) Skipped(ctx context.Context, from, floor int64) {
	s.cache.Invalidate(protocol.PermissionChange{All: true})
	s.next.Skipped(ctx, from, floor)
}

// Permissions returns the running instance's grant cache (nil when
// livesync is not running). Routers and the hub check every group a viewer
// asks for with it.
func Permissions() *perm.Cache {
	mu.Lock()
	defer mu.Unlock()
	if current == nil || current.ctx.Err() != nil {
		return nil
	}
	return current.perms
}
