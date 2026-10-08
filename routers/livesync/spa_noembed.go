// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

//go:build !livesync_embed

package livesync

import "io/fs"

// embeddedSPA returns nil: this binary has no embedded Next UI (see
// spa_embed.go); [livesync] ASSETS_DIR serves one from disk.
func embeddedSPA() fs.FS { return nil }
