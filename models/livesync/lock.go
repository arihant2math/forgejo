// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"time"

	"forgejo.org/models/db"
	"forgejo.org/modules/log"
	"forgejo.org/modules/setting"

	"code.forgejo.org/xorm/xorm"
)

// SchemaLockTimeout bounds how long WithSchemaLock waits for another instance
// that is creating or upgrading livesync's tables.
const SchemaLockTimeout = 2 * time.Minute

// schemaLockName names the database lock that serialises livesync's schema
// step between Forgejo instances sharing a database. The scope of the name is
// the current PostgreSQL schema / MySQL database (see acquireLock), so
// instances of unrelated Forgejos on the same server do not wait for each
// other.
const schemaLockName = "livesync.schema"

// WithSchemaLock runs fn while holding a database-wide lock (PostgreSQL
// session advisory lock / MySQL GET_LOCK) on the master database, so that at
// most one Forgejo instance at a time checks, creates or upgrades livesync's
// tables. xorm's Sync is check-then-create and fails when two instances race
// on a fresh database ("relation … already exists", "Duplicate key name").
//
// The lock is held on a dedicated pooled connection while fn runs its queries
// on others, so the pool needs room for at least two connections. On SQLite
// (unit tests only; livesync never runs there) fn is called without a lock.
func WithSchemaLock(ctx context.Context, fn func(ctx context.Context) error) error {
	if !setting.Database.Type.IsPostgreSQL() && !setting.Database.Type.IsMySQL() {
		return fn(ctx)
	}
	master, err := masterXORMEngine()
	if err != nil {
		return err
	}
	if n := master.DB().Stats().MaxOpenConnections; n == 1 {
		return errors.New("livesync: needs at least 2 database connections ([database] MAX_OPEN_CONNS = 1)")
	}
	conn, err := master.DB().Conn(ctx)
	if err != nil {
		return fmt.Errorf("livesync: schema lock connection: %w", err)
	}
	defer conn.Close()

	waitCtx, cancel := context.WithTimeout(ctx, SchemaLockTimeout)
	defer cancel()
	if err := acquireLock(waitCtx, conn, schemaLockName); err != nil {
		return err
	}
	defer releaseLock(conn, schemaLockName)
	return fn(ctx)
}

// acquireLock takes the session-level lock name on conn, waiting until ctx is
// done. On PostgreSQL advisory locks are per database, so the key includes
// current_schema(); MySQL lock names are server-wide (and at most 64
// characters), so the name includes a hash of DATABASE().
func acquireLock(ctx context.Context, conn *sql.Conn, name string) error {
	if setting.Database.Type.IsPostgreSQL() {
		// pg_advisory_lock waits indefinitely; the driver cancels the query
		// when ctx is done.
		if _, err := conn.ExecContext(ctx, "SELECT pg_advisory_lock(hashtext($1::text || '.' || current_schema()))", name); err != nil {
			return fmt.Errorf("livesync: acquire lock %q: %w", name, err)
		}
		return nil
	}
	timeout := SchemaLockTimeout
	if deadline, ok := ctx.Deadline(); ok {
		timeout = time.Until(deadline)
	}
	var got sql.NullInt64
	if err := conn.QueryRowContext(ctx, "SELECT GET_LOCK(CONCAT(?, '.', MD5(DATABASE())), ?)", name, max(int64(timeout/time.Second), 1)).Scan(&got); err != nil {
		return fmt.Errorf("livesync: acquire lock %q: %w", name, err)
	}
	if !got.Valid || got.Int64 != 1 {
		return fmt.Errorf("livesync: acquire lock %q: timed out after %s (another instance holds it)", name, timeout.Round(time.Second))
	}
	return nil
}

// releaseLock releases the lock taken by acquireLock. If that fails, the
// connection is discarded instead of being returned to the pool, because a
// session-level lock lives as long as its connection.
func releaseLock(conn *sql.Conn, name string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	query := "SELECT RELEASE_LOCK(CONCAT(?, '.', MD5(DATABASE())))"
	if setting.Database.Type.IsPostgreSQL() {
		query = "SELECT pg_advisory_unlock(hashtext($1::text || '.' || current_schema()))"
	}
	if _, err := conn.ExecContext(ctx, query, name); err != nil {
		log.Warn("livesync: release lock %q: %v; dropping the connection", name, err)
		_ = conn.Raw(func(any) error { return driver.ErrBadConn })
	}
}

// masterXORMEngine returns the master *xorm.Engine behind db.DefaultContext.
func masterXORMEngine() (*xorm.Engine, error) {
	engined, ok := db.DefaultContext.(db.Engined)
	if !ok {
		return nil, fmt.Errorf("livesync: db.DefaultContext (%T) has no engine", db.DefaultContext)
	}
	master, err := db.GetMasterEngine(engined.Engine())
	if err != nil {
		return nil, fmt.Errorf("livesync: master engine: %w", err)
	}
	return master, nil
}
