// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import "forgejo.org/services/livesync/idempotency"

// Idempotency returns the running instance's idempotency store (nil when
// livesync is not running). routers/livesync serves the API v1 writes that
// carry an Idempotency-Key with it (B7).
func Idempotency() *idempotency.Service {
	mu.Lock()
	defer mu.Unlock()
	if current == nil || current.ctx.Err() != nil {
		return nil
	}
	return current.idem
}
