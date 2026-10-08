// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package capture

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"testing"

	"forgejo.org/services/livesync/catalog"

	xormlog "code.forgejo.org/xorm/xorm/log"
	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPostgresDDL(t *testing.T) {
	body := pgFunctionBody(`my"schema`)
	assert.Contains(t, body, `INSERT INTO "my""schema"."livesync_change" (tbl, row_id, op) VALUES (TG_TABLE_NAME, OLD.id, 'D');`)
	assert.Contains(t, body, `VALUES (TG_TABLE_NAME, NEW.id, 'U');`)
	assert.Contains(t, body, `VALUES (TG_TABLE_NAME, NEW.id, 'I');`)
	assert.Contains(t, body, `PERFORM pg_notify('livesync', TG_TABLE_SCHEMA);`)
	assert.NotContains(t, body, "$livesync$", "the body must not end the dollar quote")
	assert.NotContains(t, body, "?", "xorm rewrites ? placeholders on PostgreSQL")

	assert.Equal(t, `CREATE OR REPLACE FUNCTION "s"."livesync_capture"() RETURNS trigger LANGUAGE plpgsql AS $livesync$`+pgFunctionBody("s")+`$livesync$`, pgCreateFunction("s"))
	assert.Equal(t, `CREATE TRIGGER "livesync_capture" AFTER INSERT OR UPDATE OR DELETE ON "s"."user" FOR EACH ROW EXECUTE FUNCTION "s"."livesync_capture"()`, pgCreateTrigger("s", "user"))
	assert.Equal(t, `DROP TRIGGER IF EXISTS "livesync_capture" ON "s"."user"`, pgDropTrigger("s", "user"))
}

func TestMySQLDDL(t *testing.T) {
	assert.Equal(t, "CREATE TRIGGER `livesync_issue_ai` AFTER INSERT ON `issue` FOR EACH ROW INSERT INTO `livesync_change` (tbl, row_id, op) VALUES ('issue', NEW.id, 'I')", mysqlCreateTrigger("issue", mysqlEvents[0]))
	assert.Equal(t, "CREATE TRIGGER `livesync_issue_au` AFTER UPDATE ON `issue` FOR EACH ROW INSERT INTO `livesync_change` (tbl, row_id, op) VALUES ('issue', NEW.id, 'U')", mysqlCreateTrigger("issue", mysqlEvents[1]))
	assert.Equal(t, "CREATE TRIGGER `livesync_issue_ad` AFTER DELETE ON `issue` FOR EACH ROW INSERT INTO `livesync_change` (tbl, row_id, op) VALUES ('issue', OLD.id, 'D')", mysqlCreateTrigger("issue", mysqlEvents[2]))
	assert.Equal(t, "DROP TRIGGER IF EXISTS `livesync_issue_ad`", mysqlDropTrigger("livesync_issue_ad"))
	for _, tbl := range catalog.Tracked() {
		for _, ev := range mysqlEvents {
			got, ok := mysqlEventOf(tbl.Name, mysqlTriggerName(tbl.Name, ev))
			require.True(t, ok)
			assert.Equal(t, ev, got)
			assert.NotContains(t, mysqlCreateTrigger(tbl.Name, ev), "?")
		}
	}
	_, ok := mysqlEventOf("issue", "livesync_issue_xx")
	assert.False(t, ok)
}

// statusAll builds a status in which every expected object has state s.
func statusAll(dialect string, s State) *Status {
	st := &Status{Dialect: dialect, Schema: "db"}
	if dialect == "postgres" {
		st.Objects = append(st.Objects, Object{Kind: KindFunction, Name: pgFunctionName, State: s})
	}
	for _, tbl := range catalog.Tracked() {
		if dialect == "postgres" {
			st.Objects = append(st.Objects, Object{Kind: KindTrigger, Table: tbl.Name, Name: pgTriggerName, State: s})
			continue
		}
		for _, ev := range mysqlEvents {
			st.Objects = append(st.Objects, Object{Kind: KindTrigger, Table: tbl.Name, Name: mysqlTriggerName(tbl.Name, ev), State: s})
		}
	}
	return st
}

