# livesync — upstream surface

Every Forgejo (upstream) symbol that livesync code imports or depends on, grouped by
upstream package. Review this list on every upstream merge (PLAN §6.5): a change to
any of these is where the fork can break. Keep it current — each milestone adds the
symbols it starts using (and removes the ones it stops using).

Scope: `models/livesync`, `services/livesync/**`, `routers/livesync`, and the shared
integration-test helpers in `tests/integration/livesync_*_test.go`.

## The patch

| Upstream file | What we change / rely on | Since |
|---|---|---|
| `cmd/web.go` `serveInstalled()` | `webRoutes := livesync_router.Wrap(routers.NormalRoutes())` (+ import). Relies on `listen(m http.Handler, …)` taking an `http.Handler` and on `routers.InitWebInstalled` having run (DB, settings) before this line | B1 |
| `go.mod` / `go.sum` / `assets/go-licenses.json` | `github.com/coder/websocket v1.8.15` | B1 |

## Production code

| Upstream package | Symbols | Used by | Since |
|---|---|---|---|
| `forgejo.org/models/db` | `Engine` (methods `Where`+`Get`, `Exec`, `IsTableExist`), `Engined`, `DefaultContext`, `GetEngine`, `GetMasterEngine` (returns `*xorm.Engine`), `InTransaction`; transactions run on the master engine (`x`) | `models/livesync` (`MasterEngine`, `SyncTables`, `MetaTableExists`, meta, schema lock) | B1 |
| `forgejo.org/models/db` PostgreSQL driver `postgresschema` (`sql_postgres_with_schema.go`) | sets `search_path` to `[database] SCHEMA` on **every pooled connection**, so raw SQL may name livesync tables unqualified and `current_schema()` is the configured schema (raw upsert in `SetMeta`, advisory-lock key in `WithSchemaLock`) | `models/livesync` | B1 |
| `code.forgejo.org/xorm/xorm` | `Engine.Context` (→ `*Session`), `Engine.DB` (`*core.DB` embedding `*sql.DB`: `Conn`, `Stats` — the schema lock's pinned connection), `Session.Close`, `Session.StoreEngine`, `Session.SyncWithOptions` (check-then-create: **not** safe for concurrent callers, hence `WithSchemaLock`), `SyncOptions{WarnIfDatabaseColumnMissed, IgnoreDropIndices}` (same options as `db.SyncAllTables`), `?` placeholder rewriting in `Exec` (→ `$n` on PostgreSQL), xorm struct tags | `models/livesync` | B1 |
| `forgejo.org/modules/timeutil` | `TimeStamp` | `models/livesync` | B1 |
| `forgejo.org/modules/setting` | `CfgProvider`, `ConfigProvider.Section`, `ConfigKey.MustBool/MustString`, `Database.Type` (`IsPostgreSQL`, `IsMySQL`), `AppSubURL` | `services/livesync`, `routers/livesync` | B1 |
| `forgejo.org/modules/log` | `Info`, `Warn`, `Error`; `Debug`, `Trace` (B2) | all | B1 |
| `forgejo.org/modules/graceful` | `GetManager`, `Manager.HammerContext`, `Manager.RunAtShutdown` (hook skipped if its ctx is done; the shutdown context is cancelled *before* hooks run) | `routers/livesync.Wrap` | B1 |
| `forgejo.org/modules/web` | `Route` built as a literal `&web.Route{R: chi.NewRouter()}` (exported field `R`) — **not** `web.NewRoute()`, which in tests resets the API v1 permission bookkeeping; `Route.Use`, `Route.Get`, `Route.NotFound`; handler signature `func(http.ResponseWriter, *http.Request)` | `routers/livesync/routes.go` | B1 |
| `forgejo.org/modules/web/routing` | `GetFuncInfo`, `UpdateFuncInfo` (so the router log names our 405 handler instead of logging an "unknown handler" error) | `routers/livesync/routes.go` | B1 |
| `forgejo.org/modules/json` | `NewEncoder` | `routers/livesync` | B1 |
| `forgejo.org/routers/common` | `ProtocolMiddlewares()` (path normalisation, panic recovery, process manager, access/route log). Note: it wraps the `ResponseWriter` and hides `Hijack` | `routers/livesync/routes.go` | B1 |
| `forgejo.org/routers/common` `stripSlashesMiddleware` (behaviour, not a symbol) | collapses repeated `/` and trims trailing `/` inside upstream's routers. `routers/livesync.normalizeSlashes` mirrors it so `Wrap` classifies paths exactly as upstream routes them — **re-check if upstream changes its path normalisation** | `routers/livesync/wrap.go` | B1 |
| `github.com/go-chi/chi/v5` | `NewRouter`, `Router.MethodNotAllowed` | `routers/livesync/routes.go` | B1 |
| Upstream **table names** (every `db.RegisterModel` bean) and the `id` auto-increment PK of the tracked ones | `services/livesync/catalog` lists every registered table as tracked or ignored; `CheckCatalog` (at Init) and `TestLivesyncCatalogContract` (CI) fail on a vanished tracked table / missing `id` PK, warn/fail on unclassified tables. **Re-check on every upstream merge that adds or drops tables** | `services/livesync/catalog`, `services/livesync/catalog_check.go` | B2 |
| `forgejo.org/models/db` | `NamesToBean()` (no names ⇒ every registered bean), `TableInfo` (`schemas.Table.Name/PrimaryKeys/AutoIncrement`), `WithTx` (production: PG trigger repair + epoch bumps in one tx, MySQL epoch bumps), `Engine.In/Where/OrderBy/Limit/Find/Delete/SQL(…).Get/Find` | `services/livesync`, `services/livesync/capture` | B2 |
| `forgejo.org/models/db` behaviour: application-level cascades (`foreign_keys.go`, Go deletes related rows); Forgejo's FKs are `NO ACTION` | MySQL does not fire triggers for FK actions; `TestLivesyncCaptureNoCascades` asserts no `CASCADE`/`SET NULL`/`SET DEFAULT` rule on a tracked table | `services/livesync/capture` (assumption) | B2 |
| `forgejo.org/models/db` `TracingHook` + `InitEngine` hook order (Slow, Error, **Tracing last**) — relied on by **not** adding a hook | xorm does not chain hook contexts: the last hook's `BeforeProcess` context is used and passed to every `AfterProcess`, and `TracingHook.AfterProcess` requires its runtime/trace task in that context. Any hook appended after it would either break it (nil task) or have to start a second task, leaving `TracingHook`'s own one unended in every runtime trace (admin diagnosis, `/debug/pprof/trace`). So livesync adds **no hook** (round-1 fix; B2 round 0 delegated to `TracingHook{}.BeforeProcess` and corrupted traces) | `services/livesync/capture/doorbell.go` | B2 |
| `code.forgejo.org/xorm/xorm` engine logger (`Engine.Logger`, `Engine.SetLogger`, `Engine.ShowSQL` → `logger.ShowSQL` + `DB().Logger = logger`), `log.ContextLogger`, `log.LogContext{Ctx, SQL, Err}`, `log.SessionShowSQLKey`; behaviour: `core.DB.beforeProcess/afterProcess` call `Logger.BeforeSQL/AfterSQL` only when `NeedLogSQL` (session `SessionShowSQLKey` override, else `Logger.IsShowSQL()`); `core.Tx.Commit` reports SQL `"COMMIT"` | MySQL (and SQLite unit tests) only: `capture.commitObserver` wraps the **master** engine's logger once (unsynchronised, at Init; stays for the process): it reports `IsShowSQL() = true`, forwards `BeforeSQL/AfterSQL` to Forgejo's logger only when that one shows SQL, and rings the doorbell after COMMIT / DML. **Re-check if xorm or Forgejo use `IsShowSQL()` for anything else, call `SetLogger` after Init, or if Forgejo starts using `Session.MustLogSQL(false)`** (such sessions are not observed). Not installed on PostgreSQL | `services/livesync/capture/doorbell.go` | B2 |
| `forgejo.org/models/db` `Engined` interface (any context with `Engine() Engine` is used by `GetEngine`/`InTransaction`); `code.forgejo.org/xorm/xorm` `Engine.NewSession`, `Session.Context/Begin/Commit/Close/Tx` (`core.Tx` embeds `*sql.Tx`) | `capture.WithQuietTx`: a transaction like `db.WithTx` whose session context carries a marker, so the observer can skip the reader's own COMMIT (`db.WithTx` sessions run under the engine's default context). The PG repair runs its DDL on the session's raw `*sql.Tx` (bypassing hooks: failures are returned, not also logged as SQL errors) | `services/livesync/capture` | B2 |
| `code.forgejo.org/xorm/xorm` (+ `/log`) | `Engine.DB().Conn` (MySQL repair DDL on one pinned connection with `SET SESSION lock_wait_timeout`, reset with `DEFAULT` or the connection is discarded) | `services/livesync/capture/install.go` | B2 |
| `xorm.io/builder` | `Gt`, `Lte`, `And` | `services/livesync/capture/reader.go` | B2 |
| `forgejo.org/modules/setting` | `DBMasterConnStr` (DSN for the LISTEN connection, pgx format), `ConfigKey.MustDuration` | `services/livesync`, `services/livesync/capture` | B2 |
| `github.com/jackc/pgx/v5` (+ `/pgconn`) | `Connect`, `Conn.Exec`, `Conn.WaitForNotification`, `Conn.Close`; `pgconn.PgError.Code` (42501 hint) | `services/livesync/capture` | B2 |
| `github.com/go-sql-driver/mysql` | `MySQLError.Number` (1419/1142/1227 privilege hint) | `services/livesync/capture` | B2 |
| PostgreSQL | `pg_get_serial_sequence` + the sequence's `last_value`/`is_called` (outbox id counter at reader start); `SET LOCAL lock_timeout`, SQLSTATE `55P03` (repair DDL) | `services/livesync/capture` | B2 |
| MySQL/MariaDB | `SHOW CREATE TABLE` `AUTO_INCREMENT=N` (live counter; `information_schema.tables` may be cached); `SET SESSION lock_wait_timeout`, error `1205`; `CURRENT_USER()`, `@@log_bin`, `@@binlog_format`, `information_schema.triggers.definer` (Inspect warnings) | `services/livesync/capture` | B2 |
| PostgreSQL catalogs | `pg_trigger` (`tgname`, `tgrelid`, `tgfoid`, `tgenabled`, `tgtype`, `tgnargs`, `tgattr`, `tgqual`, `tgisinternal`), `pg_proc` (`prosrc`, `prorettype`, `prolang`, `pronargs`), `pg_class`, `pg_namespace`, `pg_type`, `pg_language`; `CREATE TRIGGER … EXECUTE FUNCTION` needs PG ≥ 11 | `services/livesync/capture/inspect.go` | B2 |
| MySQL/MariaDB `information_schema.triggers` | `trigger_name`, `event_manipulation`, `event_object_table`, `action_timing`, `action_orientation`, `action_statement` (stored verbatim; only visible for tables the user has `TRIGGER` on) | `services/livesync/capture/inspect.go` | B2 |

