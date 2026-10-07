// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"context"
	"fmt"

	"forgejo.org/models/db"
	"forgejo.org/modules/setting"

	"code.forgejo.org/xorm/xorm"
)

// MasterEngine returns an Engine bound to ctx that is guaranteed to talk to the
// primary database, even when Forgejo is configured with read replicas
// ([database] HOST_REPLICAS / newXORMEngineGroup). Inside a transaction the
// transaction's own session is returned (transactions always run on the master).
//
// Everything correctness-critical in livesync (outbox reader, sync log writer,
// lease, idempotency records, meta) must use it instead of db.GetEngine.
func MasterEngine(ctx context.Context) (db.Engine, error) {
	if db.InTransaction(ctx) {
		return db.GetEngine(ctx), nil
	}
	master, err := masterXORMEngine()
	if err != nil {
		return nil, err
	}
	return master.Context(ctx), nil
}

// SyncTables creates or extends livesync's tables with Engine.Sync on the
// master database. It never drops columns or indexes. xorm's Sync is not safe
// against concurrent callers (check-then-create), so call it only under
// WithSchemaLock (services/livesync.EnsureTables does).
func SyncTables(ctx context.Context) error {
	master, err := masterXORMEngine()
	if err != nil {
		return err
	}
	sess := master.Context(ctx)
	defer sess.Close()
	if _, err := sess.StoreEngine("InnoDB").SyncWithOptions(xorm.SyncOptions{
		WarnIfDatabaseColumnMissed: true,
		IgnoreDropIndices:          true,
	}, Tables()...); err != nil {
		return fmt.Errorf("livesync: sync tables: %w", err)
	}
	return nil
}

// MetaTableExists reports whether livesync_meta exists on the master database,
// i.e. whether livesync has ever created its tables there.
func MetaTableExists(ctx context.Context) (bool, error) {
	e, err := MasterEngine(ctx)
	if err != nil {
		return false, err
	}
	has, err := e.IsTableExist(&Meta{})
	if err != nil {
		return false, fmt.Errorf("livesync: check table livesync_meta: %w", err)
	}
	return has, nil
}

// GetMeta returns the value stored under name in livesync_meta, read from the
// master database. ok is false when the name does not exist.
func GetMeta(ctx context.Context, name string) (value string, ok bool, err error) {
	e, err := MasterEngine(ctx)
	if err != nil {
		return "", false, err
	}
	m := &Meta{}
	has, err := e.Where("name = ?", name).Get(m)
	if err != nil {
		return "", false, fmt.Errorf("livesync: get meta %q: %w", name, err)
	}
	return m.Value, has, nil
}

// SetMeta stores value under name in livesync_meta on the master database
// with one native upsert statement (INSERT … ON CONFLICT DO UPDATE on
// PostgreSQL and SQLite, INSERT … ON DUPLICATE KEY UPDATE on MySQL/MariaDB).
// Concurrent writers of the same name, inside or outside a transaction, wait
// for each other and the last one wins; none fails because of the other.
func SetMeta(ctx context.Context, name, value string) error {
	e, err := MasterEngine(ctx)
	if err != nil {
		return err
	}
	query := "INSERT INTO livesync_meta (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value"
	if setting.Database.Type.IsMySQL() {
		// VALUES(col) is deprecated in MySQL 8.0.20+ in favour of a row
		// alias, which MariaDB does not support; it still works on both.
		query = "INSERT INTO livesync_meta (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)"
	}
	if _, err := e.Exec(query, name, value); err != nil {
		return fmt.Errorf("livesync: set meta %q: %w", name, err)
	}
	return nil
}