func TestStatusStatements(t *testing.T) {
	n := len(catalog.Tracked())

	t.Run("healthy", func(t *testing.T) {
		for _, dialect := range []string{"postgres", "mysql"} {
			st := statusAll(dialect, StateOK)
			assert.True(t, st.Healthy())
			assert.Empty(t, st.Statements())
			assert.Empty(t, st.Script())
			assert.Empty(t, st.repairTables())
		}
	})

	t.Run("postgres fresh install", func(t *testing.T) {
		st := statusAll("postgres", StateMissing)
		assert.False(t, st.Healthy())
		stmts := st.Statements()
		require.Len(t, stmts, 1+2*n)
		assert.Equal(t, pgCreateFunction("db"), stmts[0], "the function comes first")
		assert.Len(t, st.repairTables(), n)
		script := st.Script()
		assert.True(t, strings.HasPrefix(script, "-- Forgejo livesync capture triggers, PostgreSQL schema \"db\".\n"))
		for _, stmt := range stmts {
			assert.Contains(t, script, "\n"+stmt+";\n")
		}
	})

	t.Run("postgres one trigger and the function", func(t *testing.T) {
		st := statusAll("postgres", StateOK)
		st.Objects[0].State = StateStale // function
		for i := range st.Objects {
			if st.Objects[i].Table == "label" {
				st.Objects[i].State = StateMissing
			}
		}
		st.Objects = append(st.Objects, Object{Kind: KindTrigger, Table: "notice", Name: pgTriggerName, State: StateExtra})
		assert.Equal(t, []string{pgCreateFunction("db"), pgDropTrigger("db", "label"), pgCreateTrigger("db", "label"), pgDropTrigger("db", "notice")}, st.Statements())
		assert.Len(t, st.repairTables(), n, "a broken function means every table's capture was broken")
		assert.Equal(t, []Object{{Kind: KindTrigger, Table: "notice", Name: pgTriggerName, State: StateExtra}}, st.extras())
	})

	t.Run("postgres function with another return type", func(t *testing.T) {
		// CREATE OR REPLACE cannot change a function's return type: it is
		// dropped (with its triggers) and every trigger is created again.
		st := statusAll("postgres", StateOK)
		st.Objects[0].State, st.Objects[0].Detail, st.Objects[0].dropFirst = StateStale, "returns int4, not trigger", true
		stmts := st.Statements()
		require.Len(t, stmts, 2+2*n)
		assert.Equal(t, `DROP FUNCTION IF EXISTS "db"."livesync_capture"() CASCADE`, stmts[0])
		assert.Equal(t, pgCreateFunction("db"), stmts[1])
		for i, tbl := range catalog.Tracked() {
			assert.Equal(t, pgDropTrigger("db", tbl.Name), stmts[2+2*i])
			assert.Equal(t, pgCreateTrigger("db", tbl.Name), stmts[3+2*i])
		}
	})

	t.Run("mysql", func(t *testing.T) {
		st := statusAll("mysql", StateOK)
		for i := range st.Objects {
			if st.Objects[i].Name == "livesync_issue_au" {
				st.Objects[i].State = StateStale
				st.Objects[i].Detail = "different body"
			}
		}
		st.Objects = append(st.Objects, Object{Kind: KindTrigger, Table: "notice", Name: "livesync_notice_ai", State: StateExtra})
		assert.False(t, st.Healthy())
		assert.Equal(t, []string{
			"DROP TRIGGER IF EXISTS `livesync_issue_au`",
			mysqlCreateTrigger("issue", mysqlEvents[1]),
			"DROP TRIGGER IF EXISTS `livesync_notice_ai`",
		}, st.Statements())
		assert.Equal(t, []string{"issue"}, st.repairTables())
		st.User = "forgejo@%"
		script := st.Script()
		assert.Contains(t, script, "USE `db`;\n")
		assert.Contains(t, script, "error 1449")
		assert.Contains(t, script, "CREATE DEFINER = 'forgejo'@'%' TRIGGER")
		assert.Contains(t, script, "binlog_format ROW or MIXED")
		assert.Contains(t, script, mysqlCreateTrigger("issue", mysqlEvents[1])+";\n")
		assert.Contains(t, st.summary(), "1 stale: livesync_issue_au (different body)")

		// Extras alone do not make the status unhealthy.
		st = statusAll("mysql", StateOK)
		st.Objects = append(st.Objects, Object{Kind: KindTrigger, Table: "notice", Name: "livesync_notice_ai", State: StateExtra})
		assert.True(t, st.Healthy())
		assert.Len(t, st.Statements(), 1)
	})

	t.Run("summary", func(t *testing.T) {
		st := statusAll("mysql", StateMissing)
		s := st.summary()
		assert.Contains(t, s, fmt.Sprintf("%d missing: ", 3*n))
		assert.Contains(t, s, fmt.Sprintf("(%d more)", 3*n-8))
		st = statusAll("postgres", StateOK)
		st.Objects[1].State = StateMissing
		assert.Equal(t, "1 missing: "+st.Objects[1].Table+".livesync_capture", st.summary())
	})
}

