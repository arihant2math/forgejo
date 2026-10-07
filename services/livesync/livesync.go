// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Package livesync is the entry point of the livesync backend (PLAN §4): it
// reads the [livesync] settings, checks the database, creates livesync's own
// tables and owns the lifecycle (start, graceful shutdown) of the background
// parts that later milestones add (capture, materializer, hub).
//
// routers/livesync.Wrap is the only caller of Init.
package livesync

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/log"
	"forgejo.org/modules/setting"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/services/livesync/hub"
	"forgejo.org/services/livesync/materialize"
	"forgejo.org/services/livesync/perm"
	"forgejo.org/services/livesync/synclog"
)

// TablesVersion is the version of livesync's own table layout, recorded in
// livesync_meta under MetaTablesVersion each time Init syncs the tables. Bump
// it when a change to models/livesync needs more than Engine.Sync can do (and
// add the upgrade step to EnsureTables), or when older binaries must refuse
// to run against the new layout.
const TablesVersion = 1

// MetaTablesVersion is the livesync_meta name holding TablesVersion.
const MetaTablesVersion = "tables_version"

var (
	// ErrDisabled is returned by Init when [livesync] ENABLED is false.
	ErrDisabled = errors.New("livesync is disabled ([livesync] ENABLED = false)")
	// ErrUnsupportedDatabase is returned by Init on databases other than
	// PostgreSQL and MySQL/MariaDB (i.e. SQLite).
	ErrUnsupportedDatabase = errors.New("livesync supports only PostgreSQL and MySQL/MariaDB")
)

// instance is one successful Init. Its context is cancelled by Shutdown (or by
// a later Init, which replaces it); background workers of later milestones
// run under it.
type instance struct {
	ctx    context.Context
	cancel context.CancelFunc
	tailer *synclog.Tailer
	writer chan struct{} // closed when the writer role has stopped
	perms  *perm.Cache
	hub    *hub.Hub
}

// readerStopTimeout bounds how long Shutdown waits for the outbox reader
// (and the writer role around it) and for the tailer.
const readerStopTimeout = 10 * time.Second

// hubStopTimeout bounds how long Shutdown waits for the sync sessions to
// close.
const hubStopTimeout = 5 * time.Second

var (
	mu      sync.Mutex
	current *instance
)

// Init loads the [livesync] settings and, when livesync is enabled on a
// supported database, creates or updates livesync's tables, checks the table
// catalog, verifies (INSTALL_MODE verify) or installs and repairs
// (INSTALL_MODE auto) the capture triggers, starts the sync log tailer and
// the writer role (which runs the outbox reader and the materializer while
// this instance holds the writer lease, see runWriter) and marks livesync as
// running. It returns ErrDisabled or ErrUnsupportedDatabase (wrapped) when
// livesync must not run; any other error means livesync could not start.
// A *capture.NotInstalledError (errors.Is capture.ErrNotInstalled) means the
// triggers are missing or stale; its Status.Script is the DDL for a DBA.
// In every error case livesync is left stopped and the caller must serve
// plain Forgejo.
//
// The instance context (see Context) is derived from ctx and cancelled by
// Shutdown, so pass a context that outlives graceful shutdown (the web server
// passes the graceful manager's HammerContext): the shutdown hook, not the
// parent context, is what stops livesync in an orderly way. Calling Init again
// shuts the previous instance down first (tests do this; the web server calls
// it once).
func Init(ctx context.Context) error {
	mu.Lock()
	defer mu.Unlock()
	shutdownLocked()

	s, err := loadSettings(setting.CfgProvider)
	if err != nil {
		return err
	}
	Setting = s
	if !s.Enabled {
		return ErrDisabled
	}
	if !setting.Database.Type.IsPostgreSQL() && !setting.Database.Type.IsMySQL() {
		return fmt.Errorf("%w (DB_TYPE is %q)", ErrUnsupportedDatabase, setting.Database.Type)
	}

	if err := EnsureTables(ctx); err != nil {
		return err
	}
	if _, err := CheckCatalog(); err != nil {
		return err
	}
	if err := ensureCapture(ctx, s.InstallMode); err != nil {
		return err
	}

	head, err := synclog.Head(ctx)
	if err != nil {
		return fmt.Errorf("livesync: read the sync log head: %w", err)
	}
	instCtx, cancel := context.WithCancel(ctx)
	perms := perm.NewCache(s.PermCacheTTL, 0)
	hb := hub.New(instCtx, hub.Config{
		Perms: perms, Profile: ownProfile, BuildID: setting.AppVer, Schemas: materialize.Schemas(),
		SendBuffer: s.SendBuffer, MaxSubscriptions: s.MaxSubscriptions, MaxConnections: s.MaxConnections,
		MaxReplay: s.MaxReplay, RevalidateInterval: s.SessionCheckInterval,
	}, head)
	// The hub and the tailer start at the same position: the hub's
	// subscriptions go live at the position the tailer delivered.
	tailer, err := synclog.StartTailer(instCtx, synclog.TailerConfig{PollInterval: s.PollInterval}, head, permSink{cache: perms, next: hb})
	if err != nil {
		cancel()
		return fmt.Errorf("livesync: start the sync log tailer: %w", err)
	}
	writer := make(chan struct{})
	go runWriter(instCtx, s, tailer, writer)
	current = &instance{ctx: instCtx, cancel: cancel, tailer: tailer, writer: writer, perms: perms, hub: hb}
	log.Info("livesync: started (db=%s, install mode=%s)", setting.Database.Type, s.InstallMode)
	return nil
}

