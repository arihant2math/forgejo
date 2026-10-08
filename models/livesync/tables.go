// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Package livesync holds the tables owned by the livesync module.
//
// These tables are deliberately NOT registered with db.RegisterModel: they are
// not part of Forgejo's migrations, doctor checks, dumps or table catalog. They
// are created (and extended by later milestones) with Engine.Sync from
// services/livesync.Init via SyncTables. None of them declares a REFERENCES
// constraint to an upstream table, so upstream deletes are never blocked.
package livesync

import (
	"forgejo.org/modules/timeutil"
)

// Change is one row of the trigger-fed outbox. Database triggers on every
// tracked table insert (tbl, row_id, op) in the same transaction as the change
// itself; the outbox reader consumes rows in id order and deletes them once the
// materializer has processed them.
type Change struct {
	ID    int64  `xorm:"pk autoincr"`
	Tbl   string `xorm:"VARCHAR(64) NOT NULL"`
	RowID int64  `xorm:"NOT NULL"`
	// Op is 'I', 'U' or 'D'.
	Op string `xorm:"CHAR(1) NOT NULL"`
}

// TableName implements xorm's TableName interface.
func (Change) TableName() string { return "livesync_change" }

// Op values written by the capture triggers into livesync_change.op.
const (
	OpInsert = "I"
	OpUpdate = "U"
	OpDelete = "D"
)

// LogEntry is one entry of the gap-free sync log. SyncID is assigned by the
// single-writer materializer (it is not an auto-increment column so that it can
// be gap-free). Grp is the sync group ("user:1", "repo:2", "issue:3", ...,
// or "*" for entries every reader gets). Unit is the repository unit a reader
// needs to receive the entry ("" = any access to the group; see
// services/livesync/protocol.Unit). Op is protocol.Op: 'U' upsert (Payload is
// the entity's JSON), 'D' delete, 'B' re-bootstrap marker.
//
// Grp is declared before SyncID so that the composite index is (grp, sync_id),
// which is what "read group G since cursor C" needs.
type LogEntry struct {
	Grp         string             `xorm:"VARCHAR(64) NOT NULL INDEX(grp_sync)"`
	SyncID      int64              `xorm:"pk INDEX(grp_sync)"`
	Model       string             `xorm:"VARCHAR(64) NOT NULL"`
	EntityID    int64              `xorm:"NOT NULL"`
	Op          string             `xorm:"CHAR(1) NOT NULL"`
	Unit        string             `xorm:"VARCHAR(32) NOT NULL DEFAULT ''"`
	Payload     string             `xorm:"LONGTEXT"`
	SchemaVer   int                `xorm:"NOT NULL DEFAULT 0"`
	CreatedUnix timeutil.TimeStamp `xorm:"INDEX NOT NULL"`
}

// TableName implements xorm's TableName interface.
func (LogEntry) TableName() string { return "livesync_log" }

// Entity remembers, for every materialized row, which sync group (and unit)
// it belongs to, a hash of the payload last emitted for it and the sync id of
// that entry. Deletes are routed with it: the triggers only know (table, id),
// the row itself is gone by then. The materializer also backfills it for rows
// that existed before livesync was installed (Hash empty, LastSyncID 0).
//
// Tbl is the source table for a row's main entity; an additional entity
// derived from the same row uses "<table>#<suffix>" (e.g. "issue#body" for
// protocol.IssueBody), which can never collide with a table name.
//
// Perm is the permission state of the row's last materialized version, for
// rows of the tables that decide who may read what (B4): the subjects whose
// access the row affects plus a fingerprint of its permission-relevant
// columns. When it changes (or the row appears or goes), the materializer
// writes a permission epoch for the old and new subjects; keeping it here
// lets it do that for deleted rows too.
type Entity struct {
	Tbl        string `xorm:"pk VARCHAR(64)"`
	RowID      int64  `xorm:"pk"`
	Grp        string `xorm:"VARCHAR(64) NOT NULL"`
	Unit       string `xorm:"VARCHAR(32) NOT NULL DEFAULT ''"`
	Hash       string `xorm:"VARCHAR(16) NOT NULL DEFAULT ''"`
	LastSyncID int64  `xorm:"NOT NULL DEFAULT 0"`
	Perm       string `xorm:"VARCHAR(255) NOT NULL DEFAULT ''"`
}

