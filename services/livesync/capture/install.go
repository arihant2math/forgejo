// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package capture

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/setting"
	"forgejo.org/services/livesync/catalog"

	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5/pgconn"
)

// MetaEpochPrefix + table name is the livesync_meta entry holding the table's
// schema epoch: a counter bumped every time the table's capture trigger had to
// be (re)installed. Changes made while the trigger was missing or stale were
// not captured, so consumers (materializer, clients) must treat entities of
// that table as unreliable from before the bump and re-bootstrap them.
const MetaEpochPrefix = "schema_epoch."

// State is the state of one capture object (function or trigger).
type State string

const (
	// StateOK means the object exists and matches what livesync installs.
	StateOK State = "ok"
	// StateMissing means the object does not exist (never installed, or
	// dropped, e.g. by an upstream migration that recreated the table).
	StateMissing State = "missing"
	// StateStale means the object exists but differs from what livesync
	// installs (older version, disabled, edited); see Object.Detail.
	StateStale State = "stale"
	// StateExtra marks a livesync trigger on a table the catalog does not
	// track (any more). It costs a write per change but is otherwise harmless.
	StateExtra State = "extra"
)

// Object kinds.
const (
	KindFunction = "function"
	KindTrigger  = "trigger"
)

// Object is one database object of the capture machinery.
type Object struct {
	Kind   string // KindFunction (PostgreSQL only) or KindTrigger
	Table  string // the trigger's table; empty for the function
	Name   string // object name
	State  State
	Detail string // why the object is stale
}

// Status is the result of comparing the catalog with the triggers that exist
// in the database.
type Status struct {
	Dialect string // "postgres" or "mysql"
	// Schema is the PostgreSQL schema / MySQL database the objects live in.
	Schema  string
	Objects []Object
}

// Healthy reports whether every object livesync needs exists and is current.
// Extra triggers do not make a status unhealthy.
func (s *Status) Healthy() bool {
	for _, o := range s.Objects {
		if o.State == StateMissing || o.State == StateStale {
			return false
		}
	}
	return true
}

// broken returns the missing and stale objects.
func (s *Status) broken() []Object {
	var res []Object
	for _, o := range s.Objects {
		if o.State == StateMissing || o.State == StateStale {
			res = append(res, o)
		}
	}
	return res
}

func (s *Status) extras() []Object {
	var res []Object
	for _, o := range s.Objects {
		if o.State == StateExtra {
			res = append(res, o)
		}
	}
	return res
}

// repairTables returns the tracked tables whose capture must be
// (re)installed, sorted: all of them when the PostgreSQL function is broken.
func (s *Status) repairTables() []string {
	set := map[string]bool{}
	all := false
	for _, o := range s.broken() {
		if o.Kind == KindFunction {
			all = true
		} else {
			set[o.Table] = true
		}
	}
	if all {
		for _, t := range catalog.Tracked() {
			set[t.Name] = true
		}
	}
	tables := make([]string, 0, len(set))
	for t := range set {
		tables = append(tables, t)
	}
	sort.Strings(tables)
	return tables
}

// Statements returns the DDL statements that bring the database from this
// status to a healthy one, in order: (re)create the broken objects and drop
// the extra triggers. On a database without livesync triggers it is the full
// install script. Each statement is idempotent. Run them as a user allowed to
// create triggers (see Script).
func (s *Status) Statements() []string {
	var stmts []string
	switch s.Dialect {
	case "postgres":
		for _, o := range s.broken() {
			if o.Kind == KindFunction {
				stmts = append(stmts, pgCreateFunction(s.Schema))
			}
		}
		for _, o := range s.broken() {
			if o.Kind == KindTrigger {
				stmts = append(stmts, pgDropTrigger(s.Schema, o.Table), pgCreateTrigger(s.Schema, o.Table))
			}
		}
		for _, o := range s.extras() {
			stmts = append(stmts, pgDropTrigger(s.Schema, o.Table))
		}
	case "mysql":
		for _, o := range s.broken() {
			ev, ok := mysqlEventOf(o.Table, o.Name)
			if !ok {
				continue
			}
			stmts = append(stmts, mysqlDropTrigger(o.Name), mysqlCreateTrigger(o.Table, ev))
		}
		for _, o := range s.extras() {
			stmts = append(stmts, mysqlDropTrigger(o.Name))
		}
	}
	return stmts
}

