// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package capture

import (
	"context"
	"fmt"
	"sort"
	"strings"

	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/setting"
	"forgejo.org/services/livesync/catalog"
)

// Inspect compares the catalog with the capture objects that exist in the
// database (pg_trigger / information_schema.triggers) without changing
// anything.
func Inspect(ctx context.Context) (*Status, error) {
	switch {
	case setting.Database.Type.IsPostgreSQL():
		return inspectPostgres(ctx)
	case setting.Database.Type.IsMySQL():
		return inspectMySQL(ctx)
	default:
		return nil, fmt.Errorf("livesync: no change capture for database type %q", setting.Database.Type)
	}
}

// CurrentSchema returns the PostgreSQL schema / MySQL database livesync's
// tables and triggers live in (the NOTIFY payload on PostgreSQL).
func CurrentSchema(ctx context.Context) (string, error) {
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return "", err
	}
	query := "SELECT DATABASE()"
	if setting.Database.Type.IsPostgreSQL() {
		query = "SELECT current_schema()"
	}
	var schema string
	if _, err := e.SQL(query).Get(&schema); err != nil {
		return "", fmt.Errorf("livesync: current schema: %w", err)
	}
	if schema == "" {
		return "", fmt.Errorf("livesync: %s returned nothing", query)
	}
	return schema, nil
}

type pgFunctionRow struct {
	Src      string `xorm:"'src'"`
	RetType  string `xorm:"'rettype'"`
	Language string `xorm:"'lang'"`
}

type pgTriggerRow struct {
	Table      string `xorm:"'tbl'"`
	Enabled    string `xorm:"'enabled'"`
	Type       int    `xorm:"'ttype'"`
	FuncSchema string `xorm:"'fschema'"`
	FuncName   string `xorm:"'fname'"`
	NArgs      int    `xorm:"'nargs'"`
	NCols      int    `xorm:"'ncols'"`
	HasWhen    bool   `xorm:"'has_when'"`
}

func inspectPostgres(ctx context.Context) (*Status, error) {
	schema, err := CurrentSchema(ctx)
	if err != nil {
		return nil, err
	}
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return nil, err
	}
	var fns []pgFunctionRow
	if err := e.SQL(`SELECT p.prosrc AS src, t.typname AS rettype, l.lanname AS lang
		FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace
		JOIN pg_type t ON t.oid = p.prorettype
		JOIN pg_language l ON l.oid = p.prolang
		WHERE n.nspname = ? AND p.proname = ? AND p.pronargs = 0`, schema, pgFunctionName).Find(&fns); err != nil {
		return nil, fmt.Errorf("livesync: inspect capture function: %w", err)
	}
	st := &Status{Dialect: "postgres", Schema: schema}
	fn := Object{Kind: KindFunction, Name: pgFunctionName, State: StateMissing}
	if len(fns) == 1 {
		fn.State, fn.Detail = StateOK, ""
		switch {
		case fns[0].RetType != "trigger":
			// CREATE OR REPLACE cannot change the return type.
			fn.State, fn.Detail, fn.dropFirst = StateStale, "returns "+fns[0].RetType+", not trigger", true
		case fns[0].Language != "plpgsql":
			fn.State, fn.Detail = StateStale, "language "+fns[0].Language+", not plpgsql"
		case fns[0].Src != pgFunctionBody(schema):
			fn.State, fn.Detail = StateStale, "different body"
		}
	}
	st.Objects = append(st.Objects, fn)

	e, err = livesync_model.MasterEngine(ctx)
	if err != nil {
		return nil, err
	}
	var rows []pgTriggerRow
	if err := e.SQL(`SELECT c.relname AS tbl, t.tgenabled::text AS enabled, t.tgtype::int AS ttype,
			fn.nspname AS fschema, p.proname AS fname, t.tgnargs::int AS nargs,
			COALESCE(array_length(t.tgattr::int2[], 1), 0) AS ncols, (t.tgqual IS NOT NULL) AS has_when
		FROM pg_trigger t
		JOIN pg_class c ON c.oid = t.tgrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		JOIN pg_proc p ON p.oid = t.tgfoid
		JOIN pg_namespace fn ON fn.oid = p.pronamespace
		WHERE n.nspname = ? AND t.tgname = ? AND NOT t.tgisinternal`, schema, pgTriggerName).Find(&rows); err != nil {
		return nil, fmt.Errorf("livesync: inspect capture triggers: %w", err)
	}
	existing := make(map[string]pgTriggerRow, len(rows))
	for _, r := range rows {
		existing[r.Table] = r
	}
	for _, t := range catalog.Tracked() {
		o := Object{Kind: KindTrigger, Table: t.Name, Name: pgTriggerName, State: StateMissing}
		if r, ok := existing[t.Name]; ok {
			o.State, o.Detail = pgTriggerState(r, schema)
			delete(existing, t.Name)
		}
		st.Objects = append(st.Objects, o)
	}
	for _, table := range sortedKeys(existing) {
		st.Objects = append(st.Objects, Object{Kind: KindTrigger, Table: table, Name: pgTriggerName, State: StateExtra})
	}
	return st, nil
}

