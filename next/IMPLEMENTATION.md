# Forgejo Next — implementation tracker

> **Read this first, then `next/PLAN.md`.** This file is the shared state between the
> agents that implement the plan one milestone at a time. Each milestone is done by one
> worker and then checked by reviewers. When you finish a milestone: tick its box, fill
> in its *Notes/decisions*, and update **Environment** if you learned something new.
> Never delete another milestone's notes.

Branch: `claude/vigilant-turing-a3oekt`. Plan revision: PLAN.md rev 2.

---

## 1. Environment (verified 2026-10-07)

Sandbox: Ubuntu 24.04, 4 vCPU, 15 GB RAM, **you run as root**. No init system: stopped
daemons can linger as harmless `<defunct>` zombies.

### 1.1 Databases — `next/tools/dev-db.sh`

```sh
next/tools/dev-db.sh start            # PG 16 + MySQL 8.0, idempotent (~7 s from scratch, ~1 s restart)
next/tools/dev-db.sh status           # prints connection settings
next/tools/dev-db.sh stop | reset     # reset = stop + wipe data dirs + start
next/tools/dev-db.sh start mariadb    # optional MariaDB 11 in docker on :3307 (not part of `all`)
eval "$(next/tools/dev-db.sh env)"    # exports TEST_PGSQL_* / TEST_MYSQL_* / TEST_STORAGE_TYPE=local
                                      # and GITEA_I_AM_BEING_UNSAFE_RUNNING_AS_ROOT=true
```

| DB | How it runs | Endpoint | Accounts |
|---|---|---|---|
| PostgreSQL 16.15 | Preinstalled `/usr/lib/postgresql/16/bin`. The script runs it as OS user `postgres` (initdb refuses root). Data in `/var/tmp/forgejo-next-db/pg` | `127.0.0.1:5432`, socket dir `/var/tmp/forgejo-next-db/pg/run` | `postgres/postgres` (superuser), `forgejo/forgejo` (non-superuser, CREATEDB). DBs `testgitea` and `forgejo` are pre-created |
| MySQL 8.0.46 | `apt-get install mysql-server-core-8.0 mysql-client-core-8.0` (the script does this if `mysqld` is missing, ~6 s). Runs as root via `user=root` in its own `my.cnf` | `127.0.0.1:3306`, socket `/var/tmp/forgejo-next-db/mysql/mysqld.sock` | `root/<empty>` (`@localhost` and `@%`), `forgejo/forgejo` (ALL on `forgejo%`/`testgitea%`, **no SUPER**) |
| MariaDB 11.8 | `docker run mariadb:11` (docker daemon is installed but **not running**; the script starts `dockerd`). Image pull works | `127.0.0.1:3307` | `root/<empty>` |

* **Binary logging is ON** in MySQL (the 8.0 default), `log_bin_trust_function_creators=0`.
  Verified: the non-SUPER `forgejo` user gets `ERROR 1419 You do not have the SUPER
  privilege and binary logging is enabled` on `CREATE TRIGGER`, and succeeds after
  `SET GLOBAL log_bin_trust_function_creators=1`. This is exactly the PLAN §4.3 privilege
  matrix; use these two accounts to test `INSTALL_MODE=auto` vs `verify`.
  `NEXT_MYSQL_BINLOG=off next/tools/dev-db.sh reset mysql` gives a binlog-off server.
* Docker works (`dockerd` started by hand; Docker Hub pulls go through the proxy). Use it
  only for things apt can't give you (MariaDB, other PG/MySQL versions for the canary
  matrix). Prefer the native servers for day-to-day work, they start in ~1 s.

### 1.2 A running Forgejo — `next/tools/dev-forgejo.sh`

```sh
next/tools/dev-forgejo.sh start pg      # http://127.0.0.1:3000/  (PG DB `forgejo`)
next/tools/dev-forgejo.sh start mysql   # http://127.0.0.1:3010/  (MySQL DB `forgejo`)
next/tools/dev-forgejo.sh restart pg    # stop + rebuild + start
next/tools/dev-forgejo.sh stop pg | status pg | logs pg
NEXT_FORGEJO_EXTRA_INI=$'[livesync]\nENABLED = true' next/tools/dev-forgejo.sh restart pg
```

(B1: the MySQL instance moved from 3001 to **3010** — the integration tests listen on
3001 (mysql), 3002 (pgsql), 3003 (sqlite) and a running dev server made
`onApplicationRun` fail with "address already in use". B1 also fixed the pidfile, which
held a wrapper subshell's pid, so `stop`/`status` missed the real server and
`start … | tail` never returned.)
Builds `/var/tmp/forgejo-next-dev/forgejo` from this tree, writes an `app.ini` with
`INSTALL_LOCK=true`, `STATIC_ROOT_PATH=<repo>` (the binary has no bindata, so
templates/locales are read from the checkout), and creates site admin `dev/devdevdev1`.
Ready ~1.5 s after launch. The classic UI's JS/CSS bundles are **not built** (no root
`node_modules`), so classic pages render unstyled; the API and the login/OAuth consent
forms work. Run `make frontend` (root `npm ci` + webpack) only if you need them styled;
never commit its output.

### 1.3 Running as root

Forgejo refuses to start as root (`modules/setting/setting.go`). **Every** Go test that
loads settings, every integration test and the binary need
`GITEA_I_AM_BEING_UNSAFE_RUNNING_AS_ROOT=true` (the `env` output above includes it).
Without it you get `[F] Forgejo is not supposed to be run as root`.

### 1.4 Go toolchain, build, timings