// Script returns Statements as one SQL script for a DBA, with a header that
// says where and as whom to run it. It is empty when there is nothing to do.
// It works with psql and the mysql client as is (the MySQL trigger bodies are
// single statements, so no DELIMITER is needed).
func (s *Status) Script() string {
	stmts := s.Statements()
	if len(stmts) == 0 {
		return ""
	}
	var b strings.Builder
	if s.Dialect == "postgres" {
		fmt.Fprintf(&b, "-- Forgejo livesync capture triggers, PostgreSQL schema %q.\n", s.Schema)
		b.WriteString("-- Run as the owner of Forgejo's tables (normally Forgejo's database user).\n")
	} else {
		fmt.Fprintf(&b, "-- Forgejo livesync capture triggers, MySQL database %s.\n", mysqlQuote(s.Schema))
		b.WriteString("-- Run as a user with the TRIGGER privilege and, with binary logging on, SUPER\n")
		b.WriteString("-- (or with log_bin_trust_function_creators = 1).\n")
		fmt.Fprintf(&b, "USE %s;\n", mysqlQuote(s.Schema))
	}
	for _, stmt := range stmts {
		b.WriteString(stmt)
		b.WriteString(";\n")
	}
	return b.String()
}

// summary lists the broken objects for error messages.
func (s *Status) summary() string {
	var missing, stale []string
	for _, o := range s.broken() {
		name := o.Name
		if o.Kind == KindTrigger && s.Dialect == "postgres" {
			name = o.Table + "." + o.Name
		}
		if o.State == StateMissing {
			missing = append(missing, name)
		} else {
			stale = append(stale, name+" ("+o.Detail+")")
		}
	}
	var parts []string
	if len(missing) > 0 {
		parts = append(parts, fmt.Sprintf("%d missing: %s", len(missing), abbreviate(missing)))
	}
	if len(stale) > 0 {
		parts = append(parts, fmt.Sprintf("%d stale: %s", len(stale), abbreviate(stale)))
	}
	return strings.Join(parts, "; ")
}

func abbreviate(names []string) string {
	const maxNames = 8
	if len(names) <= maxNames {
		return strings.Join(names, ", ")
	}
	return strings.Join(names[:maxNames], ", ") + fmt.Sprintf(", … (%d more)", len(names)-maxNames)
}

// ErrNotInstalled is matched (errors.Is) by every NotInstalledError.
var ErrNotInstalled = errors.New("livesync capture triggers are missing or stale")

// NotInstalledError is returned by Ensure when the capture triggers are not
// healthy and could not (verify mode) or failed to (auto mode) be repaired.
// Status.Script holds the DDL a DBA can run.
type NotInstalledError struct {
	Status *Status
	// Cause is the error of the failed repair (auto mode), nil in verify mode.
	Cause error
}

func (e *NotInstalledError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("livesync: installing the capture triggers failed: %v (%s)", e.Cause, e.Status.summary())
	}
	return fmt.Sprintf("livesync: capture triggers not installed (%s)", e.Status.summary())
}

func (e *NotInstalledError) Unwrap() []error {
	if e.Cause == nil {
		return []error{ErrNotInstalled}
	}
	return []error{ErrNotInstalled, e.Cause}
}

// Report describes what Ensure found and did.
type Report struct {
	// Status is the final status (healthy unless only extras remain in
	// verify mode).
	Status *Status
	// Repaired lists the tables whose capture was (re)installed by this call
	// or, in verify mode, by a DBA since an earlier start found it broken;
	// their schema epochs were bumped.
	Repaired []string
	// Dropped lists the extra triggers that were removed.
	Dropped []string
	// Epochs holds the new schema epoch of every repaired table.
	Epochs map[string]int64
}

// Ensure checks the capture triggers against the catalog and, when repair is
// true (INSTALL_MODE = auto), creates or replaces the missing and stale ones,
// drops extra ones and bumps the schema epoch of every repaired table. When
// repair is false (INSTALL_MODE = verify) it changes no trigger. It returns a
// *NotInstalledError when the triggers are not healthy at the end, and then
// remembers the broken tables (MetaPending) so that a later Ensure that finds
// them healthy (repaired by a DBA) bumps their epochs. It runs
// under the schema lock, so instances starting together take turns.
func Ensure(ctx context.Context, repair bool) (*Report, error) {
	var report *Report
	err := livesync_model.WithSchemaLock(ctx, func(ctx context.Context) error {
		var err error
		report, err = ensureLocked(ctx, repair)
		return err
	})
	return report, err
}