// ensureCapture checks the capture triggers and, in INSTALL_MODE auto,
// repairs them. Livesync refuses to start (returns a
// *capture.NotInstalledError) when they are missing or stale at the end.
func ensureCapture(ctx context.Context, mode InstallMode) error {
	report, err := capture.Ensure(ctx, mode == InstallModeAuto)
	if err != nil {
		return err
	}
	if len(report.Repaired) > 0 {
		log.Info("livesync: (re)installed the capture triggers of %d table(s) and bumped their schema epochs: %s",
			len(report.Repaired), strings.Join(report.Repaired, ", "))
	}
	if len(report.Dropped) > 0 {
		log.Info("livesync: dropped capture triggers of untracked tables: %s", strings.Join(report.Dropped, ", "))
	}
	for _, w := range report.Status.Warnings {
		log.Warn("livesync: %s", w)
	}
	if script := report.Status.Script(); script != "" {
		// Only extra triggers are left (verify mode): harmless but wasteful.
		log.Warn("livesync: capture triggers on untracked tables remain (INSTALL_MODE=verify); a DBA can drop them with:\n%s", script)
	}
	return nil
}

// EnsureTables creates or upgrades livesync's tables and records
// TablesVersion. It runs under the database schema lock, so instances starting
// together on one database take turns, and it checks the stored version
// before touching anything: a binary older than the tables refuses to start
// without changing them (xorm's Sync adds columns and indexes and may alter
// column types, so it must not run against a newer layout).
func EnsureTables(ctx context.Context) error {
	return livesync_model.WithSchemaLock(ctx, func(ctx context.Context) error {
		exists, err := livesync_model.MetaTableExists(ctx)
		if err != nil {
			return err
		}
		if exists {
			stored, ok, err := livesync_model.GetMeta(ctx, MetaTablesVersion)
			if err != nil {
				return err
			}
			if err := checkTablesVersion(stored, ok); err != nil {
				return err
			}
		}
		if err := livesync_model.SyncTables(ctx); err != nil {
			return err
		}
		// Upgrade steps that need more than Sync (data migrations, PK
		// changes) go here, keyed on the stored version, before the new
		// version is recorded.
		return livesync_model.SetMeta(ctx, MetaTablesVersion, strconv.Itoa(TablesVersion))
	})
}

// checkTablesVersion refuses to run against tables written by a newer
// livesync (a downgrade): their layout or meaning may have changed.
func checkTablesVersion(stored string, ok bool) error {
	if !ok {
		return nil // fresh database
	}
	v, err := strconv.Atoi(stored)
	if err != nil {
		return fmt.Errorf("livesync_meta %s is %q, not a number", MetaTablesVersion, stored)
	}
	if v > TablesVersion {
		return fmt.Errorf("livesync tables have version %d, newer than this binary's %d (downgrade?); not starting", v, TablesVersion)
	}
	return nil
}

// Context returns the context of the running livesync instance; it is done
// once livesync has been shut down (or was never started). Register shutdown
// hooks and start background workers with it.
func Context() context.Context {
	mu.Lock()
	defer mu.Unlock()
	if current == nil {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		return ctx
	}
	return current.ctx
}

// Running reports whether livesync is initialised and not shut down.
func Running() bool {
	mu.Lock()
	defer mu.Unlock()
	return current != nil && current.ctx.Err() == nil
}

// Shutdown stops the running livesync instance, if any. It is registered
// with the graceful manager by routers/livesync.Wrap and is idempotent.
func Shutdown() {
	mu.Lock()
	defer mu.Unlock()
	if current != nil {
		log.Info("livesync: shutting down")
	}
	shutdownLocked()
}

func shutdownLocked() {
	if current == nil {
		return
	}
	// Tell the clients first (notice shutdown), while the instance runs.
	current.hub.Shutdown(hubStopTimeout)
	current.cancel()
	select {
	case <-current.writer:
	case <-time.After(readerStopTimeout):
		log.Warn("livesync: the sync log writer did not stop within %s", readerStopTimeout)
	}
	if !current.tailer.Wait(readerStopTimeout) {
		log.Warn("livesync: the sync log tailer did not stop within %s", readerStopTimeout)
	}
	current = nil
}
