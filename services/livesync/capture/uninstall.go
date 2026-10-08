// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package capture

import (
	"context"
	"fmt"
	"strings"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/setting"
)

// Uninstalling (the kill switch). Livesync's triggers keep writing every
// change of a tracked table to livesync_change whether livesync runs or
// not; with nothing draining it the outbox grows for good. Disabling
// livesync therefore removes them (services/livesync.Disable, INSTALL_MODE
// auto) or tells the operator how to (UninstallScript). Installing them
// again later is a repair of every table: every schema epoch is bumped, so
// clients re-bootstrap whatever they held (the changes in between were not
// captured).

// Installed reports whether any livesync capture object (the PostgreSQL
// function or any trigger, current or not) exists.
func (s *Status) Installed() bool {
	for _, o := range s.Objects {
		if o.State != StateMissing {
			return true
		}
	}
	return false
}

// UninstallStatements returns the DDL that removes every livesync capture
// object this status found (triggers first, then the PostgreSQL function).
// Each statement is idempotent. It is empty when nothing is installed.
func (s *Status) UninstallStatements() []string {
	var stmts []string
	function := false
	for _, o := range s.Objects {
		if o.State == StateMissing {
			continue
		}
		switch {
		case o.Kind == KindFunction:
			function = true
		case s.Dialect == "postgres":
			stmts = append(stmts, pgDropTrigger(s.Schema, o.Table))
		default:
			stmts = append(stmts, mysqlDropTrigger(o.Name))
		}
	}
	if function {
		// Without CASCADE: a trigger livesync does not know about that
		// uses the function makes the statement fail instead of being
		// dropped silently.
		stmts = append(stmts, "DROP FUNCTION IF EXISTS "+pgQuote(s.Schema)+"."+pgQuote(pgFunctionName)+"()")
	}
	return stmts
}

// UninstallScript returns UninstallStatements as an SQL script for a DBA,
// with a header, followed by the (commented out) statements that also
// remove livesync's own tables. It is empty when nothing is installed.
func (s *Status) UninstallScript() string {
	stmts := s.UninstallStatements()
	if len(stmts) == 0 {
		return ""
	}
	var b strings.Builder
	if s.Dialect == "postgres" {
		fmt.Fprintf(&b, "-- Remove the Forgejo livesync capture triggers, PostgreSQL schema %q.\n", s.Schema)
		b.WriteString("-- Run as the owner of Forgejo's tables, with livesync disabled ([livesync] ENABLED = false).\n")
	} else {
		fmt.Fprintf(&b, "-- Remove the Forgejo livesync capture triggers, MySQL database %s.\n", mysqlQuote(s.Schema))
		b.WriteString("-- Run as a user with the TRIGGER privilege, with livesync disabled ([livesync] ENABLED = false).\n")
		fmt.Fprintf(&b, "USE %s;\n", mysqlQuote(s.Schema))
	}
	for _, stmt := range stmts {
		b.WriteString(stmt)
		b.WriteString(";\n")
	}
	b.WriteString(TablesScript(s.Dialect, s.Schema))
	return b.String()
}

// TablesScript returns, commented out, the statements that drop
// livesync's own tables. They must only run once the triggers are gone:
// while a trigger exists, every write to its table fails without
// livesync_change.
func TablesScript(dialect, schema string) string {
	var b strings.Builder
	b.WriteString("-- To remove livesync completely, also drop its own tables (only after the triggers\n")
	b.WriteString("-- above are gone, or every write to a tracked table fails):\n")
	for _, bean := range livesync_model.Tables() {
		name := db.TableName(bean)
		if dialect == "postgres" {
			fmt.Fprintf(&b, "-- DROP TABLE IF EXISTS %s.%s;\n", pgQuote(schema), pgQuote(name))
		} else {
			fmt.Fprintf(&b, "-- DROP TABLE IF EXISTS %s;\n", mysqlQuote(name))
		}
	}
	return b.String()
}

// UninstallReport describes what Uninstall did.
type UninstallReport struct {
	// Status is what Inspect found before the uninstall.
	Status *Status
	// Dropped counts the objects removed.
	Dropped int
	// Cleared reports whether the outbox was emptied.
	Cleared bool
}

// Uninstall removes every livesync capture object and empties the outbox,
// under the schema lock, each DDL statement waiting at most DDLLockTimeout
// for its table's lock (on PostgreSQL in one transaction). The schema
// epochs are left alone: installing the triggers again repairs every table
// and bumps its epoch, which is what clients need after a period without
// capture. It does nothing (and reports nothing dropped) when no capture
// object exists and the outbox is empty.
func Uninstall(ctx context.Context) (*UninstallReport, error) {
	var report *UninstallReport
	err := livesync_model.WithSchemaLock(ctx, func(ctx context.Context) error {
		st, err := Inspect(ctx)
		if err != nil {
			return err
		}
		report = &UninstallReport{Status: st}
		stmts := st.UninstallStatements()
		report.Dropped = len(stmts)
		// Nothing writes to the outbox once the triggers are gone: what it
		// holds will never be consumed by this livesync (the next start
		// repairs every table and clients re-bootstrap), so it is emptied
		// at once (with the drops, under the same lock timeout) rather
		// than row by row.
		e, err := livesync_model.MasterEngine(ctx)
		if err != nil {
			return err
		}
		has, err := e.Table(livesync_model.Change{}.TableName()).Exist()
		if err != nil {
			return fmt.Errorf("livesync: read the outbox: %w", err)
		}
		if has {
			table := quoteTable(livesync_model.Change{}.TableName())
			stmts = append(stmts, "TRUNCATE TABLE "+table)
			if setting.Database.Type.IsMySQL() {
				// TRUNCATE resets MySQL's AUTO_INCREMENT (PostgreSQL's
				// sequence is kept): put it back, so that outbox ids stay
				// monotonic for readers and the idempotency layer's ranges
				// on instances that still run.
				last, err := LastAssignedID(ctx)
				if err != nil {
					return err
				}
				stmts = append(stmts, fmt.Sprintf("ALTER TABLE %s AUTO_INCREMENT = %d", table, last+1))
			}
			report.Cleared = true
		}
		if len(stmts) == 0 {
			return nil
		}
		run := func(ctx context.Context) error { return execStatements(ctx, stmts) }
		if setting.Database.Type.IsPostgreSQL() {
			err = db.WithTx(ctx, run) // DDL is transactional: all or nothing
		} else {
			err = run(ctx)
		}
		if err != nil {
			return fmt.Errorf("livesync: remove the capture triggers: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return report, err
}

func quoteTable(name string) string {
	if setting.Database.Type.IsPostgreSQL() {
		return pgQuote(name)
	}
	return mysqlQuote(name)
}