func ensureLocked(ctx context.Context, repair bool) (*Report, error) {
	st, err := Inspect(ctx)
	if err != nil {
		return nil, err
	}
	// Tables found broken by an earlier start that could not repair them
	// (verify mode, or a failed repair): someone has repaired them since, or
	// this start will. Their changes in between were lost all the same, so
	// their epochs are bumped once they are healthy.
	pending, err := pendingTables(ctx)
	if err != nil {
		return nil, err
	}
	extras := st.extras()
	if !st.Healthy() && !repair {
		return nil, notInstalled(ctx, st, pending, nil)
	}

	report := &Report{Status: st, Epochs: map[string]int64{}}
	if !st.Healthy() || len(extras) > 0 && repair {
		if err := execStatements(ctx, st.Statements()); err != nil {
			return nil, notInstalled(ctx, st, pending, withPrivilegeHint(err))
		}
		report.Repaired = st.repairTables()
		for _, o := range extras {
			report.Dropped = append(report.Dropped, o.Name)
		}
		if report.Status, err = Inspect(ctx); err != nil {
			return nil, err
		}
		if !report.Status.Healthy() {
			return nil, notInstalled(ctx, report.Status, append(pending, report.Repaired...), errors.New("still missing or stale after the repair"))
		}
	}

	for _, table := range mergeTables(report.Repaired, pending) {
		epoch, err := bumpEpoch(ctx, table)
		if err != nil {
			return nil, err
		}
		report.Epochs[table] = epoch
	}
	if len(pending) > 0 {
		if err := livesync_model.SetMeta(ctx, MetaPending, ""); err != nil {
			return nil, err
		}
	}
	report.Repaired = mergeTables(report.Repaired, pending)
	return report, nil
}

// MetaPending is the livesync_meta entry listing (comma-separated) the
// tracked tables whose capture was found missing or stale but not repaired
// yet; Ensure bumps their schema epochs once they are healthy again.
const MetaPending = "capture_pending"

func pendingTables(ctx context.Context) ([]string, error) {
	v, _, err := livesync_model.GetMeta(ctx, MetaPending)
	if err != nil || v == "" {
		return nil, err
	}
	return strings.Split(v, ","), nil
}

// notInstalled records the broken tables as pending and returns the error.
func notInstalled(ctx context.Context, st *Status, pending []string, cause error) error {
	tables := mergeTables(pending, st.repairTables())
	if err := livesync_model.SetMeta(ctx, MetaPending, strings.Join(tables, ",")); err != nil {
		return errors.Join(&NotInstalledError{Status: st, Cause: cause}, err)
	}
	return &NotInstalledError{Status: st, Cause: cause}
}

// mergeTables returns the sorted union of a and b.
func mergeTables(a, b []string) []string {
	set := make(map[string]bool, len(a)+len(b))
	for _, t := range a {
		set[t] = true
	}
	for _, t := range b {
		set[t] = true
	}
	res := make([]string, 0, len(set))
	for t := range set {
		res = append(res, t)
	}
	sort.Strings(res)
	return res
}

// execStatements runs the repair DDL on the master database. PostgreSQL DDL
// is transactional, so the repair is atomic there; MySQL commits each DDL
// statement implicitly.
func execStatements(ctx context.Context, stmts []string) error {
	run := func(ctx context.Context) error {
		for _, stmt := range stmts {
			e, err := livesync_model.MasterEngine(ctx)
			if err != nil {
				return err
			}
			if _, err := e.Exec(stmt); err != nil {
				return fmt.Errorf("%s: %w", firstLine(stmt), err)
			}
		}
		return nil
	}
	if setting.Database.Type.IsPostgreSQL() {
		return db.WithTx(ctx, run)
	}
	return run(ctx)
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	return line
}

// withPrivilegeHint explains the usual reason why creating triggers fails.
func withPrivilegeHint(err error) error {
	if myErr, ok := errors.AsType[*mysql.MySQLError](err); ok {
		switch myErr.Number {
		case 1419, 1142, 1227: // binlog needs SUPER, TRIGGER denied, access denied
			return fmt.Errorf("%w; the database user may not create triggers: MySQL needs the TRIGGER privilege and, with binary logging on, SUPER or log_bin_trust_function_creators = 1. "+
				"Grant them, or set [livesync] INSTALL_MODE = verify and have a DBA run the DDL", err)
		}
	}
	if pgErr, ok := errors.AsType[*pgconn.PgError](err); ok && pgErr.Code == "42501" { // insufficient_privilege
		return fmt.Errorf("%w; triggers must be created by the owner of Forgejo's tables. "+
			"Run Forgejo as the owner, or set [livesync] INSTALL_MODE = verify and have the owner run the DDL", err)
	}
	return err
}

// bumpEpoch increments the schema epoch of table and returns the new value.
// Callers hold the schema lock.
func bumpEpoch(ctx context.Context, table string) (int64, error) {
	name := MetaEpochPrefix + table
	v, ok, err := livesync_model.GetMeta(ctx, name)
	if err != nil {
		return 0, err
	}
	var epoch int64
	if ok {
		if epoch, err = strconv.ParseInt(v, 10, 64); err != nil {
			return 0, fmt.Errorf("livesync_meta %s is %q, not a number", name, v)
		}
	}
	epoch++
	return epoch, livesync_model.SetMeta(ctx, name, strconv.FormatInt(epoch, 10))
}