func TestMySQLAccount(t *testing.T) {
	assert.Equal(t, "'forgejo'@'%'", mysqlAccount("forgejo@%"))
	assert.Equal(t, "'a@b'@'localhost'", mysqlAccount("a@b@localhost"))
	assert.Equal(t, "'o''x'@'h'", mysqlAccount("o'x@h"))
	assert.Equal(t, "'nohost'", mysqlAccount("nohost"))
}

func TestNotInstalledError(t *testing.T) {
	st := statusAll("postgres", StateOK)
	st.Objects[1].State = StateMissing

	err := error(&NotInstalledError{Status: st})
	require.ErrorIs(t, err, ErrNotInstalled)
	assert.Contains(t, err.Error(), "capture triggers not installed (1 missing:")

	cause := errors.New("boom")
	err = &NotInstalledError{Status: st, Cause: cause}
	require.ErrorIs(t, err, ErrNotInstalled)
	require.ErrorIs(t, err, cause)
	assert.Contains(t, err.Error(), "installing the capture triggers failed: boom")
	var nie *NotInstalledError
	require.ErrorAs(t, fmt.Errorf("wrapped: %w", err), &nie)
	assert.Same(t, st, nie.Status)
}

func TestPrivilegeHint(t *testing.T) {
	myErr := &mysql.MySQLError{Number: 1419, Message: "You do not have the SUPER privilege and binary logging is enabled"}
	err := withHint(fmt.Errorf("CREATE TRIGGER x: %w", myErr))
	require.ErrorIs(t, err, myErr)
	assert.Contains(t, err.Error(), "log_bin_trust_function_creators = 1")
	assert.Contains(t, err.Error(), "INSTALL_MODE = verify")

	pgErr := &pgconn.PgError{Code: "42501", Message: "must be owner of table issue"}
	err = withHint(pgErr)
	require.ErrorIs(t, err, pgErr)
	assert.Contains(t, err.Error(), "owner of Forgejo's tables")

	lockErr := &pgconn.PgError{Code: "55P03", Message: "canceling statement due to lock timeout"}
	err = withHint(fmt.Errorf("DROP TRIGGER x: %w", lockErr))
	require.ErrorIs(t, err, lockErr)
	assert.Contains(t, err.Error(), "held its lock for longer than")
	myLockErr := &mysql.MySQLError{Number: 1205, Message: "Lock wait timeout exceeded; try restarting transaction"}
	err = withHint(myLockErr)
	require.ErrorIs(t, err, myLockErr)
	assert.Contains(t, err.Error(), "held its lock for longer than")

	other := errors.New("other")
	assert.Same(t, other, withHint(other))
}

func TestPokes(t *testing.T) {
	for q, want := range map[string]bool{
		"COMMIT":                                   true,
		"commit":                                   true,
		"ROLLBACK":                                 false,
		"BEGIN TRANSACTION":                        false,
		"SELECT * FROM issue":                      false,
		"INSERT INTO `issue` (`id`) VALUES (?)":    true,
		"  insert into issue values (1)":           true,
		"UPDATE \"issue\" SET \"name\"=$1":         true,
		"DELETE FROM issue WHERE id=?":             true,
		"REPLACE INTO x VALUES (1)":                true,
		"DELETE FROM `livesync_change` WHERE id=?": false,
		"INSERT INTO livesync_meta (name) VALUES (?) ON CONFLICT (name) DO UPDATE SET value = excluded.value": false,
		"UPDATED":            false,
		"DROP TABLE issue":   false,
		"CREATE TABLE x (y)": false,
		"":                   false,
	} {
		assert.Equal(t, want, pokes(q), q)
	}
}

