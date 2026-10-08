// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

//go:build livesync_embed

package livesync

import (
	"embed"
	"io/fs"
)

// With the livesync_embed build tag the Next UI's build is compiled into the
// binary: copy next/dist to routers/livesync/next_dist before building
// (`rm -rf routers/livesync/next_dist && cp -r next/dist routers/livesync/next_dist`;
// the directory is ignored by git). [livesync] ASSETS_DIR still wins when set.
//
//go:embed all:next_dist
var embeddedDist embed.FS

// embeddedSPA returns the embedded build.
func embeddedSPA() fs.FS {
	sub, err := fs.Sub(embeddedDist, "next_dist")
	if err != nil {
		return nil
	}
	return sub
}
