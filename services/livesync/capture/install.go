// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package capture

import (
	"context"
	"database/sql/driver"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/setting"
	"forgejo.org/services/livesync/catalog"

	"code.forgejo.org/xorm/xorm"
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

	// dropFirst marks a stale PostgreSQL function that CREATE OR REPLACE
	// cannot fix (its return type differs): it is dropped first, with every
	// trigger that uses it.
	dropFirst bool
}

// Status is the result of comparing the catalog with the triggers that exist
// in the database.
type Status struct {
	Dialect string // "postgres" or "mysql"
	// Schema is the PostgreSQL schema / MySQL database the objects live in.
	Schema  string
	Objects []Object
	// User is the account Forgejo connects as (MySQL CURRENT_USER(), as
	// user@host); empty on PostgreSQL.
	User string
	// Warnings are problems that do not stop livesync from serving but
	// that an operator should fix (MySQL: triggers defined by another
	// account, statement-based binary logging).
	Warnings []string
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
		recreateAll := false
		for _, o := range s.broken() {
			if o.Kind == KindFunction {
				if o.dropFirst {
					// CASCADE drops every trigger that uses the function,
					// so all of them are created again below.
					stmts = append(stmts, pgDropFunction(s.Schema))
					recreateAll = true
				}
				stmts = append(stmts, pgCreateFunction(s.Schema))
			}
		}
		for _, o := range s.Objects {
			if o.Kind == KindTrigger && (o.State == StateMissing || o.State == StateStale || recreateAll && o.State == StateOK) {
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
		b.WriteString("-- The triggers run with the privileges of the account that creates them (their\n")
		b.WriteString("-- DEFINER): if that account is dropped later, every write to these tables fails\n")
		b.WriteString("-- with error 1449, livesync enabled or not. Run this as a durable account, or make\n")
		if s.User != "" {
			fmt.Fprintf(&b, "-- Forgejo's account the definer (CREATE DEFINER = %s TRIGGER ..., needs SET_USER_ID\n", mysqlAccount(s.User))
		} else {
			b.WriteString("-- Forgejo's account the definer (CREATE DEFINER = <account> TRIGGER ..., needs SET_USER_ID\n")
		}
		b.WriteString("-- or SUPER). With binary logging on, use binlog_format ROW or MIXED: under STATEMENT\n")
		b.WriteString("-- these triggers make every captured write unsafe for replication.\n")
		fmt.Fprintf(&b, "USE %s;\n", mysqlQuote(s.Schema))
	}
	for _, stmt := range stmts {
		b.WriteString(stmt)
		b.WriteString(";\n")
	}
	return b.String()
}

// mysqlAccount quotes a user@host account name (as CURRENT_USER() returns
// it) for a DEFINER clause.
func mysqlAccount(account string) string {
	i := strings.LastIndex(account, "@")
	if i < 0 {
		return "'" + strings.ReplaceAll(account, "'", "''") + "'"
	}
	return "'" + strings.ReplaceAll(account[:i], "'", "''") + "'@'" + strings.ReplaceAll(account[i+1:], "'", "''") + "'"
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
//
// The epoch bump is durable: the tables about to be repaired are recorded in
// MetaPending before any DDL runs and removed only in the transaction that
// bumps their epochs, so a crash or an error between the repair and the bump
// leaves them pending for the next Ensure. On PostgreSQL the DDL, the bumps
// and clearing MetaPending are one transaction. The DDL waits at most
// DDLLockTimeout for table locks; a timeout is a *NotInstalledError too.
func Ensure(ctx context.Context, repair bool) (*Report, error) {
	var report *Report
	err := livesync_model.WithSchemaLock(ctx, func(ctx context.Context) error {
		var err error
		report, err = ensureLocked(ctx, repair)
		return err
	})
	return report, err
}

// DDLLockTimeout bounds how long each repair DDL statement waits for a lock
// on a tracked table (PostgreSQL lock_timeout, MySQL lock_wait_timeout).
// Without it, a long transaction that touched the table (a report, a dump,
// another instance's long request) would block the repair and Init, and on
// PostgreSQL every later query on the tables locked so far would queue
// behind the waiting DDL. Tests shorten it.
var DDLLockTimeout = 5 * time.Second

// errStillBroken is the cause of a NotInstalledError when the repair DDL ran
// but Inspect still finds broken objects.
var errStillBroken = errors.New("still missing or stale after the repair")

// ddlError marks a failure of the repair DDL itself (as opposed to the
// bookkeeping around it), which is reported as a NotInstalledError.
type ddlError struct{ err error }

func (e *ddlError) Error() string { return e.err.Error() }
func (e *ddlError) Unwrap() error { return e.err }

func ensureLocked(ctx context.Context, repair bool) (*Report, error) {
	st, err := Inspect(ctx)
	if err != nil {
		return nil, err
	}
	// Tables found broken by an earlier start that could not repair them
	// (verify mode, a failed repair, or a crash between a repair and its
	// epoch bump): someone has repaired them since, or this start will.
	// Their changes in between were lost all the same, so their epochs are
	// bumped once they are healthy.
	pending, err := pendingTables(ctx)
	if err != nil {
		return nil, err
	}
	if !st.Healthy() && !repair {
		return nil, notInstalled(ctx, st, pending, nil)
	}

	report := &Report{Status: st, Epochs: map[string]int64{}}
	extras := st.extras()
	runDDL := !st.Healthy() || repair && len(extras) > 0
	if !runDDL && len(pending) == 0 {
		return report, nil
	}
	bump := pending
	if runDDL {
		report.Repaired = st.repairTables()
		for _, o := range extras {
			report.Dropped = append(report.Dropped, o.Name)
		}
		bump = mergeTables(pending, report.Repaired)
		// Record the tables before touching them: if anything fails (or
		// the process dies) after the DDL took effect and before their
		// epochs are bumped, the next Ensure still bumps them.
		if len(bump) > len(pending) {
			if err := livesync_model.SetMeta(ctx, MetaPending, strings.Join(bump, ",")); err != nil {
				return nil, err
			}
		}
	}

	// bumpAll bumps the epochs and clears MetaPending in the caller's
	// transaction: both happen or neither does.
	bumpAll := func(ctx context.Context) error {
		for _, table := range bump {
			epoch, err := BumpEpoch(ctx, table)
			if err != nil {
				return err
			}
			report.Epochs[table] = epoch
		}
		return livesync_model.SetMeta(ctx, MetaPending, "")
	}
	// repairDDL runs the DDL and checks the result.
	repairDDL := func(ctx context.Context) error {
		if err := execStatements(ctx, st.Statements()); err != nil {
			return &ddlError{withHint(err)}
		}
		if report.Status, err = Inspect(ctx); err != nil {
			return err
		}
		if !report.Status.Healthy() {
			return fmt.Errorf("%w: %s", errStillBroken, report.Status.summary())
		}
		return nil
	}

	if setting.Database.Type.IsPostgreSQL() {
		// DDL is transactional on PostgreSQL: repair, bump and clear
		// atomically.
		err = db.WithTx(ctx, func(ctx context.Context) error {
			if runDDL {
				if err := repairDDL(ctx); err != nil {
					return err
				}
			}
			return bumpAll(ctx)
		})
	} else {
		// MySQL commits each DDL statement implicitly; MetaPending covers
		// the gap between the DDL and the bump transaction.
		if runDDL {
			err = repairDDL(ctx)
		}
		if err == nil {
			err = db.WithTx(ctx, bumpAll)
		}
	}
	var ddlErr *ddlError
	switch {
	case errors.As(err, &ddlErr):
		return nil, notInstalled(ctx, st, bump, ddlErr.err)
	case errors.Is(err, errStillBroken):
		if setting.Database.Type.IsPostgreSQL() {
			// The repair was rolled back: the database is as found.
			return nil, notInstalled(ctx, st, bump, err)
		}
		return nil, notInstalled(ctx, report.Status, bump, err)
	case err != nil:
		return nil, err
	}
	report.Repaired = bump
	return report, nil
}

// MetaPending is the livesync_meta entry listing (comma-separated) the
// tracked tables whose capture was found missing or stale but not repaired
// yet; Ensure bumps their schema epochs once they are healthy again.
const MetaPending = "capture_pending"

// MarkAllPending records every tracked table in MetaPending, under the
// schema lock: from now on their changes may be lost without Ensure being
// able to tell (livesync.Disable in INSTALL_MODE verify leaves the triggers
// to a DBA, who may drop them and create them again before livesync is
// enabled again; healthy triggers then say nothing about the gap). The next
// Ensure that finds them healthy bumps every epoch: one re-bootstrap of
// every model instead of changes lost silently.
func MarkAllPending(ctx context.Context) error {
	return livesync_model.WithSchemaLock(ctx, func(ctx context.Context) error {
		pending, err := pendingTables(ctx)
		if err != nil {
			return err
		}
		tracked := catalog.Tracked()
		tables := make([]string, 0, len(tracked))
		for _, t := range tracked {
			tables = append(tables, t.Name)
		}
		return livesync_model.SetMeta(ctx, MetaPending, strings.Join(mergeTables(pending, tables), ","))
	})
}

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

// execStatements runs the repair DDL on the master database, each statement
// waiting at most DDLLockTimeout for its locks. On PostgreSQL it runs in the
// caller's transaction (DDL is transactional there) after SET LOCAL
// lock_timeout. MySQL commits each DDL statement implicitly; there the
// statements run on one pinned connection whose lock_wait_timeout is
// lowered for the duration. Either way they bypass xorm's hooks: a failure
// is returned (and reported by Init with the DDL), not logged as an SQL
// error as well.
func execStatements(ctx context.Context, stmts []string) error {
	if len(stmts) == 0 {
		return nil
	}
	var exec func(ctx context.Context, query string) error
	if setting.Database.Type.IsPostgreSQL() {
		e, err := livesync_model.MasterEngine(ctx)
		if err != nil {
			return err
		}
		sess, ok := e.(*xorm.Session)
		if !ok || sess.Tx() == nil {
			return errors.New("livesync: the PostgreSQL repair must run in a transaction")
		}
		tx := sess.Tx().Tx
		exec = func(ctx context.Context, query string) error {
			_, err := tx.ExecContext(ctx, query)
			return err
		}
		if err := exec(ctx, fmt.Sprintf("SET LOCAL lock_timeout = '%dms'", max(DDLLockTimeout.Milliseconds(), 1))); err != nil {
			return fmt.Errorf("set lock_timeout: %w", err)
		}
	} else {
		master, err := livesync_model.MasterXORMEngine()
		if err != nil {
			return err
		}
		conn, err := master.DB().Conn(ctx)
		if err != nil {
			return err
		}
		defer conn.Close()
		exec = func(ctx context.Context, query string) error {
			_, err := conn.ExecContext(ctx, query)
			return err
		}
		if err := exec(ctx, fmt.Sprintf("SET SESSION lock_wait_timeout = %d", max(int64(DDLLockTimeout/time.Second), 1))); err != nil {
			return fmt.Errorf("set lock_wait_timeout: %w", err)
		}
		defer func() {
			resetCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := exec(resetCtx, "SET SESSION lock_wait_timeout = DEFAULT"); err != nil {
				// Do not return a connection with the short timeout to the pool.
				_ = conn.Raw(func(any) error { return driver.ErrBadConn })
			}
		}()
	}
	for _, stmt := range stmts {
		if err := exec(ctx, stmt); err != nil {
			return fmt.Errorf("%s: %w", firstLine(stmt), err)
		}
	}
	return nil
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	return line
}

// withHint explains the usual reasons why the repair DDL fails: missing
// privileges, or a lock it could not get within DDLLockTimeout.
func withHint(err error) error {
	const lockHint = "%w; a transaction on a tracked table held its lock for longer than %s (a long report, a dump, another instance's long request). " +
		"Forgejo serves without livesync for now; restart it at a quieter time, or have a DBA run the DDL"
	if myErr, ok := errors.AsType[*mysql.MySQLError](err); ok {
		switch myErr.Number {
		case 1419, 1142, 1227: // binlog needs SUPER, TRIGGER denied, access denied
			return fmt.Errorf("%w; the database user may not create triggers: MySQL needs the TRIGGER privilege and, with binary logging on, SUPER or log_bin_trust_function_creators = 1. "+
				"Grant them, or set [livesync] INSTALL_MODE = verify and have a DBA run the DDL", err)
		case 1205: // lock wait timeout exceeded
			return fmt.Errorf(lockHint, err, DDLLockTimeout)
		}
	}
	if pgErr, ok := errors.AsType[*pgconn.PgError](err); ok {
		switch pgErr.Code {
		case "42501": // insufficient_privilege
			return fmt.Errorf("%w; triggers must be created by the owner of Forgejo's tables. "+
				"Run Forgejo as the owner, or set [livesync] INSTALL_MODE = verify and have the owner run the DDL", err)
		case "55P03": // lock_not_available
			return fmt.Errorf(lockHint, err, DDLLockTimeout)
		}
	}
	return err
}

// BumpEpoch increments the schema epoch of table and returns the new value:
// changes to the table may have been lost (a repaired trigger, or a change
// the materializer had to skip). In a transaction the row is locked first
// (SELECT … FOR UPDATE), so that bumps by Ensure and by the materializer
// cannot overwrite each other.
func BumpEpoch(ctx context.Context, table string) (int64, error) {
	name := MetaEpochPrefix + table
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return 0, err
	}
	query := "SELECT value FROM livesync_meta WHERE name = ?"
	if db.InTransaction(ctx) && !setting.Database.Type.IsSQLite3() {
		query += " FOR UPDATE"
	}
	var v string
	ok, err := e.SQL(query, name).Get(&v)
	if err != nil {
		return 0, fmt.Errorf("livesync: read %s: %w", name, err)
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
