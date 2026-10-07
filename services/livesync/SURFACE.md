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
| `forgejo.org/models/db` | `Engine`, `Engined`, `DefaultContext`, `GetEngine`, `GetMasterEngine`, `InTransaction`; transactions run on the master engine (`x`) | `models/livesync` (`MasterEngine`, `SyncTables`, meta) | B1 |
| `code.forgejo.org/xorm/xorm` | `Session.StoreEngine`, `Session.SyncWithOptions`, `SyncOptions{WarnIfDatabaseColumnMissed, IgnoreDropIndices}` (same options as `db.SyncAllTables`), xorm struct tags | `models/livesync` | B1 |
| `forgejo.org/modules/timeutil` | `TimeStamp` | `models/livesync` | B1 |
| `forgejo.org/modules/setting` | `CfgProvider`, `ConfigProvider.Section`, `ConfigKey.MustBool/MustString`, `Database.Type` (`IsPostgreSQL`, `IsMySQL`), `AppSubURL` | `services/livesync`, `routers/livesync` | B1 |
| `forgejo.org/modules/log` | `Info`, `Error` | all | B1 |
| `forgejo.org/modules/graceful` | `GetManager`, `Manager.HammerContext`, `Manager.RunAtShutdown` (hook skipped if its ctx is done; the shutdown context is cancelled *before* hooks run) | `routers/livesync.Wrap` | B1 |
| `forgejo.org/modules/web` | `Route` built as a literal `&web.Route{R: chi.NewRouter()}` (exported field `R`) — **not** `web.NewRoute()`, which in tests resets the API v1 permission bookkeeping; `Route.Use`, `Route.Get`, `Route.NotFound`; handler signature `func(http.ResponseWriter, *http.Request)` | `routers/livesync/routes.go` | B1 |
| `forgejo.org/modules/web/routing` | `GetFuncInfo`, `UpdateFuncInfo` (so the router log names our 405 handler instead of logging an "unknown handler" error) | `routers/livesync/routes.go` | B1 |
| `forgejo.org/modules/json` | `NewEncoder` | `routers/livesync` | B1 |
| `forgejo.org/routers/common` | `ProtocolMiddlewares()` (path normalisation, panic recovery, process manager, access/route log). Note: it wraps the `ResponseWriter` and hides `Hijack` | `routers/livesync/routes.go` | B1 |
| `github.com/go-chi/chi/v5` | `NewRouter`, `Router.MethodNotAllowed` | `routers/livesync/routes.go` | B1 |

## Test-only

| Upstream symbol | Used for | Since |
|---|---|---|
| `tests/integration`: `testWebRoutes` (`*web.Route`), `MakeRequest`, `NewRequest`, `onApplicationRun` (real listener) | `livesyncRoutes(h)` adapts `Wrap`'s `http.Handler` to `*web.Route` (a `chi.Router` whose `ServeHTTP` is `h`) | B1 |
| `forgejo.org/tests`: `PrepareTestEnv` | test setup | B1 |
| `forgejo.org/models/unittest`: `MainTest`, `PrepareTestDatabase` | SQLite unit test of the table definitions | B1 |
| `forgejo.org/modules/setting`: `NewConfigProviderFromData`; `forgejo.org/modules/test`: `MockVariableValue` | settings in unit tests | B1 |