## Test-only

| Upstream symbol | Used for | Since |
|---|---|---|
| `tests/integration`: `testWebRoutes` (`*web.Route`), `MakeRequest`, `NewRequest`, `onApplicationRun` (real listener) | `livesyncRoutes(h)` adapts `Wrap`'s `http.Handler` to `*web.Route` (a `chi.Router` whose `ServeHTTP` is `h`) | B1 |
| `forgejo.org/routers`: `NormalRoutes` | the inner handler passed to `Wrap` in integration tests | B1 |
| `forgejo.org/tests`: `PrepareTestEnv` | test setup | B1 |
| `forgejo.org/models/unittest`: `MainTest`, `PrepareTestDatabase` | SQLite unit test of the table definitions | B1 |
| `forgejo.org/models/db`: `TableName`, `GetTableNames`, `WithTx`, `GetEngine(ctx).IsTableExist/Count`, `Engine.SQL(…).Find/Get` | table names, "not a registered upstream model" check, meta inside a transaction, information_schema queries | B1 |
| `code.forgejo.org/xorm/xorm`: `Engine.DropTables`, `Engine.DropIndexes`, `Engine.DBMetas` (`schemas.Table.Indexes`), `Engine.NewSession`, `Engine.Where(…).Delete`, `Session.Begin/Insert/Commit/Close` | dropping tables/indexes, listing indexes (downgrade guard), a competing transaction (meta upsert race) | B1 |
| `forgejo.org/modules/setting`: `NewConfigProviderFromData`, `CfgProvider.Section`, `ConfigKey.String/SetValue`, `Database.Type.IsSQLite3`, `Database.Schema`, `DatabaseType`; `forgejo.org/modules/test`: `MockVariableValue` | settings in unit and integration tests | B1 |
| `forgejo.org/models/issues`: `Label` (+ `db.Insert`, `db.DeleteByID`, `Engine.ID(…).Cols(…).Update`); `forgejo.org/models/system`: `Notice`, `NoticeRepository`; `forgejo.org/models/auth`: `AccessTokenScopeWriteIssue/WriteRepository`; `tests/integration`: `loginUser`, `getTokenForLoggedInUser`, `NewRequestWithJSON`, `AddTokenAuth`, `DecodeJSON` | probe writes on a tracked (`label`, also via API v1) and an untracked (`notice`) table | B2 |
| `forgejo.org/models/db`: `GetTableNames`, `SetDefaultEngine`, `DefaultContext` (reassigned to restore it); `code.forgejo.org/xorm/xorm`: `NewEngine`, `names.GonicMapper`, `Engine.Ping/Close`, `Session.Begin/Insert/Commit/Rollback`, `Engine.DB().DB.ExecContext` (bypasses hooks); `forgejo.org/modules/setting`: `Database.User/Passwd`, `DBMasterConnStr`; `github.com/go-sql-driver/mysql`: `MySQLError` | catalog contract; long / never-committed transactions; a write from "another instance"; an engine connected as the unprivileged MySQL user | B2 |
