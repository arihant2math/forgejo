// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package capture

import (
	"fmt"
	"strings"

	livesync_model "forgejo.org/models/livesync"
)

// The capture triggers (PLAN §4.3). Their bodies reference only the id
// column of the tracked table, so upstream migrations that add, alter or
// drop other columns never conflict with them: livesync must never be able
// to make an upstream write (or an upstream migration) fail, also not when
// it is disabled or in INSTALL_MODE=verify with triggers older than the
// binary. Keep it that way (TestTriggersReferenceOnlyID): do not compare
// columns here. Updates that may have changed a permission state and
// changed it back before the materializer read the row are handled there
// (materialize/perm.go, "touches"), not by flagging them in the trigger.
//
// PostgreSQL: one plpgsql function, schema-qualified, shared by one
// AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW trigger per tracked table.
// It does not NOTIFY (backend audit; version 1 did): a transaction that
// notifies takes a cluster-wide lock at commit, held until the commit is
// flushed, so every commit that touched a tracked table — in this database
// and in every other one of the cluster that uses NOTIFY — was serialised,
// capping concurrent write throughput at about one commit per fsync. The
// outbox reader is woken in-process instead, as on MySQL (doorbell.go).
//
// MySQL/MariaDB: three single-statement triggers per table, without an
// explicit DEFINER (so the creating account becomes the definer; see
// Status.Script), deterministic (no UUID()/NOW()). They insert into an
// AUTO_INCREMENT column, which MySQL flags as unsafe for statement-based
// replication (Note 1592): binlog_format must be ROW or MIXED (MIXED logs
// these writes row-based). Inspect warns about STATEMENT.

const (
	// pgFunctionName and pgTriggerName name the PostgreSQL objects; the
	// trigger name is per table in PostgreSQL.
	pgFunctionName = "livesync_capture"
	pgTriggerName  = "livesync_capture"
	// pgTriggerType is pg_trigger.tgtype for ROW | INSERT | DELETE | UPDATE
	// (AFTER = not BEFORE, not INSTEAD OF): 1 + 4 + 8 + 16.
	pgTriggerType = 29

	// mysqlTriggerPrefix starts the name of every livesync trigger on MySQL,
	// where trigger names are unique per database.
	mysqlTriggerPrefix = "livesync_"
)

// pgFunctionBody returns the body (pg_proc.prosrc) of the capture function
// for schema. The version marker makes a body written by an older livesync
// compare as stale, so that it is replaced.
func pgFunctionBody(schema string) string {
	outbox := pgQuote(schema) + "." + pgQuote(livesync_model.Change{}.TableName())
	return `
-- Forgejo livesync change capture v2. Managed by Forgejo: do not edit.
BEGIN
	IF TG_OP = 'DELETE' THEN
		INSERT INTO ` + outbox + ` (tbl, row_id, op) VALUES (TG_TABLE_NAME, OLD.id, '` + livesync_model.OpDelete + `');
	ELSIF TG_OP = 'UPDATE' THEN
		INSERT INTO ` + outbox + ` (tbl, row_id, op) VALUES (TG_TABLE_NAME, NEW.id, '` + livesync_model.OpUpdate + `');
	ELSE
		INSERT INTO ` + outbox + ` (tbl, row_id, op) VALUES (TG_TABLE_NAME, NEW.id, '` + livesync_model.OpInsert + `');
	END IF;
	RETURN NULL;
END;
`
}

func pgCreateFunction(schema string) string {
	return "CREATE OR REPLACE FUNCTION " + pgQuote(schema) + "." + pgQuote(pgFunctionName) +
		"() RETURNS trigger LANGUAGE plpgsql AS $livesync$" + pgFunctionBody(schema) + "$livesync$"
}

// pgDropFunction drops the capture function together with every trigger
// that uses it: needed when CREATE OR REPLACE cannot replace it (another
// return type).
func pgDropFunction(schema string) string {
	return "DROP FUNCTION IF EXISTS " + pgQuote(schema) + "." + pgQuote(pgFunctionName) + "() CASCADE"
}

func pgDropTrigger(schema, table string) string {
	return "DROP TRIGGER IF EXISTS " + pgQuote(pgTriggerName) + " ON " + pgQuote(schema) + "." + pgQuote(table)
}

func pgCreateTrigger(schema, table string) string {
	return "CREATE TRIGGER " + pgQuote(pgTriggerName) +
		" AFTER INSERT OR UPDATE OR DELETE ON " + pgQuote(schema) + "." + pgQuote(table) +
		" FOR EACH ROW EXECUTE FUNCTION " + pgQuote(schema) + "." + pgQuote(pgFunctionName) + "()"
}

// mysqlEvent is one of the three MySQL triggers of a table.
type mysqlEvent struct {
	event  string // information_schema.triggers.event_manipulation
	suffix string // trigger name suffix
	op     string // livesync_change.op
}

var mysqlEvents = [...]mysqlEvent{
	{"INSERT", "_ai", livesync_model.OpInsert},
	{"UPDATE", "_au", livesync_model.OpUpdate},
	{"DELETE", "_ad", livesync_model.OpDelete},
}

func mysqlTriggerName(table string, ev mysqlEvent) string {
	return mysqlTriggerPrefix + table + ev.suffix
}

// mysqlTriggerStatement is the trigger body
// (information_schema.triggers.action_statement). The outbox table is not
// qualified: a trigger runs in the database it belongs to.
func mysqlTriggerStatement(table string, ev mysqlEvent) string {
	row := "NEW"
	if ev.event == "DELETE" {
		row = "OLD"
	}
	return fmt.Sprintf("INSERT INTO %s (tbl, row_id, op) VALUES ('%s', %s.id, '%s')",
		mysqlQuote(livesync_model.Change{}.TableName()), table, row, ev.op)
}

func mysqlDropTrigger(name string) string {
	return "DROP TRIGGER IF EXISTS " + mysqlQuote(name)
}

func mysqlCreateTrigger(table string, ev mysqlEvent) string {
	return "CREATE TRIGGER " + mysqlQuote(mysqlTriggerName(table, ev)) +
		" AFTER " + ev.event + " ON " + mysqlQuote(table) +
		" FOR EACH ROW " + mysqlTriggerStatement(table, ev)
}

func pgQuote(ident string) string {
	return `"` + strings.ReplaceAll(ident, `"`, `""`) + `"`
}

func mysqlQuote(ident string) string {
	return "`" + strings.ReplaceAll(ident, "`", "``") + "`"
}