`/usr/local/go` is go1.24.7; inside the repo `go.mod` (`go 1.26.0`, `toolchain go1.27.1`)
auto-switches to **go1.27.1**. Tools started with `go run pkg@version` do **not** inherit
that switch, so prefix them with `GOTOOLCHAIN=go1.27.1` (golangci-lint otherwise fails
with "Go language version (go1.26) used to build golangci-lint is lower than the
targeted Go version").

| Command | Time |
|---|---|
| `go build -tags 'sqlite sqlite_unlock_notify' -o /tmp/x/forgejo .` cold (module downloads) | 2 m 15 s |
| same, warm no-op / after editing a body in `models/issues` | 0.4 s / 1.5 s |
| `go build ./...` (warm-ish) | 37 s |
| `go test -tags 'sqlite sqlite_unlock_notify' ./models/issues/ -run 'TestGetIssueByID' -count=1` (warm) | 4.3 s (first compile ~37 s) |
| `go test -c forgejo.org/tests/integration -o integrations.pgsql.test` (warm) | 17 s |
| `make 'test-pgsql#TestVersion'` (incl. compile) | 8.5 s |
| `GOTOOLCHAIN=go1.27.1 go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.14.0 run ./models/db/...` | 80 s first, 1.8 s warm |
| `GOTOOLCHAIN=go1.27.1 go run mvdan.cc/gofumpt@v0.12.0 -l <dir>` | 1.6 s |

### 1.5 Tests

**Go unit tests** (single package; `models/unittest` always uses in-memory **SQLite**):

```sh
GITEA_I_AM_BEING_UNSAFE_RUNNING_AS_ROOT=true \
  go test -tags 'sqlite sqlite_unlock_notify' ./services/livesync/catalog/ -run TestX -count=1
```

Livesync disables itself on SQLite, so **anything that needs a real trigger/outbox must
run on PG/MySQL through the integration harness** (below). Keep pure logic (catalog
classification, hole tracking, coalescing, protocol encoding, grant diffing) in DB-free
unit tests in the package itself.

**Integration tests on PG / MySQL** (Forgejo's own harness; verified passing):

```sh
next/tools/dev-db.sh start && eval "$(next/tools/dev-db.sh env)"
make 'test-pgsql#TestLivesync'      # builds ./integrations.pgsql.test, writes tests/pgsql.ini, runs -test.run TestLivesync
make 'test-mysql#TestLivesync'
# or, reusing a compiled binary:
go test -c forgejo.org/tests/integration -o integrations.pgsql.test
make generate-ini-pgsql generate-ini-mysql
PROJECT_ROOT=$PWD PROJECT_CONF=tests/pgsql.ini ./integrations.pgsql.test -test.run 'TestLivesync' -test.v
PROJECT_ROOT=$PWD PROJECT_CONF=tests/mysql.ini ./integrations.pgsql.test -test.run 'TestLivesync'   # same binary works for mysql
```

`TestVersion|TestAPIListIssues*` ran green on both: 7.1 s (PG), 10.0 s (MySQL).
Caveats:
* `TEST_STORAGE_TYPE=local` is required for PG (the template defaults to `minio`).
* `tests/test_utils.go` connects *to* `TEST_PGSQL_DBNAME` to check it exists, so
  `testgitea` must pre-exist (dev-db.sh creates it). It then creates schema `gtestschema`,
  i.e. **PG integration tests always run with a non-default `[database] SCHEMA`** —
  good, that's what PLAN §4.3 wants covered.
* `tests/*.ini`, `*.test` and `tests/integration/*-integration-*` are gitignored. The
  harness leaves data under `tests/integration/forgejo-integration-{pgsql,mysql}`; don't
  commit it.
* **Fixture reloads fire triggers.** `unittest.PrepareTestEnv` reloads fixtures with
  `DELETE FROM t` + `INSERT` in one transaction (`models/unittest/fixture_loader.go`).
  With livesync triggers installed, every reload writes thousands of outbox rows. Livesync
  integration tests must (a) install triggers inside the test and uninstall them in
  `t.Cleanup` so other tests in the same binary are unaffected, and (b) reset livesync
  state (truncate `livesync_*`, reset materializer cursor) after `PrepareTestEnv`.
* Mount `Wrap` in a test with
  `defer test.MockVariableValue(&testWebRoutes, livesyncRoutes(livesync_router.Wrap(routers.NormalRoutes())))()`
  (`testWebRoutes` is a `*web.Route`, `Wrap` returns `http.Handler`; the adapter
  `livesyncRoutes` lives in `tests/integration/livesync_helpers_test.go`) and use
  `onApplicationRun` (there is no `onGiteaRun` in this tree; real listener ⇒ WebSocket
  hijack works; it calls `PrepareTestEnv` itself). Enable livesync with
  `livesyncConfig(t, map[string]string{"ENABLED": "true"})`, which also stops livesync
  in `t.Cleanup`.
* **Capture triggers in tests (B2):** `livesyncInstallCapture(t)` installs them for one test
  (clean outbox, cursor = last assigned id) and removes them in cleanup; tests that `Init`
  livesync themselves must uninstall in cleanup too (`livesyncUninstallTriggers` +
  `livesyncResetCapture`). `livesyncDropTables` uninstalls first: with triggers present and
  `livesync_change` gone, every write to a tracked table fails.
* `log.Error` during an integration test prints `testlogger.go:recordError() FATAL
  ERROR` (it does not fail the test, but keep tests free of expected errors: an
  unknown-handler 404/405 in the router log counts as one). `tests/e2e/e2e_test.go`
  shows how a Go test starts Forgejo and runs a Node process with the URL in an env var;
  B10/F8 copy that pattern.

### 1.6 Network

| Check | Result |
|---|---|
| npm registry (`npm view react version`) | OK, 0.8 s. Current: react 19.3.0, vite **8.3.3** (Rolldown built in; don't use `rolldown-vite`), tailwindcss 4.3.3, mobx 7.0.6, @tanstack/react-router 1.170.41, @playwright/test 1.63.0. Node 22.22.0, npm 10.9.4 |
| Go proxy (`go list -m github.com/coder/websocket@latest`) | OK: **v1.8.15**. tygo: `github.com/gzuidhof/tygo@v0.2.21` |
| apt (archive.ubuntu.com) | OK |
| Docker Hub | OK (hello-world, mariadb:11 pulled) |

### 1.7 Playwright / Chromium

`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` are
set globally. Preinstalled: `chromium-1194` (Chrome 141, matches Playwright ≈1.56).
Playwright 1.63.0 wants build 1243; `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD= npx playwright install chromium`
downloads it in ~11 s (already done once: `chromium-1243`, `chromium_headless_shell-1243`
are now in `/opt/pw-browsers`). A headless launch + `setContent` was verified. Fallback:
`chromium.launch({executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'})`.

---

## 2. Conventions

### 2.1 Layout (PLAN §4.1) — new directories only

```
models/livesync/          own tables (x.Sync at Init, NOT db.RegisterModel, NOT migrations)
services/livesync/        Init/settings glue (package livesync)
  capture/ catalog/ materialize/ synclog/ perm/ hub/ idempotency/ protocol/ oauthapp/
  SURFACE.md              every upstream symbol livesync imports (keep current!)
routers/livesync/         Wrap(), route registration, handlers
tests/integration/livesync_*_test.go   DB-backed tests (new files in an existing dir; names start with TestLivesync)
next/                     frontend (own package.json + package-lock.json; npm)
  tools/                  dev-db.sh, dev-forgejo.sh, gen-protocol.sh, sync-upstream.sh, budget checks
```

Proposed `next/` tree (F1 creates it; deviations go in F1 notes):

```
next/index.html  vite.config.ts  vitest.config.ts  tsconfig.json  eslint.config.ts  stylelint.config.ts
next/src/styles/tokens.css   ← the ONLY place colours/spacing/radii/typography/motion/z-index are defined
next/src/styles/base.css     reset + element defaults, using tokens only
next/src/ui/                 shared primitives (Button, IconButton, Input, Kbd, Menu, Popover, Tooltip, Dialog,
                             Avatar, Badge/LabelChip, ListRow, Skeleton, EmptyState, …)
next/src/protocol/types.gen.ts   generated from services/livesync/protocol (tygo) — never edit by hand
next/src/data/  next/src/sync/  next/src/intents/  next/src/app/  next/src/features/<area>/
next/src/workers/  next/src/sw/
next/conformance/            B10 headless suite        next/e2e/   F8 Playwright
```

### 2.2 The upstream patch rule

* The only edit to an upstream file is **one line in `cmd/web.go` `serveInstalled()`**
  (`webRoutes := livesync_router.Wrap(routers.NormalRoutes())`, line ~221) plus the
  import, and the mechanical dependency files: `go.mod`, `go.sum`, and
  **`assets/go-licenses.json`** (regenerated by `make tidy`; `make tidy-check` fails
  without it — this file is missing from PLAN §4.2 but is equally mechanical).
* Do **not** edit: root `package.json`/`package-lock.json`, `web_src/`, `webpack.config.ts`,
  `modules/setting`, `templates/`, `options/`, root lint configs, `.deadcode-out`,
  `Makefile`. If you believe one is unavoidable, stop and record it in your milestone
  notes for the orchestrator instead of doing it.
* Check with (`origin/forgejo` = upstream `08ba2d68b6` + the PLAN commit):
  `git diff --stat origin/forgejo...HEAD -- . ':!next' ':!models/livesync' ':!services/livesync' ':!routers/livesync' ':!tests/integration/livesync_*'`
  — it must list only the files above.
* Known upstream-tooling interaction: root `npx eslint` (ESLint 9, flat config resolved
  from cwd) would lint `next/**` with root rules. Root `tsconfig.json`, `vitest.config.ts`
  and `STYLELINT_FILES` do not include `next/`. F1 decides how to handle ESLint without
  editing the root config and records it.

### 2.3 Go style (matches Forgejo; enforced by `.golangci.yml`)

* License header on every new Go file (copy exactly; this is what recent Forgejo files use):
  ```go
  // Copyright 2026 The Forgejo Authors. All rights reserved.
  // SPDX-License-Identifier: GPL-3.0-or-later
  ```
  Shell scripts: same two lines with `#`. TS/CSS files in `next/`: same text with `//` or `/* */`.
* gofumpt formatting; imports grouped std / `forgejo.org/...` / third party.
* `importas`: `forgejo.org/models/X` → `X_model`, `forgejo.org/services/X` → `X_service`
  (so `livesync_model`, `livesync_service`, `access_model`, `issues_model`,
  `org_model`; `forgejo.org/models/db` has no alias; `services/context` is `app_context`).
* depguard: use `forgejo.org/modules/json` (never `encoding/json`), no `golang.org/x/exp`,
  no `gopkg.in/yaml.v3`.
* Logging via `forgejo.org/modules/log`; settings via
  `setting.CfgProvider.Section("livesync")` inside `services/livesync`; errors wrapped
  with `fmt.Errorf("…: %w", err)`; DB work through `db.GetEngine(ctx)` /
  `db.WithTx(ctx, …)`. Forgejo can run with read replicas (`newXORMEngineGroup`): the
  outbox reader, lease and anything correctness-critical must use the **master**
  (`db.GetMasterEngine`).
* **No dead code**: `make lint-go` runs `deadcode -test` and fails on new unreachable
  functions; updating `.deadcode-out` would be an upstream diff. `-test forgejo.org`
  only adds the *root* package's tests, so in practice **every function must be
  reachable from the binary** — use in a package test or `tests/integration` does not
  count (B1 hit this). Check with
  `GOTOOLCHAIN=go1.27.1 go run golang.org/x/tools/cmd/deadcode@v0.50.0 -generated=false -f='{{println .Path}}{{range .Funcs}}{{printf "\t%s\n" .Name}}{{end}}{{println}}' -test forgejo.org | diff .deadcode-out -`
  (needs the `GOTOOLCHAIN` prefix, ~10 s).
* `[livesync]` keys are read in `services/livesync` (one `settings.go`; each milestone
  appends its own keys with defaults and a comment). `ENABLED` defaults to **false**.
* Respect `setting.AppSubURL` (Forgejo may be served under a sub-path) in every route
  match done by `Wrap`.
* Livesync tables must not declare `REFERENCES(...)` to upstream tables (Forgejo's FKs are
  `ON DELETE RESTRICT`; ours would block upstream deletes).
* Gap endpoints call **service-layer** functions only; record every imported upstream
  symbol in `services/livesync/SURFACE.md`.
* Before declaring a Go milestone done: `gofumpt -l` clean, golangci-lint clean on the
  touched packages, `go vet`, unit tests green, and `TestLivesync*` green on **both** PG
  and MySQL.

### 2.4 Frontend rules

* **Look:** clean, functional, Linear-inspired. Dense layouts, neutral greys with one
  accent colour, 1px hairline borders, small radii, no decorative shadows (popovers and
  dialogs only), system font stack, 13px UI base size, tabular numbers for counts. Light
  and dark themes from the same tokens (`[data-theme]` on `<html>`, set before paint).
  One icon set (F1 picks it, e.g. lucide) used everywhere.
* **One source of design tokens:** every colour, spacing step, radius, font size, shadow,
  z-index and motion duration is a CSS variable in `next/src/styles/tokens.css`, exposed
  to Tailwind v4 via `@theme`. Components never hard-code a hex value, px spacing, or a
  Tailwind arbitrary value (`bg-[#…]`, `p-[13px]`); lint enforces it. Need a new value? Add
  a token.
* **Shared primitives only:** features compose `next/src/ui/*`. Never restyle a button,
  menu, input or row locally — extend the primitive (variant prop) instead. No duplicated
  class strings across features; extract to a primitive.
* **Performance first:** reads come from the MobX pool, not from fetch-in-effect;
  `observer()` on leaf components, with props being ids or stable model refs; virtualize
  every list that can exceed ~50 rows (TanStack Virtual / Virtuoso); `content-visibility`/
  `contain` on rows; stable keys; no layout-property transitions and no `transition: all`
  (stylelint rule); motion tokens `--speed-in: 0s`, `--speed-out: .15s`,
  `--speed-quick: .1s`; honour `prefers-reduced-motion`; no spinners for local data.
  Heavy work (Shiki, diff parsing, search index) runs in workers.
* Budgets (CI-enforced from F1): boot-route JS ≤ 150 KB br, CSS ≤ 30 KB br.
* Keyboard first: every action reachable from the shortcut registry and ⌘K.
* Generated protocol types (`next/src/protocol/types.gen.ts`) are the only definition of
  wire shapes on the client.

### 2.5 Process

* One milestone per worker. Stay inside your milestone's scope; if you need something
  owned by a later milestone, stub the narrowest interface and say so in your notes.
* Commit messages: `livesync: …` (backend) or `next: …` (frontend), with the attribution
  trailers the orchestrator gives you. Push with retry/backoff.
* Leave dev servers stopped or healthy; never leave a half-initialised data dir (use
  `dev-db.sh reset` if in doubt).

---

## 3. Milestones

Order is sequential. Each lists **Scope**, **Files** (new unless stated), **Depends on**,
**Acceptance**. "Both DBs" always means PG 16 (with `SCHEMA=gtestschema`, as the harness
does) **and** MySQL 8.0 (binlog on).

### Backend

#### B1 — Skeleton
- [x] **Status** — done 2026-10-07 (final check: `TestLivesync*` + `TestVersion` green on PG 16/`gtestschema` and MySQL 8.0; unit tests, vet, gofumpt, golangci-lint, deadcode, `make tidy-check` clean; fork diff = `assets/go-licenses.json`, `cmd/web.go` (1 line + import), `go.mod`, `go.sum`)
- **Scope:** `services/livesync/settings.go` (`[livesync]`: `ENABLED`=false, `INSTALL_MODE`=auto|verify);
  `models/livesync` with the core tables, created by `Engine.Sync` from `livesync.Init`
  (not `db.RegisterModel`): `livesync_change(id, tbl, row_id, op)`,
  `livesync_log(sync_id, grp, model, entity_id, op, payload, schema_ver, created_unix)`,
  `livesync_entity(tbl, row_id, grp, last_sync_id)`, `livesync_meta(key, value)` (cursor,
  schema epochs), `livesync_idempotency` (columns per §4.8; logic arrives in B7).
  `routers/livesync.Wrap(inner http.Handler) http.Handler`: runs `Init` once; returns
  `inner` unchanged (with a log line saying why) when disabled, on SQLite, or when
  `Init` fails; otherwise a handler that routes `/-/sync/*` and `/-/next/*` to a
  `routes.go` registration point (empty but for `GET /-/sync/health`) and everything else
  to `inner`. Graceful-shutdown hook registration (no sockets yet). The one-line
  `cmd/web.go` patch. `go get github.com/coder/websocket@v1.8.15` + `make tidy` (it is
  not used until B5: add a blank import in `routers/livesync` with a comment so tidy keeps
  it, or defer the dep to B5 — record which). `services/livesync/SURFACE.md`.
- **Depends on:** —
- **Acceptance:** `TestLivesyncWrapDisabled` (ENABLED=false ⇒ `Wrap(h) == h` behaviour,
  routes fall through), `TestLivesyncWrapEnabled` (tables exist on both DBs incl. PG
  schema; `/-/sync/health` 200; `/api/v1/version` still served by inner), unit test for
  SQLite passthrough. `make tidy-check` clean. Fork-diff check (§2.2) shows only allowed
  files.
- **Notes/decisions:**
  - **Files.** `models/livesync/{tables.go,sync.go,lock.go}` (+ SQLite unit test);
    `services/livesync/{livesync.go,settings.go,SURFACE.md}` (+ unit tests);
    `routers/livesync/{wrap.go,routes.go,deps.go}` (+ unit tests);
    `tests/integration/livesync_{helpers,wrap,tables}_test.go`; `cmd/web.go` one-liner + import.
  - **Tables** (`models/livesync`, created by `SyncTables` = master engine,
    `StoreEngine("InnoDB").SyncWithOptions` like `db.SyncAllTables`; never registered,
    so `db.GetTableNames()` and fixtures don't see them). Go types:
    `Change`→`livesync_change(id pk autoincr, tbl varchar64, row_id, op char1)` with
    `OpInsert/OpUpdate/OpDelete` = `I/U/D`; `LogEntry`→`livesync_log(grp, sync_id pk
    (not autoincr), model, entity_id, op char1, payload LONGTEXT, schema_ver,
    created_unix)` with index `IDX_livesync_log_grp_sync (grp, sync_id)` and
    `created_unix`; `Entity`→`livesync_entity(tbl, row_id)` composite PK + `grp`,
    `last_sync_id`; `Meta`→`livesync_meta(name pk varchar255, value TEXT)`;
    `Idempotency`→`livesync_idempotency(id, user_id+idem_key UNIQUE "user_key", state
    (IdempotencyInFlight=0/Completed=1), method, path varchar1024, request_hash
    varchar64, status, headers TEXT(JSON), body LONGBLOB, sync_id, created_unix INDEX,
    updated_unix)`. Later milestones extend these structs; `Sync` adds columns/indexes
    but never changes a PK — get PKs right before adding rows.
  - **Deviation: `livesync_meta(name, value)`, not `(key, value)`** — `KEY` is reserved
    in MySQL and would need quoting in every raw query. Same reason for
    `livesync_idempotency.idem_key`.
  - **APIs for later milestones.** `livesync_model.MasterEngine(ctx)` (master engine,
    or the tx session inside `db.WithTx` — use it for every correctness-critical read;
    `db.GetEngine(ctx)` outside a tx returns a session that `db.GetMasterEngine`
    can't unwrap), `GetMeta/SetMeta(ctx, name, value)` (`SetMeta` = one native
    upsert statement, `ON CONFLICT DO UPDATE` / `ON DUPLICATE KEY UPDATE`: race-tolerant
    inside and outside transactions, one round trip), `Tables()`, `SyncTables(ctx)`
    (**not** concurrency-safe: xorm Sync is check-then-create; call it only under
    `WithSchemaLock`), `MetaTableExists(ctx)`, `WithSchemaLock(ctx, fn)` (PG session
    advisory lock keyed on `hashtext('livesync.schema.'||current_schema())` / MySQL
    `GET_LOCK('livesync.schema.'||MD5(DATABASE()))`, held on a pinned pooled connection
    while `fn` uses others, waits ≤ `SchemaLockTimeout` = 2 min, refuses
    `MAX_OPEN_CONNS = 1`; no lock on SQLite). B3's lease can reuse `acquireLock`/
    `releaseLock` in `models/livesync/lock.go` with its own name.
    `livesync_service.EnsureTables(ctx)` (the whole schema step under the lock),
    `livesync_service.Init(ctx)` (returns
    `ErrDisabled` / `ErrUnsupportedDatabase` (wrapped) / other errors),
    `Context()` — the running instance's context, cancelled by `Shutdown`: **start every
    background worker (reader, materializer, hub) under it**, `Running()`,
    `Shutdown()`, `Setting` (parsed `Settings{Enabled, InstallMode}`; append new keys to
    `Settings` + `loadSettings`), `TablesVersion`/`MetaTablesVersion` (Init refuses to
    start if `livesync_meta.tables_version` > `TablesVersion`: downgrade guard; bump it
    when a model change needs more than `Sync`).
  - **Init order** (B2 inserts trigger install/verify after the tables step): load
    settings → enabled? → PG/MySQL? → `EnsureTables` = under `WithSchemaLock`:
    if `livesync_meta` exists, tables-version check (downgrade guard, **before** any
    DDL) → `SyncTables` → slot for upgrade steps → record `tables_version` →
    instance started. Any error ⇒ `Wrap` logs (Info for disabled/SQLite, Error
    otherwise) and returns `inner` itself (`Wrap(h) == h`).
  - **Lifecycle / graceful shutdown.** `Wrap` passes `graceful.GetManager().HammerContext()`
    to `Init` and registers `RunAtShutdown(livesync_service.Context(), Shutdown)`.
    Not the ShutdownContext: graceful cancels it *before* running shutdown hooks, and
    `RunAtShutdown` skips hooks whose ctx is done. Calling `Init` again (tests) shuts
    the previous instance down, which also disarms its hook. Verified on the real
    binary (PG and MySQL): SIGTERM logs `livesync: shutting down`.
  - **Routing** (`routers/livesync/wrap.go`). `/-/sync`, `/-/sync/*`, `/-/next`,
    `/-/next/*` go to livesync's router, everything else to `inner` untouched. A
    request still carrying `setting.AppSubURL` is recognised and routed with the
    sub-path stripped (normally the proxy strips it, as for upstream routes).
    `ownPath` first collapses repeated `/` and trims trailing `/` exactly like
    upstream's `stripSlashesMiddleware` (which runs only inside upstream's routers),
    so `//-/sync/health`, `/-//sync/health` and `/-/sync/health/` are all livesync's;
    requests for inner are passed with their original path. B5/B7/B8 matchers go
    after this normalisation (match on `ownPath`'s result or the same helper). The
    router (`routes.go` `newRoutes`, **the single registration point**) is a
    `&web.Route{R: chi.NewRouter()}` literal with `common.ProtocolMiddlewares()`; do not
    use `web.NewRoute()` there (in tests it resets the API v1 permission bookkeeping
    built by `NormalRoutes`). Unknown paths ⇒ JSON 404 `{"message":"Not Found"}`, wrong
    method ⇒ JSON 405 (both named handlers, so the router log has no "unknown handler"
    errors). `GET /-/sync/health` ⇒ 200 `{"status":"ok"}` / 503 `{"status":"stopped"}`,
    `Cache-Control: no-store`, public. B5's `/-/sync/ws` must be dispatched in
    `handler.ServeHTTP` *before* `own` (ProtocolMiddlewares hide `Hijack`).
  - **WebSocket dependency: added now** (`go get github.com/coder/websocket@v1.8.15`,
    `make tidy` ⇒ go.mod, go.sum, assets/go-licenses.json). Kept by a commented blank
    import in `routers/livesync/deps.go`; **B5 deletes that file** when the hub imports
    the package. `make tidy` prints `make[1]: [Makefile:671 …] Error 1 (ignored)` from
    `go-licenses save`; that is upstream behaviour, the generated JSON is correct.
  - **Tests.** Unit (SQLite / no DB): `routers/livesync` `TestWrapPassthrough` (disabled,
    no section, SQLite, invalid INSTALL_MODE ⇒ inner, `/-/sync/health` falls through),
    `TestWrapReturnsInnerIdentity`, `TestOwnPath`, `TestHandlerRouting`;
    `services/livesync` `TestLoadSettings`, `TestInitWithoutDatabase`,
    `TestCheckTablesVersion`; `models/livesync` `TestSyncTablesAndMeta` (tags valid on
    SQLite, Sync idempotent, meta upsert incl. inside a tx). Integration
    (`livesync_tables_test.go`, review round 1): `TestLivesyncTablesDowngradeGuard`
    (drop livesync_log's indexes, store version+1 ⇒ `EnsureTables` and `Init` refuse
    and the indexes stay dropped), `TestLivesyncTablesConcurrentEnsure` (3 rounds × 6
    goroutines `EnsureTables` on dropped tables all succeed; the lock never has two
    holders), `TestLivesyncSetMetaRace` (a competing tx inserts the row; `SetMeta`
    inside `db.WithTx` and outside waits and wins). All three were verified to fail
    against the round-0 code (PG: index re-created, `42P07 already exists`, `25P02
    transaction is aborted`; MySQL: index re-created, `1061 Duplicate key name`;
    the old SetMeta happened to pass in-tx on MySQL). Also:
    `TestLivesyncWrapDisabled` (Wrap returns the same `*web.Route`, no tables created,
    `/-/sync/health` 404 from upstream, `/api/v1/version` 200) and
    `TestLivesyncWrapEnabled` (drops the tables, Wrap ⇒ tables exist in exactly the
    configured schema — `gtestschema` on PG, the test DB on MySQL — tables_version
    recorded, health 200 in-process and over a real listener, 404/405 JSON,
    `/api/v1/version` 200, after `Shutdown` health 503, re-Init keeps data; on SQLite
    asserts passthrough). Green on PG 16 and MySQL 8.0 (and SQLite).
    `TestOwnPath`/`TestHandlerRouting` cover doubled/trailing slashes;
    `TestHandlerInnerUntouched` checks inner gets the original path.
    Invalid-settings ⇒ passthrough is only unit-tested: in the integration harness the
    expected `log.Error` would print a testlogger "FATAL ERROR".
  - **Commands run:** gofumpt (clean), `golangci-lint run` on the touched packages +
    `tests/integration` (0 issues), `go vet`, deadcode diff (clean), unit tests above,
    `./integrations.pgsql.test -test.run 'TestLivesync|TestNodeinfo|TestVersion|TestAPIListIssues'`
    with `tests/pgsql.ini` and `tests/mysql.ini`, `make tidy-check` (clean after
    commit), fork-diff check (§2.2) lists only `assets/go-licenses.json`, `cmd/web.go`,
    `go.mod`, `go.sum`; dev binary smoke test with `[livesync] ENABLED = true` on PG and
    MySQL.

#### B2 — Change capture
- [ ] **Status**
- **Scope:** `services/livesync/catalog`: tracked tables (PLAN §4.3 list, tier, model
  name) + explicit ignore list; contract test that `db.GetTableNames()` ⊆ tracked ∪ ignored
  and that tracked tables have an `id` PK. `services/livesync/capture`: PG DDL (one
  `plpgsql` function using `TG_TABLE_NAME` + `pg_notify('livesync','')`, per-table
  `AFTER INSERT/UPDATE/DELETE FOR EACH ROW` triggers, everything **schema-qualified**);
  MySQL DDL (3 triggers per table, no DEFINER, deterministic); installer with
  `auto`/`verify`/repair, comparing the catalog with `pg_trigger` /
  `information_schema.triggers`, exposing the exact DDL text (for the admin page in B8);
  bump per-table `schemaEpoch` in `livesync_meta` on repair. Doorbell: passive xorm
  `contexts.Hook` on the master engine (pokes on COMMIT/autocommit DML), PG `LISTEN
  livesync` via pgx, polling fallback (250 ms; 100 ms on MySQL). Outbox reader: reads
  committed rows above a cursor, tracks holes below the high-water mark and re-checks them
  until `HOLE_TIMEOUT` (30 s), hands ordered batches to a consumer interface (the
  materializer arrives in B3; test with a fake consumer). Contract test: no DB-level
  cascades on tracked tables. `Init` refuses to serve when triggers are missing/stale.
- **Depends on:** B1
- **Acceptance (both DBs):** insert/update/delete on a tracked table ⇒ outbox rows;
  rollback ⇒ none; nested tx; a long-running tx that commits a lower id after a higher one
  is delivered (hole filling) and a never-committed id times out; dropping a trigger then
  re-`Init` repairs it and bumps the epoch; `verify` mode with a missing trigger ⇒ Wrap
  passthrough + DDL available; MySQL non-SUPER user with binlog on ⇒ `auto` fails cleanly
  and reports, `verify` works after root installs DDL. Write-amplification micro-benchmark
  recorded in notes.
- **Notes/decisions:**
  - **Files.** `services/livesync/catalog/catalog.go` (+ test); `services/livesync/capture/{ddl,inspect,install,doorbell,holes,reader}.go`
    (+ unit tests incl. a SQLite reader test with explicit ids); `services/livesync/catalog_check.go`;
    Init/settings/Wrap wiring in `services/livesync/{livesync,settings}.go`, `routers/livesync/wrap.go`;
    `tests/integration/livesync_{capture,privileges,bench}_test.go` + helpers in `livesync_helpers_test.go`;
    `models/livesync`: `masterXORMEngine` exported as **`MasterXORMEngine()`**.
  - **Catalog** (`catalog.Tracked() []Table{Name, Model, Tier, Hot}`, sorted by name; `catalog.Classify(registered)
    (unclassified, vanished)`). 39 tracked tables exactly as PLAN §4.3; tiers `TierSummary`/`TierLazy`/`TierOnDemand`
    (`issue_content_history`); `Hot` = `notification`, `commit_status`, `action_run_job`. Model names (for
    `livesync_log.model`, B3 may rename before rows exist): PascalCase of the table except `project_board`→`ProjectColumn`,
    `issue_assignees`→`IssueAssignee`, `pull_auto_merge`→`AutoMerge`, `forgejo_blocked_user`→`BlockedUser`,
    `issue_content_history`→`ContentHistory`. Every other registered table is in the grouped ignore list (incl.
    `forgejo_sem_ver`, found by the contract test). `livesync_service.CheckCatalog()` runs in Init: error if a tracked
    table vanished or lacks an auto-increment `id` PK, warning for unclassified/vanished-ignored tables;
    `TestLivesyncCatalogContract` (all DBs) fails on any of them. All tracked tables have an `id` PK today.
  - **Trigger DDL** (`capture/ddl.go`). PG: `"<schema>"."livesync_capture"()` plpgsql, one `AFTER INSERT OR UPDATE OR
    DELETE … FOR EACH ROW` trigger named `livesync_capture` per table, everything schema-qualified (schema =
    `current_schema()`, which is `[database] SCHEMA` thanks to the `postgresschema` driver). The body has a version
    marker; staleness = `prosrc` differs, or the trigger is disabled / wrong `tgtype` / calls another function / has
    args, a column list or WHEN. **Deviation: `pg_notify('livesync', TG_TABLE_SCHEMA)`** instead of an empty payload,
    so listeners ignore Forgejos sharing the database under another schema (still deduplicated per transaction).
    MySQL/MariaDB: `livesync_<tbl>_ai|_au|_ad`, no DEFINER, single-statement bodies (no DELIMITER needed); staleness =
    `information_schema.triggers` event/timing/orientation/table/`action_statement` differ. Extra livesync triggers
    on untracked tables are state `extra`: dropped in auto mode, only warned about in verify mode (not fatal).
  - **Installer API (for B8's admin page).** `capture.Inspect(ctx) (*Status, error)` (read-only);
    `capture.Ensure(ctx, repair bool) (*Report, error)` under the B1 schema lock — repair = `INSTALL_MODE=auto`.
    `Status{Dialect, Schema, Objects []Object{Kind, Table, Name, State ok|missing|stale|extra, Detail}}`,
    `Status.Healthy()`, `Status.Statements()` (idempotent DDL from this status to healthy: drop-if-exists + create per
    broken object, function first, then drops of extras; on an empty DB = full install), `Status.Script()` (same with a
    header saying where/as whom to run it, works in psql and the mysql client). Errors: `*capture.NotInstalledError
    {Status, Cause}` (`errors.Is(err, capture.ErrNotInstalled)`; `Cause` = DDL error in auto mode, wrapped with a
    privilege hint for MySQL 1419/1142/1227 and PG 42501). PG repair runs in one transaction; MySQL DDL commits per
    statement (a stale trigger is dropped and recreated: writes in that window are lost — covered by the epoch bump).
  - **Schema epochs.** `livesync_meta` `schema_epoch.<tbl>` (`capture.MetaEpochPrefix`), bumped for every repaired
    table (all tables when the PG function was broken; the first install sets them all to 1). `Report.Repaired`,
    `Report.Epochs`. **Verify mode** can't repair, so a failed Ensure records the broken tables in
    `capture_pending` (`capture.MetaPending`); the next Ensure that finds them healthy (a DBA ran the DDL) bumps their
    epochs and clears it. The PLAN's "reconciliation scan over `updated_unix`" is **not** done in B2: consumers must
    treat an epoch bump as "re-bootstrap/re-materialize this model" (B3/B5 decide; nothing reads epochs yet).
  - **Init order now:** settings → enabled/DB → `EnsureTables` → `CheckCatalog` → `ensureCapture` (Ensure; logs
    repaired/dropped) → `capture.Start` (reader under the instance context) → running. `Shutdown` cancels and waits
    ≤ 10 s for the reader. Any capture failure ⇒ Init error ⇒ `Wrap` returns `inner`; for a `NotInstalledError` Wrap
    logs **Warn** (operational state, not a crash; also keeps integration logs free of ERROR) plus the full DDL at Info.
    **For B8:** in that state Wrap passes through, so `/-/sync/admin` is not served; B8 must either serve the admin
    page in a degraded Wrap or keep the last `NotInstalledError` (Init returns it; `capture.Inspect` + `Script()` can be
    called any time, they only need the DB).
  - **Doorbell** (`capture/doorbell.go`). (1) xorm hook on the master engine (added once per engine; xorm can't remove
    hooks, it is inert without a subscribed reader): rings after `COMMIT` and after any successful
    INSERT/UPDATE/DELETE/REPLACE not mentioning `livesync_` (it can't tell autocommit from in-tx; an extra ring costs
    one empty indexed read). See SURFACE.md for the **TracingHook context quirk** this hook has to work around.
    `AddHook` is not synchronised with concurrent queries; it runs once at startup. (2) PG: `LISTEN livesync` on its own
    pgx connection (`setting.DBMasterConnStr()`, outside the pool), reconnect with backoff, rings after every
    (re)connect; failures are warnings (polling covers). (3) Polling `[livesync] POLL_INTERVAL` (default 0 = 250 ms PG /
    100 ms MySQL). Measured on the test harness: commit→reader ≈ 1–2 ms via the hook; write from another connection
    (no hook) → reader ≈ 0.3 ms via NOTIFY on PG.
  - **Outbox reader** (`capture.Start(ctx, capture.Config{PollInterval, HoleTimeout, SweepInterval, BatchSize},
    consumer) (*Reader, error)`, `Reader.Wait(timeout)`). Consumer interface: `Consume(ctx, *capture.Batch) error`;
    `Batch{Changes []livesync_model.Change (ascending within the batch), Cursor}` and `Batch.Commit(ctx)` = delete the
    batch's outbox rows + store `Cursor` in `livesync_meta` `capture_cursor` (`capture.MetaCursor`). **B3: call
    `b.Commit(txCtx)` inside the materializer's transaction** (atomic log append + ack); if the consumer doesn't, the
    reader commits after `Consume` returns nil. Error ⇒ same rows redelivered with backoff (100 ms … 10 s). Semantics:
    reads `id > high` (batches of 1000), ids skipped become holes (sorted ranges with first-seen time, capped at 10k
    ranges), holes are re-checked every cycle and given up after `[livesync] HOLE_TIMEOUT` (30 s); `Cursor` = lowest
    open hole − 1 (or `high`): monotonic, everything at or below is processed or given up. Every `SweepInterval`
    (5 s) it also delivers rows **at or below** the cursor, i.e. transactions that committed after their hole was given
    up — nothing is lost, only late. Rows are **not** globally id-ordered across batches (a filled hole comes after
    higher ids): the materializer must load current row state, not trust order. Restart resumes from `capture_cursor`;
    if the outbox's max id is below the stored cursor (table recreated) it restarts from 0. After a restart, ids that
    were delivered+deleted above the stored cursor look like holes for ≤ HOLE_TIMEOUT (harmless).
    **B2 production consumer = `drainConsumer`** in `services/livesync/livesync.go` (acks every batch so the outbox
    doesn't grow); **B3 replaces it** with the materializer. **B3 must also run the reader only under the materializer
    lease**: today every instance runs its own reader (two instances would both drain).
  - **Settings added:** `POLL_INTERVAL` (duration, default 0 = per-dialect), `HOLE_TIMEOUT` (default 30s, > 0).
  - **Ops notes (for B8 docs/admin page).** (a) Setting `ENABLED=false` after livesync ran **leaves the triggers
    installed** and the outbox grows with every tracked write, since disabled livesync never touches the DB (B1 rule).
    To turn it off for good, drop the triggers (B8 should offer the uninstall DDL / a kill switch). (b) Never drop
    `livesync_change` while triggers exist: every write to a tracked table would fail (tests' `livesyncDropTables`
    uninstalls first). (c) MySQL `verify` mode needs the DB user to have `TRIGGER` on the tables, otherwise
    `information_schema.triggers` hides them and they look missing. (d) PG: transactions that NOTIFY serialise at
    commit on a cluster-wide lock; fine at the §4.11 targets (≤ 100 writes/s) but a candidate for a debounced/polling
    mode at higher write rates.
  - **Tests.** Unit (no DB/SQLite): catalog consistency/classify; DDL text, `Statements`/`Script`/`summary` for both
    dialects, `NotInstalledError`, privilege hints, `pokes`, doorbell coalescing; hole ranges incl. a randomised check
    against a set; reader on SQLite with explicit ids (holes, fill, timeout, late sweep, retry with in-tx Commit,
    restart from cursor, recreated outbox, batch size); settings. Integration, **green on PG 16 (`gtestschema`),
    MySQL 8.0 (binlog on) and MariaDB 11.8 (binlog on)**: `TestLivesyncCaptureOutbox` (I/U/D, multi-row update,
    rollback ⇒ none, outbox row visible inside the tx, nested tx commit and inner-failure rollback, untracked table ⇒
    none, API v1 label create ⇒ row), `TestLivesyncCaptureReader` (prompt delivery, long tx commits lower id after a
    higher one ⇒ delivered and cursor catches up, never-committed id ⇒ cursor moves past it after HOLE_TIMEOUT, rows
    deleted, cursor stored), `TestLivesyncCaptureDoorbell` (hook with polling off; PG NOTIFY from a hook-less
    connection; MySQL polling), `TestLivesyncCaptureRepair` (dropped trigger / disabled or altered trigger / PG function
    replaced / extra trigger ⇒ re-`Init` repairs, bumps exactly those epochs, drops the extra),
    `TestLivesyncCaptureVerifyMode` (missing trigger ⇒ `NotInstalledError` with the DDL, `Wrap(h)==h`, `/-/sync/health`
    404, nothing changed; DBA runs `Statements()` ⇒ verify starts and bumps that epoch), `TestLivesyncCaptureMySQLPrivileges`
    (MySQL/MariaDB as the non-SUPER `forgejo` user with binlog on ⇒ auto fails with 1419 + hint, nothing created, Wrap
    passes through; root runs the DDL ⇒ verify and auto start as `forgejo`; its writes are captured; override the user
    with `TEST_MYSQL_UNPRIVILEGED_USER/PASSWORD`), `TestLivesyncCatalogContract`, `TestLivesyncCaptureNoCascades`
    (information_schema FK rules of tracked tables). Tests install triggers themselves and remove them in cleanup;
    `livesyncResetCapture` also stores the last assigned outbox id as cursor (deleting rows doesn't reset sequences).
  - **MariaDB (open question 1):** 11.8.9 via `dev-db.sh start mariadb`, binlog on, `log_bin_trust_function_creators=0`:
    all `TestLivesync*` green incl. the privilege test (same error 1419 for a non-SUPER user; needed
    `CREATE USER forgejo` there by hand — dev-db.sh doesn't create it for MariaDB). Run it with a copy of
    `tests/mysql.ini` generated with `TEST_MYSQL_HOST=127.0.0.1:3307`.
  - **Write amplification** (`LIVESYNC_BENCH=2000 … -test.run TestLivesyncCaptureWriteAmplification -test.v`; 2000
    rows on `label`, local sandbox, fsync on; µs/op without → with triggers):

    | DB | autocommit INSERT | UPDATE | DELETE | INSERT ×2000 in 1 tx |
    |---|---|---|---|---|
    | PG 16.15 | 79.7 → 121.2 (+52%) | 85.0 → 126.3 (+49%) | 74.7 → 97.3 (+30%) | 68.4 → 80.9 (+18%) |
    | MySQL 8.0.46 | 354 → 379 (+7%) | 411 → 497 (+21%) | 364 → 503 (+38%) | 235 → 291 (+24%) |
    | MariaDB 11.8.9 (docker) | 749 → 770 (+3%) | 753 → 744 (~0) | 736 → 728 (~0) | 324 → 359 (+11%) |

    i.e. ≈ 25–140 µs extra per captured row (PG: plpgsql + outbox insert + NOTIFY per tx). Negligible at the §4.11
    targets; hot tables can later be filtered in the trigger if needed.
  - **Commands run:** gofumpt (clean), `golangci-lint run ./models/livesync/... ./services/livesync/...
    ./routers/livesync/... ./tests/integration/...` (0 issues), `go vet` (+ integration with sqlite tags), deadcode diff
    (clean), `go mod tidy -diff` (clean), unit tests above, `./integrations.pgsql.test -test.run TestLivesync` with
    `tests/pgsql.ini`, `tests/mysql.ini` and a MariaDB ini (all green, no leftover triggers afterwards), benchmark on all
    three, fork-diff check (§2.2) unchanged (`assets/go-licenses.json`, `cmd/web.go`, `go.mod`, `go.sum`); dev binary
    smoke test with `[livesync] ENABLED = true` on PG and MySQL (39 tables installed, API repo create ⇒ outbox drained,
    cursor stored, SIGTERM stops the reader); dev DBs' triggers removed again afterwards.

#### B3 — Materializer, sync log, protocol DTOs
- [ ] **Status**
- **Scope:** `services/livesync/protocol`: entity DTO structs (normalized, IDs for refs,
  API v1 field names) for every tracked model + group naming (`user:`, `org:`, `repo:`,
  `issue:`) + required unit. TS generation: `next/tools/gen-protocol.sh` running
  `go run github.com/gzuidhof/tygo@v0.2.21` (config in `next/tools/tygo.yaml`) →
  `next/src/protocol/types.gen.ts`, with `--check` mode. `services/livesync/materialize`:
  coalesce by `(tbl,row_id)`, load via typed models, build viewer-independent DTOs (bodies
  rendered via the markup service; verify viewer-independence and record findings),
  maintain `livesync_entity` (group for deletes), hot-table coalescing. `synclog`: single
  writer assigns gap-free `sync_id`, append, `ReadSince(group, cursor, limit)`, retention
  (days / max rows) with "oldest available" watermark, lease (PG advisory lock / MySQL
  `GET_LOCK`), tailer interface that the hub will consume. Delete processed outbox rows.
- **Depends on:** B2
- **Acceptance (both DBs):** API v1 write (create issue, add label, comment, delete
  comment) ⇒ log entries with the expected group/model/op/payload; delete carries the
  right group from `livesync_entity`; `sync_id` strictly increasing and gap-free under
  concurrent writers; second instance cannot take the lease; retention trims and reports
  the oldest cursor; `gen-protocol.sh --check` passes; unit tests for coalescing.
- **Notes/decisions:**

#### B4 — Permissions
- [ ] **Status**
- **Scope:** `services/livesync/perm`: `Grants(ctx, user) → map[group]units` from
  `access_model.GetUserRepoPermission`, org/team membership, visibility; per-user cache
  shared across connections; permission epochs bumped by the materializer when it
  processes `access`, `collaboration`, `team*`, `org_user`, `repository`
  (visibility/owner), `repo_unit`, `user` (visibility/active/admin),
  `forgejo_blocked_user`; an event stream `{userIDs, repoIDs}` for the hub to recompute
  and emit `group_revoked`. Public-repo on-demand access check. Admins get no implicit
  groups.
- **Depends on:** B3
- **Acceptance (both DBs):** table-driven tests over fixtures comparing `Grants` with API
  v1 visibility (differential: for every fixture user × repo, `repo:{id}` granted ⇔ `GET
  /api/v1/repos/{o}/{r}` is 200 for that user, and unit lists match); making a repo
  private / removing a collaborator / removing from team bumps the epoch and drops the
  grant.
- **Notes/decisions:**

#### B5 — WebSocket hub + protocol (+ SSE fallback)
- [ ] **Status**
- **Scope:** `services/livesync/protocol` message types (`hello`, `welcome`,
  `subscribe`/`unsubscribe`, `delta`, `caught_up`, `bootstrap_required`,
  `group_revoked`, `barrier`/`barrier_ok`, `session_invalid`, `notice`, `pong`,
  `resume_from_cursor`) + TS regen. `services/livesync/hub`: connections, per-group
  subscriber index, replay-then-live per subscription, ≤16 ms frame batching,
  permessage-deflate, bounded send buffer with disconnect, per-user subscription cap,
  epoch-driven revocation, graceful shutdown. `routers/livesync`: `/-/sync/ws` handled
  **before** Forgejo middleware (raw `ResponseWriter`), bearer token in `hello` validated
  with Forgejo's OAuth2/access-token code; SSE `GET /-/sync/sse` + `POST /-/sync/send`
  speaking the same messages.
- **Depends on:** B4
- **Acceptance (both DBs, real listener via `onGiteaRun`):** hello→welcome; replay from
  cursor then live delta after an API write (< 150 ms locally); subscribe to an
  unauthorized group refused; collaborator removal ⇒ `group_revoked`; cursor older than
  retention ⇒ `bootstrap_required`; slow consumer disconnected with `resume_from_cursor`;
  invalid token ⇒ `session_invalid`; same scenario over SSE.
- **Notes/decisions:**

#### B6 — Bootstrap + partial load
- [ ] **Status**
- **Scope:** `GET /-/sync/bootstrap?group=` (NDJSON, first line `{watermark, schema}`,
  br/gzip, streaming, cancellable; summary tier = open + updated in the last 90 days,
  `SUMMARY_RECENCY` key), `GET /-/sync/load?group=issue:N` (lazy tier),
  `GET /-/sync/load?group=repo:N&closedBefore=…` for older closed items, workspace listing
  `GET /-/sync/workspace` (groups to keep hot, capped). Permission-checked via B4.
  Watermark read **before** the snapshot.
- **Depends on:** B5
- **Acceptance (both DBs):** bootstrap ∪ deltas since watermark equals a fresh bootstrap
  later (convergence test with concurrent writes); unauthorized group ⇒ 403/404 without
  leaking existence; differential test: entities returned ⊆ what API v1 returns for that
  user; streaming verified with a large fixture (memory bounded).
- **Notes/decisions:**

#### B7 — Idempotency layer for API v1
- [ ] **Status**
- **Scope:** `services/livesync/idempotency` + Wrap interception of `/api/v1/*` with
  `Idempotency-Key`: reserve `(user_id,key)`, replay completed responses, `409` for
  in-flight, buffered in-process call to `inner`, wait (bounded) for the materializer to
  pass the outbox high-water mark, set `X-Livesync-Sync-Id`, store status/body/syncId (7 d
  TTL, cleanup). Crash-window dedupe for creates (issue, comment, review): in-flight key
  after restart ⇒ look for same user/target/content in the last N minutes.
- **Depends on:** B6
- **Acceptance (both DBs):** same key twice ⇒ one issue, identical responses; concurrent
  duplicates ⇒ one 2xx + one 409/replay; forced "crash" (record left in-flight) then retry
  ⇒ no duplicate; `X-Livesync-Sync-Id` ≥ the delta's `v` for that write; requests without
  the header are untouched (byte-identical passthrough).
- **Notes/decisions:**

#### B8 — OAuth app, SPA serving, admin page, metrics
- [ ] **Status**
- **Scope:** `services/livesync/oauthapp` (ensure a public client, redirect
  `{AppURL}-/next/callback`, PKCE; confirm scope behaviour with/without
  `ENABLE_ADDITIONAL_GRANT_SCOPES`; expose client_id to the SPA via the inlined config).
  SPA serving: `/-/next/assets/*` from `ASSETS_DIR` on disk (default unset ⇒ 404) or
  `go:embed` behind build tag `livesync_embed`, `Cache-Control: immutable`;
  `/-/next/sw.js` with `Service-Worker-Allowed: /`; `index.html` for `ui=next` cookie +
  `Sec-Fetch-Dest: document` on supported canonical routes (list in one table);
  `/-/next/opt-in` / `opt-out` toggles. `/-/sync/admin` (site admin): trigger health,
  DDL for DBAs, lag, connections. Prometheus metrics (§4.11 list) registered with the
  default registry. `/-/sync/rum` sink (validated, rate-limited, metrics only).
- **Depends on:** B7
- **Acceptance (both DBs):** OAuth app created once (idempotent across restarts); full
  PKCE code flow in a Go test yields a token that works for `hello` and API v1; cookie on
  ⇒ SPA document for `/{owner}/{repo}/issues/{n}`, cookie off or XHR ⇒ classic; assets
  served with immutable headers (fixture dist dir); admin page 403 for non-admins;
  metrics visible on `/metrics`.
- **Notes/decisions:**

#### B9 — Gap endpoints
- [ ] **Status**
- **Scope:** under `/-/sync/api/`: project boards (columns CRUD, move card, ordering)
  via `services/project` / models; conflict-checked issue/PR/comment body edit
  (`expectedVersion` → 409 with current text/version); PR viewed files (`review_state`)
  get/set; blame; immutable SHA-addressed tree/blob/raw/diff (`Cache-Control: immutable`,
  `ETag` = SHA, 404 for non-SHA refs); batch markdown preview. All accept
  `Idempotency-Key` (reuse B7). Each endpoint has a contract test and appears in
  `SURFACE.md`. (Actions log tail over the socket is deferred to F7's backend notes.)
- **Depends on:** B8
- **Acceptance (both DBs):** per endpoint: permission denied cases, happy path, the
  expected delta arrives (boards/body/viewed files), conflict returns 409, immutable
  headers present.
- **Notes/decisions:**

#### B10 — Headless TS conformance suite (Phase 1 exit)
- [ ] **Status**
- **Scope:** create the first `next/package.json` (private, `"type": "module"`, npm
  lockfile), `next/tsconfig.json` and a `test:conformance` script (Vitest, Node env).
  `next/conformance/`: a minimal raw client (fetch + WebSocket, using
  `types.gen.ts`) — **not** the app's sync client (F2). Scenarios: bootstrap → live →
  reconnect from cursor → `group_revoked` purge → idempotent replay → no duplicates after
  forced crash between commit and idempotency record; plus SSE fallback.
  `tests/integration/livesync_conformance_test.go` starts Forgejo with `Wrap` (pattern of
  `tests/e2e/e2e_test.go`) and runs `npm --prefix next run test:conformance` with
  `FORGEJO_URL`; skipped when `next/node_modules` is absent.
- **Depends on:** B9
- **Acceptance:** suite green on PG and MySQL; fork diff is still exactly 1 line + go.mod
  / go.sum / go-licenses.json. Tick PLAN Phase 1 exit in notes.
- **Notes/decisions:**

### Frontend

#### F1 — Toolchain, tokens, primitives, shell
- [ ] **Status**
- **Scope:** extend `next/package.json` (keep `test:conformance` working): Vite 8
  (Rolldown), React 19, TS strict, Tailwind v4 with `@theme` mapped to
  `src/styles/tokens.css`, lightningcss, ESLint (flat, local config) incl. a ban on
  Tailwind arbitrary colour/spacing values and raw hex in TSX, Stylelint with the
  transition rule (no `transition: all`, no layout-property transitions), Vitest (jsdom).
  Design tokens (light + dark) and primitives in `src/ui/` with a dev-only gallery route.
  `index.html` with inline critical CSS + boot script (`performance.mark('appStart')`,
  `localStorage.splash` → theme/sidebar width/skeleton counts before paint, logged-out
  shell when no DB marker), modulepreload list emitted by the build, per-package vendor
  chunks. Bundle budget check script (`npm run budget`). Decide and record the root
  ESLint interaction (§2.2).
- **Depends on:** B10 (package.json exists)
- **Acceptance:** `npm ci && npm run lint && npm run typecheck && npm test && npm run build && npm run budget`
  green; gallery renders both themes; a Vitest/Playwright check that `<html data-theme>`
  is set before first paint; lint fails on a sample `transition: all` and `bg-[#fff]`.
- **Notes/decisions:**

#### F2 — Data layer
- [ ] **Status**
- **Scope:** `src/data`: IDB schema (one DB per origin+userId; store per model with
  `group` + hot-field indexes; `meta`, `intents`, `drafts`, `blobs`), per-model schema
  versions (drop/re-bootstrap one model, never `intents`/`drafts`), MobX object pool with
  per-field observables and indexes, delta applier (`v > entity.v`), group purge.
  `src/sync`: client (hello/subscribe/deltas/caught_up/barrier, reconnect with backoff,
  SSE fallback), bootstrap/load NDJSON streaming into IDB + pool, leader election via Web
  Locks, BroadcastChannel fan-out to followers, hydration order (structure + current
  route first, rest on idle), `navigator.storage.persist()`.
- **Depends on:** F1
- **Acceptance:** Vitest + fake-indexeddb: applier idempotency/ordering fuzz (fast-check),
  schema bump keeps intents; conformance-style test of the client against a real dev
  Forgejo (dev-forgejo.sh with `[livesync] ENABLED=true`) on PG: bootstrap → delta
  arrives in pool; hydrate 10k summaries benchmark recorded.
- **Notes/decisions:**

#### F3 — Auth, router, app shell, shortcuts, ⌘K
- [ ] **Status**
- **Scope:** OAuth PKCE flow (`/-/next/callback`), access token in memory, refresh token in
  IDB, refresh/401 handling, logout (revoke, warn on unsynced intents, wipe, broadcast).
  TanStack Router with canonical Forgejo URLs, `preload="intent"`. App shell: sidebar
  (workspace repos/orgs, inbox count), header, sync indicator (live / catching up /
  offline · N pending). Global shortcut registry with scoped contexts and hint rendering;
  `cmdk` palette over the pool.
- **Depends on:** F2
- **Acceptance:** Playwright against dev Forgejo: login via classic consent → shell
  renders from cache on reload with network blocked; logout wipes IDB; `⌘K` finds a repo
  and an issue from the pool in < 16 ms (perf mark).
- **Notes/decisions:**

#### F4 — Lists, issue detail (read), online optimistic edits
- [ ] **Status**
- **Scope:** virtualized issue and PR lists (repo + "my issues/PRs/review requests"),
  filters/grouping/sorting with typed search params, row context menu; issue/PR detail
  read view (timeline via lazy `issue:{id}` load, Virtuoso, markdown HTML from server,
  sidebar fields); online optimistic state/label/assignee/milestone changes through API v1
  with `Idempotency-Key`, overlay dropped on `X-Livesync-Sync-Id`.
- **Depends on:** F3
- **Acceptance:** 10k-row list scrolls without long tasks > 50 ms; local filter/apply
  < 16 ms; optimistic label change visible in another browser via delta; no flicker on
  confirm (test asserts the DOM never shows the old value after local apply).
- **Notes/decisions:**

#### F5 — Offline intents + service worker
- [ ] **Status**
- **Scope:** `src/intents`: typed intents (PLAN §5.4 table), durable IDB queue,
  overlay + rebase on deltas, flush rules (after `caught_up`, per-entity serial,
  dependencies, backoff with stable keys), conflict policies (set ops, LWW with override
  notice + undo, 3-way body merge via B9 conflict-checked edit, comment edit check, temp-id
  remap incl. URL), drafts on every failure path, "Unsynced changes" panel, follower-tab
  intent forwarding, group-revoked handling. Service worker: precache hashed chunks after
  first paint, offline navigation for supported routes, offline page, versioned
  activation + `notice{new_build}`, kill switch (self-unregister).
- **Depends on:** F4
- **Acceptance:** fast-check property: any interleaving of offline intents and remote
  changes converges with no loss/duplicates; Playwright: offline label + body edit, remote
  edit in a second context, reconnect ⇒ converged, one comment not two; warm offline boot
  renders the list.
- **Notes/decisions:**

#### F6 — Inbox, boards, search, saved views, create flows, comments
- [ ] **Status**
- **Scope:** inbox (notifications, read/unread/pin, offline-capable), project boards with
  drag and drop (move-card intent → B9), MiniSearch worker over the pool + server issue
  search fallback, saved views (local, synced later), create issue flow (temp id), comment
  composer (CodeMirror 6 markdown + batch preview), reactions.
- **Depends on:** F5
- **Acceptance:** Playwright: create issue offline → appears with temp id → online ⇒ real
  number, URL replaced; drag card between columns reflects in classic UI; search returns
  local results < 16 ms; notifications mark-read sync across tabs.
- **Notes/decisions:**

#### F7 — Code surfaces
- [ ] **Status**
- **Scope:** repo browser by `(repo, sha)` with head from synced `branch`; file view (Shiki
  worker, virtualized, cached by blob SHA in IDB + SW); PR files/diff (worker parse,
  virtualized renderer), review comments anchored `(path, side, line, commitSHA)`, review
  drafts offline + submit online, viewed files; checks/actions status + log streaming
  (add the socket log-tail message to the backend here if not done, recorded in notes);
  blame; releases; commits/branches/compare (online).
- **Depends on:** F6
- **Acceptance:** 5k-line diff scrolls at 60 fps (Playwright trace, no frame > 32 ms);
  switching to a cached file < 100 ms; prefetched PR reviewable offline.
- **Notes/decisions:**

#### F8 — E2E, perf assertions, RUM
- [ ] **Status**
- **Scope:** `next/e2e` Playwright suite driven from a Go test (pattern of
  `tests/e2e/e2e_test.go`) on PG and MySQL: multi-user, multi-tab (leader handoff),
  offline/online, permission change mid-session (purge), SW update path; perf
  assertions (local mutation < 16 ms, warm boot < 300 ms online and offline); RUM marks
  (`appStart`, `firstPaintFromCache`, `wsOpen`, `caughtUp`, mutation lifecycle) posted to
  `/-/sync/rum`; `localStorage.profile=1` profiler build switch; CI recipe written down in
  this file.
- **Depends on:** F7
- **Acceptance:** full e2e suite green on both DBs; perf assertions pass; budgets pass.
- **Notes/decisions:**

---

## 4. Open questions carried from PLAN §11

1. MariaDB in the matrix? `dev-db.sh start mariadb` makes it cheap to test; B2 should run
   its trigger tests against it once and record the result. **B2: done, all green on MariaDB 11.8 (see B2 notes).**
2. MySQL privileges in deployment — B2 implements both modes either way.
3. Offline PR creation stays online-only unless told otherwise.
