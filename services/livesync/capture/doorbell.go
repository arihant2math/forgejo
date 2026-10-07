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
	"forgejo.org/modules/log"
	"forgejo.org/modules/setting"

	"code.forgejo.org/xorm/xorm"
	"code.forgejo.org/xorm/xorm/contexts"
	"github.com/jackc/pgx/v5"
)

// The doorbell wakes the outbox reader as soon as a change may have been
// committed, so it does not have to wait for its next poll (PLAN §4.3):
//
//   - in process, a passive xorm hook on the master engine rings after every
//     COMMIT and every successful INSERT/UPDATE/DELETE/REPLACE statement
//     (which may be autocommitted: the hook cannot tell);
//   - on PostgreSQL, LISTEN livesync rings when any instance commits a
//     captured change (the trigger function calls pg_notify);
//   - polling (PollInterval) is the safety net and, on MySQL, the
//     cross-instance mechanism.
//
// A ring is only a hint: the reader re-reads the outbox, which is cheap when
// nothing is new.

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

// commitHook is the in-process doorbell, an xorm contexts.Hook.
//
// xorm's hook chain does not pass the context returned by one hook's
// BeforeProcess to the next one: the context of the LAST hook is used for
// the query and handed to every AfterProcess. Forgejo's db.TracingHook
// (registered last by db.InitEngine) stores its runtime/trace task in that
// context and its AfterProcess requires it. A hook appended after it must
// therefore return a context carrying a tracing task too, which is why
// BeforeProcess delegates to db.TracingHook.
type commitHook struct{}

var _ contexts.Hook = commitHook{}

func (commitHook) BeforeProcess(c *contexts.ContextHook) (context.Context, error) {
	return db.TracingHook{}.BeforeProcess(c)
}

func (commitHook) AfterProcess(c *contexts.ContextHook) error {
	if c.Err == nil && pokes(c.SQL) {
		ringAll()
	}
	return nil
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

// hookedEngines remembers the engines the commit hook was added to: xorm
// can add hooks but not remove them, so it is added once per engine and
// stays (it is inert while no reader is subscribed).
var hookedEngines sync.Map // *xorm.Engine -> struct{}

func addCommitHook(engine *xorm.Engine) {
	if _, loaded := hookedEngines.LoadOrStore(engine, struct{}{}); !loaded {
		engine.AddHook(commitHook{})
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
