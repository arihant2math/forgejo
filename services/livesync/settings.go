// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"forgejo.org/modules/setting"
	"forgejo.org/services/livesync/hub"
	"forgejo.org/services/livesync/idempotency"
	"forgejo.org/services/livesync/perm"
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
	// LOG_RETENTION (default 720h = 30 days): sync log entries older than
	// this are trimmed; clients whose cursor is older must re-bootstrap. 0
	// keeps entries forever (subject to LOG_MAX_ROWS) (B3).
	LogRetention time.Duration
	// LOG_MAX_ROWS (default 1000000): at most this many of the newest sync
	// log entries are kept; 0 means no row limit (B3).
	LogMaxRows int64
	// HOT_COALESCE (default 1s): a row of a hot table (notification,
	// commit_status, action_run_job) is materialized at most once per this
	// interval, with its latest state; 0 disables the coalescing (B3).
	HotCoalesce time.Duration
	// PERM_CACHE_TTL (default 10m): how long a viewer's cached grants are
	// used at most. Permission epochs invalidate them at once; the TTL is
	// a safety net for permission changes that do not pass through a
	// tracked table (B4).
	PermCacheTTL time.Duration
	// SEND_BUFFER (default 4194304 = 4 MiB): the bytes queued for one sync
	// session at most (changes and control messages); a client that does
	// not read fast enough is disconnected with resume_from_cursor (B5).
	SendBuffer int
	// MAX_SUBSCRIPTIONS (default 1000): the groups one user may subscribe
	// at once on an instance, over all of their sessions (B5).
	MaxSubscriptions int
	// MAX_CONNECTIONS_PER_USER (default 16): the sync sessions one user
	// may have open on an instance (B5).
	MaxConnections int
	// MAX_REPLAY (default 10000): the log entries of a group replayed at
	// most for one subscription; a client further behind gets
	// bootstrap_required, before anything is replayed (B5).
	MaxReplay int
	// SESSION_CHECK_INTERVAL (default 5m): how often a sync session's
	// token and account are checked again (B5).
	SessionCheckInterval time.Duration
	// SUMMARY_RECENCY (default 2160h = 90 days): a repository bootstrap's
	// summary tier holds the open issues and pull requests plus those
	// updated within this window (older closed ones are loaded on demand),
	// and the commit statuses and action runs updated within it; a user's
	// bootstrap holds the read notifications updated within it (B6).
	SummaryRecency time.Duration
	// WORKSPACE_MAX_REPOS (default 200): the repositories GET
	// /-/sync/workspace lists at most (most recently updated first) (B6).
	WorkspaceMaxRepos int
	// IDEMPOTENCY_TTL (default 168h = 7 days): how long the response of an
	// API v1 write sent with an Idempotency-Key is kept for retries (B7).
	IdempotencyTTL time.Duration
	// IDEMPOTENCY_SYNC_WAIT (default 2s): how long such a write waits at
	// most for its changes to reach the sync log before it answers; without
	// them in the log it answers without X-Livesync-Sync-Id. 0 = do not
	// wait (the header is set only if they are there already) (B7).
	IdempotencySyncWait time.Duration
	// TRIGGER_CHECK_INTERVAL (default 1m): how often the writer checks the
	// capture triggers while livesync runs and repairs them (INSTALL_MODE
	// auto); 0 turns the check off (B8).
	TriggerCheckInterval time.Duration
	// ASSETS_DIR (default empty): the directory of the built Next UI
	// (next/dist: index.html, assets/, sw.js), served under /-/next/. A
	// relative path is resolved against the work path. Empty: the build
	// embedded with the livesync_embed build tag, if any; without one the
	// Next UI is not served (B8).
	AssetsDir string
	// OAUTH_REDIRECT_URIS (default empty): comma-separated redirect URIs the
	// Next UI's OAuth2 client accepts besides {AppURL}-/next/callback, e.g.
	// http://127.0.0.1/-/next/callback for a development server (the port of
	// an http loopback URI is ignored for public clients) (B8).
	OAuthRedirectURIs []string
	// LOG_TAIL_INTERVAL (default 1s): how often a sync session's Actions
	// log tail polls its job for new lines (B9).
	LogTailInterval time.Duration
}

// Setting holds the settings loaded by the last call to Init.
var Setting Settings

