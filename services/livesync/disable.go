// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"context"
	"fmt"

	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/log"
	"forgejo.org/modules/setting"
	"forgejo.org/services/livesync/capture"
)

// Disable is the kill switch, run by routers/livesync.Wrap when Init
// returned ErrDisabled ([livesync] ENABLED = false): the capture triggers
// of an earlier run would otherwise keep filling livesync_change, which
// nothing drains while livesync is off (B2 ops note (a)).
//
// On a database livesync never ran on (no livesync_meta table) and on
// SQLite it does nothing but that one check. Otherwise, with INSTALL_MODE
// auto, it removes the triggers and empties the outbox
// (capture.Uninstall); with INSTALL_MODE verify (Forgejo may not change
// the schema) it only logs the DDL a DBA runs to remove them. Enabling
// livesync again later reinstalls them and bumps every schema epoch, so
// clients re-bootstrap what changed meanwhile.
//
// All instances sharing a database must agree on ENABLED: a running
// instance in auto mode puts the triggers back within
// triggerCheckInterval (and bumps the epochs).
//
// Errors are returned for the caller to log; Forgejo serves the classic UI
// either way.
func Disable(ctx context.Context) error {
	if !setting.Database.Type.IsPostgreSQL() && !setting.Database.Type.IsMySQL() {
		return nil
	}
	if err := livesync_model.CheckPool(); err != nil {
		return nil // livesync could not have run on this pool either
	}
	exists, err := livesync_model.MetaTableExists(ctx)
	if err != nil || !exists {
		return err
	}
	if Setting.InstallMode == InstallModeVerify {
		st, err := capture.Inspect(ctx)
		if err != nil {
			return err
		}
		if script := st.UninstallScript(); script != "" {
			log.Warn("livesync: disabled, but its capture triggers are still installed and fill livesync_change with every change (INSTALL_MODE = verify: Forgejo does not remove them); a DBA can remove them with:\n%s", script)
		}
		return nil
	}
	report, err := capture.Uninstall(ctx)
	if err != nil {
		return fmt.Errorf("%w; the installed triggers keep filling livesync_change; remove them by hand (see /-/sync/admin while enabled, or capture.UninstallScript)", err)
	}
	if report.Dropped > 0 {
		log.Info("livesync: disabled: removed its capture triggers (%d statements) and emptied livesync_change; enabling it again reinstalls them and makes clients re-bootstrap. "+
			"The Next UI's OAuth2 application \"Forgejo Next\" is kept (signed-in browsers keep refreshing API tokens): delete it in Site administration > Applications to revoke them", report.Dropped)
	}
	return nil
}
