// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Package synclog is livesync's sync log (PLAN §4.4, §4.11): a gap-free,
// strictly increasing sequence of entity changes (livesync_log) written by a
// single writer and read by every instance.
//
//   - One writer: AcquireWriter takes a database lease (PostgreSQL advisory
//     lock / MySQL GET_LOCK) and a fencing token; Writer.Append assigns the
//     next sync ids inside the caller's transaction and refuses to write if
//     another instance has taken over, so even a writer that lost its lease
//     without noticing cannot interleave ids or acknowledge outbox rows.
//   - Many tailers: every instance runs a Tailer that follows the log and
//     hands new entries to a Sink (the WebSocket hub, B5).
//   - ReadSince serves replays from a cursor; Trim applies the retention
//     policy and moves the floor below which replays are impossible
//     (clients behind it must re-bootstrap).
package synclog

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/timeutil"
	"forgejo.org/services/livesync/protocol"
)

// livesync_meta entries owned by the sync log.
const (
	// MetaHead holds the last assigned sync id.
	MetaHead = "log_head"
	// MetaWriter holds the fencing token of the current writer; every
	// AcquireWriter increments it.
	MetaWriter = "log_writer"
	// MetaFloor holds the retention floor: entries with a sync id at or
	// below it may have been trimmed; every entry above it is present.
	MetaFloor = "log_floor"
)

// leaseName names the writer lease (scoped to the schema / database like
// the schema lock).
const leaseName = "livesync.writer"

// pgNotifyChannel is the PostgreSQL channel the writer notifies (payload:
// the schema) when it appended entries; tailers on other instances LISTEN.
const pgNotifyChannel = "livesync_log"

var (
	// ErrWriterHeld is returned by AcquireWriter while another instance is
	// the writer.
	ErrWriterHeld = errors.New("livesync: another instance is the sync log writer")
	// ErrNotWriter is returned by Append when another instance has become
	// the writer since this one acquired the lease (fencing token changed).
	ErrNotWriter = errors.New("livesync: this instance is no longer the sync log writer")
)

// Writer is the single writer of the sync log.
type Writer struct {
	lease *livesync_model.Lease
	token int64
	wake  func()
}

// AcquireWriter makes this instance the sync log writer if no other instance
// is (ErrWriterHeld otherwise). wake, if not nil, is called after every
// commit that appended entries (the local tailer's Wake).
func AcquireWriter(ctx context.Context, wake func()) (*Writer, error) {
	lease, err := livesync_model.TryLease(ctx, leaseName)
	if errors.Is(err, livesync_model.ErrLeaseHeld) {
		return nil, ErrWriterHeld
	}
	if err != nil {
		return nil, err
	}
	w := &Writer{lease: lease, wake: wake}
	if err := w.init(ctx); err != nil {
		lease.Release()
		return nil, err
	}
	return w, nil
}

func (w *Writer) init(ctx context.Context) error {
	// The head row must exist before writers lock it. If it is missing
	// while entries exist (meta wiped), continue after the newest entry.
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return err
	}
	var maxID int64
	if _, err := e.SQL("SELECT COALESCE(MAX(sync_id), 0) FROM livesync_log").Get(&maxID); err != nil {
		return fmt.Errorf("livesync: read the sync log head: %w", err)
	}
	if err := livesync_model.InsertMetaIfAbsent(ctx, MetaHead, strconv.FormatInt(maxID, 10)); err != nil {
		return err
	}
	if err := livesync_model.InsertMetaIfAbsent(ctx, MetaWriter, "0"); err != nil {
		return err
	}
	return db.WithTx(ctx, func(ctx context.Context) error {
		values, err := lockMeta(ctx, MetaWriter)
		if err != nil {
			return err
		}
		w.token = values[MetaWriter] + 1
		return livesync_model.SetMeta(ctx, MetaWriter, strconv.FormatInt(w.token, 10))
	})
}

// Check reports an error once the writer lease is lost (its connection
// died). The writer must then stop: another instance may take over.
func (w *Writer) Check(ctx context.Context) error {
	return w.lease.Check(ctx)
}

// Release gives the lease up. It is idempotent.
func (w *Writer) Release() {
	w.lease.Release()
}

