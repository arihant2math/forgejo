// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"fmt"
	"strings"
	"time"

	"forgejo.org/modules/setting"
)

// InstallMode decides what livesync does about its database triggers at start
// (PLAN §4.3).
type InstallMode string

const (
	// InstallModeAuto creates or repairs the triggers at startup.
	InstallModeAuto InstallMode = "auto"
	// InstallModeVerify only checks that the triggers exist and are current; a
	// DBA installs them with the DDL shown on /-/sync/admin.
	InstallModeVerify InstallMode = "verify"
)

// Settings is the parsed [livesync] section of app.ini.
//
// Every milestone appends its own keys here, with a default and a comment, and
// parses them in loadSettings. Nothing outside services/livesync reads app.ini
// for livesync (modules/setting stays untouched).
type Settings struct {
	// ENABLED (default false): master switch. When false, Wrap returns the
	// upstream handler unchanged and livesync does not touch the database.
	Enabled bool
	// INSTALL_MODE (default auto): auto | verify, see InstallMode.
	InstallMode InstallMode
	// POLL_INTERVAL (default 0 = 250ms on PostgreSQL, 100ms on MySQL): how
	// often the outbox reader polls when no doorbell rang (B2).
	PollInterval time.Duration
	// HOLE_TIMEOUT (default 30s): how long the outbox reader waits for an
	// outbox id below its high-water mark (an uncommitted transaction) before
	// giving it up as rolled back (B2).
	HoleTimeout time.Duration
}

// Setting holds the settings loaded by the last call to Init.
var Setting Settings

// loadSettings parses the [livesync] section of rootCfg.
func loadSettings(rootCfg setting.ConfigProvider) (Settings, error) {
	sec := rootCfg.Section("livesync")
	s := Settings{
		Enabled:     sec.Key("ENABLED").MustBool(false),
		InstallMode: InstallMode(strings.ToLower(strings.TrimSpace(sec.Key("INSTALL_MODE").MustString(string(InstallModeAuto))))),
	}
	switch s.InstallMode {
	case InstallModeAuto, InstallModeVerify:
	default:
		return s, fmt.Errorf("invalid [livesync] INSTALL_MODE %q (want %q or %q)", s.InstallMode, InstallModeAuto, InstallModeVerify)
	}
	var err error
	if s.PollInterval, err = sec.Key("POLL_INTERVAL").MustDuration(0); err != nil {
		return s, fmt.Errorf("invalid [livesync] POLL_INTERVAL: %w", err)
	}
	if s.HoleTimeout, err = sec.Key("HOLE_TIMEOUT").MustDuration(30 * time.Second); err != nil {
		return s, fmt.Errorf("invalid [livesync] HOLE_TIMEOUT: %w", err)
	}
	if s.PollInterval < 0 || s.HoleTimeout <= 0 {
		return s, fmt.Errorf("invalid [livesync] POLL_INTERVAL %s / HOLE_TIMEOUT %s (want >= 0 / > 0)", s.PollInterval, s.HoleTimeout)
	}
	return s, nil
}