func pgTriggerState(r pgTriggerRow, schema string) (State, string) {
	var why []string
	if r.Enabled != "O" && r.Enabled != "A" { // origin (default) or always
		why = append(why, "disabled")
	}
	if r.Type != pgTriggerType {
		why = append(why, fmt.Sprintf("tgtype %d, want %d", r.Type, pgTriggerType))
	}
	if r.FuncSchema != schema || r.FuncName != pgFunctionName {
		why = append(why, "calls "+r.FuncSchema+"."+r.FuncName)
	}
	if r.NArgs != 0 || r.NCols != 0 || r.HasWhen {
		why = append(why, "has arguments, a column list or a WHEN condition")
	}
	if len(why) > 0 {
		return StateStale, strings.Join(why, ", ")
	}
	return StateOK, ""
}

type mysqlTriggerRow struct {
	Name        string `xorm:"'tname'"`
	Event       string `xorm:"'tevent'"`
	Table       string `xorm:"'ttable'"`
	Timing      string `xorm:"'ttiming'"`
	Orientation string `xorm:"'torient'"`
	Statement   string `xorm:"'tstmt'"`
	Definer     string `xorm:"'tdefiner'"`
}

type mysqlServerRow struct {
	User         string `xorm:"'cur_user'"`
	LogBin       int    `xorm:"'log_bin'"`
	BinlogFormat string `xorm:"'binlog_format'"`
}

func inspectMySQL(ctx context.Context) (*Status, error) {
	schema, err := CurrentSchema(ctx)
	if err != nil {
		return nil, err
	}
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return nil, err
	}
	// information_schema.triggers lists the triggers of the tables the user
	// has the TRIGGER privilege on.
	var rows []mysqlTriggerRow
	if err := e.SQL(`SELECT trigger_name AS tname, event_manipulation AS tevent, event_object_table AS ttable,
			action_timing AS ttiming, action_orientation AS torient, action_statement AS tstmt, definer AS tdefiner
		FROM information_schema.triggers
		WHERE trigger_schema = DATABASE() AND trigger_name LIKE ? ESCAPE '!'`,
		strings.ReplaceAll(mysqlTriggerPrefix, "_", "!_")+"%").Find(&rows); err != nil {
		return nil, fmt.Errorf("livesync: inspect capture triggers: %w", err)
	}
	existing := make(map[string]mysqlTriggerRow, len(rows))
	for _, r := range rows {
		existing[r.Name] = r
	}
	e, err = livesync_model.MasterEngine(ctx)
	if err != nil {
		return nil, err
	}
	var server mysqlServerRow
	if _, err := e.SQL("SELECT CURRENT_USER() AS cur_user, @@log_bin AS log_bin, @@binlog_format AS binlog_format").Get(&server); err != nil {
		return nil, fmt.Errorf("livesync: inspect server settings: %w", err)
	}
	st := &Status{Dialect: "mysql", Schema: schema, User: server.User}
	if server.LogBin != 0 && strings.EqualFold(server.BinlogFormat, "STATEMENT") {
		st.Warnings = append(st.Warnings, "binlog_format is STATEMENT: the capture triggers insert into an AUTO_INCREMENT column, "+
			"which is unsafe for statement-based replication (replicas may assign other outbox ids, and every captured write logs Note 1592); "+
			"use binlog_format ROW or MIXED")
	}
	foreign := map[string]int{} // definer -> triggers
	for _, r := range rows {
		if r.Definer != "" && r.Definer != server.User {
			foreign[r.Definer]++
		}
	}
	for _, definer := range sortedKeys(foreign) {
		st.Warnings = append(st.Warnings, fmt.Sprintf("%d livesync trigger(s) are defined by %s, not by Forgejo's account %s: they run with that account's privileges, "+
			"and every write to their tables fails (error 1449) if it is dropped; make sure it stays, or recreate them with CREATE DEFINER = %s TRIGGER",
			foreign[definer], definer, server.User, mysqlAccount(server.User)))
	}
	for _, t := range catalog.Tracked() {
		for _, ev := range mysqlEvents {
			name := mysqlTriggerName(t.Name, ev)
			o := Object{Kind: KindTrigger, Table: t.Name, Name: name, State: StateMissing}
			if r, ok := existing[name]; ok {
				o.State, o.Detail = mysqlTriggerState(r, t.Name, ev)
				delete(existing, name)
			}
			st.Objects = append(st.Objects, o)
		}
	}
	for _, name := range sortedKeys(existing) {
		st.Objects = append(st.Objects, Object{Kind: KindTrigger, Table: existing[name].Table, Name: name, State: StateExtra})
	}
	return st, nil
}

func mysqlTriggerState(r mysqlTriggerRow, table string, ev mysqlEvent) (State, string) {
	var why []string
	if !strings.EqualFold(r.Table, table) {
		why = append(why, "on table "+r.Table)
	}
	if !strings.EqualFold(r.Event, ev.event) || !strings.EqualFold(r.Timing, "AFTER") || !strings.EqualFold(r.Orientation, "ROW") {
		why = append(why, r.Timing+" "+r.Event+" FOR EACH "+r.Orientation)
	}
	if strings.TrimSpace(r.Statement) != mysqlTriggerStatement(table, ev) {
		why = append(why, "different body")
	}
	if len(why) > 0 {
		return StateStale, strings.Join(why, ", ")
	}
	return StateOK, ""
}

// mysqlEventOf returns the event of the livesync trigger name on table.
func mysqlEventOf(table, name string) (mysqlEvent, bool) {
	for _, ev := range mysqlEvents {
		if mysqlTriggerName(table, ev) == name {
			return ev, true
		}
	}
	return mysqlEvent{}, false
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