func TestDoorbell(t *testing.T) {
	a, b := newDoorbell(), newDoorbell()
	subscribe(a)
	subscribe(b)
	ringAll()
	ringAll() // coalesced
	for _, d := range []*doorbell{a, b} {
		select {
		case <-d.c:
		default:
			t.Fatal("not rung")
		}
		select {
		case <-d.c:
			t.Fatal("rings must coalesce")
		default:
		}
	}
	unsubscribe(a)
	ringAll()
	assert.Empty(t, a.c)
	assert.Len(t, b.c, 1)
	unsubscribe(b)
	assert.Nil(t, bells.Load())
	ringAll() // no subscribers: no-op
	unsubscribe(b)
}

// recordingLogger stands in for Forgejo's xorm logger.
type recordingLogger struct {
	xormlog.ContextLogger
	show          bool
	before, after int
}

func (l *recordingLogger) IsShowSQL() bool              { return l.show }
func (l *recordingLogger) ShowSQL(show ...bool)         { l.show = len(show) == 0 || show[0] }
func (l *recordingLogger) BeforeSQL(xormlog.LogContext) { l.before++ }
func (l *recordingLogger) AfterSQL(xormlog.LogContext)  { l.after++ }

func TestCommitObserver(t *testing.T) {
	inner := &recordingLogger{ContextLogger: xormlog.NewLoggerAdapter(xormlog.DiscardLogger{})}
	o := commitObserver{ContextLogger: inner}
	assert.True(t, o.IsShowSQL(), "xorm only calls AfterSQL when the logger shows SQL")
	d := newDoorbell()
	subscribe(d)
	defer unsubscribe(d)
	rung := func() bool {
		select {
		case <-d.c:
			return true
		default:
			return false
		}
	}
	lc := func(ctx context.Context, sql string, err error) xormlog.LogContext {
		return xormlog.LogContext{Ctx: ctx, SQL: sql, Err: err}
	}
	ctx := t.Context()

	// SQL logging off: nothing is forwarded, writes and COMMIT ring.
	o.BeforeSQL(lc(ctx, "COMMIT", nil))
	o.AfterSQL(lc(ctx, "COMMIT", nil))
	assert.Equal(t, 0, inner.before+inner.after)
	assert.True(t, rung())
	o.AfterSQL(lc(ctx, "INSERT INTO issue (id) VALUES (?)", nil))
	assert.True(t, rung())
	o.AfterSQL(lc(ctx, "SELECT 1", nil))
	assert.False(t, rung())
	o.AfterSQL(lc(ctx, "COMMIT", errors.New("failed")))
	assert.False(t, rung())
	// livesync's own transactions do not ring.
	o.AfterSQL(lc(context.WithValue(ctx, quietKey{}, true), "COMMIT", nil))
	assert.False(t, rung())

	// SQL logging on (engine.ShowSQL forwards to the wrapped logger):
	// forwarded, unless the session says otherwise.
	o.ShowSQL(true)
	assert.True(t, inner.show)
	o.BeforeSQL(lc(ctx, "SELECT 1", nil))
	o.AfterSQL(lc(ctx, "SELECT 1", nil))
	assert.Equal(t, 1, inner.before)
	assert.Equal(t, 1, inner.after)
	quiet := context.WithValue(ctx, xormlog.SessionShowSQLKey{}, false)
	o.BeforeSQL(lc(quiet, "SELECT 1", nil))
	o.AfterSQL(lc(quiet, "SELECT 1", nil))
	assert.Equal(t, 1, inner.before)
}