// loadSettings parses the [livesync] section of rootCfg. Enabled and
// InstallMode are set in the result even when it returns an error (Init
// decides ENABLED first).
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
	if s.LogRetention, err = sec.Key("LOG_RETENTION").MustDuration(30 * 24 * time.Hour); err != nil {
		return s, fmt.Errorf("invalid [livesync] LOG_RETENTION: %w", err)
	}
	s.LogMaxRows = sec.Key("LOG_MAX_ROWS").MustInt64(1_000_000)
	if s.HotCoalesce, err = sec.Key("HOT_COALESCE").MustDuration(time.Second); err != nil {
		return s, fmt.Errorf("invalid [livesync] HOT_COALESCE: %w", err)
	}
	if s.PermCacheTTL, err = sec.Key("PERM_CACHE_TTL").MustDuration(perm.DefaultCacheTTL); err != nil {
		return s, fmt.Errorf("invalid [livesync] PERM_CACHE_TTL: %w", err)
	}
	if s.PermCacheTTL <= 0 {
		return s, fmt.Errorf("invalid [livesync] PERM_CACHE_TTL %s (want > 0)", s.PermCacheTTL)
	}
	s.SendBuffer = sec.Key("SEND_BUFFER").MustInt(hub.DefaultSendBuffer)
	s.MaxSubscriptions = sec.Key("MAX_SUBSCRIPTIONS").MustInt(hub.DefaultMaxSubscriptions)
	s.MaxConnections = sec.Key("MAX_CONNECTIONS_PER_USER").MustInt(hub.DefaultMaxConnections)
	s.MaxReplay = sec.Key("MAX_REPLAY").MustInt(hub.DefaultMaxReplay)
	if s.SessionCheckInterval, err = sec.Key("SESSION_CHECK_INTERVAL").MustDuration(hub.DefaultRevalidateInterval); err != nil {
		return s, fmt.Errorf("invalid [livesync] SESSION_CHECK_INTERVAL: %w", err)
	}
	if s.SummaryRecency, err = sec.Key("SUMMARY_RECENCY").MustDuration(90 * 24 * time.Hour); err != nil {
		return s, fmt.Errorf("invalid [livesync] SUMMARY_RECENCY: %w", err)
	}
	s.WorkspaceMaxRepos = sec.Key("WORKSPACE_MAX_REPOS").MustInt(200)
	if s.SummaryRecency <= 0 || s.WorkspaceMaxRepos <= 0 {
		return s, fmt.Errorf("invalid [livesync] SUMMARY_RECENCY %s / WORKSPACE_MAX_REPOS %d (want > 0)", s.SummaryRecency, s.WorkspaceMaxRepos)
	}
	if s.IdempotencyTTL, err = sec.Key("IDEMPOTENCY_TTL").MustDuration(idempotency.DefaultTTL); err != nil {
		return s, fmt.Errorf("invalid [livesync] IDEMPOTENCY_TTL: %w", err)
	}
	if s.IdempotencySyncWait, err = sec.Key("IDEMPOTENCY_SYNC_WAIT").MustDuration(idempotency.DefaultSyncWait); err != nil {
		return s, fmt.Errorf("invalid [livesync] IDEMPOTENCY_SYNC_WAIT: %w", err)
	}
	if s.IdempotencyTTL <= 0 || s.IdempotencySyncWait < 0 {
		return s, fmt.Errorf("invalid [livesync] IDEMPOTENCY_TTL %s / IDEMPOTENCY_SYNC_WAIT %s (want > 0 / >= 0)", s.IdempotencyTTL, s.IdempotencySyncWait)
	}
	if s.TriggerCheckInterval, err = sec.Key("TRIGGER_CHECK_INTERVAL").MustDuration(time.Minute); err != nil || s.TriggerCheckInterval < 0 {
		return s, fmt.Errorf("invalid [livesync] TRIGGER_CHECK_INTERVAL %q (want a duration >= 0)", sec.Key("TRIGGER_CHECK_INTERVAL").String())
	}
	if s.AssetsDir = strings.TrimSpace(sec.Key("ASSETS_DIR").String()); s.AssetsDir != "" && !filepath.IsAbs(s.AssetsDir) {
		s.AssetsDir = filepath.Join(setting.AppWorkPath, s.AssetsDir)
	}
	for u := range strings.SplitSeq(sec.Key("OAUTH_REDIRECT_URIS").String(), ",") {
		if u = strings.TrimSpace(u); u != "" {
			s.OAuthRedirectURIs = append(s.OAuthRedirectURIs, u)
		}
	}
	if s.LogTailInterval, err = sec.Key("LOG_TAIL_INTERVAL").MustDuration(hub.DefaultLogInterval); err != nil || s.LogTailInterval <= 0 {
		return s, fmt.Errorf("invalid [livesync] LOG_TAIL_INTERVAL %q (want a duration > 0)", sec.Key("LOG_TAIL_INTERVAL").String())
	}
	if s.SendBuffer <= 0 || s.MaxSubscriptions <= 0 || s.MaxConnections <= 0 || s.MaxReplay <= 0 || s.SessionCheckInterval <= 0 {
		return s, fmt.Errorf("invalid [livesync] SEND_BUFFER %d / MAX_SUBSCRIPTIONS %d / MAX_CONNECTIONS_PER_USER %d / MAX_REPLAY %d / SESSION_CHECK_INTERVAL %s (want > 0)",
			s.SendBuffer, s.MaxSubscriptions, s.MaxConnections, s.MaxReplay, s.SessionCheckInterval)
	}
	if s.LogRetention < 0 || s.LogMaxRows < 0 || s.HotCoalesce < 0 {
		return s, fmt.Errorf("invalid [livesync] LOG_RETENTION %s / LOG_MAX_ROWS %d / HOT_COALESCE %s (want >= 0)", s.LogRetention, s.LogMaxRows, s.HotCoalesce)
	}
	if s.PollInterval < 0 || s.HoleTimeout <= 0 {
		return s, fmt.Errorf("invalid [livesync] POLL_INTERVAL %s / HOLE_TIMEOUT %s (want >= 0 / > 0)", s.PollInterval, s.HoleTimeout)
	}
	return s, nil
}