// Entry is one sync log entry to append.
type Entry struct {
	Group     string
	Unit      protocol.Unit
	Model     protocol.Model
	EntityID  int64
	Op        protocol.Op
	Payload   string
	SchemaVer int
}

// Append appends entries in ctx's transaction and returns the sync id
// assigned to the first one; the others follow consecutively. It must run
// in a transaction (the materializer's), and it first locks the log head and
// verifies the fencing token, so call it in every transaction that acts as
// the writer (also with no entries, e.g. one that only acknowledges outbox
// rows): it returns ErrNotWriter if another instance has become the writer.
// Ids are gap-free and strictly increasing in commit order: the head row
// stays locked until the transaction ends, and a rollback discards both.
func (w *Writer) Append(ctx context.Context, entries []Entry) (int64, error) {
	if !db.InTransaction(ctx) {
		return 0, errors.New("livesync: synclog Append outside a transaction")
	}
	values, err := lockMeta(ctx, MetaHead, MetaWriter)
	if err != nil {
		return 0, err
	}
	if values[MetaWriter] != w.token {
		return 0, ErrNotWriter
	}
	head := values[MetaHead]
	if len(entries) == 0 {
		return head + 1, nil
	}
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return 0, err
	}
	now := timeutil.TimeStamp(time.Now().Unix())
	const chunk = 100
	rows := make([]livesync_model.LogEntry, 0, min(len(entries), chunk))
	for i, en := range entries {
		rows = append(rows, livesync_model.LogEntry{
			Grp:         en.Group,
			SyncID:      head + 1 + int64(i),
			Model:       string(en.Model),
			EntityID:    en.EntityID,
			Op:          string(en.Op),
			Unit:        string(en.Unit),
			Payload:     en.Payload,
			SchemaVer:   en.SchemaVer,
			CreatedUnix: now,
		})
		if len(rows) == chunk || i == len(entries)-1 {
			if _, err := e.Insert(&rows); err != nil {
				return 0, fmt.Errorf("livesync: append to the sync log: %w", err)
			}
			rows = rows[:0]
		}
	}
	if err := livesync_model.SetMeta(ctx, MetaHead, strconv.FormatInt(head+int64(len(entries)), 10)); err != nil {
		return 0, err
	}
	if setting.Database.Type.IsPostgreSQL() {
		// Delivered at commit, to the tailers of every instance.
		if _, err := e.Exec("SELECT pg_notify(?, current_schema())", pgNotifyChannel); err != nil {
			return 0, fmt.Errorf("livesync: notify the sync log tailers: %w", err)
		}
	}
	if w.wake != nil {
		db.AfterTx(ctx, w.wake)
	}
	return head + 1, nil
}

// lockMeta reads the given livesync_meta rows as numbers, locking them
// until the end of ctx's transaction (SELECT … FOR UPDATE; SQLite, used by
// unit tests only, locks the whole database on write anyway). Missing rows
// read as 0 (and are not locked). The rows are locked in name order, so
// that transactions locking several of them cannot deadlock (without ORDER
// BY, PostgreSQL locks them in physical order, which changes with every
// update).
func lockMeta(ctx context.Context, names ...string) (map[string]int64, error) {
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return nil, err
	}
	query := "SELECT name, value FROM livesync_meta WHERE name IN (?" + strings.Repeat(", ?", len(names)-1) + ") ORDER BY name"
	if !setting.Database.Type.IsSQLite3() {
		query += " FOR UPDATE"
	}
	args := make([]any, 0, len(names))
	for _, name := range names {
		args = append(args, name)
	}
	var metas []livesync_model.Meta
	if err := e.SQL(query, args...).Find(&metas); err != nil {
		return nil, fmt.Errorf("livesync: lock %v: %w", names, err)
	}
	values := make(map[string]int64, len(names))
	for _, m := range metas {
		v, err := strconv.ParseInt(m.Value, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("livesync_meta %s is %q, not a number", m.Name, m.Value)
		}
		values[m.Name] = v
	}
	return values, nil
}

// metaInt reads a numeric livesync_meta entry (0 if missing).
func metaInt(ctx context.Context, name string) (int64, error) {
	v, ok, err := livesync_model.GetMeta(ctx, name)
	if err != nil || !ok {
		return 0, err
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("livesync_meta %s is %q, not a number", name, v)
	}
	return n, nil
}