// TestTriggersReferenceOnlyID keeps the PLAN §4.3 invariant: a capture
// trigger reads no column of its table but id, so an upstream migration
// that renames or drops any other column can never make an upstream write
// fail (B4 once compared permission columns in MySQL update triggers; an
// upstream rename then broke every update of the table).
func TestTriggersReferenceOnlyID(t *testing.T) {
	rowRef := regexp.MustCompile(`(?i)\b(OLD|NEW)\b\s*(\.\s*[` + "`" + `"]?(\w+)|\))?`)
	checkBody := func(t *testing.T, name, body string) {
		t.Helper()
		refs := rowRef.FindAllStringSubmatch(body, -1)
		require.NotEmpty(t, refs, name)
		for _, m := range refs {
			assert.Equal(t, "id", m[3], "%s references %q of a row: triggers may read only id", name, m[0])
		}
		for _, banned := range []string{"to_jsonb", "row_to_json", "TG_ARGV", "TG_NARGS", "CASE", "IF("} {
			assert.NotContains(t, body, banned, name)
		}
	}
	checkBody(t, "postgres function", pgFunctionBody("s"))
	for _, tbl := range catalog.Tracked() {
		assert.True(t, strings.HasSuffix(pgCreateTrigger("s", tbl.Name), `"livesync_capture"()`), "%s: the PostgreSQL trigger passes no arguments", tbl.Name)
		for _, ev := range mysqlEvents {
			checkBody(t, mysqlTriggerName(tbl.Name, ev), mysqlTriggerStatement(tbl.Name, ev))
		}
	}
}

func TestPostgresTriggerState(t *testing.T) {
	ok := pgTriggerRow{Table: "repository", Enabled: "O", Type: pgTriggerType, FuncSchema: "s", FuncName: pgFunctionName}
	state, detail := pgTriggerState(ok, "s")
	assert.Equal(t, StateOK, state, detail)

	// A trigger written by B4 review round 2 (permission columns as
	// arguments) is stale and gets replaced.
	r := ok
	r.NArgs = 2
	state, _ = pgTriggerState(r, "s")
	assert.Equal(t, StateStale, state)
	r = ok
	r.HasWhen = true
	state, _ = pgTriggerState(r, "s")
	assert.Equal(t, StateStale, state)
}

func TestUninstallStatements(t *testing.T) {
	n := len(catalog.Tracked())
	for _, dialect := range []string{"postgres", "mysql"} {
		st := statusAll(dialect, StateMissing)
		assert.False(t, st.Installed())
		assert.Empty(t, st.UninstallStatements())
		assert.Empty(t, st.UninstallScript())
	}

	st := statusAll("postgres", StateOK)
	st.Objects[1].State = StateMissing // that table's trigger is gone already
	st.Objects[2].State = StateStale
	st.Objects = append(st.Objects, Object{Kind: KindTrigger, Table: "notice", Name: pgTriggerName, State: StateExtra})
	assert.True(t, st.Installed())
	stmts := st.UninstallStatements()
	require.Len(t, stmts, n+1, "every existing trigger (stale and extra ones too), then the function")
	assert.Equal(t, pgDropTrigger("db", st.Objects[2].Table), stmts[0])
	assert.Equal(t, pgDropTrigger("db", "notice"), stmts[n-1])
	assert.Equal(t, `DROP FUNCTION IF EXISTS "db"."livesync_capture"()`, stmts[n], "no CASCADE: unknown dependents make it fail")
	script := st.UninstallScript()
	assert.True(t, strings.HasPrefix(script, "-- Remove the Forgejo livesync capture triggers, PostgreSQL schema \"db\".\n"))
	for _, stmt := range stmts {
		assert.Contains(t, script, "\n"+stmt+";\n")
	}
	assert.Contains(t, script, `-- DROP TABLE IF EXISTS "db"."livesync_change";`, "dropping the tables is offered, commented out")

	st = statusAll("mysql", StateOK)
	st.Objects = append(st.Objects, Object{Kind: KindTrigger, Table: "notice", Name: "livesync_notice_ai", State: StateExtra})
	stmts = st.UninstallStatements()
	require.Len(t, stmts, 3*n+1)
	assert.Equal(t, "DROP TRIGGER IF EXISTS `"+mysqlTriggerName(catalog.Tracked()[0].Name, mysqlEvents[0])+"`", stmts[0])
	assert.Equal(t, "DROP TRIGGER IF EXISTS `livesync_notice_ai`", stmts[3*n])
	script = st.UninstallScript()
	assert.Contains(t, script, "USE `db`;\n")
	assert.Contains(t, script, "-- DROP TABLE IF EXISTS `livesync_meta`;")
	assert.NotContains(t, script, "\nDROP TABLE", "the tables are never dropped by the script as is")
}