// TableName implements xorm's TableName interface.
func (Entity) TableName() string { return "livesync_entity" }

// Meta is a small key/value store for livesync's own durable state: the
// materializer cursor, per-table schema epochs, the version of these tables.
//
// The columns are called name/value rather than key/value because KEY is a
// reserved word in MySQL and would have to be quoted in every raw query.
type Meta struct {
	Name  string `xorm:"pk VARCHAR(255)"`
	Value string `xorm:"TEXT"`
}

// TableName implements xorm's TableName interface.
func (Meta) TableName() string { return "livesync_meta" }

// Idempotency states stored in livesync_idempotency.state.
const (
	IdempotencyInFlight  = 0
	IdempotencyCompleted = 1
)

// Idempotency records one API v1 write made with an Idempotency-Key header
// (PLAN §4.8, services/livesync/idempotency): the key is reserved before the
// request runs (state in-flight, Owner = the attempt running it), and the
// response is stored when it completes so that a retry with the same key
// replays it. Records expire after [livesync] IDEMPOTENCY_TTL (7 days).
type Idempotency struct {
	ID     int64  `xorm:"pk autoincr"`
	UserID int64  `xorm:"UNIQUE(user_key) NOT NULL"`
	Key    string `xorm:"'idem_key' VARCHAR(255) UNIQUE(user_key) NOT NULL"`
	State  int    `xorm:"NOT NULL DEFAULT 0"`
	// Method, Path and RequestHash (sha256 of method, path, query, content
	// type and body) detect a key reused for a different request.
	Method      string `xorm:"VARCHAR(16) NOT NULL"`
	Path        string `xorm:"VARCHAR(1024) NOT NULL"`
	RequestHash string `xorm:"VARCHAR(64) NOT NULL"`
	// The stored response: status, selected headers (JSON) and body.
	Status  int    `xorm:"NOT NULL DEFAULT 0"`
	Headers string `xorm:"TEXT"`
	Body    []byte `xorm:"LONGBLOB"`
	// SyncID is the X-Livesync-Sync-Id echoed with the response (-1: not
	// known yet, computed at the next replay).
	SyncID int64 `xorm:"NOT NULL DEFAULT 0"`
	// Owner is the attempt running an in-flight record ("<instance>/<token>";
	// empty once the record is completed, or released because the attempt's
	// outcome is unknown, e.g. a 5xx). An in-flight record whose owner's
	// instance is gone was interrupted by a crash (B7).
	Owner string `xorm:"VARCHAR(64) NOT NULL DEFAULT ''"`
	// OutboxLow is the outbox position (last assigned livesync_change id)
	// before the first attempt ran, OutboxHigh the position after the
	// completing attempt: the outbox rows of the write lie in between (B7).
	OutboxLow   int64              `xorm:"NOT NULL DEFAULT 0"`
	OutboxHigh  int64              `xorm:"NOT NULL DEFAULT 0"`
	CreatedUnix timeutil.TimeStamp `xorm:"INDEX NOT NULL"`
	UpdatedUnix timeutil.TimeStamp `xorm:"NOT NULL"`
}

// TableName implements xorm's TableName interface.
func (Idempotency) TableName() string { return "livesync_idempotency" }

// Tables returns one bean per livesync table, in creation order.
func Tables() []any {
	return []any{
		new(Change),
		new(LogEntry),
		new(Entity),
		new(Meta),
		new(Idempotency),
	}
}
