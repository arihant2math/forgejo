// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package capture

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/log"
	"forgejo.org/modules/setting"

	"code.forgejo.org/xorm/xorm"
	xormlog "code.forgejo.org/xorm/xorm/log"
	"github.com/jackc/pgx/v5"
)

// The doorbell wakes the outbox reader as soon as a change may have been
// committed, so it does not have to wait for its next poll (PLAN §4.3):
//
//   - on PostgreSQL, LISTEN livesync rings when any instance, this one
//     included, commits a captured change (the trigger function calls
//     pg_notify; notifications are sent at commit, one per transaction);
//   - on MySQL, which has no NOTIFY, a passive observer of the master
//     engine's statements rings after every COMMIT and every successful
//     INSERT/UPDATE/DELETE/REPLACE (which may be autocommitted: it cannot
//     tell), except livesync's own (see withQuietTx);
//   - polling (PollInterval) is the safety net and, on MySQL, the
//     cross-instance mechanism.
//
// A ring is only a hint: the reader re-reads the outbox, which is cheap when
// nothing is new, and it runs at most one cycle per minCycleGap however
// often the bell rings.

// doorbell is a coalescing wake-up signal: any number of rings between two
// reads wake the reader once.
type doorbell struct {
	c chan struct{}
}

func newDoorbell() *doorbell {
	return &doorbell{c: make(chan struct{}, 1)}
}

func (d *doorbell) ring() {
	select {
	case d.c <- struct{}{}:
	default:
	}
}

// bells is the copy-on-write set of doorbells the commit hook rings. The hook
// runs for every SQL statement Forgejo executes, so its fast path is one
// atomic load.
var (
	bells   atomic.Pointer[[]*doorbell]
	bellsMu sync.Mutex
)

func subscribe(d *doorbell) {
	bellsMu.Lock()
	defer bellsMu.Unlock()
	var next []*doorbell
	if cur := bells.Load(); cur != nil {
		next = append(next, *cur...)
	}
	next = append(next, d)
	bells.Store(&next)
}

func unsubscribe(d *doorbell) {
	bellsMu.Lock()
	defer bellsMu.Unlock()
	cur := bells.Load()
	if cur == nil {
		return
	}
	var next []*doorbell
	for _, b := range *cur {
		if b != d {
			next = append(next, b)
		}
	}
	if len(next) == 0 {
		bells.Store(nil)
		return
	}
	bells.Store(&next)
}

func ringAll() {
	if cur := bells.Load(); cur != nil {
		for _, d := range *cur {
			d.ring()
		}
	}
}

// commitObserver is the in-process doorbell on MySQL. It wraps the master
// engine's xorm logger rather than being a contexts.Hook: xorm does not chain
// hook contexts (the context returned by the LAST hook's BeforeProcess is
// used for the query and handed to every AfterProcess), and Forgejo's
// db.TracingHook, registered last, keeps its runtime/trace task in that
// context. Any hook appended after it therefore either breaks TracingHook
// (nil task) or has to start a second trace task, leaving TracingHook's own
// one unended in every runtime trace. The logger sees the same statements,
// with their error and context, and leaves the hook chain alone.
//
// xorm calls the logger's BeforeSQL/AfterSQL only when IsShowSQL is true
// (core.DB.NeedLogSQL), so the observer reports true and forwards
// BeforeSQL/AfterSQL to the wrapped logger only when that one logs SQL; all
// other methods are the wrapped logger's. A session forced quiet with
// MustLogSQL(false) is not observed (Forgejo does not use it).
type commitObserver struct {
	xormlog.ContextLogger
}

var _ xormlog.ContextLogger = commitObserver{}

func (o commitObserver) logs(c xormlog.LogContext) bool {
	if show, ok := c.Ctx.Value(xormlog.SessionShowSQLKey{}).(bool); ok {
		return show
	}
	return o.ContextLogger.IsShowSQL()
}

func (o commitObserver) IsShowSQL() bool { return true }

func (o commitObserver) BeforeSQL(c xormlog.LogContext) {
	if o.logs(c) {
		o.ContextLogger.BeforeSQL(c)
	}
}

