// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"strconv"
	"sync"
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
// on others, so the pool needs room for at least two connections (CheckPool
// asks for MinOpenConns). On SQLite
// (unit tests only; livesync never runs there) fn is called without a lock.
func WithSchemaLock(ctx context.Context, fn func(ctx context.Context) error) error {
	if !setting.Database.Type.IsPostgreSQL() && !setting.Database.Type.IsMySQL() {
		return fn(ctx)
	}
	master, err := MasterXORMEngine()
	if err != nil {
		return err
	}
	if err := checkPool(master); err != nil {
		return err
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

// MinOpenConns is the smallest [database] MAX_OPEN_CONNS livesync runs with
// (0, unlimited, is fine). An instance pins up to two pooled connections for
// as long as it runs — the idempotency instance lock (every instance) and the
// sync log writer lease (the writer instance) — and needs at least one more
// for everything else: the materializer's transaction, the outbox reader,
// the tailer, its HTTP endpoints and Forgejo's own requests (which then take
// turns on it), briefly a second one while it checks another instance's lock
// (idempotency) or holds the schema lock at start. With fewer, every query
// that is not on a pinned connection would wait forever.
const MinOpenConns = 3

// CheckPool refuses a connection pool too small for livesync (see
// MinOpenConns). Init calls it before anything else touches the database.
func CheckPool() error {
	if !setting.Database.Type.IsPostgreSQL() && !setting.Database.Type.IsMySQL() {
		return nil
	}
	master, err := MasterXORMEngine()
	if err != nil {
		return err
	}
	return checkPool(master)
}

func checkPool(master *xorm.Engine) error {
	if n := master.DB().Stats().MaxOpenConnections; n > 0 && n < MinOpenConns {
		return fmt.Errorf("livesync: needs at least %d database connections, [database] MAX_OPEN_CONNS is %d (it pins one for its instance lock and one for the sync log writer lease, and works on the others)", MinOpenConns, n)
	}
	return nil
}

// MasterXORMEngine returns the master *xorm.Engine behind db.DefaultContext.
func MasterXORMEngine() (*xorm.Engine, error) {
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

// Lease is a database-wide lock (PostgreSQL session advisory lock / MySQL
// GET_LOCK, scoped like WithSchemaLock's) held on a pinned pooled connection
// until Release. The lock lives as long as that connection: if the
// connection dies, the database releases it and another instance can take
// it, so holders must Check it regularly and stop acting on its behalf as
// soon as Check fails (and fence their writes, see services/livesync/synclog).
//
// A holder whose host dies or is cut off without closing the connection
// (no FIN/RST) would keep the lock until the database server noticed the
// dead connection: hours with the default TCP keepalive (PostgreSQL) or
// wait_timeout (MySQL: 8 h), during which no other instance can take over
// (backend audit). So the lease's session is configured to be ended by the
// server once it has been idle for LeaseIdleTimeout (PostgreSQL
// idle_session_timeout, 14+, and TCP keepalives; MySQL wait_timeout), and
// the lease pings it every LeaseKeepalive while it is held, whatever its
// holder is busy with. The connection is closed on Release instead of going
// back to the pool with these settings.
type Lease struct {
	conn *sql.Conn // nil on SQLite (unit tests): no locking
	name string

	stop, done chan struct{}
	mu         sync.Mutex
	lost       error // set by the keepalive when a ping failed
}

// Lease session timeouts. Variables so that tests can change them.
var (
	// LeaseIdleTimeout: the database ends a lease's session (and so frees
	// its lock) after this long without a statement on it.
	LeaseIdleTimeout = 30 * time.Second
	// LeaseKeepalive: how often a held lease pings its session.
	LeaseKeepalive = 5 * time.Second
)

// ErrLeaseHeld is returned by TryLease when another session holds the lock.
var ErrLeaseHeld = errors.New("livesync: the lock is held by another session")

// TryLease takes the lock name without waiting. It returns ErrLeaseHeld when
// another session holds it. On SQLite every call succeeds (no locking).
func TryLease(ctx context.Context, name string) (*Lease, error) {
	if !setting.Database.Type.IsPostgreSQL() && !setting.Database.Type.IsMySQL() {
		return &Lease{name: name}, nil
	}
	master, err := MasterXORMEngine()
	if err != nil {
		return nil, err
	}
	if err := checkPool(master); err != nil {
		return nil, err
	}
	conn, err := master.DB().Conn(ctx)
	if err != nil {
		return nil, fmt.Errorf("livesync: lease connection: %w", err)
	}
	discard := func() {
		_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		conn.Close()
	}
	if err := setLeaseTimeouts(ctx, conn); err != nil {
		discard()
		return nil, fmt.Errorf("livesync: lease %q: set the session timeouts: %w", name, err)
	}
	query := "SELECT GET_LOCK(CONCAT(?, '.', MD5(DATABASE())), 0)"
	if setting.Database.Type.IsPostgreSQL() {
		query = "SELECT CASE WHEN pg_try_advisory_lock(hashtext($1::text || '.' || current_schema())) THEN 1 ELSE 0 END"
	}
	var got sql.NullInt64
	if err := conn.QueryRowContext(ctx, query, name).Scan(&got); err != nil {
		discard()
		return nil, fmt.Errorf("livesync: try lock %q: %w", name, err)
	}
	if !got.Valid || got.Int64 != 1 {
		discard()
		return nil, ErrLeaseHeld
	}
	l := &Lease{conn: conn, name: name, stop: make(chan struct{}), done: make(chan struct{})}
	go l.keepalive()
	return l, nil
}

// setLeaseTimeouts makes the server end conn's session once it has been
// idle for LeaseIdleTimeout (see Lease).
func setLeaseTimeouts(ctx context.Context, conn *sql.Conn) error {
	secs := max(int64(LeaseIdleTimeout/time.Second), 1)
	if setting.Database.Type.IsMySQL() {
		_, err := conn.ExecContext(ctx, "SET SESSION wait_timeout = "+strconv.FormatInt(secs, 10))
		return err
	}
	// TCP keepalives (ignored on a Unix socket): a dead peer is detected
	// after about idle + count × interval.
	interval := max(secs/6, 1)
	for _, set := range []string{
		"SET tcp_keepalives_idle = " + strconv.FormatInt(max(secs/2, 1), 10),
		"SET tcp_keepalives_interval = " + strconv.FormatInt(interval, 10),
		"SET tcp_keepalives_count = 3",
	} {
		if _, err := conn.ExecContext(ctx, set); err != nil {
			return err
		}
	}
	var version int
	if err := conn.QueryRowContext(ctx, "SELECT current_setting('server_version_num')::int").Scan(&version); err != nil {
		return err
	}
	if version >= 140000 { // idle_session_timeout is new in PostgreSQL 14
		if _, err := conn.ExecContext(ctx, "SET idle_session_timeout = "+strconv.FormatInt(LeaseIdleTimeout.Milliseconds(), 10)); err != nil {
			return err
		}
	}
	return nil
}

// keepalive pings the lease's session every LeaseKeepalive until Release,
// so that the server's idle timeout ends it only when this process cannot
// reach it any more.
func (l *Lease) keepalive() {
	defer close(l.done)
	t := time.NewTicker(LeaseKeepalive)
	defer t.Stop()
	for {
		select {
		case <-l.stop:
			return
		case <-t.C:
		}
		ctx, cancel := context.WithTimeout(context.Background(), max(LeaseKeepalive, time.Second))
		err := l.conn.PingContext(ctx)
		cancel()
		if err != nil {
			l.mu.Lock()
			if l.lost == nil {
				l.lost = err
			}
			l.mu.Unlock()
			return
		}
	}
}

// Check verifies that the lease's connection is still alive (and so the
// lock still held).
func (l *Lease) Check(ctx context.Context) error {
	if l.conn == nil {
		return nil
	}
	l.mu.Lock()
	lost := l.lost
	l.mu.Unlock()
	if lost == nil {
		lost = l.conn.PingContext(ctx)
	}
	if lost != nil {
		return fmt.Errorf("livesync: lease %q lost: %w", l.name, lost)
	}
	return nil
}

// Release releases the lock and closes the connection (it carries the
// lease's session timeouts, so it does not go back to the pool). It is
// idempotent.
func (l *Lease) Release() {
	if l.conn == nil {
		return
	}
	close(l.stop)
	<-l.done
	releaseLock(l.conn, l.name)
	_ = l.conn.Raw(func(any) error { return driver.ErrBadConn })
	l.conn.Close()
	l.conn = nil
}
