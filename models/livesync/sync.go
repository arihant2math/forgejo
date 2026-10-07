// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"context"
	"fmt"

	"forgejo.org/models/db"

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
	engined, ok := db.DefaultContext.(db.Engined)
	if !ok {
		return nil, fmt.Errorf("livesync: db.DefaultContext (%T) has no engine", db.DefaultContext)
	}
	master, err := db.GetMasterEngine(engined.Engine())
	if err != nil {
		return nil, fmt.Errorf("livesync: master engine: %w", err)
	}
	return master.Context(ctx), nil
}

// SyncTables creates or extends livesync's tables with Engine.Sync on the
// master database. It never drops columns or indexes, so it is safe to run at
// every start and on every instance.
func SyncTables(ctx context.Context) error {
	engined, ok := db.DefaultContext.(db.Engined)
	if !ok {
		return fmt.Errorf("livesync: db.DefaultContext (%T) has no engine", db.DefaultContext)
	}
	master, err := db.GetMasterEngine(engined.Engine())
	if err != nil {
		return fmt.Errorf("livesync: master engine: %w", err)
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

// SetMeta stores value under name in livesync_meta (insert or update) on the
// master database. Concurrent first writers (several instances starting on a
// fresh database) are tolerated: the loser of the insert race updates instead.
func SetMeta(ctx context.Context, name, value string) error {
	e, err := MasterEngine(ctx)
	if err != nil {
		return err
	}
	update := func() (bool, error) {
		if _, err := e.Where("name = ?", name).Cols("value").Update(&Meta{Value: value}); err != nil {
			return false, fmt.Errorf("livesync: update meta %q: %w", name, err)
		}
		// MySQL reports 0 affected rows when the value is unchanged, so
		// existence is checked separately instead of trusting the count.
		has, err := e.Where("name = ?", name).Exist(&Meta{})
		if err != nil {
			return false, fmt.Errorf("livesync: check meta %q: %w", name, err)
		}
		return has, nil
	}
	if done, err := update(); err != nil || done {
		return err
	}
	if _, insertErr := e.Insert(&Meta{Name: name, Value: value}); insertErr != nil {
		// Lost an insert race? Then the row exists now and an update wins.
		if done, err := update(); err != nil || done {
			return err
		}
		return fmt.Errorf("livesync: insert meta %q: %w", name, insertErr)
	}
	return nil
}