func (o commitObserver) AfterSQL(c xormlog.LogContext) {
	if o.logs(c) {
		o.ContextLogger.AfterSQL(c)
	}
	if c.Err == nil && pokes(c.SQL) && (c.Ctx == nil || c.Ctx.Value(quietKey{}) == nil) {
		ringAll()
	}
}

// quietKey marks the context of livesync's own transactions (withQuietTx):
// their statements and COMMIT do not ring the in-process doorbell, otherwise
// every delivered batch would wake the reader once more for nothing.
type quietKey struct{}

// txContext is a context whose database engine is the transaction session
// sess (db.Engined), so db.GetEngine, db.InTransaction and
// livesync_model.MasterEngine use it, like the context db.WithTx passes.
type txContext struct {
	context.Context
	sess *xorm.Session
}

func (c txContext) Engine() db.Engine { return c.sess }

// WithQuietTx runs fn in a transaction on the master database, like
// db.WithTx, but its statements and COMMIT do not ring the in-process
// doorbell (db.WithTx sessions run under the engine's default context, so
// they cannot be told apart). The reader commits batches with it; a consumer
// that commits a Batch in its own transaction (B3) can use it for the same
// reason. Nested calls inside an existing transaction just run fn.
func WithQuietTx(ctx context.Context, fn func(ctx context.Context) error) error {
	if db.InTransaction(ctx) {
		return fn(ctx)
	}
	master, err := livesync_model.MasterXORMEngine()
	if err != nil {
		return err
	}
	sess := master.NewSession()
	defer sess.Close()
	sess.Context(context.WithValue(ctx, quietKey{}, true))
	if err := sess.Begin(); err != nil {
		return err
	}
	if err := fn(txContext{Context: ctx, sess: sess}); err != nil {
		return err
	}
	return sess.Commit()
}

// pokes reports whether a successful statement may have committed a
// captured change: COMMIT, or a DML statement (autocommitted or not) that is
// not livesync's own bookkeeping.
func pokes(query string) bool {
	query = strings.TrimLeft(query, " \t\r\n(")
	if len(query) < 6 {
		return false
	}
	switch query[0] {
	case 'C', 'c':
		return strings.EqualFold(query, "COMMIT")
	case 'I', 'i', 'U', 'u', 'D', 'd', 'R', 'r':
	default:
		return false
	}
	word, _, _ := strings.Cut(query, " ")
	switch strings.ToUpper(word) {
	case "INSERT", "UPDATE", "DELETE", "REPLACE":
		return !strings.Contains(query, "livesync_")
	}
	return false
}

// observedEngines remembers the engines whose logger was wrapped: it is
// done once per engine and stays (the observer is inert while no reader is
// subscribed). Wrapping is not synchronised with concurrent queries on that
// engine; it runs once, at startup.
var observedEngines sync.Map // *xorm.Engine -> struct{}

func observeCommits(engine *xorm.Engine) {
	if _, loaded := observedEngines.LoadOrStore(engine, struct{}{}); !loaded {
		engine.SetLogger(commitObserver{ContextLogger: engine.Logger()})
	}
}

// listenPostgres rings d whenever a NOTIFY for schema arrives on the
// livesync channel, until ctx is done. It uses its own connection (not one of
// the pool's), reconnects with backoff, and rings once after every
// (re)connect to catch up with what it may have missed. Failures only cost
// latency, polling still works, so they are logged as warnings.
func listenPostgres(ctx context.Context, schema string, d *doorbell) {
	const maxBackoff = 30 * time.Second
	backoff := time.Second
	for {
		connected, err := listenOnce(ctx, schema, d)
		if ctx.Err() != nil {
			return
		}
		if connected {
			backoff = time.Second
		}
		log.Warn("livesync: LISTEN %s: %v; polling only, retrying in %s", pgNotifyChannel, err, backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, maxBackoff)
	}
}

func listenOnce(ctx context.Context, schema string, d *doorbell) (connected bool, err error) {
	connStr, err := setting.DBMasterConnStr()
	if err != nil {
		return false, err
	}
	conn, err := pgx.Connect(ctx, connStr)
	if err != nil {
		return false, err
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = conn.Close(closeCtx)
	}()
	if _, err := conn.Exec(ctx, "LISTEN "+pgQuote(pgNotifyChannel)); err != nil {
		return false, err
	}
	d.ring()
	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return true, err
		}
		if n.Payload == schema {
			d.ring()
		}
	}
}
