// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package capture

import (
	"fmt"
	"strings"

	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/services/livesync/catalog"
)

// The capture triggers (PLAN §4.3). Their bodies reference only the id
// column of the tracked table — plus, on updates of a permission table, its
// permission columns (catalog.Table.PermColumns): an update that changes one
// of them is written as livesync_model.OpPermUpdate instead of OpUpdate, so
// the materializer learns that a row's permission state changed even when
// a later update restored it before the row was materialized. Upstream
// migrations that add, alter or drop other columns never conflict with them.
//
// PostgreSQL: one plpgsql function, schema-qualified, shared by one
// AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW trigger per tracked table.
// A permission table's trigger passes its permission columns as trigger
// arguments; the function compares them through to_jsonb(OLD/NEW), so a
// column that disappears is never an error (it compares equal: no flag).
// The function also rings the cross-instance doorbell with
// pg_notify('livesync', <schema>): notifications are delivered at commit and
// deduplicated per transaction; the payload lets listeners ignore other
// Forgejo instances that share the database under another schema.
//
// MySQL/MariaDB: three single-statement triggers per table, without an
// explicit DEFINER (so the creating account becomes the definer; see
// Status.Script), deterministic (no UUID()/NOW()). They insert into an
// AUTO_INCREMENT column, which MySQL flags as unsafe for statement-based
// replication (Note 1592): binlog_format must be ROW or MIXED (MIXED logs
// these writes row-based). Inspect warns about STATEMENT. The update
// trigger of a permission table names its permission columns (MySQL has no
// row-to-JSON): an upstream migration that drops or renames one of them
// makes every update of that table fail until the trigger is replaced (Init
// does that at the next start, after the migrations; CheckCatalog refuses
// to serve, and so to install triggers, while a permission column is
// missing).

const (
	// pgFunctionName and pgTriggerName name the PostgreSQL objects; the
	// trigger name is per table in PostgreSQL.
	pgFunctionName = "livesync_capture"
	pgTriggerName  = "livesync_capture"
	// pgNotifyChannel is the LISTEN/NOTIFY channel.
	pgNotifyChannel = "livesync"
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
DECLARE
	op text := '` + livesync_model.OpUpdate + `';
	o jsonb;
	n jsonb;
BEGIN
	IF TG_OP = 'DELETE' THEN
		INSERT INTO ` + outbox + ` (tbl, row_id, op) VALUES (TG_TABLE_NAME, OLD.id, '` + livesync_model.OpDelete + `');
	ELSIF TG_OP = 'UPDATE' THEN
		IF TG_NARGS > 0 THEN
			o := to_jsonb(OLD);
			n := to_jsonb(NEW);
			FOR i IN 0 .. TG_NARGS - 1 LOOP
				IF o -> TG_ARGV[i] IS DISTINCT FROM n -> TG_ARGV[i] THEN
					op := '` + livesync_model.OpPermUpdate + `';
					EXIT;
				END IF;
			END LOOP;
		END IF;
		INSERT INTO ` + outbox + ` (tbl, row_id, op) VALUES (TG_TABLE_NAME, NEW.id, op);
	ELSE
		INSERT INTO ` + outbox + ` (tbl, row_id, op) VALUES (TG_TABLE_NAME, NEW.id, '` + livesync_model.OpInsert + `');
	END IF;
	PERFORM pg_notify('` + pgNotifyChannel + `', TG_TABLE_SCHEMA);
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
	args := make([]string, 0, len(permColumns(table)))
	for _, c := range permColumns(table) {
		args = append(args, "'"+strings.ReplaceAll(c, "'", "''")+"'")
	}
	return "CREATE TRIGGER " + pgQuote(pgTriggerName) +
		" AFTER INSERT OR UPDATE OR DELETE ON " + pgQuote(schema) + "." + pgQuote(table) +
		" FOR EACH ROW EXECUTE FUNCTION " + pgQuote(schema) + "." + pgQuote(pgFunctionName) + "(" + strings.Join(args, ", ") + ")"
}

// permColumns returns the permission columns of a tracked table (none for
// other tables).
func permColumns(table string) []string {
	t, _ := catalog.Lookup(table)
	return t.PermColumns
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
	op := "'" + ev.op + "'"
	if cols := permColumns(table); ev.event == "UPDATE" && len(cols) > 0 {
		// NOT (a <=> b) is "distinct", NULLs included.
		changed := make([]string, 0, len(cols))
		for _, c := range cols {
			changed = append(changed, fmt.Sprintf("NOT (OLD.%s <=> NEW.%s)", mysqlQuote(c), mysqlQuote(c)))
		}
		op = fmt.Sprintf("CASE WHEN %s THEN '%s' ELSE '%s' END", strings.Join(changed, " OR "), livesync_model.OpPermUpdate, ev.op)
	}
	return fmt.Sprintf("INSERT INTO %s (tbl, row_id, op) VALUES ('%s', %s.id, %s)",
		mysqlQuote(livesync_model.Change{}.TableName()), table, row, op)
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
