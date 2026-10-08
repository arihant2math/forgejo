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
* **Livesync running in a test (B3):** `livesyncStart(t, extraSettings)` resets the outbox / sync log / entity index /
  meta, runs `Init` (triggers, tailer, writer role + materializer) and cleans up; wait for entries with
  `livesyncWaitLog(t, cursor, timeout, livesyncEntry(model, id, op))` from `cursor := livesyncLogHead(t)`.
  `onApplicationRun`/`PrepareTestEnv` fixture reloads while livesync runs are materialized like any write.
* **Sync sessions in a test (B5):** `livesyncServe(t)` (or `livesyncServeWith(t, settings)`) **before**
  `onApplicationRun(t, func(t, u) {...})` — do not also call `tests.PrepareTestEnv` (onApplicationRun does; nesting fails).
  `livesyncDial(t, u, "ws"|"sse")` is a raw protocol client (`send`, `waitType`, `waitFor`, `waitChange`, `waitClosed`);
  `livesyncSettle(t)` waits until the outbox is drained and the log head is stable (take cursors after it).
* **Protocol types (B3):** after changing `services/livesync/protocol`, run `next/tools/gen-protocol.sh` (tygo
  v0.2.21, ~2 s warm) and commit `next/src/protocol/types.gen.ts`; `--check` fails when it is stale.
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
- [x] **Status** — done 2026-10-07 (final check: all `TestLivesync*` + `TestVersion` green on PG 16/`gtestschema` and MySQL 8.0 binlog on (privilege + STATEMENT-binlog tests run on MySQL); unit tests, `go vet`, gofumpt, golangci-lint (0 issues), deadcode diff clean; fork diff = `assets/go-licenses.json`, `cmd/web.go` (1 line + import), `go.mod`, `go.sum`; review rounds 1–2 closed, no open findings)
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
    `information_schema.triggers` event/timing/orientation/table/`action_statement` differ. **Correction (round 1):**
    the triggers are *not* safe under statement-based binlog (PLAN §4.3's sentence is wrong): an insert into an
    AUTO_INCREMENT column from a trigger is unsafe (`Note 1592` under STATEMENT; MIXED switches to row format), so
    `binlog_format` must be ROW or MIXED; `Inspect` adds a `Status.Warnings` entry when `@@log_bin` and STATEMENT.
    Without DEFINER the creating account becomes the definer and the triggers run with its rights (SQL SECURITY
    DEFINER): if a DBA creates them with a personal account that is later dropped, **every** write to the tracked tables
    fails (1449), livesync enabled or not. `Script()` says so and suggests `CREATE DEFINER = '<forgejo>'@'<host>'
    TRIGGER …` (from `Status.User` = `CURRENT_USER()`); `Inspect` warns when a trigger's definer differs from
    `CURRENT_USER()` (not fatal). Extra livesync triggers
    on untracked tables are state `extra`: dropped in auto mode, only warned about in verify mode (not fatal).
  - **Installer API (for B8's admin page).** `capture.Inspect(ctx) (*Status, error)` (read-only);
    `capture.Ensure(ctx, repair bool) (*Report, error)` under the B1 schema lock — repair = `INSTALL_MODE=auto`.
    `Status{Dialect, Schema, Objects []Object{Kind, Table, Name, State ok|missing|stale|extra, Detail}}`,
    `Status.Healthy()`, `Status.Statements()` (idempotent DDL from this status to healthy: drop-if-exists + create per
    broken object, function first, then drops of extras; on an empty DB = full install), `Status.Script()` (same with a
    header saying where/as whom to run it, works in psql and the mysql client). Errors: `*capture.NotInstalledError
    {Status, Cause}` (`errors.Is(err, capture.ErrNotInstalled)`; `Cause` = DDL error in auto mode, wrapped with a
    privilege hint for MySQL 1419/1142/1227 and PG 42501, or a lock hint for MySQL 1205 / PG 55P03). `Status.User`,
    `Status.Warnings` (round 1, for B8's admin page; logged at Warn by Init). PG repair DDL + epoch bumps + clearing
    `capture_pending` run in **one** transaction; MySQL DDL commits per statement (a stale trigger is dropped and
    recreated: writes in that window are lost — covered by the epoch bump, which is durable, see below). **Lock
    timeout (round 1):** every repair DDL statement waits at most `capture.DDLLockTimeout` (5 s) for table locks
    (PG `SET LOCAL lock_timeout` in the repair tx; MySQL `SET SESSION lock_wait_timeout` on a pinned connection,
    reset afterwards or the connection is discarded), so a long transaction on a tracked table cannot hang Init or
    queue every query on the tables behind a waiting `ACCESS EXCLUSIVE`; a timeout is a `NotInstalledError` (classic
    UI, retried at the next start). The DDL runs on the raw `*sql.Tx` / `*sql.Conn` (no xorm hooks: failures are
    returned and reported by Wrap, not also logged as `[Error SQL Query]`). A PG function with another return type
    (which `CREATE OR REPLACE` cannot change) is dropped with `DROP FUNCTION … CASCADE` and every trigger recreated.
  - **Schema epochs.** `livesync_meta` `schema_epoch.<tbl>` (`capture.MetaEpochPrefix`), bumped for every repaired
    table (all tables when the PG function was broken; the first install sets them all to 1). `Report.Repaired`,
    `Report.Epochs`. **Verify mode** can't repair, so a failed Ensure records the broken tables in
    `capture_pending` (`capture.MetaPending`); the next Ensure that finds them healthy (a DBA ran the DDL) bumps their
    epochs and clears it. **Durable (round 1):** auto mode also writes the tables it is about to repair to
    `capture_pending` *before* running any DDL, and clears it only in the transaction that bumps their epochs, so a
    crash or error between the DDL and the bump leaves them pending and the next Ensure bumps them (an epoch may be
    bumped twice in the worst case, never zero times). The PLAN's "reconciliation scan over `updated_unix`" is **not**
    done in B2: consumers must treat an epoch bump as "re-materialize / re-bootstrap this model". **B3 owns consuming
    the epochs** (added to B3's Scope/Acceptance in round 1); nothing reads them yet.
  - **Init order now:** settings → enabled/DB → `EnsureTables` → `CheckCatalog` → `ensureCapture` (Ensure; logs
    repaired/dropped) → `capture.Start` (reader under the instance context) → running. `Shutdown` cancels and waits
    ≤ 10 s for the reader. Any capture failure ⇒ Init error ⇒ `Wrap` returns `inner`; for a `NotInstalledError` Wrap
    logs **Warn** (operational state, not a crash; also keeps integration logs free of ERROR) plus the full DDL at Info.
    **For B8:** in that state Wrap passes through, so `/-/sync/admin` is not served; B8 must either serve the admin
    page in a degraded Wrap or keep the last `NotInstalledError` (Init returns it; `capture.Inspect` + `Script()` can be
    called any time, they only need the DB).
  - **Doorbell** (`capture/doorbell.go`, reworked in round 1). (1) **PostgreSQL: `LISTEN livesync` only** on its own
    pgx connection (`setting.DBMasterConnStr()`, outside the pool), reconnect with backoff, rings after every
    (re)connect; failures are warnings (polling covers). NOTIFY is sent at commit, once per transaction that wrote a
    tracked row, by this instance too, so no in-process observer is installed on PG. (2) **MySQL (and SQLite unit
    tests): `commitObserver`** wraps the master engine's xorm *logger* (once per engine, at Init; inert without a
    subscribed reader) and rings after `COMMIT` and any successful INSERT/UPDATE/DELETE/REPLACE not mentioning
    `livesync_` (it can't tell autocommit from in-tx). Round 0 used an xorm `contexts.Hook` that re-ran
    `db.TracingHook.BeforeProcess`, which started a second runtime/trace task per statement and left TracingHook's own
    task unended (corrupting every runtime trace once a reader started); any hook appended after TracingHook has that
    problem, so there is no hook now — details and re-check triggers in SURFACE.md. The reader's own batch commits run
    in `capture.WithQuietTx` (a tx whose session context carries a marker the observer skips; B3 can use it for its
    transaction too; fn gets a real `*db.Context`, so derived contexts stay in the tx — review round 2). (3) Polling `[livesync] POLL_INTERVAL` (default 0 = 250 ms PG / 100 ms MySQL). (4) The reader
    runs at most one cycle per `minCycleGap` (5 ms): rings that arrive meanwhile are merged, an idle reader still reacts
    at once. Measured by `TestLivesyncCaptureDoorbell` (timer started before the write, one mechanism at a time,
    polling off): PG NOTIFY only: autocommit ≈ 2 ms, COMMIT ≈ 1.2 ms, another connection ≈ 2–6 ms (incl. the test's
    id lookup); MySQL observer only: autocommit ≈ 3 ms, COMMIT ≈ 1.3–2 ms; a write from another connection on MySQL
    rings nothing (asserted) and is found by the next poll. Round 0's "1–2 ms via the hook / 0.3 ms via NOTIFY" were
    not isolated measurements (PG's hook test was also served by NOTIFY, the second timer started after delivery).
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
    if the outbox's **id counter** (PG sequence `last_value`/`is_called` via `pg_get_serial_sequence`; MySQL
    `AUTO_INCREMENT` from `SHOW CREATE TABLE`, which is live unlike `information_schema.tables`) says the last assigned
    id is below the stored cursor (table recreated / truncated), it restarts from 0 — round 0 compared `MAX(id)`, which
    missed the common case of an empty recreated outbox (every change then waited for the 5 s sweep). **Hole re-check
    (round 1):** one indexed range scan `cursor < id <= high` per cycle (none when there are no holes) instead of
    ⌈H/64⌉ OR-of-BETWEEN queries: every row in that range is a filled hole, because delivered rows are deleted before
    the reader advances and given-up ids lie at or below the cursor. The hole set is cloned only when rows are
    delivered.
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
    mode at higher write rates. Round 1 measured it: **with a LISTENer connected**, a NOTIFYing autocommit write costs
    ≈ +55–70 µs on the sandbox (≈ +85–100 % over plain Forgejo at a saturating single writer, see the benchmark); with
    LISTEN disabled (polling only) the overhead falls back to the triggers-only figure, and with LISTEN on but rings
    ignored it stays (13 vs 186 reader batches): the cost is PostgreSQL's notification delivery, not the reader's
    cycles. Negligible at ≤ 100 writes/s (< 1 % of a core); a `POLL_ONLY`/debounce switch is the knob if a deployment
    needs it (not added). (e) **Degraded state:** while livesync refuses to serve (`CheckCatalog` failure, or a
    `NotInstalledError` — e.g. verify mode after an upstream `RecreateTables` dropped one table's trigger, or a partial
    MySQL auto repair that failed midway on 1419/1142/1205), the triggers that *are* installed keep inserting into
    `livesync_change` and no reader drains it: the outbox grows until a DBA repairs and livesync starts (it then
    catches up from its cursor — the backlog is useful, so no drain-only reader runs while degraded). Wrap's Warn line
    says so. **For B8:** show this state (outbox row count) on the admin page and next to the kill switch / uninstall
    DDL from (a). (f) MySQL: run `Script()` as a durable account or with `DEFINER = <forgejo account>` (see Trigger DDL),
    and use `binlog_format` ROW or MIXED; both are reported in `Status.Warnings`.
  - **Tests.** Unit (no DB/SQLite): catalog consistency/classify; DDL text, `Statements`/`Script`/`summary` for both
    dialects (incl. the PG drop-function case, MySQL definer/binlog header), `NotInstalledError`, privilege and lock
    hints, `pokes`, doorbell coalescing, `commitObserver` (forwards only when SQL logging is on, rings on COMMIT/DML,
    not for quiet txs or errors); hole ranges incl. a randomised check against a set; reader on SQLite with explicit ids
    (holes, fill, timeout, late sweep, retry with in-tx Commit, restart from cursor, recreated outbox incl. empty with a
    reset counter, batch size, `TestReaderWakeups`: no cycle for the reader's own commit, bursts of rings merged, ≤ 1
    cycle per `minCycleGap` — verified to fail with `db.WithTx` for the reader's commit); settings. Integration, **green on PG 16 (`gtestschema`),
    MySQL 8.0 (binlog on) and MariaDB 11.8 (binlog on)**: `TestLivesyncCaptureOutbox` (I/U/D, multi-row update,
    rollback ⇒ none, outbox row visible inside the tx, nested tx commit and inner-failure rollback, untracked table ⇒
    none, API v1 label create ⇒ row), `TestLivesyncCaptureReader` (prompt delivery, long tx commits lower id after a
    higher one ⇒ delivered and cursor catches up, never-committed id ⇒ cursor moves past it after HOLE_TIMEOUT, rows
    deleted, cursor stored), `TestLivesyncCaptureDoorbell` (round 1: polling off, one mechanism at a time — PG NOTIFY
    for autocommit, COMMIT (nothing before it) and another connection; MySQL observer for autocommit and COMMIT, a raw
    write is *not* delivered without a poll, then the 100 ms poll finds one), `TestLivesyncCaptureOutboxRecreated`
    (outbox dropped + recreated empty with cursor 1 000 000 ⇒ a new write is delivered at once, sweep off),
    `TestLivesyncCaptureRepair` (dropped trigger / disabled or altered trigger / PG function replaced / PG function
    with another return type / extra trigger ⇒ re-`Init` repairs, bumps exactly those epochs, drops the extra),
    `TestLivesyncCaptureRepairDurableEpoch` (the bump fails after the DDL ⇒ table stays pending; the next Ensure bumps
    it exactly once; verified to fail on MySQL without the pre-DDL pending write), `TestLivesyncCaptureRepairLockTimeout`
    (a tx holding the table lock ⇒ Ensure gives up after `DDLLockTimeout` = 1 s with a `NotInstalledError` + lock hint,
    table pending; after rollback the repair bumps it), `TestLivesyncCaptureMySQLStatementBinlog` (Inspect warns under
    `binlog_format=STATEMENT`, not under ROW),
    `TestLivesyncCaptureVerifyMode` (missing trigger ⇒ `NotInstalledError` with the DDL, `Wrap(h)==h`, `/-/sync/health`
    404, nothing changed; DBA runs `Statements()` ⇒ verify starts and bumps that epoch), `TestLivesyncCaptureMySQLPrivileges`
    (MySQL/MariaDB as the non-SUPER `forgejo` user with binlog on ⇒ auto fails with 1419 + hint, nothing created, Wrap
    passes through; root runs the DDL ⇒ verify and auto start as `forgejo`, Inspect warns that the triggers are defined
    by root; its writes are captured; override the user
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

    i.e. ≈ 25–140 µs extra per captured row (PG: plpgsql + outbox insert + NOTIFY per tx). **These round-0 figures
    cover the triggers only** (no reader ran). Round 1 re-ran it with a third pass where an outbox reader (doorbell
    included, drain consumer) runs concurrently, as in production (µs/op: without → triggers → triggers + reader):

    | DB | autocommit INSERT | UPDATE | DELETE | INSERT ×2000 in 1 tx | reader batches for 10 000 rows |
    |---|---|---|---|---|---|
    | PG 16.15 | 84.4 → 104.2 → 156.4 (+85%) | 85.5 → 101.5 → 158.8 (+86%) | 71.9 → 84.3 → 144.5 (+101%) | 68.8 → 83.4 → 81.7 (+19%) | 186 |
    | MySQL 8.0.46 | 364 → 457 → 469 (+29%) | 406 → 513 → 539 (+33%) | 399 → 444 → 541 (+35%) | 264 → 267 → 306 (+16%) | 607 |

    (single sequential writer saturating the DB, 4 vCPU sandbox, fsync on; run-to-run noise ≈ ±15 %.) On MySQL the
    reader adds little on top of the triggers. On PG the extra ≈ 55–70 µs per autocommitted write is PostgreSQL's
    NOTIFY delivery to the connected listener, not the reader's cycles (see ops note (d)). At the §4.11 targets this is
    negligible; hot tables can later be filtered in the trigger if needed.
  - **Commands run:** gofumpt (clean), `golangci-lint run ./models/livesync/... ./services/livesync/...
    ./routers/livesync/... ./tests/integration/...` (0 issues), `go vet` (+ integration with sqlite tags), deadcode diff
    (clean), `go mod tidy -diff` (clean), unit tests above, `./integrations.pgsql.test -test.run TestLivesync` with
    `tests/pgsql.ini`, `tests/mysql.ini` and a MariaDB ini (all green, no leftover triggers afterwards), benchmark on all
    three, fork-diff check (§2.2) unchanged (`assets/go-licenses.json`, `cmd/web.go`, `go.mod`, `go.sum`); dev binary
    smoke test with `[livesync] ENABLED = true` on PG and MySQL (39 tables installed, API repo create ⇒ outbox drained,
    cursor stored, SIGTERM stops the reader); dev DBs' triggers removed again afterwards.
  - **Review round 1 (12 findings, all fixed or documented; details in the bullets above).** (1) durable epoch bump
    (pending recorded before DDL, cleared in the bump tx; PG DDL+bump in one tx); (2) doorbell load: PG relies on NOTIFY
    alone, the reader's own commit no longer rings (`WithQuietTx`), ≤ 1 cycle per 5 ms, benchmark re-run with a reader;
    (3) hole re-check = one range scan; (4) outbox restart detected from the id counter, not `MAX(id)`; (5) repair DDL
    lock timeout (5 s) ⇒ `NotInstalledError`, never a hung Init; (6) no xorm hook any more (logger observer on MySQL,
    nothing on PG): runtime traces are no longer corrupted; (7) doorbell test isolates each mechanism, numbers
    corrected; (8) PG function with another return type is dropped (CASCADE) and every trigger recreated; (9) MySQL
    definer: Script header + Inspect warning; (10) STATEMENT binlog claim corrected (also wrong in PLAN §4.3, left
    as is there) + Inspect warning; (11) degraded-state outbox growth documented (ops note (e)) and logged by Wrap;
    (12) epoch consumption / reconciliation handed to B3 (Scope + Acceptance) and B5 (`bootstrap_required`).
    Nothing was rejected. Not done, by choice: a drain-only reader while degraded (the backlog is what lets livesync
    catch up after the repair), a PG poll-only switch (measured, documented as the knob). Commands: gofumpt, golangci-lint
    (0 issues), `go vet`, deadcode diff (clean; `holes.contains/ranges` moved to the test file), unit tests,
    `TestLivesync*` green on PG 16 (`gtestschema`), MySQL 8.0 (binlog on) and MariaDB 11.8 (binlog on), benchmark on PG
    and MySQL.
  - **Review round 2 (1 finding, fixed).** `WithQuietTx` handed fn a home-made `txContext` that was a `db.Engined`
    only by type assertion on the context itself; `*db.Context` also answers `Value(enginedContextKey)`, so any
    context derived from fn's (`cache.WithCacheContext`, `WithTimeout`, `WithValue`) silently fell back to the default
    engine, outside the tx (writes on other connections, not atomic with `Batch.Commit`/cursor; on MySQL blocking on
    the tx's row locks), and `db.AfterTx` ran hooks at once, before the commit. The reviewer's suggested fix (a helper
    in `models/db` returning `newContext(ctx, sess, true)`) was built first and then reverted: `models/db` is upstream
    code and §2.2 forbids editing it. Instead, using only public API: `WithQuietTx` begins the tx on its own quiet
    session (the marker must be on the session context before BEGIN, the COMMIT runs under it), then calls
    `db.TxContext(sessionContext{quiet, sess})`, which reuses the transaction it finds in its parent and returns a real
    `*db.Context` over `sess` plus a half committer; fn runs with that context, then `sess.Commit()`, then the half
    committer's `Commit()`, which hands the AfterTx hooks to the (non-tx) parent, i.e. runs them after the commit; on
    error its `Close()` rolls back and the hooks are dropped. This leans on `TxContext`'s documented reuse/half-commit
    behaviour; `TestWithQuietTx` (SQLite unit: derived contexts incl. `cache.WithCacheContext`/timeout/value see
    `InTransaction`, the same session and `MasterEngine`, stay quiet, roll back, AfterTx after commit / dropped on
    rollback, nesting both ways) and `TestLivesyncCaptureQuietTx` (PG + MySQL: writes through derived contexts invisible
    to other connections until commit, rolled back on error, AfterTx sees the committed row) pin it; both fail on the
    round-1 code. Caveat that stays (upstream behaviour, same as `db.WithTx`): `db.AfterTx` only recognises the
    `*db.Context` itself, so register hooks on the ctx fn receives, not on a derived one. Commands: gofumpt,
    golangci-lint (0 issues), `go vet`, unit tests, `TestLivesync*` green on PG 16 (`gtestschema`) and MySQL 8.0;
    fork-diff check unchanged.

#### B3 — Materializer, sync log, protocol DTOs
- [x] **Status** — done 2026-10-07 (final check: all `TestLivesync*` + `TestVersion` green on PG 16/`gtestschema` (23 pass, 3 MySQL-only skips) and MySQL 8.0 binlog on (25 pass, 1 skip), incl. the 7 B3 materialize/synclog tests; unit tests, `go vet`, gofumpt, golangci-lint (0 issues), deadcode diff clean; `gen-protocol.sh --check` up to date; fork diff = `assets/go-licenses.json`, `cmd/web.go` (1 line + import), `go.mod`, `go.sum`; review round 1 closed, no open findings — the cross-reference placement is an open design issue handed to B5/B6, see notes)
- **Scope:** `services/livesync/protocol`: entity DTO structs (normalized, IDs for refs,
  API v1 field names) for every tracked model + group naming (`user:`, `org:`, `repo:`,
  `issue:`) + required unit. TS generation: `next/tools/gen-protocol.sh` running
  `go run github.com/gzuidhof/tygo@v0.2.21` (config in `next/tools/tygo.yaml`) →
  `next/src/protocol/types.gen.ts`, with `--check` mode. `services/livesync/materialize`:
  coalesce by `(tbl,row_id)`, load via typed models, build viewer-independent DTOs (bodies
  rendered via the markup service; verify viewer-independence and record findings),
  maintain `livesync_entity` (group for deletes), hot-table coalescing. **Schema epochs (from B2 review):** the
  materializer consumes `livesync_meta` `schema_epoch.<tbl>` (B2 bumps it whenever a table's trigger was missing or
  stale, i.e. changes may have been lost): it remembers the last epoch it handled per table and, when one moved,
  re-materializes that table's entities (reconciliation scan, e.g. over `updated_unix` where the table has it, else
  all rows of the affected groups) or appends a per-model "re-bootstrap" marker to the log that B5 turns into
  `bootstrap_required`; record which. Run its transaction with `capture.WithQuietTx` so its COMMIT does not wake the
  reader again on MySQL (its ctx is a real `*db.Context`: derived contexts stay in the tx; register `db.AfterTx`
  hooks on the ctx it passes, not on a derived one). `synclog`: single
  writer assigns gap-free `sync_id`, append, `ReadSince(group, cursor, limit)`, retention
  (days / max rows) with "oldest available" watermark, lease (PG advisory lock / MySQL
  `GET_LOCK`), tailer interface that the hub will consume. Delete processed outbox rows.
- **Depends on:** B2
- **Acceptance (both DBs):** API v1 write (create issue, add label, comment, delete
  comment) ⇒ log entries with the expected group/model/op/payload; delete carries the
  right group from `livesync_entity`; `sync_id` strictly increasing and gap-free under
  concurrent writers; second instance cannot take the lease; retention trims and reports
  the oldest cursor; `gen-protocol.sh --check` passes; unit tests for coalescing; a bumped
  `schema_epoch.<tbl>` (drop a trigger, write, re-`Init`) ⇒ the write made while the trigger was missing reaches
  the log (reconciliation) or the model is marked for re-bootstrap, and the epoch is recorded as handled.
- **Notes/decisions:**
  - **Files.** `services/livesync/protocol/{protocol,entities}.go` (models, per-model schema versions, ops, groups,
    units, 40 DTOs); `next/tools/{gen-protocol.sh,tygo.yaml}` → `next/src/protocol/types.gen.ts` (generated, committed);
    `services/livesync/synclog/{writer,read,retention,tailer}.go` (+ SQLite unit tests);
    `services/livesync/materialize/{materializer,coalesce,load,specs,specs_render,render,index,epochs,backfill}.go`
    (+ SQLite unit tests over Forgejo's fixtures); `services/livesync/writer.go` (writer role) and Init/settings changes;
    `models/livesync`: `Lease`/`TryLease`/`ErrLeaseHeld` (lock.go), `InsertMetaIfAbsent` (sync.go), new columns;
    `capture`: `Batch.Defer`, exported `Listen` and `CurrentSchema`; `tests/integration/livesync_{materialize,synclog}_test.go`
    + helpers (`livesyncStart`, `livesyncLogHead/LogSince/WaitLog/Entry`; `livesyncResetCapture` now also empties
    `livesync_log`/`livesync_entity` and every `livesync_meta` row but `tables_version`). `drainConsumer` is gone.
  - **Table changes** (Sync adds them; no rows existed, `TablesVersion` stays 1): `livesync_log.unit` VARCHAR(32);
    `livesync_entity.unit` VARCHAR(32) and `.hash` VARCHAR(16) (fnv-64a hex of the last payload). `livesync_entity.tbl` is
    the *entity key*: the table for a row's main entity, `"<table>#<suffix>"` for a derived one (`issue#body`).
  - **Protocol (for B5/B6/F2).** Groups `user:{id}`/`org:{id}`/`repo:{id}`/`issue:{id}` (`protocol.UserGroup` …) plus
    the pseudo group **`protocol.GroupAll = "*"`**: entries every reader gets (`synclog.ReadSince(group)` always includes
    them) — **only `B` markers** (no entity data; review round 1 removed the unknown-group deletes). Log ops
    (`protocol.Op`): `U` upsert (payload = full DTO JSON, not HTML-escaped), `D` delete (no payload), **`B` re-bootstrap
    marker** (GroupAll, entity id 0, payload `RebootstrapMarker{table, epoch}`). `livesync_log.unit` = required unit
    (`protocol.Unit`): in `repo:`/`issue:` a repository unit (`""` any access, `code`, `issues`, `pulls`, `issues|pulls` =
    either, `releases`, `projects`, `actions`; same names as `RepoUnit.type`/`TeamUnit.type`); **in `user:{id}`: `""`
    = anyone who may see the user, `self` = that user only; in `org:{id}`: `""` = anyone who may see the org, `members` =
    its members only** (round 1). `schema_ver` = `protocol.Schema<Model>` (all 1).
    DTO conventions: API v1 snake_case names, refs as ids, times RFC 3339 UTC (`time.Time`, optional ones omitted).
    **Placement** (all in `materialize/specs*.go`, round 1 changes in bold): Repository, RepoUnit, Collaboration →
    `repo:{id}` unit none; User → `user:{id}` unit none (`org:{id}` for orgs; public profile only, no email/admin/active
    flags, pronouns only if not private); **OrgUser → `org:{org_id}` unit none if public, `members` if concealed;
    Team/TeamUser/TeamRepo/TeamUnit → `org:{org_id}` `members`**; Access, Notification, Stopwatch, IssueWatch, Watch,
    Star, BlockedUser, **ReviewState** (viewed files are per user, PLAN §4.4) → `user:{user_id}` **unit `self`**; Label →
    `repo:` unit `issues|pulls` (org labels → `org:` unit none); Milestone → `repo:` `issues|pulls`; Project/ProjectColumn
    → the project's repo (unit `projects`) or owner (`org:`/`user:` unit none); **ProjectIssue → the issue's
    `repo:{repo_id}` unit `issues`/`pulls`** (a user/org project can hold issues of private repositories its readers
    cannot see); Issue, IssueLabel, IssueAssignee → `repo:{issue.repo_id}` unit `issues`/`pulls` by `is_pull`;
    **IssueBody** (body + body_html, derived from the issue row, same id) → `issue:{id}`; PullRequest, AutoMerge →
    `repo:{base_repo_id}` `pulls`; Branch, CommitStatus → `code`; Release → `releases`, **a draft release → no group**
    (upstream: writers only); ActionRun/Job → `actions`; Comment, Review (`pulls`), IssueDependency, TrackedTime →
    `issue:{issue_id}`, **except a pending Review and the code comments of a pending review → `user:{reviewer_id}`
    `self`** (upstream: the reviewer only), **and a cross-reference Comment from another repository (`IssueRef`/
    `CommentRef`/`PullRef` with `ref_repo_id` ≠ the issue's repo) → no group**; **Reaction, ContentHistory → the
    comment's place when `comment_id` ≠ 0**, else `issue:{issue_id}`; Attachment → **the release's place** (draft: none),
    **the comment's place**, else `issue:`; unattached ones nowhere. A row whose group **or unit** changes gets `D` in
    the old group/unit + `U` in the new one (round 1: unit changes too, e.g. a membership concealed). **Dependents**
    (`spec.dependents`, round 1): when a row's main entity changes group (incl. entering or leaving every group), the
    rows whose place derives from it are materialized again in the same transaction (review → its comments; comment →
    attachments, reactions, revisions; release → attachments), since their own rows do not change on submit/publish
    (`SubmitReview` only updates the review row). **For B4/B6:** grant `user:{id}` unit none to whoever may see the
    user and `self` to the user only; `org:{id}` unit none to whoever may see the org, `members` to members only. A
    pending review's draft stays in the reviewer's `self` even if they lose access to the repository (their own text and
    the diff hunk they commented on).
  - **TS generation.** `next/tools/gen-protocol.sh [--check]` runs `go run github.com/gzuidhof/tygo@v0.2.21` with
    `GOTOOLCHAIN` = go.mod's toolchain (tygo loads this module), writes to a temp file, then copies (or diffs for
    `--check`, exit 1 when stale). Go doc comments become TSDoc. Const blocks have their comment detached by a blank
    line (tygo otherwise repeats a block comment on every constant). `time.Time` → `string`, `map[string]any` →
    `{ [key: string]: any}`. B5 adds its message types to the same package and re-runs the script.
  - **Sync log (`synclog`).** `AcquireWriter(ctx, wake) (*Writer, error)` = `models/livesync.TryLease("livesync.writer")`
    (`pg_try_advisory_lock` / `GET_LOCK(…, 0)` on a pinned connection; `ErrWriterHeld` otherwise) + **fencing token**
    (`livesync_meta.log_writer`, incremented on every acquisition). `Writer.Append(txCtx, entries) (first int64, err)`
    must run in the caller's transaction and is called in **every** writer transaction (also with no entries): it locks
    `log_head` + `log_writer` with `SELECT … ORDER BY name FOR UPDATE` (without ORDER BY PostgreSQL locks in physical
    order and concurrent appends deadlocked — found by the concurrency test), returns `ErrNotWriter` if the token moved,
    assigns `head+1…` (gap-free, strictly increasing in commit order since the head row stays locked), inserts in chunks
    of 100, updates the head, `pg_notify('livesync_log', current_schema())` on PG and `db.AfterTx(wake)`. `Check` pings
    the lease connection; `Release`. `Head`, `Floor`, `ReadSince(ctx, group, cursor, limit)` (group `""` = all; entries
    of group + GroupAll, ascending; `*TrimmedError{Cursor, Floor}` / `ErrTrimmed` when `cursor < floor` — the floor is
    read *after* the entries, so a concurrent trim can never hide a gap), `Trim(ctx, maxAge, maxRows) (floor, error)`
    (chunks of 5000, each chunk's DELETE and the `log_floor` move in one tx; floor = "oldest cursor still served").
    **Round 1: `Trim` is a `Writer` method**: every chunk transaction is fenced (`Append(ctx, nil)` ⇒ `ErrNotWriter` for
    a writer that lost its lease; the writer role then steps down) and moves the floor only up (`log_floor` read with
    `FOR UPDATE`, a higher value stays), so overlapping trims of an old and a new writer cannot move the floor back and
    make `ReadSince` serve a silent gap (`TestTrimFencing`).
    **Tailer** (every instance; invariant 2 = writer and tailer split): `StartTailer(ctx, cfg, sink)` from the current
    head, woken by the local writer (AfterTx), by `LISTEN livesync_log` on PG (via `capture.Listen`, one more pgx
    connection per instance) and by polling (`POLL_INTERVAL`, default 250 ms PG / 100 ms MySQL); hands ordered batches
    to `Sink.Deliver(ctx, []LogEntry)`; skips ahead to the floor with a warning if it ever fell behind retention.
    **B5: implement `synclog.Sink` in the hub and replace `logSink` (services/livesync/writer.go) in Init.**
  - **Writer role** (`services/livesync/writer.go`, started by Init on every instance): loop { `AcquireWriter`; on
    success `materialize.New` + `Prepare` (backfill state, epochs) + `capture.Start(reader, materializer)`; then every
    2 s `Check` the lease, every 5 s `HandleEpochs`, retention at once and every 10 min, backfill steps every 10 ms until
    done; on lease loss / `ErrNotWriter` (the materializer calls `stop`) / shutdown: stop the reader (wait ≤ 10 s),
    release; otherwise retry every 2 s }. So **only the lease holder runs the outbox reader** (B2's open point), and a
    writer that lost its lease without noticing is fenced by the token. Shutdown waits for the writer goroutine and the
    tailer (≤ 10 s each). Writer transactions run on `context.WithoutCancel` (≤ 1 min): cancelling mid-transaction made
    database/sql roll back under running statements and xorm log `[Error SQL Query] ROLLBACK` at every shutdown.
  - **Materializer.** `Consume` (capture.Consumer): coalesce by (table, row) in first-appearance order; untracked tables
    are acknowledged; hot rows rate-limited (below); then **one quiet transaction** (`capture.WithQuietTx`): load the
    rows per table with `In("id", …)` through the typed models (parents — issues, repos, projects, pulls — cached per
    batch), build DTOs, read the entity index, decide per entity: gone/no group + indexed → `D` in the indexed
    group/unit and unindex; new or changed → `U` (+ `D` in the old group if it moved) and upsert the index with the new
    hash/sync id; **same group, unit and payload hash → nothing** (no-op updates such as fixture reloads or touched
    timestamps that the DTO does not carry produce no entry); `Writer.Append`; index writes (multi-row upserts);
    **`Batch.Commit` in the same transaction** (log append + outbox delete + capture cursor atomic, B2's open point). A
    row whose DTO cannot be built is logged at Error and skipped (one bad row must not stall the log); DB errors make the
    reader retry the batch. **Hot tables** (`notification`, `commit_status`, `action_run_job`): a row materialized less
    than `HOT_COALESCE` (default 1 s) ago is deferred with the new `capture.Batch.Defer(id, until)` — its newest outbox
    row stays in the outbox (the others are deleted), the reader skips it until due (the hole re-check and the sweep now
    page by id and filter deferred rows; the sweep also runs when a deferred row is due) and delivers it again: at most
    one entry per hot row per second, latest state, first change after a quiet period immediate, nothing lost on restart
    (the sweep finds deferred rows).
  - **Markdown / viewer-independence (PLAN §4.4 check, findings).** `body_html` of IssueBody, Comment, Review and
    Release is rendered by `markdown.RenderString` with the repository's metas and links (as the issue page) but with the
    materializer's context, which is not an `*app_context.Context`, so `services/markup.ProcessorHelper` treats it as
    **anonymous**: @mentions link public users only (limited/private users are plain text for every reader — a safe
    subset of the classic UI), permalink code previews show public repositories' code only (never private code; also
    not the issue's own private repo), issue refs / SHAs / team mentions depend only on the repository; the
    "(comment)" suffix of comment links is English (no locale). Result: viewer-independent, so rendering once is fine;
    **no per-request rendering needed**. Each repository's git repo is opened once per batch for SHA checks (and when
    it is missing on disk, `repoPath` is dropped from the metas, so SHAs stay plain text instead of upstream logging
    "unable to open repository" per SHA — this happened in tests whose fixture reloads were materialized).
    Milestone/Project/Label descriptions are raw only. **Correction (review round 1):** "viewer-independent, no
    per-request rendering needed" holds for the *markdown* only. Whether a reader may receive an entity at all is
    decided by its placement, and three kinds of rows were placed too widely in round 0 (pending reviews with their
    draft comments and attachments, draft releases with their attachments, cross-references from other repositories);
    they now have non-shared placements (above). **Open issue for B5/B6 (cross-references):** upstream shows a
    cross-reference comment from repository P on issue X only to viewers who can read X *and* P's issues/pulls
    (`filterXRefComments`); one group + one unit cannot express two conditions, so these comments are **not published**
    (no group) and the Next timeline misses them for now. Suggested fix when B5/B6 exist: an optional second requirement
    on log entries (e.g. `livesync_log.also_grp/also_unit` = `repo:{P}`/`issues|pulls`, checked by the hub per delivery
    and by the issue bootstrap per viewer), or serve them per viewer from the bootstrap/an on-demand endpoint.
    **Rendering cost (round 1):** the entity index hash of a DTO with markdown is the hash of the payload *without* the
    rendered HTML plus the rendering environment (repository link + markup metas), so markdown is rendered only when the
    source or environment changed (`entity.changeHash`/`payload`, `loader.markdown`): posting a comment no longer
    re-renders the unchanged issue body (`TestConsumeRenderSkip`). External inputs of the HTML (a mentioned user's
    visibility, a referenced commit appearing) are picked up at the next change of the source, as before. **Payloads
    are encoded without HTML escaping** (`materialize.marshal`: `SetEscapeHTML(false)`; round 0 wrote `\u003c` for every
    `<`). **Avatars (round 1):** `User.AvatarLink` generates/stores a random avatar and UPDATEs the user row in
    local-avatar mode (OFFLINE_MODE default) and federated avatars write `email_hash`; `userAvatarLink` uses the fast link
    `/user/avatar/{name}/0` in those cases (the redirect does the work in its own web request) and `repoAvatarLink` gives
    no avatar for a repository without one under `AVATAR_FALLBACK = random`, so DTO building has no side effects.
  - **Schema epochs — decision: re-bootstrap markers, no reconciliation scan.** A scan over `updated_unix` would miss
    deletes and the many writes that do not touch `updated_unix` (counters, `NoAutoTime`, tables without the column), so
    it cannot make the log correct; the hash makes a full rescan cheap in log entries but not in DB work. Instead
    `HandleEpochs` (at `Prepare` and every 5 s, so bumps by another instance's start are seen) compares
    `schema_epoch.<tbl>` with `materialized_epoch.<tbl>` (`materialize.MetaHandledEpochPrefix`): for every table that
    differs it appends one `B` marker per model of the table (`issue` → Issue + IssueBody) to GroupAll, restarts that
    table's index backfill **in repair mode** (`entity_backfill.<tbl>` = `repair:0`; round 1) and records the epoch as
    handled, in one writer transaction. The repair walk overwrites every index row's group and unit with the row's
    current ones and clears its hash (`indexRepair`, `last_sync_id` kept), so a move or a change lost while the trigger
    was missing can neither misroute a later delete nor make a later change look unchanged (`TestEpochRepairsIndex`).
    During the walk the old index still routes; that reaches nobody who keeps it, because every client holding the
    table's models re-bootstraps after the marker and bootstraps wait for the walk (B6 gate below). A table with **no** handled
    epoch yet (first start, newly tracked table) is recorded without a marker (bootstraps read tables directly; no client
    can hold its entities from the log). **For B5:** a `B` entry ⇒ `bootstrap_required{group, reason}` for every
    subscribed group that can contain that model (by group kind) for clients whose cursor is below the marker.
  - **Entity index backfill** (deletes of rows that existed before livesync was installed have no index row and
    could not be routed). `BackfillStep` walks each tracked table by id (500 rows per writer transaction, group/unit
    only, `ON CONFLICT DO NOTHING` / `ON DUPLICATE KEY UPDATE tbl = tbl` so it never overwrites the materializer's newer
    rows), progress in `entity_backfill.<tbl>` (last id, `repair:<id>`, or `done`; `materialize.MetaBackfillPrefix`),
    serialised with `Consume` by the materializer's mutex. **A delete of an unindexed row is emitted nowhere** (round 1;
    round 0 wrote it to GroupAll while the table's backfill was incomplete, which broadcast ids of deleted private rows to
    every connection for the whole initial backfill and after every repair — against PLAN §4.4 "exactly one group", §4.5
    "nothing is broadcast instance-wide", §4.11 invariant 3 — and still lost deletes committed before the walk but
    consumed after it, review finding 7). **Constraint for B6 (the bootstrap gate): a bootstrap of a model must wait (or
    answer "retry later") until its table's `entity_backfill.<tbl>` is `done`.** Then no client can hold an unindexed
    row: the walk indexes every row that existed when it passed, later inserts are indexed by the materializer, and a
    row deleted before the walk reached it is in no bootstrap made after `done`. After a marker the value is
    `repair:0` again, so re-bootstraps wait for the repair walk too. Cost: ≈ rows/500 transactions per table, 10 ms
    apart, in the background (a 1M-row table ≈ 1–2 min); the Next UI's first bootstrap after installing livesync waits
    for it. **Also for B6** (independent of the backfill): a bootstrap's watermark must not be ahead of what the
    materializer has consumed (a row inserted and deleted around the snapshot would otherwise stay in the client): take
    the snapshot, then wait until the capture cursor passes the outbox ids committed before it (or a `barrier`) before
    handing out the watermark.
  - **Settings added:** `LOG_RETENTION` (default 720h, 0 = no age limit), `LOG_MAX_ROWS` (default 1 000 000, 0 = no
    row limit), `HOT_COALESCE` (default 1s, 0 = off). `POLL_INTERVAL` now also drives the tailer.
  - **livesync_meta names now:** `tables_version`, `capture_cursor`, `capture_pending`, `schema_epoch.*` (B1/B2);
    `log_head`, `log_writer`, `log_floor` (synclog), `materialized_epoch.*`, `entity_backfill.*` (materialize).
  - **Review round 1 (12 findings: 11 fixed, 1 (cross-references) fixed by not publishing + recorded as open
    issue for B5/B6).** (1) pending reviews + their code comments + attachments → `user:{reviewer}` `self`, moved to
    `issue:{id}` on submit via dependents; (2) draft releases + attachments → no group until published; (3) cross-repo
    reference comments → no group (open issue above); (4) units `self`/`members` split `user:`/`org:` groups into public
    and private parts (ProjectIssue moved to the issue's repo group, found while fixing this); (5) epoch marker ⇒ repair
    backfill (group/unit overwritten, hash cleared); (6)+(7) no GroupAll deletes; B6 bootstrap gate on the backfill
    (finding 7's sequence needs a bootstrap before the table's backfill is done, which the gate forbids; its suggested
    high-water mark is therefore not needed); (8) fenced, monotonic `Trim`; (9) markdown rendered only when source or
    environment changed; (10) ContentHistory DTO without `content_text` (on-demand tier: metadata only, text fetched on
    request — B6/B7 provide the endpoint); (11) payloads without HTML escaping; (12) avatar links without side effects.
    Tests added: `TestConsumePlacement`, `TestConsumeRenderSkip`, `TestEpochRepairsIndex`, `TestUserAvatarWithoutSideEffects`,
    `TestTrimFencing`, integration `TestLivesyncMaterializeDrafts` (API v1: pending review with a code comment → `user:1`
    `self`, nothing about it elsewhere; submit → `D` there + `U` in `issue:3` for review and comment; draft release → no
    entry and its title nowhere in the log; publish → `U` in `repo:1` `releases`); `TestConsume`/`TestLoadFixtures`/
    `TestHandleEpochs` updated (no GroupAll delete; a comment entering a group brings its attachments/reactions; no
    `\u003c` and no `content_text` in any fixture payload; `repair:0`). Commands: gofumpt, golangci-lint (0 issues),
    `go vet` (+ integration with sqlite tags), deadcode diff (clean), unit tests (`-race` for materialize/synclog),
    `gen-protocol.sh --check`, `TestLivesync*|TestVersion` green on PG 16 (`gtestschema`, 4 full runs) and MySQL 8.0 (2
    full runs), the drafts test 3× on each; fork diff unchanged. One full PG run printed a testlogger "FATAL ERROR"
    (a `log.Error`) inside `TestLivesyncCaptureRepair` (the test passed); it did not recur in 3 more full runs and 5 runs
    of the capture tests, and the line was not captured — watch for it.
  - **Not done / for later.** No `Head()` on the tailer and no sync id in `/-/sync/health` (kept free of activity
    information); B5 adds what it needs. Per-row DTO errors are skipped, but a row that fails to *load* (xorm conversion
    error) still makes the batch retry. The cross-reference open issue above. B4 hooks permission epochs into the materializer
    (no hook point added: it would be dead code now). MariaDB not re-run for B3 (B2 covered the triggers there).
  - **Tests.** Unit (no DB / SQLite with fixtures): `TestCoalesce`, `TestHotLimiter`, `TestSpecsCoverCatalog` (a spec per
    tracked table, catalog model names = protocol names), `TestLoadFixtures` (all 39 tables' fixture rows load, place
    and encode, with and without DTOs), `TestConsume` (entries/groups/units/payloads incl. rendered HTML, batch
    acknowledged in the tx, index rows, hash dedupe, delete routed by the index, unknown delete → GroupAll until the
    backfill is complete, group move = D + U), `TestConsumeHot`, `TestConsumeFencing` (ErrNotWriter ⇒ stop, batch not
    acknowledged), `TestHandleEpochs`, `TestBackfill`; `synclog`: `TestAppendAndReadSince`, `TestWriterFencing`, `TestTrim`,
    `TestTailer`, `TestTrimFencing`; `capture`: `TestReaderDefer` (deferred rows below/above the cursor), `TestReaderHoles` made robust (it
    read the stored cursor before the reader's commit; flaked under `-race` already on B2's code); settings. Integration,
    **green on PG 16 (`gtestschema`) and MySQL 8.0**: `TestLivesyncMaterializeAPI` (API v1 create issue → Issue in
    `repo:1`/issues + IssueBody in `issue:N` with body_html; add label → IssueLabel + Label; comment → Comment with
    body_html + Issue comments=1; delete comment → `D` in `issue:N` from the index, index row removed; gap-free;
    outbox drained), `TestLivesyncMaterializeConcurrentWriters` (8 goroutines × 15 label writes, some insert+update
    in one tx ⇒ exactly one entry per label, ids gap-free), `TestLivesyncMaterializeEpoch` (drop label trigger, write,
    re-Init ⇒ epoch 2, `B` marker for Label only, handled = 2, the lost write not in the log, backfill restarted,
    capture works again), `TestLivesyncSyncLogLease` (running instance holds the lease ⇒ `ErrWriterHeld`; released at
    shutdown; killing the lease session (`pg_terminate_backend` / `KILL`) ⇒ `Check` fails, another writer takes over,
    the old one gets `ErrNotWriter`), `TestLivesyncSyncLogConcurrentAppend` (8 × 25 concurrent transactions of 2
    entries, every 5th rolled back ⇒ ids 1…320 gap-free, a transaction's entries consecutive), `TestLivesyncSyncLogRetention`
    (age and row limits, floor reported, `TrimmedError`). All B1/B2 `TestLivesync*` still green (the materializer now
    consumes the fixture reloads `onApplicationRun` does while livesync runs).
  - **Commands run:** gofumpt (clean), `golangci-lint run ./models/livesync/... ./services/livesync/... ./routers/livesync/...
    ./tests/integration/...` (0 issues), `go vet` (+ integration with sqlite tags), deadcode diff (clean), unit tests
    (`-race` for capture/synclog/materialize), `next/tools/gen-protocol.sh --check` (up to date), `./integrations.pgsql.test
    -test.run 'TestLivesync|TestVersion|TestNodeinfo'` with `tests/pgsql.ini` and `tests/mysql.ini` (all green),
    fork-diff check unchanged (`assets/go-licenses.json`, `cmd/web.go`, `go.mod`, `go.sum`; tygo runs via `go run
    …@version` and adds nothing to go.mod); dev binary smoke test on PG and MySQL with `ENABLED = true` (repo + issue
    via API ⇒ Repository, RepoUnit×8, User, Watch, Issue, IssueBody entries with a rendered @mention and #ref, outbox
    empty, backfill done, writer token 1); dev DBs' triggers removed again afterwards.

#### B4 — Permissions
- [x] **Status** — done 2026-10-07 (final check: `TestLivesyncPerm*` (differential, epochs, auth, lost changes) + `TestLivesyncCaptureOutbox*` + `TestVersion` green on PG 16/`gtestschema` and MySQL 8.0 binlog on, no testlogger "FATAL ERROR"; livesync unit tests green; `gen-protocol.sh --check` up to date; fork diff = `assets/go-licenses.json`, `cmd/web.go` (1 line + import), `go.mod`, `go.sum`; review rounds 1–2 fixed; round 3 (the open major item: MySQL permission-column triggers vs. upstream migrations) fixed — capture triggers reference only `id` again on every dialect, undone permission changes are caught by materializer touches, see *Review round 3*; round 4 (touches detached every running grant computation) fixed, see *Review round 4*; round 5 (per-call touch copies made `Invalidate` O(running × touched rows) under the cache mutex) fixed, see *Review round 5*; no open items)
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
  - **Files.** `services/livesync/perm/{units,grants,cache,basis,touches}.go` (+ SQLite unit tests `perm_test.go`, `basis_test.go`, `main_test.go`);
    `services/livesync/materialize/perm.go` (permission states / epochs) + changes in `materializer.go`, `specs.go`,
    `specs_render.go`, `load.go`, `index.go`, `backfill.go`, `epochs.go` (+ `perm_test.go`); `services/livesync/perms.go`
    (`permSink`, `Permissions()`), `settings.go` (`PERM_CACHE_TTL`), `livesync.go`, `writer.go`; `synclog/tailer.go`
    (`Sink.Skipped`); `protocol/{protocol,entities}.go` (+ regenerated `next/src/protocol/types.gen.ts`);
    `models/livesync/tables.go` (`livesync_entity.perm`); `routers/livesync/{auth,grants}.go` (+ `auth_test.go`),
    `routes.go`; `tests/integration/livesync_perm_test.go`, helpers `livesyncServe`, `livesyncToken`,
    `livesyncWaitBackfill` in `livesync_helpers_test.go`.
  - **Public profiles (orchestrator note from B3) — decision: shared visibility directories + a per-user profile group;
    `user:{id}` is granted to that user only.** New groups: **`profiles:public`** (the User entity of every individual user
    with visibility public; granted to every signed-in viewer, restricted ones included, as upstream), **`profiles:limited`**
    (visibility limited; every signed-in viewer who is not restricted) and **`profile:{id}`** (a *private* user's User entity,
    plus the projects (and columns) any user owns; readable as API v1's `GET /users/{name}` decides). Organizations' User
    entities stay in `org:{id}`. Changing a user's visibility moves the entity (`D` in the old group, `U` in the new one,
    B3's move logic). `user:{id}` now holds only `self` entries (the `self` unit is kept as defence in depth). Why
    directories and not one group per user: a client needs the names/avatars of hundreds of users; per-user groups would mean
    one subscription and one bootstrap request per person (and per-connection hub memory O(people)), while the directories
    are two subscriptions and two bootstraps, the payloads are viewer-independent and fan-out stays O(subscribers of that
    group). They are not "broadcasts" in the §4.5 sense: only clients that subscribe get them, and the content is what every
    signed-in viewer may see anyway. Cost: the directory bootstrap is ≈ 300 B × users (1k users ≈ 300 KB, fine at the §4.11
    targets; at 100k users it should be partitioned or made lazy — protocol-compatible, group names are opaque). Profile
    changes are rare (the DTO has no last-login field, the hash dedupe drops no-op updates).
  - **Profile visibility = API v1, not the web page.** API v1's `individualPermsChecker` shows a private user's profile only
    to themselves and site administrators (then `IsUserVisibleToViewer`: limited ⇒ not for restricted viewers); the web
    profile page is more lenient (followers and organization co-members of a private user see it). Livesync takes the
    stricter API rule (`perm.profileVisible`), found by the differential test. Consequence: follows and team co-membership
    never decide profile visibility, so `follow` stays untracked. Blocked users: upstream blocking hides nothing from
    reading; its effects on access (collaborations removed by `BlockUser`) are epochs of those rows, and a block itself is
    an epoch for both users. **Known gap:** a restricted user whose own visibility is limited cannot read
    `profiles:limited`, so their own User entity does not reach them (upstream shows it to them); B5 may put the viewer's
    profile into `welcome`.
  - **`services/livesync/perm` API (for B5/B6).** `perm.NewCache(ttl, size)`; one per running instance:
    **`livesync_service.Permissions() *perm.Cache`** (nil when stopped). `Cache.Grants(ctx, viewerID) (*Grants, error)` —
    implicit grants: `user:{me}` {self}, `profile:{me}`, `profiles:public`, `profiles:limited` (not restricted),
    `org:{o}` {members} for every `org_user` membership, `repo:{r}` with its readable units for every repository the
    viewer owns, collaborates on, has an `access` row for or reaches through a team (`team_repo` or an
    includes-all-repositories team), each decided by `GetUserRepoPermission` (`HasAccess`, `CanRead` per unit). **Site
    administrators get no implicit groups** beyond their own relations. `Grants.Units(group)`, `Grants.Wire()`
    (`protocol.Grants`). `Cache.Check(ctx, viewerID, group) (Decision, ok, error)` — on-demand check of any group (public
    repositories, visible organizations, profiles, `issue:{id}`; uses the cached grants when the group is one of them):
    `repo:` = `GetUserRepoPermission`+`HasAccess`; `issue:` = the repository's check plus `issues`/`pulls` readable for that
    issue; `org:` = `HasOrgOrUserVisible`, unit `members` for members **and site administrators** (API v1
    `reqOrgMembership`); `profile:` = `profileVisible`; pseudo groups (`*`, `!perm`) and malformed names are never granted.
    `Decision{Units, RepoID}` (`RepoID` = the repository a `repo:`/`issue:` decision came from, so the hub can index
    subscriptions for re-checks). `perm.UnitSet` (bit mask; `Allows(entry unit)` handles `""`, `"a|b"`, unknown names ⇒
    never), `perm.Mask`, `perm.UnitOf` (moved from materialize's `unitName`). Viewers who may not sign in (inactive, login
    prohibited, organizations, missing) get nothing. The cache is keyed by viewer id, loads the viewer row itself, computes a
    viewer at most once at a time (waiters share the result), is bounded (LRU, `DefaultCacheSize` 10 000) and expires entries
    after `[livesync] PERM_CACHE_TTL` (default 10 min; safety net only). **Review round 1:** an invalidation *detaches* the
    running computations it may concern (users named; for repos/owners every running one, decided when it finishes), so a
    caller after the epoch (B5 re-checking a viewer) never joins a computation that read the data before the change; such a
    computation is cached only if none of the (≤ 64, else not cached) invalidations it overlapped concerns its result
    (round 4: touches do not detach and are not counted, see *Review round 4* of B4; round 5: they are kept once per cache
    in a touch journal, see *Review round 5*). A
    computation runs in its own goroutine on `context.WithoutCancel` (≤ 1 min): a cancelled request stops waiting but does
    not fail the others. Grants and checks run in one quiet read transaction on the **master** (`capture.WithQuietTx`;
    replicas may lag behind an epoch). `Check` without cached grants loads the viewer and decides the one group (no full
    computation). **Cost of `Grants`:** a fixed number of queries — viewer, `org_user`, `collaboration`, `access`, teams,
    their `team_repo`/`team_unit` rows, owned and includes-all repositories, then per 500 related repositories the rows,
    owners and units (≈ 12 + 3 per 500 repositories) — decided in memory by `viewerInputs.repoPermission`, a step-by-step
    mirror of `GetUserRepoPermission` (SURFACE.md; `TestGrantsMatchUpstream` compares them for every fixture user ×
    repository). Do not call `Grants`/`Check` inside a transaction of your own.
  - **Permission epochs (the materializer hook point B3 left out).** Specs of the permission tables have a `perm` hook
    returning the row's *permission state* = subjects + fingerprint of permission-relevant columns (`materialize/perm.go`):
    `access` (u, repo+mode), `collaboration` (u, repo+mode), `team` (t = members, mode + includes_all), `team_user` (u),
    `team_repo` (t, r), `team_unit` (t, type+mode), `org_user` (u), `repository` (r + u owner, private+owner),
    `repo_unit` (r, type+default permissions), `user` (u + O = org:/profile: readers and every owned repository; visibility,
    active, prohibit_login, admin, restricted, type), `forgejo_blocked_user` (u, u). The state of the last materialized
    version is stored in the new **`livesync_entity.perm`** column (VARCHAR(255), added by Sync; `TablesVersion` stays 1),
    written by upserts, repair backfill, the initial backfill and the permission walk (round 1), so deletes have it. When a row's state changes (incl.
    appearing/going), the old and new subjects are collected; per transaction they are expanded (team members, owners'
    repositories, read in the writer transaction) into one **`protocol.OpPermission` (`P`) entry in the pseudo group
    `protocol.GroupPermission` (`"!perm"`, entity id 0, model `""`) with a `protocol.PermissionChange{users, repos,
    owners, all}` payload, placed *before* the transaction's other entries** (a hub applying the log in order revokes
    before delivering anything written in the same batch). A changed state without a visible DTO change (e.g. a user made
    admin) writes the epoch alone and updates only the index's perm column. No epoch for changes that leave the state alone
    (names, counters, `updated_unix`) — **round 3:** since triggers do not say which columns an update changed, such an update of a repository/user row is a *touch* and of another permission table names its subjects, see *Review round 3*. The sync id of a `P` entry is the epoch. **Lost changes:** `HandleEpochs` writes
    `P{all:true}` before the markers when a permission table's trigger was repaired, and a delete of a permission row the
    index does not know yet (only possible before the table's backfill is done) also gives `P{all:true}`. **Review round 1
    (unknown states, `permSubjects.transition`):** a permission row *inserted and deleted again* between two materializations
    (coalesced away; possible whenever the materializer lags) gives `P{all}` — except `access`, whose rows
    `recalculateAccess` derives in the same transaction from the other permission tables (whose changes are the epochs; often
    replaced twice in one flow, e.g. an org repository created by a non-owner, which would otherwise mean `P{all}` per
    creation); an index row with an **empty** state (written by B3) is unknown: deleted ⇒ `P{all}`, changed ⇒ the current
    subjects (a state's subjects are fixed id columns, except a repository's owner, whose old readers are also `r<id>`'s);
    walks record the state of a row that still has outbox changes as **unverified** (`?` prefix), and its next change names
    the recorded and the current subjects. **Netting:** per transaction, known states that went and came back (same table +
    state string) cancel out — Forgejo replaces every access row of a repository with new ids on each recalculation, team
    and repository units on each update; previously every user with an access row on the repository was named. Netting can
    only hide an intermediate state with *fewer* rows (less access) between two transactions of one batch, i.e. at worst a
    grant computed in that gap is a stale *denial* until the next epoch or the TTL, never a leak. **Permission walk:** for a
    permission table whose `materialized_perm.<tbl>` differs from `permVersion` (1; absent on B3 databases) `HandleEpochs`
    starts a walk `entity_backfill.<tbl>` = `perm:<id>` (`indexPerm`: fills only the perm column, inserts missing rows; no
    markers, no epoch); B6's gate (`done`) waits for it too (once, after an upgrade from B3).
  - **Event stream for the hub (B5).** The `P` entries *are* the stream: every instance's tailer reads them in order with the
    deltas (`ReadSince(group)` never returns them to clients: their group is never granted and they are not in `*`).
    `perm.DecodeChange(entry)` decodes one. `services/livesync.permSink` wraps the tailer's sink: it applies every epoch to
    the instance's cache (`Cache.Invalidate`: drops the users, and every cached viewer granted `repo:{r}` of a repository or
    `org:{o}`/`profile:{o}` of an owner — found through a group→viewers index, O(affected)) **before** passing the batch on,
    and drops everything on `Skipped`. **B5:** replace `logSink` (keep `permSink` in front, or fold its loop into the hub);
    on a `P` entry recompute the grants of `users` (re-check all their subscriptions, send `group_revoked`), re-check
    subscribers of `repo:{r}` and of the `issue:` groups whose `Decision.RepoID` is in `repos`, and subscribers of
    `org:{o}`/`profile:{o}` for `owners`; `all` ⇒ re-check everyone; **round 3:** `touched` ⇒ re-check the subscriptions
    whose `Decision.Basis.Stale(ch.Touched)`. `synclog.Sink` gained **`Skipped(ctx, from, floor)`**
    (the tailer calls it when it jumps over trimmed entries; the hub must re-bootstrap its subscriptions then).
  - **Placement versions** (`materialize.placementVersions`, meta `materialized_placement.<tbl>`): B4 changed the placement
    of `user`, `project`, `project_board` (version 1). `HandleEpochs` treats a table whose recorded placement differs
    (absent = 0) like a repaired trigger — `B` markers (new `RebootstrapMarker.reason` = `placement_changed`; repaired
    triggers say `trigger_repaired`) and a repair backfill of its index — except on a fresh table (no handled epoch), which
    is just recorded. So a database materialized by B3 re-places users/projects at the first B4 start. Bump a table's
    version whenever its placement rules change.
  - **HTTP: `GET /-/sync/grants`** (`routers/livesync/grants.go`): the viewer's implicit grants (`protocol.Grants`), or with
    `?group=` one decision (`protocol.Grant`); a group that is not readable, does not exist or is not a client group is
    always `404 {"message":"Not Found"}` (no existence leak); 401 without/with an invalid token, 403 for accounts that may
    not sign in or tokens without full read access, 503 while stopped. It is the production caller of `perm` (deadcode) and
    the surface of the differential test. **Auth for B5/B6** (`routers/livesync/auth.go` `authenticate(req)`): Forgejo's
    `auth_method.OAuth2` + `auth_method.AccessToken{PermitBearer}` (Authorization `Bearer`/`token`, or the form, like API v1;
    no sessions ⇒ no CSRF surface, no passwords), then API v1's whole account check (`checkAccount`, round 1: not activated,
    inactive / prohibited, must change the password, two-factor required but not enrolled ⇒ 403 with API v1's messages), then
    `checkTokenAccess`: the token must have `read:repository,issue,organization,user,notification` (or the write/all
    equivalents), not `public-only`, and no repository restriction (only `authz.AllAccessAuthorizationReducer` or none).
    B5's `hello` should call the same function (it takes an `*http.Request`; build one or split the token part out).
    Filtering grants by narrower scopes is a possible later refinement.
  - **Settings added:** `PERM_CACHE_TTL` (default 10m, > 0).
  - **Tests.** Unit: `perm` — `TestUnitSet`, `TestParseGroup`, `TestCheckMatchesUpstream` (SQLite fixtures: every user ×
    every repository / organization / user: `Check` = `GetUserRepoPermission` (`HasAccess`, `CanRead` per unit) /
    `HasOrgOrUserVisible` + membership / API v1's profile rule; `user:{id}` only for that user), `TestGrants` (implicit set
    incl. admin without implicit groups, restricted, inactive/prohibited/org/missing viewers, private profiles, pseudo
    groups; every implicit grant = an on-demand check), `TestCheckIssue`, `TestCache` (invalidation by users / repositories /
    owners / all, TTL, LRU + index consistency), `TestCacheInvalidatedWhileComputing`, `TestCacheConcurrent`,
    `TestDecodeChange`; `materialize` — `TestPermSubjects`, `TestConsumePermissionEpochs` (collaboration mode/delete,
    repository description (no epoch) vs. private, user made admin (epoch alone, stored), user made private (directory →
    profile group + owned repositories), team membership, team mode, team_repo, several rows ⇒ one epoch first),
    `TestConsumeUnindexedPermissionDelete`, `TestProfilePlacement`, `TestHandleEpochsPlacementAndPermissions`; B3 tests
    updated (`P` entries, marker reason); `routers/livesync` — `TestCheckTokenAccess`, `TestAuthenticateWithoutToken`;
    `synclog` — `TestTailer` checks `Skipped`. Integration (PG 16 `gtestschema` + MySQL 8.0): **`TestLivesyncPermDifferential`**
    (every fixture user × every repository: `repo:{id}` via `/-/sync/grants?group=` ⇔ API v1 `GET /repos/{o}/{r}` 200; units
    `code` ⇔ `/languages`, `issues` ⇔ `/issues/pinned`, `releases` ⇔ `/releases`, `issues`/`pulls` ⇔ `/issues/{n}` of one
    issue and one pull request per repository, and `issue:{id}` ⇔ the same request; every organization: `org:` ⇔ `GET
    /orgs/{org}`, `members` ⇔ `GET /orgs/{org}/teams`; every user's profile group ⇔ `GET /users/{name}`; every implicit
    grant equals the on-demand check; the admin's implicit repositories are all related; inactive/prohibited users get 403
    from both; > 100 readable pairs compared — ≈ 10 600 requests, 65 s PG / 85 s MySQL), **`TestLivesyncPermEpochs`**
    (API v1: collaborator added to a private repo ⇒ epoch for the user, cached grants refreshed; removed ⇒ epoch, grant
    gone, `?group=` 404; public repo made private ⇒ epoch naming the repo and owner, on-demand access gone, owner keeps it;
    member removed from the team giving access to a private org repo ⇒ epoch, grant gone, `TeamUser` delete in `org:3`
    members; user made private via the admin API ⇒ epoch with owner + repositories, profile moves `profiles:public` →
    `profile:5`, not readable by others; no non-`self` entry in any `user:` group), `TestLivesyncPermLostChanges`
    (collaboration trigger dropped, collaborator removed, re-Init ⇒ `P{all}` before the `Collaboration` marker),
    `TestLivesyncPermAuth` (401/403/404 shapes, 503 when stopped). `TestLivesyncMaterializeEpoch` updated (marker reason).
  - **Commands run:** gofumpt (clean), `golangci-lint run ./models/livesync/... ./services/livesync/... ./routers/livesync/...
    ./tests/integration/...` (0 issues), `go vet` (+ integration with sqlite tags), deadcode diff (clean), unit tests
    (`-race` for all livesync packages), `next/tools/gen-protocol.sh --check` (up to date), `./integrations.pgsql.test
    -test.run 'TestLivesync|TestVersion'` with `tests/pgsql.ini` (28 pass, 3 MySQL-only skips) and `tests/mysql.ini` (30 pass,
    1 skip), no testlogger "FATAL ERROR"; fork-diff check unchanged (`assets/go-licenses.json`, `cmd/web.go`, `go.mod`,
    `go.sum`); dev binary smoke test on PG with `ENABLED = true` (B3-era dev database: every epoch handled, `P{all}` +
    markers, users re-placed to `profiles:public`; `/-/sync/grants` 200 with a personal token, 404 for a missing repository,
    401 without; creating a private repository wrote `P{users:[1],repos:[3]}`); dev DB triggers removed afterwards.
  - **Not done / for later.** No `group_revoked` yet (B5 consumes the epochs). Grants ignore narrower token scopes (such
    tokens are refused instead). The restricted-user own-profile gap above. PLAN §4.4's group list (`user:`, `org:`, `repo:`,
    `issue:`) now also has the profile groups; PLAN text not edited. **For B5:** `authenticate` runs at `hello`; a socket
    that outlives a later 2FA requirement / password-change flag / deactivation must be re-validated (deactivation and login
    prohibition are user-row epochs; `must_change_password` and 2FA enrolment are not tracked).
  - **Review round 1 (10 findings, all fixed; details in the bullets above).** (1) insert+delete coalesced away ⇒ `P{all}`
    (access exempt, argued in `specs.go`); (2) B3 index rows with `perm=''` ⇒ unknown (delete `P{all}`, change current
    subjects) + permission walk; (3) callers after an `Invalidate` never join an older computation (detach); (4)
    `authenticate` = API v1's full account check; (5) walks record pending rows as unverified; (6) grants/checks on the
    master in one read transaction; (7) batched grants (fixed query count) + lightweight `Check`; (8) netting of replaced
    states per table; (9) computations detached from the starting request's context; (10) the unbounded `recent` list is
    gone (per-computation, bounded change lists). **Residual (found while fixing (1), not fixed):** coalescing also hides an
    *update* that is undone within one batch (`repository.is_private` true→false→true, a collaborator's mode up and down):
    the row's final state equals the indexed one, so no epoch, although a grant computed in between saw the intermediate
    state. Naming a row's subjects whenever it changed twice in a batch would fire for every busy repository (counter
    updates) and be wrong for B5's load; the precise fix is capture-level (the trigger flags updates that touch
    permission columns, e.g. op `P`), a change of B2's DDL with an epoch bump of every table, left for an explicit
    decision. It needs a human-speed flip-flop inside one materializer batch (milliseconds, longer only while it lags).
    **→ Fixed in review round 2 (capture-level flag), see below.**
    Tests added: `TestConsumeVanishedPermissionRow`, `TestConsumePermissionNetting`, `TestConsumeLegacyPermissionStates`,
    `TestBackfillPendingPermissionChange`, `TestGrantsMatchUpstream` (verified to fail with mutated `repoPermission`),
    `TestCacheInvalidatedWhileComputing` (rewritten: joins, detaches, bounded changes), `TestCacheCancelledCaller`,
    `TestCheckAccount`; `TestLivesyncPermAuth` compares must-change-password and `GLOBAL_TWO_FACTOR_REQUIREMENT=all` answers
    with API v1's (user24 with 2FA passes). Notes on the reviewers' repros: finding 5's scratch test updated the row without
    an outbox row (the trigger writes one in the same transaction), so no walk could tell; `TestBackfillPendingPermissionChange`
    inserts it as the trigger would. Finding 3's scratch test poked at internals that no longer exist; the rewritten cache
    test covers its scenario. **Bug introduced and fixed in this round:** the walk-mode map defaulted to `indexUpsert` (zero
    value), so the initial walk overwrote the materializer's index rows; `TestLivesyncMaterializeDrafts` caught it on MySQL
    (≈ 1 run in 3), `TestBackfill` now asserts that the initial walk keeps an emitted row (verified to fail without the fix),
    and the materialize integration tests then passed 10/10 on MySQL.
    Commands: gofumpt (clean), golangci-lint (0 issues), `go vet` (+ integration with sqlite tags), deadcode diff (clean),
    unit tests with `-race`, `gen-protocol.sh --check` (unchanged), `TestLivesync*|TestVersion` on PG 16 (`gtestschema`) and
    MySQL 8.0: PG 28 pass + 3 MySQL-only skips, MySQL 30 pass + 1 skip, no testlogger "FATAL ERROR"; fork diff unchanged.
  - **Review round 2 (1 finding, fixed; its capture-level design was replaced in round 3 — the triggers no longer compare
    columns, see *Review round 3*; kept as history): flip-flops of permission columns.** A permission row updated and changed back
    before the materializer read it (`repository.is_private` false→true→false, a user made admin and back, a collaborator's
    mode up and down) looked unchanged: no epoch, so a grant / B5 subscription obtained in between stayed. **Decision:
    capture-level flag.** The materializer cannot fix this alone: it only ever sees the stored and the current state, and
    "the row changed twice in a batch" is not even sufficient (the first update's batch may already read the restored row,
    the second update arriving in the next batch). So the **update trigger of every permission table compares the table's
    permission columns and writes outbox op `P`** (`livesync_model.OpPermUpdate`) instead of `U` when one changed.
    `catalog.Table.PermColumns` lists them (repository `owner_id, is_private`; user `type, visibility, is_active,
    prohibit_login, is_admin, is_restricted`; org_user `uid, org_id`; team `authorize, includes_all_repositories`; team_user
    `uid, team_id`; team_repo `team_id, repo_id`; team_unit `team_id, type, access_mode`; collaboration/access `user_id,
    repo_id, mode`; repo_unit `repo_id, type, default_permissions`; forgejo_blocked_user `user_id, block_id`) — exactly
    the columns the materializer's permission states read: **`TestPermColumns`** (materialize, SQLite) changes every
    column of a fixture row of each permission table and asserts that the state changes iff the column is listed
    (verified to fail when a column is missing or extra). `coalesce` keeps `rowChanges.permUpdated`;
    `permSubjects.transition(…, permFlags{inserted, updated, derived, backfilled})` names the stored **and** the current
    subjects of a flagged row directly (outside netting), even when the states are equal; the intermediate state has the
    same subjects (id columns Forgejo never updates, except a repository's owner, whose intermediate owner's access is
    `repo:{id}`'s, which `r<id>` covers). Counter/name/`updated_unix` updates stay `U` and produce no epoch, as before.
    **DDL:** PG: the shared function (now "v2") reads the permission columns from **trigger arguments**
    (`EXECUTE FUNCTION livesync_capture('owner_id', 'is_private')`) and compares `to_jsonb(OLD) -> col IS DISTINCT FROM
    to_jsonb(NEW) -> col`, so a dropped/renamed column is never a runtime error (it just stops flagging); `Inspect` now
    compares `pg_trigger.tgargs` with the catalog (a trigger with other arguments is stale). MySQL: the `_au` trigger of a
    permission table is `… VALUES ('repository', NEW.id, CASE WHEN NOT (OLD.`owner_id` <=> NEW.`owner_id`) OR … THEN 'P'
    ELSE 'U' END)` (single statement, deterministic; `action_statement` round-trips, so staleness detection is unchanged).
    **Caveat (MySQL only):** the MySQL trigger names columns, so an upstream migration that drops or renames a permission
    column makes updates of that table fail until the trigger is replaced — Init replaces it at the next start (after the
    migrations) because the expected body changes with the catalog, and `CheckCatalog` (hence `TestLivesyncCatalogContract`)
    now fails when a permission column does not exist, so an upstream sync that renames one is caught in CI;
    `TestPermColumns` fails too. **(Understated — see *Open items at close*.)** The window is the migration run itself (and a deployment that disabled livesync with the
    triggers left installed: B8's uninstall). These are core columns; accepted. **Upgrade cost:** the PG function body
    changed, so the first start after this change repairs it and bumps every table's schema epoch (`P{all}` + `B`
    markers for every table, once); on MySQL only the 11 `_au` triggers are replaced (their tables' epochs). Nothing is
    deployed yet. **Write cost** (sandbox, autocommit single writer, LISTEN off, 3000 updates): PG `UPDATE user SET
    last_login_unix…` +43 µs, `repository.num_stars` +60 µs (the two `to_jsonb` of a wide row) vs. +2 µs for a
    non-permission table (`label`); MySQL ≈ +100–250 µs per update on all tracked tables, noisy (fsync-bound) and not
    measurably different between permission and other tables. Negligible at the §4.11 write rates; if PG's `user`
    updates ever matter, a per-table function with direct column references is the faster variant (it loses the
    dropped-column robustness). Tests: `TestConsumePermissionFlipFlop` (repo private→public→private + a counter in one
    batch ⇒ epoch `{users:[2], repos:[2]}` and the DTO update; user 4 admin and back split over two batches ⇒ an epoch in
    each; a collaboration's mode up and down in a batch that also nets an access replacement ⇒ epoch for the user; plain
    `U` updates ⇒ none; verified to fail without the `transition` change), `TestCoalesce` (`permUpdated`),
    `TestPostgresDDL`/`TestMySQLDDL`/`TestPostgresTriggerState` (arguments, `tgargs` decoding and staleness);
    integration: `TestLivesyncCaptureOutbox/permission columns` (PG + MySQL: for every permission table and column,
    `SET c = c` ⇒ `U`, a changed value ⇒ `P`, in a rolled-back raw transaction; counters ⇒ `U`) and
    `TestLivesyncPermEpochs` (repo1 made public and private again in **one transaction** — no visible change at all — ⇒
    an epoch naming repository 1). The reviewer's scratch repro (`TestRR3FlipFlop`) used `U` ops, which the triggers no
    longer write for those updates.
    Commands: gofumpt (clean), golangci-lint on livesync packages + `tests/integration` (0 issues), `go vet`, deadcode diff
    (clean), unit tests with `-race` (all livesync packages), `TestLivesync*|TestVersion` on PG 16 (`gtestschema`: 28 pass,
    3 MySQL-only skips) and MySQL 8.0 (30 pass, 1 skip), plus `TestLivesyncCapture*|TestLivesyncMaterialize*|
    TestLivesyncPermEpochs|TestLivesyncPermLostChanges` on MariaDB 11.8.9 (all pass; the `CASE` trigger body round-trips
    through `information_schema.triggers` there too), no testlogger "FATAL ERROR"; protocol unchanged; fork diff unchanged.
  - **Open items at close:** none. (The round-2 item "[major] MySQL/MariaDB capture triggers name permission columns" —
    an upstream rename/drop of e.g. `repository.is_private` made every UPDATE of the table fail with `ERROR 1054`, also
    during the upgrade's later migrations, in `INSTALL_MODE=verify` and with livesync disabled but triggers installed —
    was resolved in round 3.)
  - **Review round 3 (orchestrator issue, fixed): triggers reference only `id` again; undone permission changes are
    caught in the materializer.** *Invariant restored:* the PG function is the B2 "v1" body again (no `to_jsonb`, no
    trigger arguments; a v2 function / triggers with arguments are stale and repaired at the next start, which bumps the
    epochs once — nothing is deployed), the MySQL/MariaDB `_au` triggers are plain `… VALUES ('<tbl>', NEW.id, 'U')`;
    `catalog.Table.PermColumns`, `livesync_model.OpPermUpdate`, the `CheckCatalog` permission-column check and the
    `tgargs` comparison are gone. PG kept the id-only design too although its `to_jsonb` lookup could not fail: symmetry,
    and it was +40–60 µs per update of wide rows. PLAN §4.3 now states the invariant as a hard rule with the reasons, §4.5
    the replacement mechanism. *Mechanism (decision):* the materializer cannot tell an undone change from a counter update
    any more, so (`materialize/perm.go` `permSubjects.transition`, `rowChanges.updated` = any op other than I/D, legacy
    `P` outbox rows included):
    - **rarely updated permission tables** (`access`, `collaboration`, `team`, `team_user`, `team_repo`, `team_unit`,
      `org_user`, `repo_unit`, `forgejo_blocked_user`): *any* update names the stored and current subjects outside netting
      (the round-2 rule with "updated" instead of "flagged"). Their updates are permission changes or rare (org membership
      visibility, unit config, team counters, which move with `team_user`/`team_repo` changes that name the team's members
      anyway); cost accepted.
    - **busy tables** (`repository`: issue/star/watch counters, pushes; `user`: sign-ins, counters): an update that leaves
      the stored (known, verified) state alone is a **touch** `protocol.PermissionTouch{kind, id, state}` in the new
      `PermissionChange.Touched` of the same `P` entry (spec `permTouch`; `P` entries may now carry only touches). `state`
      is the fingerprint after the updates — `perm.RepositoryState` (`is_private,owner_id`) / `perm.UserState` (visibility,
      active, prohibit_login, admin, restricted, type); the materializer's stored states are built from the same functions,
      so stored states are unchanged (no permission walk). A real state change is still an epoch naming the subjects.
    - **Decisions record what they read** (`perm.Basis`, `services/livesync/perm/basis.go`): cached `Grants` record the
      viewer's row and every evaluated repository and its owner; `Decision.Basis` (on-demand checks: viewer, repository +
      owner — `checkRepo` loads the owner itself so the recorded row is the one `GetUserRepoPermission` uses —, the
      profile's user, the organization; from cached grants: the grants' basis). A row read in two states by one
      computation (PG READ COMMITTED) is recorded as a conflict that any touch makes stale. `Cache.Invalidate` drops only
      entries whose basis has *another* state of a touched row (new `byRow` index, O(entries that read the row)); running
      computations decide at the end like for repository epochs. So a grant computed while repository 1 was public is
      dropped by the touch `true,2`; every grant computed from the current state survives: **a counter update or sign-in
      recomputes nothing** (one map lookup per cached viewer that read the row). Propagation: touches are in the sync log,
      every instance's `permSink` applies them (unchanged code path).
    - Why not the orchestrator's first suggestion (any update of a repository/user row ⇒ scoped invalidation of `r<id>` /
      `u<id>`+`O<id>`): correct, but every issue created would drop (and, in B5, re-check) every viewer of the repository,
      every sign-in every viewer of the user's repositories — the recompute storm. Tagging with outbox positions does not
      work with commit-order holes. Basis comparison is exact for the rows that can be "busy" and costs nothing when the
      state did not change.
    - **Cost:** one extra small `P` log row per materializer batch that updated repository/user rows (not delivered to
      clients; coalesced per batch). ~~Detaching running grant computations on touches (as on repository epochs) can start a
      second computation for a viewer who asks again meanwhile; harmless.~~ Wrong — touches come with almost every batch; see *Review round 4*.
    - **For B5:** on a `P` entry re-check a subscription when its `Decision.Basis.Stale(ch.Touched)` (besides users / repos
      / owners as before); keep the `Decision` (with its `Basis`) per subscription. Do not modify a `Basis`.
    - **Tests.** `TestTriggersReferenceOnlyID` (capture: every MySQL trigger statement and the PG function read only
      `OLD.id`/`NEW.id`, no `to_jsonb`/`TG_ARGV`/`CASE`; the PG trigger passes no arguments — verified to fail on the
      round-2 DDL), `TestPostgresTriggerState` (arguments ⇒ stale); materialize `TestConsumePermissionFlipFlop` rewritten
      for `U` ops (repo private→public→private + counter ⇒ touch `{repository 2 "true,2"}` and no subjects; user 4 admin
      and back over two batches ⇒ a touch each; collaboration mode up/down ⇒ epoch for the user; a real change ⇒ subjects
      + another row's touch in the same entry; issue/label updates ⇒ nothing; verified to fail without the touch),
      `TestConsumePermissionEpochs` / `TestConsumePlacement` adjusted (unchanged user row ⇒ touch, unchanged collaboration
      / team / org_user update ⇒ subjects), `TestPermColumns` → **`TestPermStateColumns`** (column list now local to the
      test; also asserts the repository/user state fingerprints equal `perm.RepositoryState`/`UserState`); perm
      `TestBasis`, **`TestCacheTouches`** (repository 2's owner switched to user 4 and back: user 4's grants computed in
      between are dropped by the touch, user 2's and user 5's kept; counter ⇒ nothing dropped; user 5 restricted and back;
      owner-row touches; `byRow` index consistency), `TestDecisionBasis`, `TestCacheTouchedWhileComputing` (verified to fail
      without the touch handling in `Invalidate`/`affects`), `TestDecodeChange` (touched). Integration:
      **`TestLivesyncCaptureColumnRename`** (PG + MySQL + MariaDB: with triggers installed, each of the 30 permission-state
      columns of the 11 permission tables is renamed (`ALTER TABLE … RENAME COLUMN`), the table updated through the renamed
      column and `SET id = id` — both succeed and write `U` —, `Inspect` stays healthy, the column is restored (also in
      `t.Cleanup` on failure); verified to fail with `Error 1054 (42S22): Unknown column 'is_private' in 'OLD'` on MySQL
      8.0 with a round-2-style `CASE` trigger), `TestLivesyncCaptureOutbox/permission columns` (every update is `U`),
      `TestLivesyncPermEpochs` (repo 1 public-and-private-again in one transaction ⇒ a `P` entry with the touch
      `{repository 1 "true,2"}` and without `repos:[1]`).
    - **Commands:** gofumpt (clean), golangci-lint on livesync packages + `tests/integration` (0 issues), `go vet` (+
      integration with sqlite tags), deadcode diff (clean), unit tests with `-race` (all livesync packages),
      `gen-protocol.sh` (types regenerated: `PermissionTouch`, `Touched`, `TouchRepository`/`TouchUser`; `--check` up to
      date), `TestLivesync*|TestVersion` on PG 16 (`gtestschema`: 29 pass, 3 MySQL-only skips) and MySQL 8.0 binlog on (31
      pass, 1 skip), `TestLivesyncCapture*|TestLivesyncMaterialize*|TestLivesyncPermEpochs|TestLivesyncPermLostChanges` on
      MariaDB 11 (all pass; the privilege test skips without a `forgejo` account there), no testlogger "FATAL ERROR"; fork
      diff unchanged (`assets/go-licenses.json`, `cmd/web.go`, `go.mod`, `go.sum`). `SURFACE.md`: `checkRepo` relies on
      `GetUserRepoPermission` keeping a loaded owner.
  - **Review round 4 (orchestrator issue, fixed): touches no longer detach running grant computations.** *Problem:* since
    round 3 the materializer writes a touch-only `P` entry for nearly every batch (issue create/close →
    `UpdateRepoIssueNumbers`, stars, pushes, sign-ins), and `Cache.Invalidate` treated any `Touched` like a repository
    epoch for **every** running computation: removed it from `inflight` (later callers for the same viewer started a
    duplicate computation) and appended the change to `call.changes`, so after 64 batches the result was never cached —
    single-flight was effectively off under the §4.11 write load and long computations were recomputed on every call.
    *Fix (`perm/cache.go`; the per-call recording was replaced by one journal per cache in *Review round 5*, the rules
    are unchanged):* a touch only **records** the touched rows' states on each running call (`call.touched`, a
    `Basis`: one entry per distinct row, `basisConflict` when one row is touched in two states — exactly equivalent to
    checking every touch on its own; bounded by `maxCallTouchedRows` = 65 536 rows, beyond which the call is stale and
    detached as before) and **does not detach** it nor count toward `maxCallChanges` (which now only counts repository /
    owner epochs; a mixed entry's epoch part is stored without its touches). When the computation finishes,
    `Basis.staleAgainst(call.touched)` decides: not stale ⇒ cached and handed to everybody; stale ⇒ not cached, the
    callers that joined **before** the first touch get the result (as before: they asked before the change was known),
    those that joined **after** a touch (`call.touches > 0` at join time) loop in `get` and compute again (joining one
    fresh computation among themselves), so nobody who asked after a touch gets a result read in the undone state.
    Conservative simplification: a caller that joined after an unrelated touch but before the relevant one also
    recomputes (only when the result is stale, i.e. a real undone permission change of a row the viewer read). `affects`
    no longer looks at `ch.Touched` (changes carry none). Users / `All` epochs and repository / owner epochs are unchanged.
    *Tests:* `TestCacheTouchedWhileComputing` rewritten — stale against the touch (early caller gets the result, the
    joined later caller computes again, only the fresh result cached), row not read / read in the touched state (joined,
    cached), **regression: 1 + 128 touches of unrelated rows ⇒ later callers join and the result is cached** (the
    reviewer's probe; verified to fail with touches detaching — "unexpected computation" — and with touches counting
    toward `maxCallChanges` — "not cached after unrelated touches"; the late-joiner recompute verified to fail without
    the `continue` in `get`), one `touched` entry per row however often touched, a row touched in two states ⇒ stale,
    mixed epoch + touch (detached, touch recorded, not stored on the change), the row bound; `TestBasis` covers
    `staleAgainst` (conflict, symmetry, unread rows).
    *Commands:* gofumpt (clean), golangci-lint `./services/livesync/...` (0 issues), `go vet`, deadcode diff (clean),
    livesync unit tests with `-race`, `TestLivesync*|TestVersion` on PG 16 (`gtestschema`: 29 pass, 3 MySQL-only skips) and
    MySQL 8.0 (31 pass, 1 skip), no testlogger "FATAL ERROR"; triggers untouched (no MariaDB run); protocol unchanged; fork
    diff unchanged (`assets/go-licenses.json`, `cmd/web.go`, `go.mod`, `go.sum`).

  - **Review round 5 (orchestrator issue, fixed): one touch journal per cache instead of per-call copies.** *Problem:*
    round 4 copied every touched row of a `P` entry into each running computation's own `call.touched` map (≤ 65 536 rows
    each) while holding `c.mu`, so one entry cost running × touched rows map inserts and as much transient memory: a bulk
    repository/user update (org rename `UPDATE repository SET owner_name=…`, `num_stars` recount — up to
    `capture.DefaultBatchSize` = 1000 touches per entry, 500 entries per `Deliver`) during a reconnect storm stalled every
    `Grants`/`Check` and the tailer's `permSink.Deliver` (fan-out) for seconds and allocated GBs — against PLAN §4.11
    (per-delta cost must not scale with everything in flight). *Fix (`perm/touches.go`, `perm/cache.go`):* the cache keeps
    one **`touchJournal`**: a seq per invalidation carrying touches, and per touched row one record `{last seq, last state,
    seq of its last touch in another state}` in a map + a list ordered by last seq. A computation records only the seq at
    its start (`call.since`); when it finishes, `journal.stale(basis, since)` decides per row it read: stale iff the row was
    touched after `since` and (its last state differs from the one read, or it was touched in another state after `since`)
    — exactly "some touch since the start had another state" (round 4's per-call `Basis` with `basisConflict`, now
    `Basis.staleAgainst` is gone); iterates the smaller of basis and journal. Running computations sit in `Cache.tracking`
    (ordered by `since`); when one finishes, records not touched after the oldest remaining `since` are trimmed from the
    list front (amortised O(1) per touch), and the journal is dropped (fresh map: no spike memory kept) when nothing runs;
    touches arriving while nothing runs only bump the seq. *Bound:* `maxTouchedRows` = 65 536 records for the whole cache
    (was per call); beyond it every tracked computation loses its touches (`touchLost`: not cached, detached, callers that
    joined after a touch compute again — the old per-call overflow rule) and the journal is cleared, O(running) but only
    once per 65 536 distinct rows. `Invalidate` also loops over the running computations only for an epoch naming users /
    repos / owners / all (`invalidateRunningLocked`), not for touch-only entries. Joining rule unchanged: a caller that
    joins after any touch since the start (`journal.seq > since`) recomputes iff the result is touch-stale. *Cost now:*
    `Invalidate` O(affected entries + entries that read a touched row + touched rows) for touches, whatever the number of
    running computations; memory O(distinct rows touched since the oldest running computation started) ≤ 65 536 records.
    *Measured* (scratch probe through `go test -overlay`, no repo file; HEAD~ = round 4 via a scratch worktree): 100
    running + one 20k-row entry 3.6 ms / 9 MB (round 4: 351 ms / 318 MB); 1000 running, same 3.4 ms / 9 MB (3.28 s / 3.1
    GB); 3000 running × 300 entries of 5 rows 0.46 ms total, max hold 44 µs (1.53 s, max 172 ms, 573 MB); 3000 running × 20
    entries of 1000 rows 3.2 ms total / 6.7 MB (23.4 s, max 9.5 s, 9.4 GB). *Tests:* **`TestTouchJournal`** (unrelated
    rows; state read once/twice; conflict basis; another state and back — stale for computations started before the other
    state, not after; two states in one invalidation; journal-side iteration; trim order and floor; clear keeps the seq),
    **`TestCacheTouchCostIndependentOfRunning`** (regression: `testing.AllocsPerRun` of `Invalidate` with 1000 fresh touched
    rows is the same with 1 and 500 running computations, the journal holds one record per row for all of them, the viewer
    whose read row was touched in another state is not cached and the 499 others are, journal and tracking empty
    afterwards; verified to fail — 12 007 vs 2 028 allocs — with a per-call `Basis` copy put back into `touchLocked`),
    `TestCacheTouchedWhileComputing` adapted (journal record counts, `reset` asserts nothing is kept when nothing runs;
    the bound test: overflow ⇒ stale + `touchLost`, journal and tracking empty, the caller that joined after a touch does
    not take the old result but joins the fresh computation); `TestBasis` lost its `staleAgainst` part (moved to
    `TestTouchJournal`). *Not changed:* an epoch naming repositories/owners still appends to every running call's
    `changes` (O(running), ≤ 64 per call, as since round 1; epochs are rare compared to touches).
    *Commands:* gofumpt (clean), golangci-lint `./services/livesync/...` (0 issues), `go vet`, deadcode diff (clean),
    livesync unit tests with `-race`, `TestLivesync*|TestVersion` on PG 16 (`gtestschema`: 29 pass, 3 MySQL-only skips) and
    MySQL 8.0 (31 pass, 1 skip), no testlogger "FATAL ERROR"; triggers untouched (no MariaDB run); protocol unchanged; fork
    diff unchanged (`assets/go-licenses.json`, `cmd/web.go`, `go.mod`, `go.sum`).

#### B5 — WebSocket hub + protocol (+ SSE fallback)
- [x] **Status** — done 2026-10-07 (final check: `TestLivesync*` + `TestVersion` green on PG 16/`gtestschema` (31 pass, 3 MySQL-only skips) and MySQL 8.0 binlog on (33 pass, 1 skip), incl. `TestLivesyncHub` (ws + sse) and `TestLivesyncHubSlowConsumer`, no testlogger "FATAL ERROR"; livesync unit tests green with `-race` (1 run); `gen-protocol.sh --check` up to date; `routers/livesync/deps.go` gone; fork diff = `assets/go-licenses.json`, `cmd/web.go` (1 line + import), `go.mod`, `go.sum`; review rounds 1–2 fixed; the final review's open item (flaky `TestHeldEntries`/`TestTouches`) fixed 2026-10-07 — a real, if mild, product bug, plus two siblings — see *Final-review open item*; its re-review's item (a delta claimed a re-bootstrap marker's position before the marker's `bootstrap_required`) fixed 2026-10-07 for every `bootstrap_required` path — see *Final-review round 2*; its re-review's item (a missed
  `permission_changed` is not told again on resume, though the contract said so) fixed 2026-10-07 by correcting the client contract
  — see *Final-review round 3*; its re-review's item (removing the `permission_changed` cap lost entities in the "changed and
  undone" case) fixed 2026-10-07 by restoring the cap — see *Round-3 re-review*; no open items)
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
  invalid token ⇒ `session_invalid`; a re-bootstrap marker from B3's epoch handling (if B3 chose that) ⇒
  `bootstrap_required` for that model's groups; same scenario over SSE.
- **Notes/decisions:**
  - **Files.** `services/livesync/protocol/messages.go` (+ regenerated `next/src/protocol/types.gen.ts`; `next/tools/tygo.yaml`
    frontmatter adds the `ClientMessage` / `ServerMessage` unions); `services/livesync/hub/{hub,conn,session,replay,models,ws,sse}.go`
    (+ SQLite unit tests `hub_test.go`); `services/livesync/hub_glue.go` (`Hub()`, `ownProfile`), `livesync.go`, `settings.go`,
    `writer.go` (`logSink` gone); `routers/livesync/sync.go` (`serveWebSocket`, `serveSSE`, `sendMessage`, `authenticateToken`),
    `wrap.go`, `routes.go`; **`routers/livesync/deps.go` deleted** (the hub imports `coder/websocket`; `go mod tidy -diff` clean);
    `synclog/{read,tailer}.go`, `materialize/{specs,specs_render}.go`, `perm/{basis,cache,grants}.go` (small API additions, below);
    `tests/integration/livesync_hub_test.go`, helpers `livesyncServeWith`, `livesyncSettle`.
  - **Protocol** (all JSON, snake_case like the DTOs — PLAN §4.6's camelCase sketch was not followed; every message has a literal
    `"type"`, generated as a TS discriminant). C→S: `hello {token, client_id?, protocol?, build_id?, last_sync_id?, groups?:
    [{group, since?}]}`, `subscribe {groups:[{group, since?}]}`, `unsubscribe {groups:[…]}`, `barrier {id}`, `ping {id?}`. S→C:
    `welcome {server_sync_id, viewer_id, granted:[Grant], refused:[{group, reason: forbidden|limit}], grants:[Grant] (implicit, as
    GET /-/sync/grants), build_id, protocol, schemas:{Model: ver}, profile?: Change}`, `subscribed {granted, refused}`, `delta {to,
    changes:[{v, g, m, id, op: U|D, d?}]}`, `caught_up {sync_id}`, `bootstrap_required {group, reason, model?}`, `group_revoked
    {group}`, `barrier_ok {id, sync_id}`, `session_invalid {message}`, `notice {kind: new_build|shutdown}`, `pong {id?, sync_id}`,
    **`grants {grants}`** (new: implicit grants changed, e.g. made a collaborator — so the workspace learns about new groups),
    `resume_from_cursor {sync_id}`, **`error {code, message}`** (new: bad_message, hello_required, too_many_barriers,
    too_many_connections, internal), **`session {session}`** (SSE only). `protocol.ProtocolVersion = 1`. TypeScript: the
    `ClientMessage`/`ServerMessage` unions and the literal unions `RefusalReason`, `BootstrapReason`, `NoticeKind`, `ErrorCode` (the
    fields' `tstype`) are written in `tygo.yaml`'s frontmatter; **`protocol.TestTypeScriptUnions`** fails when a `Msg*` type, a message
    struct or a reason/kind/code constant is missing from them (review round 1).
    - **Positions (client contract, documented in messages.go).** A group's position = the highest `v` received in it, raised to
      `delta.to`, `caught_up.sync_id`, `pong.sync_id`, `barrier_ok.sync_id`, `resume_from_cursor.sync_id` for every group that was
      caught up (a `caught_up` arrived after it was subscribed). Resume a group with `since` = its position. `since` absent = live
      from the server's position (use after a bootstrap). `since` ahead of the hub but ≤ the DB log head is fine (a B6 watermark may be
      ahead of the tailer for a moment); ahead of the log head ⇒ `bootstrap_required{cursor_unknown}` and live.
    - **`bootstrap_required` never removes the subscription**: changes keep coming; the client drops what it holds of the group (or
      only of `model` when set — re-bootstrap markers) and loads it again (B6), the watermark makes the overlap harmless. Reasons:
      `trigger_repaired` / `placement_changed` (B3/B4 markers), `cursor_trimmed`, `cursor_unknown`, `replay_too_long` (more than
      `MAX_REPLAY` log entries of the group to replay; sent before any of them), `permission_changed` (the viewer's units in the group
      changed: what they hold no longer matches; **not sent again on resume** — see the units rule below).
    - **Units rule (client contract, `protocol.GroupRequest`; final review round 3).** Every grant (`welcome.granted`,
      `subscribed.granted`) carries the viewer's units in the group (canonical order: `UnitSet.Units()`; a granted set is base + named
      bits only, so equal lists ⇔ equal sets). The client keeps with each group the units what it holds was filtered by (those of the
      grant, or of the bootstrap that loaded it — **B6 must state them**) and treats a grant whose units differ as
      `bootstrap_required{permission_changed}`. That message goes only to the subscriptions that saw the change; a new session cannot
      derive it (it does not know the units the client had), so a client that missed it learns it from the units of its next grant —
      whatever position it resumes from. Equal units need nothing even if they changed and changed back meanwhile: replays and live
      changes are filtered by the current units, and no frame before `permission_changed` claims past the subscription's hold, so the
      client's position never passes the held entries the new units dropped (`TestPermissionChangedResume`; round-3 re-review).
    - **Replays give states, not history**: a replay sends each entity once, as it is at the hub's position (or a delete). A client
      resuming from a position therefore never sees intermediate states it did not receive live (edited/redacted text, a profile before
      it went private), whatever `since` it claims; what it can get is what a bootstrap would give it now. The ids of entities deleted
      in the range are still sent (as deletes).
    - `group_revoked`: the subscription is gone; purge the group. Refusals never tell "forbidden" from "does not exist".
    - `bootstrap_required` and `group_revoked` carry no position; the server guarantees that no frame before them claims a
      position (`delta.to`) past what they are about (a marker's sync id − 1, a suspended subscription's hold, the position before
      a retention skip), so resuming from the last position received replays the reason again (final review round 2) — for every
      reason except `permission_changed`, which the units rule covers instead (round 3); before `permission_changed` too no frame
      claims past the hold, so that equal units after a change undone meanwhile leave no gap (round-3 re-review).
  - **Hub** (`services/livesync/hub`, PLAN §4.6/§4.11). The hub is the tailer's sink (`permSink{cache, next: hub}`): `permSink`
    applies epochs to the grant cache first, then `Hub.Deliver` handles the batch **in log order under one hub lock**:
    - **Fan-out** (entity entries): `byGroup[grp]` → live subscriptions whose units allow the entry (`perm.UnitSet.Allows`) and whose
      `liveFrom` is below it. O(subscribers of the group). `!perm` entries and any other `!…` group are never delivered.
    - **Replay-then-live**: a subscription with `since` is `stateReplay`; the session's worker reads the keys (no payloads) of the
      range `synclog.ReadKeys(group, cursor, until = hub position)` (never past what the tailer delivered, so never past a permission
      epoch the hub has not applied; `until` always bounds, 0 included), then the payloads of what it sends
      (`synclog.ReadEntries(ids)`, 500 per query), then under the hub lock goes live with `liveFrom = cursor` if `cursor ≥ hub position`
      (else reads on). **Only the newest entry of each entity (model, id) that the viewer's units allow is sent** (a delete stays a
      delete; re-bootstrap markers are kept in place): a replay gives the state at `until`, never the intermediate states the log keeps
      (review round 1). No gap, no duplicate (unit test interleaves deliveries with a replay). **Fast path:** a request whose `since` is
      at or ahead of the hub's position goes live in `subscribeLocked` without any read; a session's queued replays are first checked
      together (`skipIdle`: one `synclog.ReadGroups(min cursor, until)` = `MAX(sync_id) … GROUP BY grp` over at most 10 000 entries),
      and the groups that missed nothing go live without a query of their own (a reconnect resumes up to 1 000 groups from one
      position). Replays wait for room in the send buffer (half full) instead of overflowing; at most 16 database reads/checks run at
      once (semaphore), **a slot is held for one read or check only, never while waiting for the client or a retry pause**;
      `MAX_REPLAY` bounds the log entries scanned for one replay and is **decided before anything is sent** (the key read asks for
      `MAX_REPLAY + 1`).
    - **Permission epochs** (`P` entries; `Skipped` = `P{all}`): the subscriptions an epoch may concern — all of a named user's
      sessions (and `revalidate`: token + account check, implicit grants re-sent if changed), `byGroup[repo:r]` ∪ `byRepo[r]` (the
      `issue:` groups decided by repository r), `byGroup[org:o]`/`byGroup[profile:o]` for owners, and for touches `byRow[(kind,id)]`
      whose `Decision.Basis.Stale(touch)` — are **suspended at the epoch's position** (`stateRecheck`, cursor = the epoch's sync id) and
      re-checked with `perm.Cache.Check` by the worker; meanwhile the fan-out **holds** their group's entries (and markers) in memory
      (`sub.held`, unfiltered; at most `SEND_BUFFER` bytes per session, beyond it the subscription drops them and catches up from the
      log instead; `Skipped` drops them too); still granted ⇒ the held entries are sent with the new units and it is live again, no log
      read (review round 1; `bootstrap_required{permission_changed}` if the units changed); not granted ⇒ removed + `group_revoked`. So
      nothing after the epoch reaches a subscription before its re-check. While suspended, frames do not claim completeness past the suspension point
      (`conn.holds`: `delta.to`/`pong` = min(hub position, holds)), so a client that drops the connection then cannot skip the
      entries that were held back. Checks that ran while an epoch arrived (hello/subscribe check → registration gap) are redone:
      the hub keeps the last 64 epochs (`epochsSince`); a request is stale only if one of the epochs since the checkpoint concerns it
      exactly as `permissionLocked` would (`epochConcerns`: everybody, the viewer, its repository / repo group, its org/profile owner, a
      touch its decision's basis read in another state), or if the epochs are no longer kept; a stale request starts in replay from the
      checkpoint position with `recheck` set (`TestEpochDuringCheck`, `TestEpochDuringCheckConcerns`). Touch-only epochs, which come with
      nearly every write batch, no longer make every running check stale (review round 1).
    - **Re-bootstrap markers** (`B` in `*`): `bootstrap_required{group, reason, model}` to every live subscription whose group kind can
      hold the model (`hub/models.go` `modelKinds`, from the B3/B4 placement rules; unknown models ⇒ every group;
      `TestModelKindsCoverModels` checks it covers `materialize.Schemas()`); replaying subscriptions meet the marker in their replay.
      This and `P{all}`/`Skipped` are the only paths that visit every session.
    - **`Skipped(from, floor)`**: live subscriptions get `bootstrap_required{cursor_trimmed}` and everything is re-checked (`P{all}`
      held at `from`).
    - **Frames**: one `delta` per ≤ 16 ms (`FrameInterval`; the first change after a quiet period goes out at once), cut at 256 KiB of
      changes; payloads are embedded verbatim (no re-encoding). Control messages are ordered with the changes in one queue per session.
      The writer computes a frame's `to` when it takes the queue (`conn.take`: hub position loaded first, then min over the holds under
      `conn.mu`), so whatever changes what `to` may claim must change in the same `conn.mu` critical section that queues what the claim
      depends on, or before the writer is woken — never after (see *Final-review open item*). A message that tells the client a
      caught-up group is complete only up to some position (`bootstrap_required`, `group_revoked`) caps the last delta queued
      before it (`conn.capLocked` → `outItem.maxTo`, applied in `take`; see *Final-review round 2*) — also
      `permission_changed`, which a resume does not re-derive (round 3), so that the client's position never passes held entries the
      new units drop (round-3 re-review).
    - **Backpressure** (*superseded 2026-10-08 for live changes: a change that does not fit makes its subscription catch up from
      the log, and a session is slow when messages wait and the writer finishes no frame within `DRAIN_TIMEOUT` — see B8, *Burst
      backpressure* and its issue round 2; the rest
      of this bullet is the B5 design*): per-session queue bounded by `SEND_BUFFER` bytes, **live changes and control messages** (review round 1: pongs,
      errors, …; control messages are encoded when queued, so their size is exact; one item larger than the buffer may enter an empty
      queue, else it could never be sent); replays wait for room instead. Overflow ⇒ the unsent queue is dropped,
      `resume_from_cursor{sync_id = the last frame's to written}` and close (WS 1013 Try Again Later). Each write has a 10 s deadline
      (`WriteTimeout`); a stuck write closes the session. **Before the hello** anything but a hello gets one `error{hello_required}` and
      the session is closed (WS 1008), so unauthenticated sockets cannot make the server queue answers; an unknown message type is
      echoed cut to 64 bytes.
    - **Caps**: `MAX_SUBSCRIPTIONS` per user over all their sessions on the instance (refusal reason `limit`; requests beyond the room
      are not even checked), `MAX_CONNECTIONS_PER_USER` sessions (`error{too_many_connections}` + close). Per instance, not cluster-wide.
    - **Own profile (B4's restricted-limited gap): closed.** `welcome.profile` is the viewer's User entity (`materialize.Profile`, `v`
      = its `livesync_entity.last_sync_id`), and every later `User` entry with the viewer's id is sent to the viewer's sessions even
      without a subscription to its group (buffered until the welcome is queued, so nothing between the profile read and the welcome is
      lost).
    - **Sessions**: hello within 10 s or close (`stop` waits for the session's worker and for a client message being handled — over SSE a
      POST may run concurrently — and later messages are dropped, so nothing of a session runs or is registered after its handler
      returned; review round 2); the token is re-validated every `SESSION_CHECK_INTERVAL` (5 min) and on every epoch
      naming the viewer; failing ⇒ `session_invalid` + close (WS 1008). **OAuth2 access tokens expire (1 h by default): F2/F3 must
      reconnect with a refreshed token** (there is no in-session token refresh message; a possible addition). Keep-alive: WS ping /
      SSE comment every 25 s. Graceful shutdown: `notice{shutdown}` + close (1001) to every session before the instance stops (≤ 5 s).
    - **Barrier**: `barrier_ok` once the hub delivered the DB log head read at the barrier and no subscription of the session replays or
      is held; ≤ 16 pending. (*Changed 2026-10-08, B8 issue round 3:* no replay the client asked for runs and the session's
      `position()` — capped by the holds of rechecked / behind subscriptions — is ≥ the head; `caught_up` likewise waits only for
      those replays and claims `position()`.)
  - **Transports.** **WebSocket** `GET /-/sync/ws` (`coder/websocket`, permessage-deflate **without context takeover** — a pooled
    compressor per message instead of a 32 KiB window + flate writer per connection; messages < 512 B uncompressed; accepted origins:
    the request host and `AppURL`'s host). **SSE fallback** `GET /-/sync/sse` (first event `session{session}`: a random 128-bit id) +
    `POST /-/sync/send` with header `X-Livesync-Session` (204; 404 unknown session; 413 > 256 KiB); the hello in the body
    authenticates exactly like over WS, no cookies (a cross-site page cannot set the header without a preflight), so `EventSource`
    works natively. SSE is not compressed (a compressing writer would buffer). The SSE transport touches the `ResponseWriter` only under
    its mutex between the headers and `close` (keep-alives come from the worker goroutine; review round 1: a keep-alive could run after
    `ServeSSE` returned — a data race with net/http's `finishRequest` and a nil-pointer panic in a non-handler goroutine that killed the
    process — or before the headers). Both session endpoints are dispatched in
    `handler.ServeHTTP` **before** livesync's router (raw `ResponseWriter`: hijack; `http.ResponseController` write deadlines and
    flushes — Forgejo's `context.Response` has no `Unwrap`), so they are not in the router/access log; `/-/sync/send` goes through the
    router. Max client message 256 KiB.
  - **Auth.** `routers/livesync.authenticateToken(ctx, token)` passes a synthetic request with `Authorization: Bearer <token>` through
    B4's `authenticate` (OAuth2 / personal access token, API v1's account checks, livesync's scope rule); 4xx ⇒ `session_invalid` with
    API v1's message, 5xx ⇒ `error{internal}` + close (the client keeps its token).
  - **APIs for later milestones.** `livesync_service.Hub() *hub.Hub` (nil when stopped); `hub.Hub.ServeWebSocket/ServeSSE(w, req,
    auth)`, `Hub.Send(session, msg)`; `hub.Config` (all limits); `synclog.ReadKeys(ctx, group, cursor, until, limit)` (entries without
    payload; `until` always bounds), `synclog.ReadEntries(ctx, ids)` (`*TrimmedError` when one was trimmed meanwhile),
    `synclog.ReadGroups(ctx, cursor, until)` (last sync id per group of a short range); `ReadSince(group)` now reads a group with two
    range scans of `(grp, sync_id)` (the group's and `*`'s) merged in Go — `grp IN (g,'*') ORDER BY sync_id LIMIT n` was planned as a
    primary-key walk filtering every group's rows (PG 16, 1M rows: 28 ms / 2 848 buffers vs 2.6 + 0.1 ms);
    **`synclog.StartTailer(ctx, cfg, from, sink)`** (start position is a parameter now: Init reads the head once for tailer and hub);
    `materialize.Profile(ctx, u) (*protocol.User, group)`, `materialize.Schemas()`; `perm.Basis.Rows()`. **Changed B4 behaviour:**
    a `Decision` taken from cached grants now carries only the basis rows that decided its group (viewer; repository + owner for
    `repo:`; the user for `org:`/`profile:`) instead of the whole grants basis — otherwise a viewer with 100 subscriptions × 200
    basis rows put 20 000 entries per viewer into the hub's touch index and every touch of any of their repositories re-checked
    all of their subscriptions (`TestDecisionBasis` updated). Cache entry invalidation still uses the full basis.
  - **For B6:** subscribe with `since` = the bootstrap watermark (allowed to be ahead of the hub, see Positions). On
    `bootstrap_required` the client re-bootstraps while staying subscribed. The hub has no snapshot cache; bootstrap must honour B3's
    backfill gate. **For B7:** `X-Livesync-Sync-Id` vs. `delta.v`: a client's group position passes it once the write's entries were
    delivered; `barrier` is the explicit alternative. **For B8:** metrics hooks are not added yet (connections = `len(h.conns)`,
    subscriptions, overflow disconnects, replays, frames — add counters to the hub); the admin page can list sessions per user.
    **For F2:** the client contract above (positions, `bootstrap_required` keeps the subscription, `grants` updates the workspace,
    `session_invalid` ⇒ refresh token + reconnect with backoff, `resume_from_cursor`/`notice{shutdown}` ⇒ reconnect and resume each
    group from its position, profile arrives in `welcome`).
  - **Settings added:** `SEND_BUFFER` (4194304 bytes, changes + control messages; B8's burst fix adds `DRAIN_TIMEOUT`), `MAX_SUBSCRIPTIONS` (1000),
    `MAX_CONNECTIONS_PER_USER` (16), `MAX_REPLAY` (10000 log entries scanned per replay), `SESSION_CHECK_INTERVAL` (5m); all > 0.
  - **Tests.** Unit (SQLite fixtures, real `synclog` + `perm.Cache`, fake transport, `Deliver` driven by the test; all with `-race`,
    repeated 8×): `TestHelloWelcome` (hello required, refusals incl. pseudo groups and missing groups, implicit grants, profile, index
    rows of a grants-derived subscription = repository + owner only, invalid token ⇒ session_invalid + 1008, `notice{new_build}`),
    `TestReplayThenLive` (replay from since, payload embedded, caught_up, live, a replay with deliveries interleaved ⇒ every entry
    once and in order), `TestFrameBatching`, `TestUnitsAndSelfProfile` (members-only entries not sent to a non-member; own profile
    without subscription, others' not), `TestPermissionEpochRevokes` (collaboration removed + `P{users}` ⇒ `group_revoked`, nothing of
    the group after the epoch, the other subscription re-checked and caught up, `grants` message, indexes cleaned),
    `TestTouches` (touch in the recorded state ⇒ nothing; in another ⇒ re-check + catch-up), `TestRebootstrapMarker` (live and
    replaying; `user:` groups not told about labels), `TestTrimmedAndUnknownCursor`, `TestReplayTooLong`, round 1's tests in
    `replay_test.go`/`session_test.go` (see *Review round 1*), `TestSlowConsumer`
    (blocked writer, overflow ⇒ `resume_from_cursor` + 1013, unsent changes dropped), `TestBarrierUnsubscribeLimits`, `TestShutdown`,
    `TestModelKindsCoverModels`, `TestEpochDuringCheck`; `routers/livesync` `TestHandlerRouting` (ws/sse/send dispatch, 503 when
    stopped, 405); `synclog` `ReadKeys`/`ReadEntries`/`ReadGroups` (in `TestAppendAndReadSince`/`TestTrim`); settings. Integration (real listener via `onApplicationRun`, raw WS client with
    permessage-deflate negotiated, raw SSE client; **PG 16 `gtestschema` + MySQL 8.0**): **`TestLivesyncHub`** (`ws` and `sse`
    subtests, same scenario: invalid token ⇒ session_invalid + close (WS 1008); label created via API v1 before the session ⇒
    replayed from the cursor, then caught_up; **live delta after an API v1 write: ≈ 16–20 ms** measured from before the request on
    both DBs, asserted < 150 ms; barrier; user5 refused `repo:2`, `user:2`, `!perm`; made collaborator via API ⇒ `grants` with
    `repo:2` ⇒ subscribe granted; collaborator removed via API ⇒ `group_revoked{repo:2}` and no later `repo:2` change; retention
    floor moved ⇒ `bootstrap_required{cursor_trimmed}` then caught_up; `schema_epoch.label` bumped ⇒ writer's marker ⇒
    `bootstrap_required{repo:1, trigger_repaired, Label}` and not for `user:2`; ping/pong; no `!`/`*` group in any change),
    **`TestLivesyncHubSlowConsumer`** (review round 1: the client stops reading (4 KiB socket receive buffer), `SEND_BUFFER = 65536`,
    400 comments of 4 KB in `issue:1` ⇒ after reading again it got some comments, then `resume_from_cursor` at a position it was sent
    (`caught_up` or a `delta.to`) below the log head, fewer comments than written, close WS 1013; over SSE too. A writer blocked by a
    full socket is the unit test's case: the kernel autotunes the server's send buffer up to `net.ipv4.tcp_wmem`'s maximum (4 MiB
    here), so a paced burst of 3.4 MB was absorbed completely in an experiment).
  - **Also fixed:** `TestLivesyncMaterializeDrafts` (B3) was flaky on PG (≈ 1 in 4 full runs here: the pending review's own later
    update landed after the submit cursor); it now waits for the log to settle (`livesyncSettle`) before taking the cursor.
  - **Commands run:** gofumpt (clean), `golangci-lint run ./services/livesync/... ./routers/livesync/... ./models/livesync/...
    ./tests/integration/...` (0 issues), `go vet` (+ integration with sqlite tags), deadcode diff (clean), `go mod tidy -diff`
    (clean), unit tests with `-race` for every livesync package (hub tests also 8× repeated), `next/tools/gen-protocol.sh --check`
    (up to date; the generated file also type-checks with `tsc --strict`), `./integrations.pgsql.test -test.run
    'TestLivesync|TestVersion'` on PG 16 (`gtestschema`: 31 pass, 3 skips) and MySQL 8.0 binlog on (33 pass, 1 skip), no testlogger
    "FATAL ERROR"; each of the five commits builds on its own; fork diff unchanged (`assets/go-licenses.json`, `cmd/web.go`,
    `go.mod`, `go.sum`); dev binary smoke test on PG with `ENABLED = true` (SSE session: session → hello via POST → welcome with
    implicit grants → caught_up → ping/pong; `/-/sync/ws` without upgrade headers ⇒ 426), dev DB triggers removed afterwards.
    MariaDB not re-run (no trigger/DDL change).
  - **Review round 1 (14 findings: 13 fixed, 1 fixed differently; details in the bullets above).** (1) the check semaphore is
    taken per database read/check only (`conn.withSlot`), never while a replay waits for room or a retry pauses
    (`TestReplaySlotsNotHeldWhileWaiting`: 20 gated sessions replaying 200 entries each, another user's one-entry replay arrives at
    once; the reviewer's repro failed with "got nothing within 3s"); (2) SSE: the writer is used only under the transport mutex between
    the headers and `close` (which now waits for a write in progress), keep-alives before the headers are skipped, and `stop` joins the
    session's worker (`TestSSEWriterLifetime`: 160 streams with a 20 µs keep-alive through a writer wrapper that records any use
    after the handler returned or before the headers — on the round-0 code it panics with the reported nil-pointer dereference in
    `bufio.(*Writer).Flush` ← `keepAlive`); (3) replays send the newest state per entity (`TestReplayNewestState`,
    `TestReplayUnitChange`: a reader of the old unit only gets the delete, a reader of both the new state); (4) control messages count
    against `SEND_BUFFER`, nothing but a hello is answered before the hello (one error, then close), unknown types echoed cut
    (`TestControlMessagesBounded`: 1000 pings without reading ⇒ queue ≤ the buffer, `resume_from_cursor`, 1013); (5) group reads as
    two index range scans merged in Go (measured above); (6) fast path for `since ≥ hub position` + `skipIdle`
    (`TestResumeAtPositionGoesLive`, `TestSkipIdle`); (7) `MAX_REPLAY` decided before streaming (`TestReplayTooLong` now expects no
    change before `bootstrap_required`, and exactly `MAX_REPLAY` entries replay); (8) **fixed differently:** the reviewer's first
    option ("suspend only the subscriptions whose decision may change") is not decidable for a user epoch — `u<id>` covers
    deactivation, restriction and every relation, and on-demand decisions (public repositories, visible orgs) change with them — so
    every subscription of the named user is still re-checked, but the grants are recomputed once per session before the re-checks
    (implicit groups then hit the cache) and the entries held meanwhile are sent from memory instead of re-read (`TestHeldEntries`
    delivers entries that are not in the log at all; `TestHeldEntriesOverflow`); (9) `until` always bounds a read and the hub replays
    nothing at position 0 (`TestReplayAtPositionZero`, the reviewer's scenario: only the entry before the epoch, then
    `group_revoked`); (10) the limit pre-check spends room on new groups only (`TestLimitCountsNewGroupsOnly`); (11) per-request
    staleness from the recent epochs (`TestEpochDuringCheckConcerns`: touches of other rows or in the state read, other users,
    repositories and owners are not stale; the viewer, the repository, a touch in another state, everybody, and lost epochs are); (12)
    tests added for `Skipped` (`TestSkipped`), `permission_changed` (`TestPermissionChangedUnits`), owner epochs (`TestOwnerEpoch`),
    `selfPending` (`TestSelfPending`), `HelloTimeout` (`TestHelloTimeout`), periodic and epoch-triggered re-validation ending in
    `session_invalid` (`TestRevalidate`), and the integration slow-consumer test asserts a real resume position; (13)
    `hub.ErrClosed` and `closeNormal` removed; (14) `TestTypeScriptUnions` + literal reason unions (a `switch` over `BootstrapReason`
    with a `never` default type-checks under `tsc --strict`, an unknown literal does not). All seven regression tests that compile
    against the round-0 code (3, 9, 1, 4, 2, 10 and the coalescing unit-change test) were run there and fail. Commands: gofumpt (clean),
    golangci-lint on livesync packages + `tests/integration` (0 issues), `go vet` (+ integration with sqlite tags), deadcode diff
    (clean), `go mod tidy -diff` (clean), livesync unit tests with `-race` (hub 8× repeated), `gen-protocol.sh --check` (up to date),
    `TestLivesync*|TestVersion` on PG 16 (`gtestschema`: 31 pass, 3 MySQL-only skips) and MySQL 8.0 binlog on (33 pass, 1 skip), no
    testlogger "FATAL ERROR"; fork diff unchanged (`assets/go-licenses.json`, `cmd/web.go`, `go.mod`, `go.sum`).
  - **Review round 2 (1 finding, fixed).** Over SSE a client message runs in `POST /-/sync/send` (`Hub.Send` → `conn.handle`)
    concurrently with the stream handler's deferred `stop`; a hello (or subscribe) still being handled when the stream closed
    registered the session in `byUser` and its subscriptions in `byGroup`/`subCount` after `stop` had cleaned up, for good (each leak
    took one of `MAX_CONNECTIONS_PER_USER` and up to `MAX_SUBSCRIPTIONS` of the user's room until a restart; fan-out kept queueing
    into the dead session). The cached grant/check paths do not look at the cancelled context, so the hello completed. Fix: `stop`
    and `handle` exclude each other — `stop` cancels, then takes `handleMu` (waits for the message in progress) and sets
    `conn.stopped`; `handle` returns at once when `stopped` or the context is cancelled (a `Send` that looked the session up before
    `stop` removed it). WebSocket was not affected (its messages run in the handler's own read loop). `TestStopDuringHello`: warmed
    grants, a hello blocked in the authenticator, `stop` as `ServeSSE`'s defer, then a late hello on a stopped session — on the
    round-1 code `stop` returned during the hello and `byUser[2]`, `byGroup[repo:1]` held 3 sessions and `subCount[2]` was 3 (1
    expected). Commands: gofumpt (clean), golangci-lint on livesync packages (0 issues), `go vet`, livesync unit tests with `-race`
    (hub 8× repeated), `TestLivesync*|TestVersion` on PG 16 (`gtestschema`: 31 pass, 3 skips) and MySQL 8.0 (33 pass, 1 skip), no
    testlogger "FATAL ERROR".
  - **Not done / known gaps.** No in-session token refresh (reconnect instead). Hello/subscribe checks run one `Check` per requested
    group (cached grants make implicit ones cheap; on-demand groups are one small read transaction each) — a batch check is a later
    optimisation. Cross-reference comments are still unpublished (B3's open issue; the hub has no second requirement per entry). No
    metrics yet (B8). Caps are per instance. The WS/SSE session requests do not appear in Forgejo's router log. Grants for narrower
    token scopes: still refused at hello (B4 rule).

  - **Final-review open item: flaky `TestHeldEntries` / `TestTouches` (fixed 2026-10-07).** Under load (`-race -count=5`) they
    failed at `replay_test.go:277` ("expected 4, actual 1") / `hub_test.go:523` ("expected 4, actual 3"). Cause as diagnosed:
    `releaseHeldLocked` queued the held entries (each `enqueueChange`/`send` its own `conn.mu` section, waking the writer) before
    `goLiveLocked` → `clearHold`; the writer takes `conn.mu`, not `h.mu`, so it could take them in between and claim the stale hold.
    - **Product impact: a real bug, but no loss.** The frame carrying the released entries said `to` = the epoch's position (< their
      `v`) and nothing raised it until the session's next change. Per the position contract (a group's position = highest `v`
      received, raised to `to`) the re-checked group was fine; the session's other caught-up groups kept an older position (they
      resume a little early and replay extra — what a quiet session does anyway). `to` was never too high; nothing was lost, withheld
      or stuck (the changes themselves went out in order, at once).
    - **The suggested fix ("clear the hold before enqueueing") would have been a loss bug:** with the hold gone and the entries not
      queued yet, a writer taking the queue (other groups' changes) claims `to` = hub position ≥ their `v`; a client that resumes from
      that frame never gets them. **Fix:** `releaseHeldLocked` removes the hold and queues the held entries and markers in **one
      `conn.mu` critical section** (`sendLocked`/`enqueueChangeLocked`); the writer only ever takes whole critical sections.
    - **Same pattern elsewhere (scanned every place that queues and then changes what `to` depends on):** (a) **`Deliver`** queued
      live changes and markers' `bootstrap_required` (waking the writer) before `h.pos.Store`: a writer taking the queue at once (the
      first change after a quiet period is not batched) claimed the previous position, same staleness. Now `conn.enqueueDelivered` /
      `sendDelivered` queue without waking and `Deliver` wakes the sessions it queued for (`Hub.delivered`) after storing the
      position. (b) **`revokeLocked`** removed the hold (`removeSubLocked`) *before* queueing `group_revoked`; and even in that order,
      a delta queued earlier but taken after the hold went claims the hub's position while the client still holds the revoked group as
      caught up — resumed after a re-grant, it would miss `(hold, to]` (a real, narrow loss). Now the hold goes in the critical section
      that queues `group_revoked`, and the last delta queued before it keeps the hold as a cap (`outItem.maxTo`, applied in `take`).
      Checked and fine: `goLiveLocked` after a catch-up replay (the replayed changes are queued under the hold, before it goes —
      conservative), `suspendLocked`/`setHold` (only lowers), `Skipped` (its control messages claim nothing; holds and position change
      under `h.mu` before anything else is queued), `caught_up`/`barrier_ok` (position read under `h.mu` with `busy == 0`, i.e. no
      holds; *since B8 issue round 3 they read `position()`, i.e. the holds, and `busy` is gone*), `pong` (`position()` reads the holds under `conn.mu`; queued after `group_revoked` now). **Residual, by design:** a writer
      woken for another reason (frame timer, a pong) during `Deliver` can still take changes before the position store; `to` then lags
      like a quiet session's (never too high).
    - **Mechanics:** `conn.unlock()` wakes the writer after releasing `conn.mu` (`conn.wake` set by `addedLocked`/`endLocked`); the
      writer's step is `conn.take()` (encoded frames + the position each claims), used by `writeLoop`; `conn.onWake` (tests only)
      replaces the wake. Test harness: `connectEager` (a writer that takes the queue at every wake, right after the lock was
      released — the worst case a real writer reaches only under load) and `connectManual` (the test calls `take`).
    - **Regression tests (deterministic):** `TestHeldEntriesFrameTo` (eager; checks every frame never claims an entry not yet sent and
      the last claims the released position), `TestDeliverFrameTo` (eager; a change, then a change + marker), `TestRevokeCapsQueuedFrame`
      (manual; the delta queued before `group_revoked` claims the epoch, the next one the hub position). Each was run against the old
      code paths reintroduced one at a time and fails: old release (last `to` 1, want 4), clear-first release ("a frame claims 4 before
      it was sent"), writers woken during `Deliver` (`to` 0 for `v` 1), only the marker woken early (`to` 1, want 3), old revoke (the
      delta before `group_revoked` claims 2, hold 1). (`TestDeliverFrameTo`'s second step asserted `to` = the marker's position; that
      was the hazard of round 2 below and now asserts the change's.)
    - **Integration test race fixed (pre-existing):** `TestLivesyncHub/ws` on MySQL failed now and then at `livesync_hub_test.go:437`
      ("trigger_repaired" vs "cursor_trimmed"; old code 1/20, hub fix before this test change 5/26 — same path, timing-dependent, the
      hub fix does not touch the tailer or the floor): the PATCH before the retention step creates
      user2's avatar, whose entries can be materialized after the "after" barrier; the test then set the floor to the head while the
      tailer was behind it, so the tailer skipped ahead (`Skipped` ⇒ `cursor_trimmed` to `cl`). The test now waits for a barrier on
      `other` (hub delivered ≥ the floor) before setting the floor: 20/20 MySQL, 10/10 PG.
    - **Commands:** hub package `-race -count=50` green (201 s), and again under 6 busy loops on 4 vCPU (286 s); livesync unit tests
      `-race`; `TestLivesync*|TestVersion` on PG 16 (`gtestschema`: 31 pass, 3 MySQL-only skips) and MySQL 8.0 binlog on (33 pass, 1
      skip), no testlogger "FATAL ERROR"; gofumpt clean, golangci-lint on `services/livesync/...` + `tests/integration/...` (0
      issues), `go vet`, deadcode diff clean, `gen-protocol.sh --check` up to date (wire format unchanged); fork diff unchanged
      (`assets/go-licenses.json`, `cmd/web.go`, `go.mod`, `go.sum`). MariaDB not run (no trigger change).

  - **Final-review round 2: a delta claimed a re-bootstrap marker's position before its `bootstrap_required` (major, fixed
    2026-10-07).** `take` gives the last delta of a batch `to` = hub position (capped by the holds and `maxTo` only), also when a
    `bootstrap_required` queued after it depends on that position. `bootstrap_required` carries no position, so a session that broke
    between the two writes (write timeout, reset, SSE cut) resumed the group from `to` ≥ the marker and the replay `(to, …]` never
    included it: the client kept stale data of that model for good. Deterministic since the wake-after-store change whenever one
    `Deliver` brought a change and then a marker for a session (frames `delta to=2 (marker at 2)`, `bootstrap_required`; a client
    resuming `repo:1` from 2 got `caught_up`), and on release (`releaseHeldLocked` queues held `[change, marker]`; `delta to=3`
    (marker 3)). `TestDeliverFrameTo` asserted the hazard (`to == v+1`, "the marker's position too").
    - **Root cause / scope.** The round-1 rule ("no frame before `group_revoked` may claim more than the hold") applies to every
      message that tells the client a group it holds as caught up is complete only up to some position and carries none itself.
      Scanned every `bootstrap_required`: besides the two reported, the same loss existed for (c) markers met by a **catch-up replay**
      (a re-checked subscription whose held entries overflowed: the replay queues `[change, marker]` under the hold, `goLiveLocked`
      removes it, the delta then claims the hub position), (d) **`permission_changed`** (`check` queues it while the hold is there; with
      nothing held, the release queues nothing after it and the earlier delta claims the hub position — the client resumed past the unit
      change and kept/lacked data), (e) **`restartLive`** (`replay_too_long`/`cursor_trimmed` of a catch-up: same, at the hold) and (f)
      **`Skipped`** (`cursor_trimmed` queued before `h.pos` jumps to the floor; the subscriptions' holds are at `from`, but once the
      re-check went live with nothing to replay the earlier delta claimed the floor). Not affected: `cursor_unknown` at subscribe (the
      group was not caught up for the client), replays of `stateReplay` subscriptions (not caught up; `to` does not raise their
      position — capped anyway, harmless), position-bearing control messages (`caught_up`/`pong`/`barrier_ok` read the position under
      `h.mu`/the holds before the marker is applied or after it is queued).
    - **Fix.** `conn.capLocked(limit)` caps the last delta queued so far (`outItem.capped`/`maxTo`; `capped` because a cap of 0 is
      legal: a marker at sync id 1) and is called in the critical section that queues the message: markers `limit = sync id − 1`
      (`sendDelivered(msg, limit)` in `markerLocked`; `heldItem.at` keeps the held marker's sync id for `releaseHeldLocked`; the replay
      uses `sendCapped`), `permission_changed`/`restartLive` at the subscription's hold (`sendAtHold`; nothing when it replays;
      round 3 removed it for `permission_changed`, the round-3 re-review restored it — see below),
      `Skipped` at `from`, `revokeLocked` at the hold (its inline loop replaced). Lowering `to` is always safe (positions are the highest
      `v` raised to `to`); the cost is a lagging position after a marker in a quiet session — a resume from it meets the marker once more
      (one extra `bootstrap_required`), never a loss.
    - **Tests.** `TestBootstrapCapsQueuedFrame` (manual writer; subtests `live marker`, `held marker`, `replayed marker` (catch-up
      after held overflow, `SEND_BUFFER` 2000), `permission changed` (user4 leaves org3, a `repo:1` delta queued before the epoch, an
      unrelated entry after it), `trimmed` (`Skipped` with nothing of the group after the floor)); the three marker subtests also resume
      the group in a new session from the claimed `to` and require `bootstrap_required` (`resumeGetsBootstrap`). `TestDeliverFrameTo`
      now expects `to` = the change and a resume that gets `bootstrap_required`; `TestHeldEntriesFrameTo` also checks no frame claims the
      marker before its `bootstrap_required`. Against the round-1 code every subtest fails (`to` 2/3/6/3/4 vs 1/2/5/2/1; resumed clients
      get `caught_up`); the reviewer's overlay repro passes now.
    - **Commands:** hub package `-race -count=20` green (92 s); livesync + `routers/livesync` unit tests `-race`; `TestLivesync*|TestVersion` on PG 16 (`gtestschema`: 31 pass, 3
      MySQL-only skips) and MySQL 8.0 binlog on (33 pass, 1 skip), incl. `TestLivesyncHub` (ws + sse) and
      `TestLivesyncHubSlowConsumer`, no testlogger "FATAL ERROR"; `gen-protocol.sh --check` up to date (only a doc comment in
      `messages.go`: the Positions contract now says `bootstrap_required`/`group_revoked` carry no position and nothing before them
      claims past what they are about); gofumpt
      clean, golangci-lint `services/livesync/...` + `routers/livesync/...` (0 issues), `go vet`, deadcode diff clean; fork diff unchanged
      (`assets/go-licenses.json`, `cmd/web.go`, `go.mod`, `go.sum`). Wire format unchanged. MariaDB not run (no trigger change).

  - **Final-review round 3: a missed `permission_changed` is never told again on resume (major, fixed 2026-10-07).** Round 2 listed
    `permission_changed` as case (d) and capped the delta before it at the subscription's hold (`sendAtHold`), and wrote into the
    client contract (`messages.go`, Positions above) that a client resuming from its position after missing a `bootstrap_required`
    "is told again". The cap does not make a resume tell this reason (but see *Round-3 re-review*: it is still needed so the
    position does not pass entries the client never got): a new session checks the group with the current units and replays
    `(since, now]` filtered by them; it does not know which units the client had, so it never produces `permission_changed`. The
    reviewer's overlay (user4 leaves org3 after a `repo:1` delta; frames `delta to=2`, `grants`, `bootstrap_required{org:3,
    permission_changed}`; a session resuming `org:3` from 2 got `welcome granted [{org:3 units:[]}]`, `caught_up`) showed it. A client
    trusting the contract keeps a lost unit's entities forever (units shrank) or never gets the older entities of a new unit (grew).
    The gap predates round 2; round 2 claimed to close it.
    - **Root cause.** `permission_changed` is not in the log: it is the difference between two decisions of one subscription
      (`check`: `d.Units != s.units`). Only reasons a resume re-derives (markers, `cursor_trimmed`, `replay_too_long`, revoke) are
      protected by positions.
    - **Fix: option (b), correct the contract (no wire change).** Option (a) (send `permission_changed` on resume whenever an epoch
      in `(since, now]` concerns the viewer or group) was rejected: epochs concern every subscriber of a repository on any
      collaborator/team change, touch epochs come with nearly every write batch, and a `since` older than the 64-epoch window would
      have to count as concerned, so nearly every reconnect after a while would re-bootstrap — bad for an offline-first client and
      still not exact. The grant already carries the exact information: the units are what `check` compares, so the client-side
      comparison catches exactly the missed changes (the units rule above). `messages.go`: the Positions paragraph excludes
      `permission_changed`, `GroupRequest` documents the units rule, `BootstrapPermissionChanged` says it is not sent again on resume
      (`types.gen.ts` regenerated: doc comments only). `check` queued `permission_changed` with a plain `send` (wrongly: "the cap
      only made positions lag" — reverted in the round-3 re-review).
    - **Follow-ups for later milestones.** B6: the bootstrap response must state the units it was filtered by (header line next to
      `watermark`), since after a live `permission_changed` that is what the client's data is filtered by. B10/F2: the client keeps
      units per group and compares them with every grant (welcome, subscribed) before applying the replay.
    - **Tests.** `TestPermissionChangedResume` (session_test.go): `units shrank` (members ⇒ none; the client misses
      `permission_changed` and resumes from the hub's position: grant units `[]` ≠ held `[members]`), `units grew` (none ⇒ members;
      grant `[members]`, and the older members-only entity is not in the replay — only a bootstrap brings it), `changed and undone`
      (members ⇒ none ⇒ members while away: same units, and the replay sends the members-only entity written meanwhile). The
      `permission changed` subtest of `TestBootstrapCapsQueuedFrame` (it asserted the cap) was removed (restored by the re-review). The reviewer's overlay still
      fails by design (it expects `bootstrap_required` on resume, which the contract no longer promises).
    - **Commands:** hub package `-race -count=5` green; the new/related tests `-race -count=40` green; livesync + `routers/livesync`
      unit tests `-race` (`capture` needs a real DB, not run on SQLite); `TestLivesync*|TestVersion` on PG 16 (`gtestschema`) and
      MySQL 8.0 binlog on: PG 31 pass, 3 MySQL-only skips; MySQL 33 pass, 1 skip; no testlogger "FATAL ERROR"; gofumpt clean, golangci-lint `services/livesync/...` + `routers/livesync/...`
      (0 issues), `go vet`, deadcode diff clean, `gen-protocol.sh --check` up to date; fork diff unchanged (`assets/go-licenses.json`,
      `cmd/web.go`, `go.mod`, `go.sum`). MariaDB not run (no trigger change).

  - **Round-3 re-review: removing the `permission_changed` cap lost entities in the "changed and undone" case (major, fixed
    2026-10-07).** Round 3 made `check` (`replay.go`) queue `bootstrap_required{permission_changed}` with a plain `c.send` instead of
    `c.sendAtHold`, reasoning that the cap restored nothing. But the units rule ("equal units need nothing even if they changed and
    changed back") holds only if the client's position never passes entries it did not get. Without the cap, the delta queued before
    `permission_changed` was taken after `releaseHeldLocked` removed the hold and, as the last delta of its batch, claimed
    `to = h.pos`, past the hold.
    - **Loss scenario.** Held entries the new units drop are never sent (a members-only entity after the viewer leaves the org);
      the session breaks after that delta and before `bootstrap_required` — the client's position is past them; the permission is
      restored before the reconnect; the resumed grant's units equal the held ones, so the client does nothing; the replay starts
      after the dropped entries — lost for good. Reviewer's overlay (`TestZZPermChangedUndoneAfterBreak`): frames `delta to=3`,
      `grants`, `bootstrap_required{org:3, permission_changed}`; the resume of `org:3` from 3 got `granted [members]`, `caught_up`,
      no Team v=3.
    - **Fix.** `check` queues `permission_changed` with `c.sendAtHold(s, …)` again: frames before it claim at most the hold; the
      held entries the new units drop are not sent, and a resume from the hold after the change was undone replays them (filtered by
      the restored units); if it was not undone the grant's units differ and the client bootstraps. The rest of round 3 stays (units
      rule, contract wording, grants carrying units): the cap is not what tells a missed `permission_changed`, the grant is.
      Comments corrected (`conn.sendAtHold`: re-derived reasons, and `permission_changed` for positions; `replay.go`). The original
      ordering fix (*Final-review open item*: the hold changes in the `conn.mu` section that queues the held entries) is untouched:
      `releaseHeldLocked` still deletes the hold and queues the held entries under one `conn.mu`.
    - **Tests.** `TestPermissionChangedResume/changed while connected and undone` (user4 live on `org:3` (members) and `repo:1`; a
      `repo:1` delta queued; user4 leaves org3, the epoch arrives with a members-only `org:3` Team entry, which is held and dropped by
      the new units; the client's frames up to `bootstrap_required` are taken (manual writer) and the claimed `to` must be below the
      Team entry; user4 rejoins; a resume from that `to` gets grant units `[members]` and the Team entry in the replay).
      `TestBootstrapCapsQueuedFrame/permission changed` restored (claims the epoch, not the hub position). Both fail against
      7123a93's `replay.go` (`to` 3 vs < 3; 3 vs 2); the reviewer's overlay passes.
    - **Commands:** hub package `-race -count=50` green (235 s; the ordering fix of *Final-review open item* holds); livesync +
      `routers/livesync` unit tests `-race` (`capture` needs a real DB); `TestLivesync*|TestVersion` on PG 16 (`gtestschema`: 31
      pass, 3 MySQL-only skips) and MySQL 8.0 binlog on (33 pass, 1 skip), plus `TestLivesyncHub*` `-count=3` on both, no testlogger
      "FATAL ERROR"; gofumpt clean, golangci-lint `services/livesync/...` + `routers/livesync/...` (0 issues), `go vet`, deadcode
      diff clean, `gen-protocol.sh --check` up to date (no protocol change); fork diff unchanged (`assets/go-licenses.json`,
      `cmd/web.go`, `go.mod`, `go.sum`). MariaDB not run (no trigger change).

#### B6 — Bootstrap + partial load
- [x] **Status** — done 2026-10-08 (final check: `TestLivesyncBootstrap*` (API, differential, convergence, large) + `TestLivesyncPermDifferential` + `TestVersion` green on PG 16/`gtestschema` and MySQL 8.0 binlog on, no testlogger "FATAL ERROR"; livesync unit tests, `go vet`, gofmt clean; `gen-protocol.sh --check` up to date; fork diff = `assets/go-licenses.json`, `cmd/web.go` (1 line + import), `go.mod`, `go.sum`; review round 1 fixed (15/16, item 4 completed in round 2), round 2 fixed; the open item left at close (`owner:{id}` exposed full owner `Project` rows to viewers who cannot see the owner) fixed in the *Follow-up (open item 1)*: `owner:{id}` now holds `ProjectRef`s and count-free org labels only; no open items)
- **Scope:** `GET /-/sync/bootstrap?group=` (NDJSON, first line `{watermark, schema}`,
  br/gzip, streaming, cancellable; summary tier = open + updated in the last 90 days,
  `SUMMARY_RECENCY` key), `GET /-/sync/load?group=issue:N` (lazy tier),
  `GET /-/sync/load?group=repo:N&closedBefore=…` for older closed items, workspace listing
  `GET /-/sync/workspace` (groups to keep hot, capped). Permission-checked via B4.
  Watermark read **before** the snapshot. The header line also states the viewer's units the bootstrap was filtered by
  (`units`, as in a Grant): the client compares them with its grants (B5 *units rule*, final review round 3).
- **Depends on:** B5
- **Acceptance (both DBs):** bootstrap ∪ deltas since watermark equals a fresh bootstrap
  later (convergence test with concurrent writes); unauthorized group ⇒ 403/404 without
  leaking existence; differential test: entities returned ⊆ what API v1 returns for that
  user; streaming verified with a large fixture (memory bounded).
- **Notes/decisions:**
  - **Files.** `services/livesync/protocol/bootstrap.go` (`BootstrapHeader`, `BootstrapEnd`, `Workspace`, `WorkspaceGroup`,
    `Tier*`, `Workspace*` reasons, `ParseGroup`; regenerated `next/src/protocol/types.gen.ts`, also checked with `tsc --strict`);
    `services/livesync/materialize/{snapshot,refs}.go` (+ `snapshot_test.go`; `commentDTO` extracted in `specs_render.go`);
    `services/livesync/bootstrap/{bootstrap,workspace}.go` (+ SQLite unit tests); `routers/livesync/bootstrap.go` (+ `bootstrap_test.go`),
    `routes.go`; `services/livesync/settings.go`; `tests/integration/livesync_bootstrap_test.go`; `go.mod` (`andybalholm/brotli`
    indirect → direct; it was already compiled in, so `go.sum` / `go-licenses.json` unchanged, `make tidy-check` clean).
  - **Endpoints** (all bearer-token authenticated with B4's `authenticate`, JSON errors like `/-/sync/grants`):
    `GET /-/sync/bootstrap?group=G[&model=M,…]` — any client group; `repo:{id}` ⇒ summary tier, the others ⇒ everything (`full`).
    `GET /-/sync/load?group=issue:{id}[&model=…]` — the lazy tier (same as its bootstrap). `GET /-/sync/load?group=repo:{id}&closedBefore=C[&limit=N]`
    — a page of older closed issues/PRs (newest first; `C` = `<unix>` or `<unix>.<id>`, start with the summary header's `closed_before`;
    `limit` default 500, max 2000; the end line's `next` is the next page's `closedBefore`). `GET /-/sync/workspace` (`protocol.Workspace`).
    400 for a missing group, an unknown model, `closedBefore` on bootstrap, `load` of other kinds. **A group the viewer may not read or
    that does not exist is always `404 {"message":"Not Found"}`** (never 403; same body for both). **503 + `Retry-After: 2`** while the
    entity index walk of a table the response reads is not `done` (B3's gate; also after a re-bootstrap marker restarted it). 401/403 as
    `/-/sync/grants`.
  - **Format (client contract, documented on `protocol.BootstrapHeader`).** NDJSON: header `{type:"header", group, watermark, units,
    tier: full|summary|closed, schemas, models?, closed_before?, before?}`, then entity lines = `protocol.Change` (`op:"U"`, **`v` = watermark**),
    the group's own entities first, then embedded profiles of other groups, then `{type:"end", count, refs, next?}`. **No end line ⇒
    incomplete** (an error after the headers only drops the end line and closes the encoder; the status is already 200). A full/summary
    response **replaces** what the client holds of the group (of `models` when filtered): drop the group's entities with `v ≤ watermark`
    not in the response; closed pages and profile lines of other groups only add. **(Review round 1: the replacement is limited to the
    tier's scope, closed pages replace their range, embedded lines set no position — see *Review round 1*, items 3 and 4.)** Subscribe
    with `since = watermark` (B5: allowed to be ahead of the hub). `units` = the viewer's units the response was filtered by (B5 units rule: compare with every later grant). The
    header's `schemas` lists the models the response may contain plus `User`.
  - **Consistency (decision: index-presence filter, no barrier).** The watermark W (`synclog.Head`) is read first, then the gate, then
    the snapshot. Each chunk (≤ 500 rows, 100 for comment/review/release) is read in its own short quiet read transaction on the master
    (`capture.WithQuietTx`; review round 1: a source's candidate ids are read first, through its conditions' indexes, then chunked in
    Go): candidate ids → `spec.load` (the materializer's loaders, placement and DTOs) → keep entities placed in the
    group, allowed by the units and the model filter → **keep only those with a `livesync_entity` row**. Why it converges: an indexed
    entity's later changes/moves/deletes are materialized after the chunk was read, i.e. after W, so they get sync ids > W (the log head
    row stays locked until a writer transaction commits); an unindexed one has a pending outbox change (it arrives as a delta > W) or
    was inserted and deleted and coalesced (no delete is ever emitted — B3's "around the snapshot" case — so it must not be in a
    bootstrap) or is not in the log at all (a later bootstrap leaves it out too). B3's suggested "wait until the capture cursor passes
    the outbox ids committed before the snapshot" was **not** used: it does not cover a delete committed after the snapshot but coalesced
    with the insert, and it would block bootstraps on long transactions / deferred hot rows. **The gate is read after W** (review of my
    own first version): a marker and its `repair:0` restart are one transaction, so the marker is either above W (the client gets
    `bootstrap_required` and loads again) or the gate sees the walk (503). Markdown of an entity whose index hash equals its current
    change hash is taken from its last log entry (if not trimmed) instead of being rendered again.
  - **Tiers / candidate rows** (`materialize/snapshot.go` `snapshotSources`; candidates may be a superset, placement decides; the
    unit test `TestSnapshotCoversPlacement` checks that every fixture row of every tracked table is in its group's snapshot and nothing
    else). `repo:` summary: repository, units, collaborations, labels, milestones, projects + columns, branches, published releases (+
    their attachments), **issues/PRs open or updated since `now − SUMMARY_RECENCY`** with their labels, assignees, project cards, pull
    requests, auto-merges (read per chunk of issues through their `issue_id`/`pull_id` index: `source.children`), **commit statuses and
    action runs/jobs updated since the cutoff** (older ones are not loadable through livesync: online via API v1). `closed` tier: closed
    issues not updated since the cutoff + the same children. `issue:` body, comments, reviews, reactions/attachments/revisions (also by
    `comment_id` of the issue's comments), ~~dependencies, tracked times~~ (review round 1: dependencies are conditional entities of the
    load, tracked times are in `user:`). `user:` access, notifications (**read ones only if updated since the cutoff**), stopwatches,
    issue watches, watches, stars, blocks, viewed files, tracked times (not deleted), the user's pending reviews and their comments (+
    reactions, attachments, revisions). `profile:` the private user + their projects/columns; directories: the users of that visibility;
    `org:` the org's profile, memberships, teams (+ users/repos/units), org labels, org projects/columns. **(Review round 2: org labels
    and user/org projects moved to the new `owner:{id}` group; `profile:`/`org:` keep the projects' columns — see *Review round 2*.
    Follow-up: the `Project`s are back in `profile:`/`org:`; `owner:{id}` = org labels + the projects' `ProjectRef`s.)**
  - **Profiles a bootstrap refers to (orchestrator note B3/B4).** `materialize.userRefs` reads the DTO fields that name users
    (`poster_id`, `user_id`, `owner_id`, `assignee_id`, … — `TestUserRefFields` makes every integer `*_id` field of every DTO classified).
    At the end the groups of those users' User entities are decided (`ProfileGroups`) and checked for the viewer (cached grants first,
    else `perm.Cache.Check`, at most 1000 checks per response — review round 1: one `perm.Cache.CheckGroups` batch, no cap): readable
    groups go to `end.refs`; the profiles in **per-user groups**
    (`profile:{id}` private users — only the user themselves and admins, B4's API rule — and `org:{id}`) are **embedded** as change lines
    with their own `g`; the directories are only listed (the workspace subscribes and bootstraps them). The requested group itself is
    never listed. Unreadable referenced profiles (another user's private profile) are neither listed nor sent.
  - **Cross-references (B3's open issue, partly resolved; review round 1: generalised to `materialize.Conditionals` /
    `bootstrap.conditionals`, which also carry the issue's dependencies, decided with `CheckGroups`).** A load of `issue:{id}` adds the comments that reference the issue from
    other repositories that the viewer may see (`materialize.CrossReferences` + `bootstrap.crossReferences`: `perm.Cache.Check(repo:{ref})`
    must allow `issues`, or `pulls` for a PR reference — upstream's `filterXRefComments`; `TestCrossReferences` compares with
    `GetUserRepoPermission(...).CanReadIssuesOrPulls`). They are still **not in the sync log**: no delta adds/changes/removes them; the next
    load refreshes them (documented in the protocol). Their attachments/reactions are not included. A live solution needs the "second
    requirement per entry" design from the B3 notes.
  - **B3 placement fix found by the differential test: tags without a release need the `code` unit** (were `releases`; API v1's release
    routes 404 for `is_tag` rows and `/tags` needs code). `placementVersions["release"] = 1` ⇒ existing databases get `B` markers
    (`placement_changed`) for Release and a repair walk once.
  - **Workspace** (`bootstrap.Workspace`): the implicit grants' non-repository groups (reasons `self`, `profile`, `directory`, `member`),
    then repositories = implicit repo grants (`owner` if `owner_id` = viewer, else `access`) ∪ watched repositories
    (`repo_model.BuilderWatchAnything`, checked on demand, reason `watch`), sorted by `repository.updated_unix` desc, capped at
    `WORKSPACE_MAX_REPOS` (`truncated`). Units are the grants'. Review round 1: the watched repositories are decided in one batch, and the
    organizations owning the listed repositories that the viewer may see without being a member come before them (reason `repo_owner`). Admins get only their own relations (B4 rule). Pins are client-side.
    Review round 2: also the owner groups — the viewer's own `owner:{me}` (`profile`), member organizations' (`member`) and those of the
    listed repositories' owners (`repo_owner`, decided in the same batch as the organizations).
  - **Transport.** `Content-Type: application/x-ndjson; charset=utf-8`, `Cache-Control: no-store`, `Vary: Accept-Encoding`, chunked;
    `Accept-Encoding` ⇒ `br` (quality 4, 256 KiB window) > `gzip` (default level) > identity; the encoder and the HTTP writer are
    flushed after the header and after every chunk; cancelled with the request context (checked between chunks, DB reads use it).
    Served through livesync's router (Forgejo's `context.Response` implements `http.Flusher`).
  - **Settings added:** `SUMMARY_RECENCY` (default 2160h = 90 days, > 0), `WORKSPACE_MAX_REPOS` (default 200, > 0).
  - **APIs for later milestones.** `bootstrap.Prepare(ctx, Request) (*Prepared, pending []string, error)` + `Prepared.Stream(ctx, w,
    flush, perms)`; `bootstrap.Workspace`; `materialize.Snapshot(ctx, SnapshotRequest, emit)`, `SnapshotTables`, `SnapshotModels`,
    `BackfillPending`, `ProfileGroups`, `Profiles`, `CrossReferences`, `ClosedCursor`/`ParseClosedCursor`; `protocol.ParseGroup`. **For
    F2:** the contract above; on `bootstrap_required{model}` reload with `?model=`; on 503 retry after `Retry-After`; keep `units` per
    group. **For B7:** nothing (bootstraps are reads). **For B8:** metrics (bootstrap bytes/duration, 503s) are not added; there is no
    per-instance limit on concurrent bootstraps yet (each holds one DB connection per chunk read, never across client writes).
    Snapshots are viewer-independent except for the unit filter, the embedded profiles and the cross-references (PLAN §4.11 invariant 4:
    a shared snapshot cache would cache the unfiltered group and filter per viewer).
  - **Tests.** Unit (SQLite fixtures): `materialize` — `TestSnapshotCoversPlacement`, `TestSnapshotPayloads` (payloads = the log's;
    unchanged markdown not rendered again; user refs), `TestSnapshotIndexFilter` (an unmaterialized insert is left out until consumed;
    insert+delete coalesced ⇒ never in a snapshot and no delete in the log), `TestSnapshotTiers` (summary vs. closed pages of one,
    newest first, children only with their issue, cursor round trip), `TestSnapshotFilters` (units, models, tables, models list),
    `TestBackfillPending`, `TestProfiles`, `TestClosedCursor`, `TestUserRefFields`, `TestReleasePlace`; `bootstrap` — `TestStream`
    (header, flushes, count, refs, embedded org profile, own private profile embedded / another's not, model filter, no units, closed
    tier), `TestCrossReferences` (repo 32 made private; five viewers vs. upstream; verified to fail without the filter), `TestPrepareGate`,
    `TestWorkspace`, `TestAppendChange`; `routers/livesync` — `TestNegotiateEncoding`, `TestCompress` (br/gzip/identity: flushed data
    decodes before the end), routing cases; settings. Integration (**PG 16 `gtestschema` and MySQL 8.0 binlog on, all green, no
    testlogger "FATAL ERROR"**): `TestLivesyncBootstrapAPI` (401, 400s, identical 404s for unreadable/missing/pseudo groups, the gate's
    503 + Retry-After, header units = `/-/sync/grants?group=` units, tiers, closed page, lazy load, model filter, br/gzip/identity over
    a real listener with the same entities and no Content-Length, workspace reasons and units = grants), **`TestLivesyncBootstrapDifferential`**
    (every fixture user who may sign in × every repository: bootstrap 404 ⇔ grant 404; repository ⇒ `GET /repos/{o}/{r}` 200; issues ⊆
    `/issues?state=all`, labels, milestones (`state=all`), releases ⊆ API v1 (tags: only with the code unit); up to 3 issue loads per
    repository: body ⇒ `/issues/{n}` 200, comments ⊆ `/issues/{n}/comments`, reviews ⊆ `/pulls/{n}/reviews`; every organization: teams,
    labels, members (`members`/`public_members` by unit; inactive members skipped, API v1 lists active ones) ⊆ API v1; own stars ⊆
    `/user/starred`; directories ⇒ `/users/{name}` 200 for four viewers; 88 s PG / 123 s MySQL), **`TestLivesyncBootstrapConvergence`**
    (3 writers over the real listener — issues created/closed, comments created/edited/deleted, labels created/attached/deleted, the
    body edited; 3 rounds of bootstraps of `repo:1` and `issue:1` while they write, each followed by a WebSocket subscription from its
    watermark; after a barrier, every replica = a fresh bootstrap, entity by entity; each writer has its own kinds of writes because
    upstream deadlocks on MySQL (`Error 1213` in `CreateComment`'s `num_comments` subquery) when two comments are created on one issue
    concurrently, livesync or not), **`TestLivesyncBootstrapLarge`** (40 000 issues bulk-inserted and materialized in ≈ 7 s; a 25 MB
    bootstrap read over the real listener while the test samples the live heap after a GC every 2 000 lines: growth 2–6 MB, asserted
    below half the response).
  - **Commands run:** gofumpt (clean), `golangci-lint run ./services/livesync/... ./routers/livesync/... ./models/livesync/...
    ./tests/integration/...` (0 issues), `go vet` (+ integration with sqlite tags), deadcode diff (clean), `go mod tidy -diff` and
    `make tidy-check` (clean), unit tests of every livesync package, `next/tools/gen-protocol.sh --check` (up to date) + `tsc --strict` on
    the generated file, `./integrations.pgsql.test -test.run 'TestLivesync|TestVersion'` with `tests/pgsql.ini` (35 pass, 3 skips) and
    `tests/mysql.ini` (37 pass, 1 skip), fork-diff check unchanged (`assets/go-licenses.json`, `cmd/web.go`, `go.mod`, `go.sum` — `go.mod`
    gained only the brotli direct requirement); dev binary smoke test on PG with `ENABLED = true` (repository + issue via API ⇒ workspace,
    `bootstrap?group=repo:N` with br, `load?group=issue:N` with rendered body and @mention, 401 without token; dev DB triggers dropped
    afterwards). MariaDB not run (no trigger change). The F1 merge (pulled before the notes) does not touch `services/livesync`;
    `next/` lint/typecheck were not run (no `next/node_modules`; only the generated file changed there).
  - **Known gaps / for later.** No live sync of cross-references (above). Referenced private users' profiles are invisible to others
    (B4's API rule; API v1 still shows such a poster's name in issue JSON). Older commit statuses / action runs and old read
    notifications are not loadable through livesync. The summary header's `schemas` lists every model of the tables read (e.g. `Issue`
    for an `issue:` load, which never contains one). No concurrent-bootstrap limit and no metrics (B8). Fixture quirk: team units have
    no `org_id`, so they are placed in `org:0`, which no client can name (B3 placement, harmless; skipped in the coverage test).
    `TestLivesyncHubSlowConsumer` (B5) failed once on MySQL in a full run under load ("frames were written until the socket was full")
    and passed 3/3 alone and in the next full run — watch it.
  - **Review round 1 (16 findings: 15 fixed; finding 4's "org labels reachable" fixed for organizations the viewer may see, open for
    the others — see item 4).** Commits `7078979` … `9da58e8` (+ these notes).
    1. *(major) `issue:{id}` candidates as `issue_id = N OR comment_id IN (…)`.* Each source now has a list of conditions, each read on
       its own (`from(table, conds…)`); the candidates are their union. Measured on a PG 16 scratch DB (3M issues, 1M comments over 20k
       issues, 1M reactions; dropped afterwards): round-0 shape 158 ms (`reaction_pkey` walk, 999 950 rows removed); `issue_id = 7`
       0.27 ms (bitmap scan), `comment_id IN (SELECT id FROM comment WHERE issue_id = 7)` 0.56 ms (nested loop over both indexes).
    2. *(major) keyset paging walked the primary key.* `Snapshot` reads a source's candidate ids once, without `ORDER BY id … LIMIT`
       (8 bytes each; e.g. 1M public users = 8 MB), and chunks them in Go. Reading them before the chunks is as consistent as per chunk: a
       row that enters the candidates later changed after W (doc in `snapshot.go`). Scratch DB, a repository with 60k issues spread over
       3M, 100 open: round 0 685 ms per chunk (`issue_pkey` walk, 2 999 900 rows removed); now 205 ms once (bitmap on `repo_id`; the
       synthetic layout puts every row on its own heap block, so heap fetches dominate). Splitting `repo_id AND (open OR recent)` in two
       did not help (lossy BitmapAnd). This covers commit statuses, action runs/jobs, notifications and every other source; the
       cross-reference/dependency reads no longer page by id either. **`TestSnapshotQueries`** records the SQL of `repo:1`/`issue:1`/
       `user:1`/`org:3` snapshots (an xorm logger on the master engine): no `ORDER BY … LIMIT`, no `OR` in reaction/attachment/revision
       queries — fails on the round-0 code. **Not changed:** the closed page keeps `ORDER BY updated_unix DESC, id DESC LIMIT n+1`: PG
       plans a top-N sort over the repository's rows via `repo_id` (scratch: 240 ms per page for 60k issues); without an upstream
       `(repo_id, is_closed, updated_unix)` index a page costs O(issues of the repository). Acceptable for a lazy, user-driven load; noted.
    3. *(major) contract: a summary re-bootstrap "replaced" the closed tier.* `protocol.BootstrapHeader` now defines the replacement
       **scope**: everything in the group except what the tier leaves out — in a summary the closed tier (Issues held as closed with
       `updated_at` < `closed_before` and what hangs off them: IssueLabel/IssueAssignee/ProjectIssue/PullRequest by `issue_id`, AutoMerge
       by `pull_id`) and CommitStatus/ActionRun/ActionRunJob with `updated_at` < `closed_before`; in a `user:{id}` bootstrap (its header
       now has `closed_before` too) the read Notifications older than it. Decided on the held entities after applying the response. Units
       different from the held ones ⇒ the scope is the whole group (the closed tier goes too). A dropped Issue takes its `issue:{id}`
       group with it. A closed page (new header field **`before`** = its `closedBefore`) replaces the closed tier in its range:
       `(updated_at, id)` < `before` and ≥ `end.next` (or down to the oldest), plus what hangs off the page's issues. Kept closed-tier
       entities may be stale after missed deltas until their pages are loaded again (documented). `TestSnapshotTiers` checks the page
       ranges, `TestStream`/`TestLivesyncBootstrapAPI` the header fields. **For F2:** implement exactly this; the doc comment on
       `BootstrapHeader` (and `types.gen.ts`) is the only definition.
    4. *(major) referenced org groups left partial — **reachability completed in review round 2**, see below.* Contract: an embedded profile line only adds the entity — it is no bootstrap of its
       group and does not set or raise that group's position (`messages.go`'s positions rule amended); to hold a referenced group,
       bootstrap it and subscribe from that bootstrap's watermark (`end.refs` no longer says "subscribe with since = watermark").
       Reachability: the workspace lists the organizations owning its repositories that the viewer may see (reason **`repo_owner`**,
       units = the grant's), so their labels/projects/teams get bootstrapped. **Open:** an organization the viewer may not see (a private
       organization's outside collaborator): its labels referenced by `IssueLabel` stay unreachable (upstream's issue JSON shows their
       names and colours). Placing org labels where every repository reader sees them needs a second placement per label (one entity,
       one group); left for a decision (options: a derived entity `label#repo:{id}` per using repository, or labels embedded in
       summaries like profiles).
    5. *(major) differential test.* `TestLivesyncBootstrapDifferential` now compares every served model with API v1 (units ⊆ `has_*`,
       collaborators, issue labels/assignees via the issue JSON, pull requests via their issue's `pull_request`, branches, statuses by
       sha, action runs/jobs, release assets, every comment type ⊆ `/timeline` (which applies the cross-reference filter), code
       comments ⊆ their review's comments, reactions (user, content), issue/comment assets, dependencies, tracked times ⊆ `/user/times`,
       notifications ⊆ `/notifications?all=true`, embedded profile lines ⇒ `/users|orgs/{name}`), creates the rows the fixtures lack
       (issue/comment revisions, dependencies incl. one on a private repository's issue, dependencies enabled via API), and asserts each
       model was compared (counts logged, e.g. Comment 1625, IssueDependency 29, ContentHistory 54, TrackedTime 7). Exceptions (no API
       v1, or the web UI shows more), checked against the unit instead: projects/columns (projects), revisions (the issue's), deleted
       branches (code: the web branch list shows them), code comments without a review (pulls: only the web files view lists them).
       **Fixed what it found:** (a) `TrackedTime` → `user:{user_id}` `self` (like `/user/times`; an issue's list needs the time tracker
       and shows non-writers only their own), deleted → no group; (b) `IssueDependency` → no group, sent by issue loads per viewer
       (`Conditionals`: dependencies enabled, the dependency's repository readable with issues/pulls, as `GetIssueDependencies`); (c)
       `Reaction` of a type not in `[ui] REACTIONS` → no group (upstream's `FindReactions` hides them everywhere); the allowed types are
       hashed into the reaction table's placement version (`placementVersion`), so changing them re-places reactions at the next start.
       Placement versions 1 of `tracked_time`, `issue_dependency`, `reaction` ⇒ `placement_changed` markers + repair walks once on
       existing databases; `hub/models.go`: TrackedTime kinds `user` + `issue` (old placement). The test avoids `/pulls` (upstream's
       `ToAPIPullRequest` logs errors for fixture PRs without git refs). Tests `TestTrackedTimePlace`, `TestReactionPlace`,
       `TestDependencies` (vs `GetUserRepoPermission`).
    6. *(major) convergence test did not exercise the index-presence filter.* `livesyncPauseMaterializer` holds the `log_head` row lock
       (the materializer waits in `Append` after reading its batch; detected via `pg_stat_activity` / MySQL `processlist` — MySQL's
       `innodb_trx` did not list the waiting transaction); while it is paused a comment and a label are created (asserted pending in the
       outbox and absent from the bootstraps), bootstraps of `issue:1`/`repo:1` are taken and followed, the two are deleted, the
       materializer resumes (asserted: no log entry for either); those replicas must equal fresh bootstraps at the end. The concurrent
       writers also create-and-delete comments and labels. **Verified:** with the filter removed from `snapshotRows` the test fails on PG.
    7. *(major) child tables reloaded the chunk's issues.* One loader per chunk transaction shared by the source and its children
       (`snapshotRows(ctx, l, …)`); `pull_request`'s spec caches its rows for the auto-merges; the git repositories opened for rendering
       are kept for the whole snapshot (`closeGitRepos`). `TestSnapshotQueries`: the summary chunk reads full issue rows once and pull
       requests once (4 issue reads on round 0). No snapshot-wide parent cache (memory would grow with the group).
    8. *(minor) up to 1000 sequential checks for refs.* `perm.Cache.CheckGroups(ctx, viewer, groups)`: cached grants first, then one read
       transaction with a fixed number of queries (user rows; the viewer's `org_user` rows among the organizations; per 500 repositories
       their rows, owners and units with B4's `repoPermission`); profiles are decided by `profileVisible` without queries; issue groups
       one by one. **`TestCheckGroups`**: the same decisions (units, repository, basis) as `Check` for every fixture user × every group,
       with and without cached grants. `profileRefs` uses it, no cap (**`TestProfileRefsMany`**: 1200 private profiles for the admin;
       round 0 returned 1000).
    9. *(minor) the gate waited for permission walks.* `BackfillPending` treats `perm:<id>` as done (a permission walk writes only the
       perm column). That needs `perm:` to mean "index complete": `HandleEpochs` started a permission walk in place of an **unfinished
       initial walk** (which then left the rows not yet reached unindexed); such a table now gets a repair walk instead (no markers).
       `TestHandleEpochsIncompleteWalk` (fails on round 0), `TestBackfillPending`.
    10. *(minor) closed page/cursor built from unreadable rows.* `closedPage` filters `is_pull` by the viewer's issues/pulls units
        (neither ⇒ no page). `TestSnapshotTiers` (pull request 2 closed: an issues-only viewer gets issue 5 and no cursor; fails without
        the filter).
    11. *(minor) workspace N+1.* The watched repositories are decided with one `CheckGroups` batch before the cap (unreadable ones no
        longer cost a full check each); `TestWorkspace` checks every group's units against `Check`, and the `repo_owner` reason.
    12. *(minor) writers outliving a failed test.* `stopWriters := sync.OnceFunc(close + Wait)`, deferred right after the writers start.
    13. *(minor) no regression test for ddb14e1.* `Prepare` calls a test-only hook (`betweenReads`) between the watermark and the gate;
        **`TestPrepareOrder`** writes a marker + `repair:0` there (`HandleEpochs`) and asserts that the gate refuses and that the
        watermark predates the marker. Fails with the two reads swapped.
    14. *(minor) duplicated parsing/limits.* `protocol.ParseGroup` (moved to `protocol.go`) is the only parser: `perm.parseGroup` maps its
        prefix to a kind, `hub.groupKind` returns it. `materialize.MaxClosedPage` is the router's limit too.
    15. *(minor) closed pages' children untested.* `TestSnapshotTiers` asserts that every IssueLabel/IssueAssignee/ProjectIssue/
        PullRequest of the closed issues is in their page and not in the summary.
    16. *(minor) SURFACE.md.* 40 000 issues; rows for the mirrored reaction/tracked-time/dependency rules, `CheckGroups`, the new columns
        and the API v1 endpoints the differential test uses.
    - **Known gaps added:** dependencies are not live (like cross-references: the next load refreshes them); with `[attachment] ENABLED
      = false` API v1 answers 404 for assets while livesync still sends attachment metadata (config-dependent like reactions; not
      fixed); the closed-page cost (item 2); ~~org labels of organizations the viewer may not see (item 4)~~ (resolved in round 2).
    - **Commands run (round 1):** gofumpt (clean), `golangci-lint run ./services/livesync/... ./routers/livesync/... ./models/livesync/...
      ./tests/integration/...` (0 issues), `go vet` (+ integration with sqlite tags), deadcode diff (clean), livesync unit tests with
      `-race` (every package but `capture`, which needs a real DB), `next/tools/gen-protocol.sh --check` (regenerated: `before`,
      `repo_owner`, doc comments), `TestLivesyncBootstrapConvergence` 5× PG / 3× MySQL, and `./integrations.pgsql.test -test.run
      'TestLivesync|TestVersion'` on PG 16 (`gtestschema`: 35 pass, 3 MySQL-only skips) and MySQL 8.0 binlog on (37 pass, 1
      skip), no testlogger "FATAL ERROR". No `go.mod` change; fork diff unchanged (`assets/go-licenses.json`, `cmd/web.go`, `go.mod`,
      `go.sum`). The first full PG run failed once in the convergence test: a fixture reload resets id sequences, so the paused
      phase's comment reused the id of a comment an earlier test created (its reload delete was in the log); the check now reads
      the log from a cursor taken before the pause (`9da58e8`).
  - **Review round 2 (1 finding, fixed): org labels and owner projects unreachable for viewers who cannot see the owner** (round 1's
    item 4, left open). An outside collaborator of a private organization's repository, or a restricted user with access to a
    repository of a limited organization, got `IssueLabel`/`ProjectIssue` rows (`repo:{id}`) naming org labels / org projects placed
    only in `org:{owner}`, which `perm` refuses them (`HasOrgOrUserVisible`); upstream shows them those labels (issue JSON, the
    repository's label page) and projects (issue list filter, issue sidebar). **Decision: a new group kind `owner:{id}`
    (`protocol.OwnerGroup`, `GroupPrefixOwner`) holding what an owner shares with its repositories — organization labels and the
    projects a user or organization owns — instead of a derived per-repository label entity (labels × repositories copies, one
    label edit fanning out to every repository) or labels embedded in summaries like profiles (not live: label edits and newly
    attached org labels would not reach the client until the next bootstrap).** One entity, one group, live like any other group.
    - **Readable** (`perm/owner.go`) like upstream's `RetrieveLabels` / `retrieveProjects` (SURFACE.md): by everyone who may read the
      owner's own group (`HasOrgOrUserVisible` for an organization, `profileVisible` for a user), else **through a repository of the
      owner whose issues or pull requests the viewer may read** — without seeing the owner, only collaborators have access
      (`GetUserRepoPermission`), so the candidates are the viewer's `collaboration` rows on the owner's repositories; the one with the
      smallest id decides and is the decision's `RepoID` (so B5's `byRepo` index re-checks the subscription on that repository's
      epochs; the re-check then finds another repository if there is one). Units: base only (every entity `UnitNone`). Implicit
      grants: `owner:{me}`, `owner:{org}` for member organizations, and the owner of every granted repository with issues/pulls
      (`Grants.addOwner`, `ownerRepos` for the through-a-repository case; `Grants.decision` is now the one place a cached decision is
      built, used by `Check` and `CheckGroups`). `CheckGroups` decides owner groups in its batch (`checkOwners`: owner rows and
      memberships with the organizations', one collaboration query for the owners not visible, `repoPermission` from the viewer's
      inputs). Epochs: `Owners` now also re-check `owner:{id}` subscriptions (hub `permissionLocked`/`epochConcerns`) and drop cached
      grants holding it (`perm.changedGroups`); repository epochs reach through-a-repository decisions via `RepoID`; the viewer's
      collaboration/team changes via `Users`; owner/repository row touches via the decision's `Basis` (owner row + deciding repository).
    - **Placement** *(the `project` part is superseded by the follow-up below: the `Project` went back to `org:`/`profile:`,
      `owner:{id}` holds a reduced `ProjectRef`)*: `label` with `org_id` → `owner:{org_id}`; `project` with `repo_id = 0` (user or organization project) →
      `owner:{owner_id}`; **`project_board` unchanged** (`org:{id}` / `profile:{id}`, new `loader.columnPlace`): upstream shows an
      owner's boards only on the owner's pages, so a viewer reading through a repository gets the project (title) of a card, not its
      columns (`ProjectIssue.column_id` stays unresolved for them, as upstream). Placement versions **label 1, project 2** ⇒ existing
      databases get `placement_changed` markers for Label and Project and a repair walk once (moves: `D` in `org:`/`profile:`, `U` in
      `owner:`); hub `modelKinds`: Label `repo, owner, org`, Project `repo, owner, org, profile` (old kinds kept for the markers).
      Snapshots: `owner:{id}` = `label(org_id)` + `project(owner_id, repo_id = 0)`; `org:`/`profile:` read only the columns now.
    - **Reachability:** a `repo:{id}` response's `end.refs` lists `owner:{repo owner}` when readable (never embedded;
      `materialize.RepositoryOwner`, `bootstrap.ownerRefs`; `BootstrapEnd.Refs` doc updated); the workspace lists the owner groups
      (see *Workspace*). `protocol` docs: `OwnerGroup`, `OrgGroup`/`ProfileGroup` (columns only), `Unit`, `PermissionChange`,
      `Grants`, `Workspace*` reasons; `types.gen.ts` regenerated (`GroupPrefixOwner` + comments).
    - **For F2:** hold `owner:{id}` of every repository you hold (the workspace lists them; `end.refs` names it); org labels / owner
      projects arrive there, columns in `org:`/`profile:` when readable. `owner:{id}` may be granted while `org:{id}` is not.
    - **Tests:** `perm` **`TestCheckOwner`** (every fixture viewer × every user/org: `Check(owner:)` ⇔ visible (upstream functions) or
      some repository of the owner with `GetUserRepoPermission` issues/pulls, `RepoID` = the smallest such when not visible, implicit
      grants agree; user4 → `owner:23` through repository 40 while `org:23` is refused, with and without cached grants; repository /
      owner epochs drop the cached grants; gone without the collaboration), `TestCheckGroups` (owner groups added: batch = `Check`,
      `RepoID` and `Basis` included); `hub` **`TestOwnerGroupThroughRepository`** (user4 subscribed to `owner:23` receives its label
      delta, an epoch of another repository leaves it alone, issues/pulls disabled on repository 40 + its epoch ⇒ `group_revoked`;
      verified to fail with `RepoID` not set), `TestOwnerEpoch` (owner epoch ⇒ `org:3` and `owner:3` revoked); `materialize`
      `TestProfilePlacement` (project → `owner:2`, its column → `profile:2`), `TestConsumePlacement`, `TestHandleEpochsPlacementAndPermissions`
      (Label/Project markers, versions), `TestSnapshotFilters` (`org:3`/`owner:3` models), `TestSnapshotCoversPlacement` (unchanged, covers
      `owner:`); `bootstrap` **`TestOwnerGroupReachable`** (an org label, org project + column on a new issue of repository 40: user4's
      `repo:40` bootstrap names them and lists `owner:23` but not `org:23` in `end.refs`, `owner:23` holds exactly the label and the
      project, the workspace lists `owner:23` as `repo_owner` and no `org:23`; user10 refused, member user5 allowed), `TestStream`
      (refs `owner:2`/`owner:3`, never embedded), `TestWorkspace` (reasons of `owner:2`/`owner:3`). Integration
      **`TestLivesyncBootstrapDifferential`** extended: an org label (API) and org project (DB) on an issue of repository 40; for
      every viewer × repository every org label / owner project named by `IssueLabel`/`ProjectIssue` (of the repository's owner) is
      in the `owner:` bootstrap that `end.refs` lists, asserted to happen at least once for an organization whose `org:` group the
      viewer may not read; for every viewer × user `owner:{id}` 404 ⇔ bootstrap 404, readable ⇒ the owner is visible through API v1
      (`/orgs|users/{name}` 200) or the viewer reads the issues/pulls of one of its repositories, org labels ⊆ `/orgs/{org}/labels`
      when visible. Fixture quirks (label 4 of org3 on user2/repo1's issue, user2's project 4 on org3's repository 32 — upstream's
      `NewIssueLabel` / `Project.CanBeAccessedByOwnerRepo` refuse such rows) are left out of that check; such a foreign label/project
      is in its own owner's group, readable or not. **`TestLivesyncPermDifferential`** extended: for every viewer × user/organization,
      `owner:{id}` granted ⇔ `/orgs/{org}` or `/users/{name}` 200 or the viewer reads (as compared with API v1 in the same test) the
      issues or pull requests of one of its repositories; implicit owner grants = the on-demand check (it first failed with
      "unexpected implicit grant owner:N" until the test knew the new kind).
    - **Known gaps:** an issue keeps its project card after its repository is transferred (`TransferOwnership` removes old org labels,
      not project cards); the card then names the old owner's project, in that owner's `owner:` group, which the new readers may not
      read (upstream's sidebar still shows the title). `ProjectIssue.column_id` of owner projects is unresolved for viewers reading only
      through a repository (as upstream).
    - **Commands run (round 2):** gofumpt (clean), `golangci-lint run ./services/livesync/... ./routers/livesync/... ./models/livesync/...
      ./tests/integration/...` (0 issues), `go vet` (+ integration with sqlite tags), deadcode diff (clean), livesync unit tests with
      `-race` (all packages), `next/tools/gen-protocol.sh` (regenerated) and `--check`, `TestLivesyncBootstrapDifferential` on PG
      (123 s; e.g. Label 147, Project 144, IssueLabel 111, ProjectIssue 167 compared), and `./integrations.pgsql.test -test.run
      'TestLivesync|TestVersion'` on PG 16 (`gtestschema`) and MySQL 8.0 binlog on — results below.
    - **Results (round 2, from the reviewer's re-run on the working tree):** livesync unit tests pass (all packages),
      `gen-protocol.sh --check` up to date, gofmt clean; `TestLivesync|TestVersion` on PG 16 (35 pass, 3 skips, no testlogger
      "FATAL ERROR") and MySQL 8.0 binlog on (37 pass, 1 skip). The MySQL run logged one testlogger "FATAL ERROR": the upstream
      `UPDATE issue SET num_comments` deadlock (`Error 1213`) between the convergence test's concurrent comment writers; the test
      still passed, unrelated to the fix (see *Tests*). Code committed as `d38b900`.
  - **Final check (2026-10-08):** working tree committed; gofmt clean, `go vet` (sqlite tags) clean, livesync unit tests pass
    (all packages incl. `routers/livesync`), `gen-protocol.sh --check` up to date; `TestLivesyncBootstrap*` (API, Differential,
    Convergence, Large) + `TestVersion` pass on PG 16 (`gtestschema`; differential 129 s) and MySQL 8.0 binlog on (differential
    183 s), `TestLivesyncPermDifferential` passes on both, no testlogger "FATAL ERROR" in either run; fork diff unchanged
    (`assets/go-licenses.json`, `cmd/web.go`, `go.mod`, `go.sum`).
  - **Open items:** none. *(Item 1 at milestone close — `owner:{id}` gave full owner `Project` rows (description, creator,
    timestamps) to collaborators who may not see the owner, e.g. user4 on repository 40 of private org 23 — is fixed by the
    follow-up below.)*
  - **Follow-up (open item 1, owner `Project` exposure) — fixed.** Root cause: `d38b900` placed the whole project row
    (`protocol.Project`) in `owner:{owner_id}`, whose readers include every collaborator who reads issues or pulls in one of the
    owner's repositories (`checkOwner`/`checkOwners`/`Grants.addOwner`, unchanged and correct for what upstream shows them), while
    upstream shows such a viewer only what `retrieveProjects` renders: the issue list's project filter, the issue sidebar's project
    menu and the issue's selected project show **title, icon (`Project.IconName` ← `type`), the open/closed split and a link**;
    the project page `/{owner}/-/projects/{id}` (description, columns, cards) is a 404 for an owner they may not see; API v1 has no
    projects. **Decision: option (a), a second entity of the project row** (like `issue` → `Issue` + `IssueBody`):
    - `protocol.ProjectRef{id, owner_id, title, closed, type}` (new model `ProjectRef`, `SchemaProjectRef = 1`; `materialize`
      `projectSpec`, key `project#ref`) in `owner:{owner_id}` for every user/organization project (`repo_id = 0`;
      `projectRefPlace`), none for repository projects. The full **`Project` is back in `org:{id}` / `profile:{id}`** (`projectPlace`
      = the old rule, again shared with the columns; `columnPlace` removed): only those who may see the owner read it. Clients resolve
      `ProjectIssue.project_id` with the `Project` when held, else the `ProjectRef` (documented on both types and on
      `OwnerGroup`/`OrgGroup`/`ProfileGroup`, `BootstrapEnd.Refs`, `WorkspaceRepoOwner`). A description/creator/timestamp change
      emits a `Project` delta only (the `ProjectRef` hash is unchanged); title/closed changes emit both; a delete emits `D` in both
      groups.
    - **Org labels double-checked** against what upstream shows the same viewers: the repository label page (`RetrieveLabels`,
      `label_list.tmpl`) shows an org label's name, colour, description, exclusive and archived flags and the *per-repository*
      open count (`CalOpenOrgIssues`); API v1's issue JSON has no counts or timestamps. Our `Label` carried the organization-wide
      `num_issues`/`num_closed_issues` (counting the issues of private repositories of the org, shown upstream only to org owners on
      the settings page) and `updated_at`, which upstream's `doRecalcLabel` (`Update(&Label{})`) moves on every counter
      recalculation — so every labelling in a private repository of the org was a visible `Label` delta in `owner:{id}`.
      **Fixed:** an org label's DTO has `num_issues = num_closed_issues = 0` and no `updated_at` (`Label.UpdatedAt` is now optional,
      set for repository labels only; **`SchemaLabel = 2`**, so clients drop and re-bootstrap `Label`); a counter recalculation is
      no change for its readers. `created_at` is kept (static; repository labels carry it too).
    - **Migration:** placement version **project 3** ⇒ `placement_changed` markers for `Project` and `ProjectRef` and a repair walk
      of `project` once (clients that held a `Project` in `owner:{id}` re-bootstrap; the index then routes the next change as
      `D owner:` + `U org:/profile:` — `TestProjectRefPlacement` covers the move from a version-2 index row). Hub `modelKinds`:
      `ProjectRef` `owner`; `Project` keeps `owner` for the markers. Snapshots: `org:`/`profile:` read `project` again
      (`.holding(Project)`), `owner:` reads it `.holding(ProjectRef)` — new `source.models` makes `SnapshotModels` (header
      `schemas`) exact for a table with two models (`owner:3` → `Label, ProjectRef`; `org:3`/`profile:2` list `Project`, not
      `ProjectRef`). `types.gen.ts` regenerated (`ProjectRef`, `ModelProjectRef`, `SchemaProjectRef`, `Label.updated_at?`,
      `SchemaLabel = 2`, docs); `tsc --strict` on it clean. SURFACE.md: the mirrored page contents and the web routes the test uses.
    - **Tests:** `materialize` **`TestProjectRefPlacement`** (org project → `Project` in `org:3` + `ProjectRef` in `owner:3` whose
      payload is exactly `{id, owner_id, title, closed, type}`; repository project → no ref; a description change → `Project` only;
      closing → both; a version-2 index row (`Project` in `owner:3`) → `D owner:3` + `U org:3` + `U owner:3 ProjectRef`; delete →
      `D` in both), **`TestOrgLabelPayload`** (org label without counts/`updated_at`, a counter + `updated_unix` bump is no entry;
      repository label unchanged), `TestProfilePlacement`, `TestHandleEpochsPlacementAndPermissions` (markers incl. `ProjectRef`,
      version 3), `TestSnapshotFilters` (models of `org:`/`owner:`/`profile:`), `TestUserRefFields` (`ProjectRef` classified);
      `bootstrap` **`TestOwnerGroupReachable`** = the regression test of the reported case: user4's `owner:23` bootstrap is exactly
      `{Label (no counts/updated_at), ProjectRef {id, owner_id 23, title, closed, type}}`, its header `schemas` lacks `Project`,
      `org:23` refused; member user5's `org:23` holds the `Project` with its description and creator. Integration
      **`TestLivesyncBootstrapDifferential`** extended: every `owner:` bootstrap of every viewer has no `Project`, `ProjectRef`
      payloads with exactly those five keys, labels without counts/`updated_at`; **for an owner the viewer may not see** (user4 /
      privated_org; asserted to happen) it signs the viewer in to the web UI and compares: `ProjectRef`s (id, title, closed) = the
      owner projects in the project filter of the repository's issue list (open/closed by section), org labels = the `li.org-label`
      entries of the repository's label page, every ref's `/{owner}/-/projects/{id}` = 404, `org:`/`profile:` bootstraps 404; the
      repository-side check ("every owner project a `ProjectIssue` names is in `end.refs`' owner group") now looks for
      `ProjectRef`; `ProjectRef` added to the models that must be compared (114 compared on PG). `TestLivesyncPermDifferential`
      unchanged (it compares grants, which did not change: the group stays readable by the same viewers).
    - **Not changed (noted):** upstream's `retrieveProjects` lists only owner projects whose `type` matches the owner's kind; a
      mismatched row (none in the fixtures; upstream never creates one) would still get a `ProjectRef`. Repository projects stay in
      `repo:{id}` with unit `projects` although upstream's issue list shows their titles to every issue reader (narrower than
      upstream, no leak).
    - **Commands run (follow-up):** gofumpt (clean), `golangci-lint run ./services/livesync/... ./routers/livesync/...
      ./models/livesync/... ./tests/integration/...` (0 issues), `go vet` (+ integration with sqlite tags), deadcode diff (clean),
      livesync unit tests (all packages incl. `routers/livesync`), `next/tools/gen-protocol.sh` + `--check`, `tsc --strict` on
      `types.gen.ts`, fork-diff check unchanged (`assets/go-licenses.json`, `cmd/web.go`, `go.mod`, `go.sum`). MariaDB not run (no
      trigger change).
    - **Results (follow-up):** `./integrations.*.test -test.run 'TestLivesync|TestVersion'` on PG 16 (`gtestschema`: 35 pass, 3
      MySQL-only skips; differential 119 s) and MySQL 8.0 binlog on (37 pass, 1 skip; differential 184 s, perm differential 96 s),
      no testlogger "FATAL ERROR" in either; `TestLivesyncBootstrap*` + `TestLivesyncPermDifferential` re-run on PG with the final
      binary (pass, differential 137 s).
  - **Sandbox note:** the root filesystem reports little free space (≈ 0.3 GB at one point although only 39 GB of 252 GB were used:
    the host disk is shared). Leftover `/tmp/prepared-forgejo*` / `/tmp/appdata*` dirs of killed unit-test runs (≈ 2.4 GB) and MySQL
    binary logs (the large bootstrap test writes ≈ 0.7 GB per MySQL run) were the reclaimable part: `rm -rf /tmp/prepared-forgejo*`,
    `FLUSH BINARY LOGS; PURGE BINARY LOGS TO '<newest>'`. A full disk shows up as `collect2: ld returned 1 exit status` / `[build failed]`.

#### B7 — Idempotency layer for API v1
- [x] **Status** — done 2026-10-08 (final check after rebasing onto F2: `TestLivesyncIdempotency*` + `TestVersion` green on PG 16/`gtestschema` and MySQL 8.0 binlog on, no testlogger "FATAL ERROR"; livesync unit tests, vet, gofumpt clean; `gen-protocol.sh --check` up to date; fork diff = `assets/go-licenses.json`, `cmd/web.go`, `go.mod`, `go.sum`; all 13 review round 1 findings fixed, none open)
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
  - **Files.** `services/livesync/idempotency/{idempotency,wait,dedupe}.go` (+ SQLite unit tests `idempotency_test.go`);
    `routers/livesync/idempotency.go` (+ `idempotency_test.go`), dispatch in `wrap.go`; `services/livesync/writes.go`
    (`Idempotency()`), `livesync.go` (start/stop), `writer.go` (cleanup, `Consumed` hook), `perms.go` (`delivered` hook),
    `settings.go`; `services/livesync/protocol/writes.go` (header names + the client contract; regenerated
    `next/src/protocol/types.gen.ts`); `models/livesync/tables.go` (`livesync_idempotency.owner`, `outbox_low`, `outbox_high`,
    added by Sync, `TablesVersion` stays 1); `capture.LastAssignedID` (exported, was `lastAssignedID`); `materialize.Config.Consumed`;
    `tests/integration/livesync_idempotency_test.go`; `livesyncResetCapture` also empties `livesync_idempotency`.
  - **Interception** (`handler.ServeHTTP`, before inner): a request is *keyed* iff it has an `Idempotency-Key` header (checked first:
    requests without it cost one map lookup and reach inner as the same `*http.Request`/`ResponseWriter`, body unread —
    `TestKeyedPassthrough`), the method is POST/PUT/PATCH/DELETE (GET/HEAD with a key: untouched) and the path, normalised like
    `ownPath` (slashes, `AppSubURL` stripped), starts with `/api/v1/` (`/api/forgejo/v1` is not covered). Keyed requests: 503 +
    `Retry-After: 2` while livesync is stopped (never run without the key honoured); one key value of 1–255 printable ASCII else 400;
    body buffered (≤ 16 MiB, else 413); **identity**: `authMethods` (OAuth2 + `AccessToken{PermitBearer}`, B4) on a clone with its own
    body copy (token extraction may `ParseForm`) — success ⇒ the user; a bad/expired token or basic auth with a *password* (OAuth2 reads
    basic passwords as JWTs) ⇒ 401; no token but another `Authorization` scheme (HTTP signatures, …) ⇒ 400; no credentials ⇒ 401.
    Decision: only tokens, because any other credential API v1 accepts would make the write run without a user to key on. API v1 still
    checks the account and scopes itself (no `checkAccount`/livesync scope rule here).
  - **Request hash** (`idempotency.RequestHash`): sha256 over length-prefixed method, normalised path, raw query, Content-Type,
    **credential scope** (`credentialScope`: the token's normalised scope + its reducer — all / public / sorted specific repo ids) and the
    body. Same key + different hash ⇒ 422. The credential part keeps a response stored for a broad token from being replayed to a
    narrower token of the same user (scope bypass); OAuth refreshes keep the grant's scope, so retries match. The token itself is not
    hashed.
  - **Store** (`livesync_idempotency`, per running instance `idempotency.Service`): `Begin` reads the outbox position *L*
    (`capture.LastAssignedID`), then one native insert-or-nothing of `(user_id, idem_key)` in flight with `owner = "<instance>/<token>"`
    and `outbox_low = L`, then reads the row back: own owner ⇒ **Run**; else expired (older than TTL, not cleaned yet) ⇒ deleted, start
    over; hash differs ⇒ **Mismatch** (422); completed ⇒ **Replay**; in flight and the owner *alive* ⇒ **InFlight** (409 `{message}` +
    `Retry-After: 1`); in flight and the owner dead (or `owner = ''`: released) ⇒ compare-and-swap the owner ⇒ **Run, `Recovered`**
    (`outbox_low` and `created_unix` of the first attempt kept). **Liveness:** every instance holds the DB lock `livesync.idem.<16 hex
    id>` (`models/livesync.TryLease`; PG advisory / MySQL `GET_LOCK`, pinned connection, pinged every 30 s and re-taken if lost) for its
    lifetime; an owner of this process is alive iff its token is in the in-process `running` set (registered *before* the insert/CAS);
    another instance's owner is alive iff its lock is held (try-lock; errors count as alive). So a crash is detected **immediately** by a
    retry on the restarted server (no heartbeat timeout). One extra pinned DB connection per instance (two on the writer
    instance with its writer lease: livesync needs `MAX_OPEN_CONNS` 0 or ≥ 3, see review round 1). On shutdown the lock is kept until
    the running attempts finished (≤ 10 s, `drain`), so a graceful restart does not let a retry run them twice. `Complete` (state
    completed, status, headers JSON, body, sync id, `outbox_high`, owner cleared) and `Release` (owner cleared, nothing stored) are CAS
    on the owner: an attempt that was taken over stores nothing (logged). **What is stored:** every response with status < 500; ≥ 500 ⇒
    `Release` (unknown outcome; the next retry is `Recovered`). A panic in inner ⇒ `Release` + re-panic. Headers are stored minus
    `Set-Cookie`, `Date`, `Content-Length`, hop-by-hop and `X-Livesync-*`; a body over 16 MiB is streamed to the client (no sync id) and
    stored without body + `X-Livesync-Body-Omitted: true`. **Replay** = stored status, headers, body + `X-Livesync-Idempotent-Replay:
    true` + the stored `X-Livesync-Sync-Id`. **TTL / cleanup:** `IDEMPOTENCY_TTL` (7 d); the writer role deletes expired records
    (1000 per statement) with the log retention (at start, then every 10 min).
  - **`X-Livesync-Sync-Id` — what it guarantees (client contract in `protocol/writes.go`, TS `HeaderSyncID`).** *Every sync log
    entry produced from the rows the request committed before API v1 answered has `v` ≤ the header value*, whichever group it lies in;
    and those entries are already in the log when the response is sent. So a client holds the write's effect in a group once that
    group's B5 position (highest `v` received, raised by `delta.to`/`caught_up`/`pong`/`barrier_ok`) is ≥ the value; that is when it drops
    the write's overlay. Mechanism: *L* = outbox position before the first attempt, *H* = after inner returned; the write's outbox rows
    have ids in (L, H] (ids are assigned inside the writing transaction, which committed before H was read). `WaitSynced` polls until
    **no row with id in (L, H] is left in `livesync_change`** — the materializer deletes consumed rows in the transaction that appends
    their entries, so once the write's rows are gone its entries are committed — and then returns `synclog.Head` read afterwards.
    Uncommitted rows of other transactions in the range are invisible and do not hold it up, unlike the capture cursor (holes would
    block for up to HOLE_TIMEOUT), which is why the cursor is not used; consumed-but-deferred hot rows (≤ HOT_COALESCE) do hold it up,
    which makes notification writes covered too. Wake-ups: the local materializer's `Consumed` callback and every tailer delivery
    (`permSink.delivered`, i.e. a remote writer's progress) broadcast to the waiters; otherwise polls at 5 ms doubling to 100 ms.
    Bounded by `IDEMPOTENCY_SYNC_WAIT` (2 s; 0 = check once): on timeout (materializer behind/not running) or a cancelled request the
    header is **absent**, the record stores `sync_id = -1` with `outbox_low/high`, and a later replay computes it then (and stores it).
    A recovered attempt uses the first attempt's *L*, so its value also covers what the crashed attempt committed. **Not covered:**
    writes API v1 makes asynchronously after answering (UI notifications for other users, webhooks), and a hot-table row (notification,
    commit_status, action_run_job) changed again by someone else within HOT_COALESCE (the materializer then keeps only the newest
    outbox row, outside (L, H], so the wait may end before the row's newest state is in the log; the overlay can flicker for ≤ 1 s).
    Measured (`TestLivesyncIdempotencyDelta`, label create, 10 sequential, sandbox): PG 7.1 ms plain → 16.1 ms keyed, MySQL 8.0 ms →
    24.4 ms (reserve + run + materializer round trip + store); the delta's `v` ≤ the header over a real WebSocket.
  - **Crash-window dedupe** (`idempotency.FindDuplicate`, PLAN §4.8): only for `Recovered` attempts (interrupted by a crash, or the
    previous attempt answered ≥ 500) of `POST /repos/{o}/{r}/issues`, `…/issues/{n}/comments`, `…/pulls/{n}/reviews` with a JSON body:
    look on the master for the entity by the same user on the same target with the same content created since the first reservation
    (− 5 s clock slack) — issues: `repo_id`, `poster_id`, not a PR, title as `NewIssue` stores it (trimmed, ≤ 255 bytes), body; comments:
    issue by index, `poster_id`, type comment, body; reviews: pull by index, `reviewer_id`, type from `event` (as `preparePullReviewType`),
    body, **`updated_unix`** (submitting completes an earlier pending review). Compared in Go (MySQL collations are case-insensitive).
    Found ⇒ inner is called with a synthetic `GET` of the entity (same credentials, sub-path kept) and its body is answered with the
    create's status (201/201/200) and stored like any response; not found ⇒ the request runs. "Prevented in practice": an entity
    edited before the retry no longer matches; the code comments of a review whose submit was interrupted are created again; other
    creates (labels, milestones, attachments, PRs, time entries) simply run again after a crash.
  - **Settings added:** `IDEMPOTENCY_TTL` (168h, > 0), `IDEMPOTENCY_SYNC_WAIT` (2s, ≥ 0).
  - **APIs for later milestones.** `livesync_service.Idempotency() *idempotency.Service` (nil when stopped); `Service.Begin/Complete/
    Release/WaitSynced/Notify`, `idempotency.{Position, RequestHash, ValidKey, FindDuplicate, ErrNoDuplicate, Cleanup, StoreSyncID}`;
    `protocol.Header{IdempotencyKey, SyncID, IdempotentReplay, BodyOmitted}` (TS consts). **For B9** (gap endpoints must accept
    `Idempotency-Key`): extend `keyed` with `/-/sync/api/` and run them through `serveKeyed` with livesync's own router as the target
    instead of `inner` (`run` calls `h.inner`; make the target a parameter then) — the store, hash, wait and replay are path-agnostic;
    their creates get no crash-window check unless added to `FindDuplicate`. **For B8:** metrics hooks (replays, 409s, sync waits that
    timed out, wait duration) are not added; the admin page could list in-flight records. **For F2/F5:** send a fresh UUID per intent
    and the same one on every retry; 409 ⇒ retry after `Retry-After`; 422 ⇒ a bug (key reused); a missing `X-Livesync-Sync-Id` ⇒ keep
    the overlay until a delta for the entity arrives; replays carry `X-Livesync-Idempotent-Replay: true`.
  - **Tests.** Unit (SQLite): `idempotency` — `TestValidKey`, `TestRequestHash`, `TestBeginCompleteReplay` (run, in flight in-process,
    per-user keys, replay fields, mismatch, double complete), `TestReleaseRecovers` (low/since kept), `TestTakeOverInterrupted` (dead
    instance, own stale owner, expired), `TestCleanup`, `TestWaitSynced` (range semantics, timeout, wake by `Notify`, cancel),
    `TestSignal`, `TestFindDuplicate` (fixtures: issue/comment/review matches and every non-match), `TestStopDrains` (all with `-race`);
    `routers/livesync` — `TestKeyed`, `TestKeyedPassthrough`, `TestKeyedStopped`, `TestRecorder` (buffer, stream over the limit,
    discard), `TestStoredHeadersAndWriteResponse`, `TestReadRequest`, `TestCredentialScope`; settings. Integration (**PG 16
    `gtestschema` and MySQL 8.0 binlog on**): **`TestLivesyncIdempotency`** — same key twice ⇒ one issue, identical body/Content-Type/sync
    id + replay header, the Issue and IssueBody entries already in the log at the response with `v` ≤ header; a narrower token of the same
    user ⇒ 422; different body ⇒ 422; another user's same key ⇒ independent; label add (200) and comment delete (204) replayed with the
    stored sync id; no header (and GET with a key) ⇒ no sync header, no record; 401/400 auth cases and bad/duplicate keys; **8
    concurrent duplicates ⇒ exactly one 201 run, the others 409 or replay, one issue**; an in-flight record of a *live* instance (the
    test holds its lock) ⇒ 409 + Retry-After, after the lock is released ⇒ recovered and run once; **forced crash** (record left in flight
    by a dead instance after the write committed) for an issue, a comment and a review ⇒ the retry answers with the created entity (=
    API v1's GET of it), no duplicate, then plain replays; crash before the commit ⇒ runs once; a record stored without sync id gets one
    at the replay. **`TestLivesyncIdempotencyDelta`** — over a real WebSocket the Issue delta's `v` ≤ the header; latency figures above.
  - **Commands run:** gofumpt (clean), `golangci-lint run ./models/livesync/... ./services/livesync/... ./routers/livesync/...
    ./tests/integration/...` (0 issues), `go vet` (+ integration with sqlite tags), deadcode diff (clean), `go mod tidy -diff` (clean),
    unit tests of every livesync package with `-race`, `next/tools/gen-protocol.sh --check` (up to date), `TestLivesyncIdempotency*`
    green on PG 16 (`gtestschema`) and MySQL 8.0 (several runs each), full `./integrations.*.test -test.run 'TestLivesync|TestVersion'`:
    MySQL 39 pass / 1 skip, no testlogger "FATAL ERROR"; PG 36 pass / 3 MySQL-only skips + **`TestLivesyncHubSlowConsumer/sse` failed
    once** ("frames were written until the socket was full", the B6-noted flake; B7 does not touch the hub) and passed 3/3 when re-run;
    an earlier full MySQL run printed one testlogger "FATAL ERROR" inside `TestLivesyncBootstrapConvergence` (test passed; line not
    captured; it passed alone and in the final full run — likely B6's known upstream MySQL deadlock under concurrent comment writes,
    watch it). Fork-diff check unchanged (`assets/go-licenses.json`, `cmd/web.go`, `go.mod`, `go.sum`). Dev binary smoke test on PG with
    `ENABLED = true`: the same keyed issue create twice ⇒ 201 + `X-Livesync-Sync-Id: 219` both times, the second with
    `X-Livesync-Idempotent-Replay: true` and a byte-identical body, one issue; basic auth with a key ⇒ 401; dev DB triggers dropped
    afterwards. `next/` lint/typecheck not run (only the generated file changed there).
  - **Not done / known gaps.** Only token-authenticated writes can be keyed. `/api/forgejo/v1` and gap endpoints (B9) are not
    intercepted yet. No metrics (B8). The hot-table and asynchronous-write limits of the sync id (above). While an instance's lock
    connection is lost (until the 30 s re-check re-takes it), a retry on another instance treats its running attempts as crashed.
    Request and response bodies over 16 MiB (above). MariaDB not run (no trigger/DDL change).
  - **Environment note (disk).** The sandbox disk filled up during B6. `~/.cache/go-build` had grown to 18 GB; deleting entries not
    used for 4 h (`find ~/.cache/go-build -type f -mmin +240 -delete`, Go re-creates what it needs) freed 12 GB, and old `*.test`
    binaries in the session scratchpad another 1.4 GB. A full `go test -c` of `tests/integration` is ≈ 165 MB.
  - **Review round 1 (13 findings, all fixed; the notes above are amended by these):**
    1. *Connection pool* (major). An instance pins **two** pooled connections, not one: the idempotency instance lock (every
       instance) and the sync log writer lease (the writer); with `[database] MAX_OPEN_CONNS = 2` nothing was left for the
       materializer, the reader and API v1, and everything hung. `livesync_model.MinOpenConns = 3` (two pinned + one to work on;
       `alive()`'s try-lock and the schema lock at start need one more briefly, they take turns with the rest), checked by
       `livesync_model.CheckPool` first thing in `Init` (clear error, livesync does not start) and in `TryLease`/`WithSchemaLock`
       (were `== 1`). `0` (unlimited, the default) is fine. `TestLivesyncIdempotencyPool`: 2 ⇒ Init refused; 3 ⇒ a keyed write
       completes with its sync id.
    2. *Credential-issuing routes* (major). `POST /user/applications/oauth2`, `PATCH /user/applications/oauth2/{id}`,
       `POST /users/{u}/tokens`, `POST /admin/users/{u}/tokens`, `POST /{user,orgs/{o},repos/{o}/{r},admin}/actions/runners` return a
       secret upstream keeps only hashed: with `Idempotency-Key` they are refused (**400**, nothing runs, nothing stored) rather than
       stored without body (a replay without the secret is useless, and a retry that runs again would create a second credential).
       List in `credentialRoutes` + SURFACE.md (re-check on upstream merges). Also: the recorder now drops bodies for statuses that
       allow none (1xx/204/304, as net/http does), so e.g. a team-invite accept's 204 body (with its token) is not stored.
    3. *Sudo*. The `Sudo` header is part of the request hash (`?sudo=` and a form `sudo` already were, via query/body); the
       crash-window check looks for entities of the user API v1 acts as (`dedupeUser`: `?sudo=` then the header, as `sudo()` reads
       them for a JSON body; none if the token's user is not an admin or the sudo user is unknown — API v1 refuses then). Chosen over
       refusing sudo: it costs nothing and keeps admin tooling working.
    4. *Tokens in the query / form*. API v1 reads `token`/`access_token` from the query or a urlencoded body **before** the
       Authorization header; keyed requests carrying one are refused (400 "send the token in the Authorization header"). So the token
       is never hashed, the synthetic crash-window GET (headers only) carries the credentials API v1 uses, and the user the key is
       scoped to is the one API v1 acts as. Refused even with `DISABLE_QUERY_AUTH_TOKEN = true` (simpler than mirroring it).
    5. *Path storage*. `storedPath`: `strings.ToValidUTF8` (a decoded `%FF`) then `util.SplitStringAtByteN(…, 1024)` (rune
       boundary). Was `path[:1024]`, which PG/MySQL rejected ⇒ 500 on every attempt.
    6. *Shutdown race*. `Service.Enter()` registers a keyed request as soon as the layer has the store (before body and auth);
       `drain` waits for entered requests as well as running attempts; after the instance context is done `Enter` fails and
       `Begin` returns `ErrUnavailable` (also while the instance lock is lost) ⇒ 503 + `Retry-After: 2`. So the lock is released only
       when no keyed request can still reserve or run (bounded by the 10 s drain as before).
    7. *Sync wait and deferred hot rows*. `capture.Batch.Commit` now marks the rows the consumer deferred
       (`livesync_change.deferred`, new column `BOOL NOT NULL DEFAULT false`, added by Sync, triggers unchanged, `TablesVersion`
       stays 1; one `UPDATE … WHERE id IN` only in batches that deferred something); `WaitSynced` ignores marked rows, so an unrelated
       hot-row update in the global range (L, H] no longer holds a write for up to HOT_COALESCE. **Contract change:** a change to a
       hot row that the materializer deferred is not covered by the header (its entry follows within HOT_COALESCE, above the value);
       this replaces the "changed again by someone else" carve-out and the earlier claim that deferral made notification writes
       covered. Error responses (status ≥ 400) no longer wait: one check (`SyncedNow`), header only if the range is already in the log.
    8. *Account checks*. `checkAccount` (B4) runs right after authentication for every keyed request: replays, 409s and 422s of a
       prohibited / deactivated / must-change-password / 2FA-required account get API v1's 403.
    9. *Body after auth*. The request is authenticated (header token, on a clone without body) before the body is read; an
       unauthenticated keyed write gets 401 without its body being read (tested with a counting reader).
    10. *Middlewares*. The layer's own answers (503/400/401/403/413/409/422/500, replays, crash-window answers) go through a second
        router with `common.ProtocolMiddlewares()` (`newAnswers`, handler `idempotencyAnswer`): access log, router log, process entry,
        panic recovery. A request that runs is logged once, by API v1's own router. A crash-window duplicate logs the synthetic GET
        (API v1) **and** the POST (the layer's answer). Not inside the middlewares: the authentication and `Begin` queries before the
        answer (no process entry for them).
    11. *Position read failure*. When the outbox position cannot be read after the write, the record stores `outbox_high = -1`
        (unknown) and `sync_id = -1`; a replay reads the current position as the upper bound (above everything the write committed)
        instead of using `max(0, low)`.
    12. *Round trips*. `capture.PositionQuery` caches the PG sequence name (per host/db/schema). `Begin` reserves in **one** statement
        on PostgreSQL (`INSERT … VALUES (…, (SELECT … FROM <seq>), …) ON CONFLICT DO NOTHING RETURNING id, outbox_low`; was
        2 position + insert + select = 4), on MySQL position + insert (affected rows / `LastInsertId`, no read-back; was 3); the record is
        read back only when the key exists. MySQL still reads the position (`SHOW CREATE TABLE`) before learning the key exists — one
        wasted query on retries, chosen to keep first attempts at two. After the write: one query on PG (was two). Measured
        (`TestLivesyncIdempotencyDelta`, sandbox): PG 6.5 ms plain → 14.4 ms keyed, MySQL 8.3 → 22.3 ms.
    13. *Tests*. `TestLivesyncIdempotencyServerErrors` (inner that fails on purpose): 502 after the issue was committed ⇒ record
        released, the retry is recovered and answers with the existing issue (one issue); 500 before the commit ⇒ the retry runs; a
        panic in inner ⇒ released, re-panicked, the retry runs once; a deferred hot row in the write's range ⇒ header at once (HOT_COALESCE
        1 h). `TestLivesyncIdempotencyLateMaterializer`: `IDEMPOTENCY_SYNC_WAIT = 0`, the test holds the writer lease (no
        materializer) ⇒ 201 without header, record `sync_id -1` with `outbox_high > outbox_low`, replay still without; lease released
        ⇒ a replay gets the header, which covers the issue's entry, and stores it. New subtests of `TestLivesyncIdempotency`:
        credential routes, query/form token, auth before body, sudo (422 for another sudo user; crash-window found for the sudo user),
        long non-ASCII and `%FF` paths, prohibited account replay ⇒ 403. Unit: `TestStopDrainsEntered`, `TestStoredPath`,
        deferred/`SyncedNow` cases in `TestWaitSynced`, `TestReaderDefer` checks the mark; routers: `TestIssuesCredentials`,
        `TestFormToken`, `TestAnswersMiddlewares`, `TestRecorderNoBody`.
    **Round 1 commands:** gofumpt clean; golangci-lint (livesync packages + `tests/integration` with sqlite tags) 0 issues; `go vet`;
    deadcode diff clean; `go mod tidy -diff` clean; `gen-protocol.sh --check` up to date (only doc comments changed); unit tests of
    every livesync package with `-race`; full `-test.run 'TestLivesync|TestVersion'`: **PG 16 (`gtestschema`) 40 pass / 3 skips,
    MySQL 8.0 42 pass / 1 skip**, no testlogger "FATAL ERROR"; fork-diff check unchanged.

#### B8 — OAuth app, SPA serving, admin page, metrics
- [x] **Status** — done 2026-10-08 (final check: `TestLivesyncOAuth`, `TestLivesyncSPA`, `TestLivesyncAdminDegraded`, `TestLivesyncAdminRunning`, `TestLivesyncDisable`, `TestLivesyncTriggerWatch`, `TestLivesyncUninstallMonotonicIDs`, `TestLivesyncHubSlowConsumer`, `TestLivesyncCaptureVerifyMode` + `TestVersion` green on PG 16/`gtestschema` and MySQL 8.0 binlog on, no testlogger "FATAL ERROR"; livesync unit tests, `go vet`, gofumpt, golangci-lint (0 issues), deadcode diff clean; `gen-protocol.sh --check` up to date; fork diff = `assets/go-licenses.json`, `cmd/web.go`, `go.mod`, `go.sum`; review round 1 fixed, no open items; the `TestLivesyncHubSlowConsumer/sse` flake root-caused and fixed, see notes; its product note (a burst above `SEND_BUFFER` disconnected fast clients) fixed 2026-10-08 — see *Burst backpressure*; its issue round 2 (`DRAIN_TIMEOUT` disconnected slow-but-steady clients during replays, log tails and bursts that fit) fixed 2026-10-08 — see *Burst backpressure, issue round 2*; its issue round 3 (a permanently behind subscription blocked the session's worker: no token re-validation, no replays for new subscriptions, no `caught_up`/`barrier_ok`) fixed 2026-10-08 — see *Burst backpressure, issue round 3*; its re-review's open item (major, pre-existing: an ending session's worker busy-spins until the writer gives up) fixed 2026-10-08 — see *Burst backpressure, issue round 4*; no open items)
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
  - **Files.** `services/livesync/oauthapp/oauthapp.go`; `services/livesync/metrics/metrics.go`; `services/livesync/{disable,status}.go`
    (+ `livesync.go` (`InitError`, `OAuthApp`, `ErrInvalidSettings`, metrics registration), `settings.go`, `writer.go`
    (`watchTriggers`, writer flag), `livesync_test.go`); `services/livesync/capture/uninstall.go` (+ `reader.go` `Batch.Seen`,
    `ddl_test.go`); `services/livesync/hub/{hub,conn,replay,ws,sse}.go` (`Hub.Stats`, metric hooks);
    `services/livesync/materialize/materializer.go` (metric hooks); `services/livesync/protocol/next.go` (+ regenerated
    `next/src/protocol/types.gen.ts`, the only `next/` file touched besides this one); `routers/livesync/{spa,spa_embed,spa_noembed,
    admin,rum}.go` (+ `spa_test.go`, `spa_embed_test.go` (tag `livesync_embed`), `admin_test.go`), `routes.go` (`newRouter`,
    `newRoutes(inner, spa)`), `wrap.go`, `bootstrap.go` and `idempotency.go` (metric hooks), `routers/livesync/.gitignore`
    (`/next_dist/`); review round 1: `routers/livesync/{classic.go,classic_header.tmpl,classic_test.go}`; `tests/integration/livesync_{oauth,spa,admin,disable}_test.go`, `livesync_hub_test.go` (slow consumer
    rewritten, `livesyncWaitHub`), `livesync_capture_test.go`/`livesync_privileges_test.go` (degraded instead of `Wrap(h)==h`);
    `SURFACE.md`.
  - **Kill switch / uninstall (B2 ops note (a)).** `ENABLED = false` is now safe: `Wrap` calls **`livesync_service.Disable`** when
    `Init` returns `ErrDisabled` (Init itself still touches no database when disabled). On PG/MySQL it checks whether livesync ever ran
    (`livesync_meta` exists — one query per start for deployments that never enabled it; nothing else happens then).
    **`ENABLED` is decided before the other `[livesync]` keys** (review round 1): with `ENABLED = false` a malformed key is only a
    Warn and `Init` still returns `ErrDisabled` (not `ErrInvalidSettings`), so the kill switch runs; an invalid `INSTALL_MODE` then
    counts as `verify` (Disable only logs the script). In
    `INSTALL_MODE = auto` it runs **`capture.Uninstall`**: under the schema lock, every livesync trigger (any state, extras included)
    and the PG function are dropped (`Status.UninstallStatements`; function without `CASCADE`) and the outbox is `TRUNCATE`d, each
    statement under `DDLLockTimeout`, on PG in one transaction; MySQL's `TRUNCATE` resets `AUTO_INCREMENT`, so it is put back to
    last + 1 (outbox ids stay monotonic for other instances and B7's ranges). **Review round 1:** on MySQL the counter is read
    *after* the last `DROP TRIGGER` (the statements run one by one and the remaining triggers keep assigning ids; read before, the
    counter went back by hundreds under concurrent writes, so a running writer's reader skipped the new ids); `DROP TRIGGER` waits
    for its table's metadata lock, so no transaction that fired a trigger is open then. The outbox is truncated whenever anything is
    uninstalled (it may look empty while triggers still write). `TestLivesyncUninstallMonotonicIDs` (a concurrent writer; fails on
    the old code on MySQL: counter 30 vs. 341 seen). The Next UI's OAuth2 application is **not** removed by the kill switch: the
    admin page's kill-switch text, `TablesScript` (in `UninstallScript`) and Disable's log say that signed-in browsers keep
    refreshing API tokens until it is deleted in Site administration → Applications (which deletes its grants). In `verify` mode it only logs (Warn) the uninstall
    script. Failures are a Warn; Forgejo serves the classic UI either way (`Wrap(h) == h`). Enabling again = a repair of every table
    (epochs bumped, `B` markers, clients re-bootstrap; B2/B3 machinery, `TestLivesyncDisable`). `Status.UninstallScript()` (also on
    the admin page) adds the `DROP TABLE` statements of livesync's own tables, commented out (only after the triggers are gone).
    Schema epochs are not touched by the uninstall. **Multi-instance:** all instances must agree on `ENABLED`; a running writer
    re-checks the triggers every **`[livesync] TRIGGER_CHECK_INTERVAL`** (default 1m, 0 = off; `watchTriggers` in `writer.go`, runs
    `capture.Ensure` like Init: auto reinstalls + bumps epochs, verify records `capture_pending` and logs the DDL once per state),
    so a peer that starts disabled (or a DBA, or a migration that recreates a table) cannot silently stop capture for long
    (`TestLivesyncTriggerWatch`: `capture.Uninstall` under a running instance ⇒ triggers back, every epoch +1, `B` marker, captures again).
  - **Degraded mode (B2's "for B8").** When livesync is enabled with valid settings but `Init` fails (capture triggers missing/stale,
    e.g. verify mode; anything else), `Wrap` now returns **`degraded`** (`admin.go`): `/-/sync/admin` and `/-/sync/health`
    (503 `{"status":"degraded"}`) are livesync's, every other request goes to `inner` untouched (`/-/next/*` and the rest of
    `/-/sync/*` get upstream's 404). Disabled, SQLite and **invalid settings** (`ErrInvalidSettings`, new) still return `inner` itself.
    `livesync_service.State()` = running | degraded | stopped, `InitError()` (last Init's error). A degraded instance does **not**
    retry Init: restart after the DBA ran the DDL (as before). B2's `TestLivesyncCaptureVerifyMode` / B2's privilege test now assert
    the degraded handler instead of `Wrap(h) == h`.
  - **Admin page `GET /-/sync/admin`** (HTML; JSON with `?format=json` or `Accept: application/json`). Shows state + Init error,
    install mode, writer flag, Next UI source, OAuth client; capture triggers (dialect, schema, MySQL account, health, counts by
    state, the objects that are not ok, warnings, `capture_pending`), **the install/repair DDL (`Status.Script()`) and the uninstall
    DDL** with kill-switch instructions; outbox (last assigned id, cursor, backlog), sync log (head, floor, writer token, hub
    position, lag), entity backfill still running, hub sessions by transport, subscriptions, top 20 viewers. Data:
    `livesync_service.CollectStatus(ctx)` (read-only; parts that fail are listed in `errors`). **Who:** a site administrator —
    either a token in `Authorization` (OAuth2 / PAT) with `read:admin` (403 otherwise; account checks as API v1), or the classic
    UI session: livesync never reads sessions (with Forgejo's default `memory` session provider a second session manager would not
    see upstream's sessions), it asks upstream (`inner`) for the admin-only `GET /admin/system_status` with the request's cookies:
    200 + body starting with `<dl` = admin; redirect to `/user/login` = signed out ⇒ 303 to `/user/login?redirect_to=…` (401 for
    JSON); anything else (403, upstream's 200 "prohibited/activate" pages, change-password/2FA redirects) = 403. Fails closed if
    upstream reshapes that page (SURFACE.md). Read-only page (no POST, so no CSRF surface); `Cache-Control: no-store`, own CSP
    (`default-src 'none'; style-src 'unsafe-inline'`), `X-Frame-Options: DENY`.
  - **Metrics** (`services/livesync/metrics`, registered with Prometheus' **default registry** at the first *enabled* Init —
    degraded included —, so Forgejo's own `/metrics` (`[metrics] ENABLED = true`, optional `TOKEN`) serves them; no route of ours).
    Names `forgejo_livesync_*`, labels with fixed value sets only. Scrape-time gauges (collector in `status.go`, DB reads ≤ 2 s):
    `up{state}`, `outbox_backlog` (last assigned outbox id − capture cursor = **capture lag** in changes), `log_head`,
    `hub_position` (head − position = fan-out lag in entries), `writer`, `sessions{transport}`, `subscriptions`. Event metrics:
    `materialize_lag_seconds` (reader first saw the change — or the gap a late transaction fills, `capture.Batch.Seen` — until its
    log entries committed; sweep/deferred rows not observed), `materialized_changes_total` (outbox rows consumed, `Batch.Consumed`:
    a deferred hot row counts once, when it is consumed — review round 1), `log_entries_total`, `fanout_seconds`
    (one `Hub.Deliver`), `delivered_entries_total`, `sessions_opened_total{transport}`, `slow_consumer_disconnects_total`,
    `frames_total`, `frame_bytes_total`, `replays_total`, `bootstrap_required_total{reason}`, `group_revoked_total`,
    `bootstrap_requests_total{endpoint,status}`, `bootstrap_bytes_total{endpoint}` (on the wire, compressed),
    `bootstrap_seconds{endpoint}`, `idempotency_requests_total{outcome=run|recovered|duplicate|replay|in_flight|mismatch|refused}`,
    `idempotency_sync_wait_seconds`, `idempotency_sync_wait_timeouts_total`, `rum_seconds{mark}`, `rum_events_total{event}`,
    `rum_rejected_total{reason}`. Not measured: commit → outbox-reader delay (the outbox has no timestamp; adding one would change
    `livesync_change` for every captured write — not done), cross-instance log-commit → fan-out time (`created_unix` is seconds).
  - **RUM sink `POST /-/sync/rum`** (`rum.go`, contract `protocol.RUMReport`): `application/json` only (415 otherwise: a cross-site
    page cannot post it without a CORS preflight, which is not answered), ≤ 8 KiB (413), anonymous allowed (the boot shell reports
    before sign-in), token bucket per client address (10/min, burst 10; map ≤ 10 000 keys) and per instance (200/s, burst 400) ⇒
    429 + `Retry-After: 60`; known marks (ms, 0–10 min: `firstPaintFromCache dataOpen wsOpen caughtUp hydrateRoute hydrateAll
    mutationLocal mutationAcked mutationConfirmed inp`) and events (counts 0–1000: `intentFlushed intentRetried intentFailed
    conflictMerged conflictOverride conflictDiscarded`) feed the histograms/counters; anything else is ignored and counted as
    rejected; 204. Nothing stored or logged. **F8:** post these names; add new ones to `protocol/next.go` + `rum.go` together.
  - **OAuth app (`services/livesync/oauthapp`).** `Ensure` at every Init (after the capture check, under the schema lock, in one
    transaction on the master): an instance-wide (UID 0) **public** client "Forgejo Next", redirect URI `{AppURL}-/next/callback`
    (+ `[livesync] OAUTH_REDIRECT_URIS`, comma-separated, e.g. `http://127.0.0.1/-/next/callback` for a dev server — any port for
    http loopback), client id kept in `livesync_meta` `oauth_client_id`; edited fields are put back, a deleted application is
    created again (new client id, Warn); when `livesync_meta` lost the client id (its tables dropped), the existing instance-wide
    public "Forgejo Next" application with the callback URI is **adopted** instead of creating a second (review round 1). Failure (e.g. `[oauth2] ENABLED = false` ⇒ `ErrOAuth2Disabled`) is a Warn: livesync runs,
    the config's `oauth` is `null`. **Scope** `oauthapp.Scope = "write:issue write:repository read:user read:organization
    write:notification"` — exactly PLAN §4.9 (review round 1 reverted round 0's `write:organization write:user`: the token lives in
    the browser, refresh token in IDB for 730 h, and `write:user` would let a stolen one add SSH keys / OAuth2 apps / hooks / emails;
    `TestLivesyncOAuth` checks `POST /user/keys`, `POST /user/applications/oauth2`, `POST /orgs/{o}/hooks` are 403). **For F4/F6:**
    starring (`/user/starred` needs `write:user`), follows, blocks and org-level labels/projects are not writable with this token;
    the milestone that needs them widens `oauthapp.Scope` (Ensure then revokes the old grants: one forced sign-in, since public
    clients see the consent page at every authorization anyway) and records the decision.
    **Confirmed behaviour (`TestLivesyncOAuth`, both values of `ENABLE_ADDITIONAL_GRANT_SCOPES`):** the token's API scope is the
    grant's scope in both modes (the setting only affects the userinfo `groups` claim) — e.g. `GET /api/v1/packages/user2` is 403;
    PKCE is mandatory for public clients; **the consent page is shown at every authorization** of a public client (upstream, RFC
    6749 §10.2: one consent per sign-in, not "one-time" as PLAN says); an authorization whose scope string differs from the user's
    existing grant fails ("a grant exists with different scope"), so `Ensure` deletes the client's grants with another scope when
    `oauthapp.Scope` changes (meta `oauth_scope`); refresh works without a secret; there is no revocation endpoint (logout forgets
    the tokens; the grant stays in the user's settings). The token passes livesync's scope rule (hello, `/-/sync/*`) and API v1.
  - **SPA serving (`routers/livesync/spa.go`; contract in `protocol/next.go`, regenerated into `types.gen.ts`).** Build source:
    **`[livesync] ASSETS_DIR`** (the Vite output `next/dist`; relative to the work path), else the copy embedded with build tag
    **`livesync_embed`** (`rm -rf routers/livesync/next_dist && cp -r next/dist routers/livesync/next_dist && go build -tags
    'livesync_embed …'`; directory git-ignored; `TestSPAEmbedded` runs only with the tag), else none (`/-/next/*` 404, opted-in
    browsers get the classic UI). Routes: `GET|HEAD /-/next/assets/*` (`Cache-Control: public, max-age=31536000, immutable`;
    `*.map`, dot files and `.vite/` never served), `/-/next/sw.js` (`Service-Worker-Allowed: {AppSubURL}/`, `no-cache`; 404 until F5
    ships one), other files at the build root (`no-cache`), `GET|POST /-/next/opt-in|opt-out[?redirect=<path on this site>]` (cookie
    `ui=next`, Path `{AppSubURL}/`, 1 year, SameSite Lax, Secure on https; 303; no CSRF protection needed — it only picks the UI),
    `GET /-/next/config` (the config JSON, for dev servers), and **index.html for every other path below `/-/next`** without an
    extension (the SPA's own routes: `/-/next/callback`, the gallery…; `no-cache` + ETag). **Canonical URLs:** a GET/HEAD with
    `Sec-Fetch-Dest: document` and cookie `ui=next` to a route of **`spaRoutes`** (the one table: `/`, `/notifications`, `/issues`,
    `/pulls`, `/{owner}/{repo}/issues[/{n}]`, `/{owner}/{repo}/pulls[/{n}]`; owner/repo must be usable names (`IsUsableUsername`,
    `IsUsableRepoName`), `{n}` > 0) gets index.html (`private, no-cache`, `Vary: Cookie, Sec-Fetch-Dest`) through the protocol
    middlewares; everything else (no cookie, XHR/fetch, iframes, POST, other routes) is upstream's. **F3–F7 extend `spaRoutes`**
    when the UI renders a route. Text files (js, css, html, json, webmanifest, svg, wasm ≤ 8 MiB) are cached in memory with brotli
    and gzip variants, `Vary: Accept-Encoding`, weak ETag + 304; binary files via `http.ServeContent`. **Compression (review round
    1):** brotli q11 (≈ 0.5 MB/s) never runs on the request path: the variants are computed in the background (warm at start, or
    started by the first request; at most 2 at a time) and until they are ready a response is encoded on the fly with brotli q4 /
    gzip default (as bootstrap). **Precompressed siblings:** `<file>.br` and `<file>.gz` in the build, not older than the file, are
    used as is when the file needs no sub-path rewrite (never served directly) — **F1/F5 may emit them** (F1's budget already
    computes q11). A new build deployed into `ASSETS_DIR` (index.html's mtime/size changes) is warmed again and cached files no
    longer on disk are dropped, so the cache mirrors the directory.
    **index.html as served:** (1) under an AppSubURL every *string literal that is exactly* `"/-/next/"` (any quote) in JS, every
    HTML attribute value / CSS `url(` starting with `/-/next/`, and JSON strings starting with it are rewritten to
    `{AppSubURL}/-/next/` (also in assets and sw.js); (2) F1's `<link rel="icon" href="data:,">` becomes Forgejo's
    `{AppSubURL}/assets/img/favicon.svg`; (3) **the config block** `<script type="application/json" id="forgejo-next-config">`
    (`protocol.NextConfig`: `app_url`, `app_sub_url`, `base`, `app_name`, `version`, `protocol`, `oauth: {client_id, redirect_uri,
    scope, authorize_url, token_url} | null`) right after `<meta charset>`; (4) **CSP** (PLAN §4.9): `default-src 'self'; script-src
    'self' 'sha256-…'` (a hash of each inline script, computed when served — so F1 needs no build-time hashing; JSON data blocks are
    not scripts), `style-src 'self' 'unsafe-inline'` (F1's splash inserts a `<style>` element at boot, which a hash cannot allow;
    switching it to a constructable stylesheet would allow dropping `unsafe-inline`), `img-src * data: blob:`, `media-src * data:
    blob:` (avatars, markdown), `font-src 'self' data:`, `connect-src 'self'`, `worker-src 'self' blob:`, `manifest-src 'self'`,
    `frame-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'self'`,
    **`require-trusted-types-for 'script'; trusted-types forgejo-next`** (review round 1 dropped `default`: a default policy applies
    implicitly to every sink, and a permissive one anywhere in the bundle would cancel enforcement). Verified with the real F1 build (`next/dist`)
    in Chromium 1243 (Playwright 1.63, scratch harness, not committed): boots with no console error or CSP/TT violation, with and
    without an AppSubURL.
    **Contract for F3 (and F4/F5):** read the config from `#forgejo-next-config` (or `GET /-/next/config` in dev); use exactly
    `oauth.scope`; build URLs from `app_sub_url`/`import.meta.env.BASE_URL`, never by concatenating `"/-/next"` with something
    (only exact base literals are rewritten — F1's router currently does `startsWith('/-/next/') … slice(8)`, which breaks under an
    AppSubURL: F3 must use the router basepath = `base`); create DOM sinks' values through the Trusted Types policy named
    `forgejo-next` — the only one allowed, **never a `default` policy** (e.g. server-rendered `body_html`, F4); `/-/next/callback` receives `code`+`state`. **For F5:** when livesync is
    disabled or degraded, `/-/next/sw.js` and `/-/next/*` fall through to upstream (404) and canonical URLs serve the classic UI:
    the service worker must not answer navigations from cache while online without checking the network (self-unregister on a
    404 of sw.js / of the document is the kill switch).
  - **Classic pages (PLAN §4.10; review round 1).** `routers/livesync/classic_header.tmpl` is for the operator to install as
    `templates/custom/header.tmpl` in Forgejo's custom directory (no upstream change; upstream's `base/head.tmpl` includes
    `custom/header` on every classic page, sign-in included; the admin page shows it when the UI is served). It loads
    **`GET /-/next/classic.js`** (`classic.go`, `no-cache` + ETag, 404 without a build): a "Try Forgejo Next" / "Turn off Forgejo
    Next" toggle (fixed pill bottom-right, classic `--color-primary` variables; links to `opt-in`/`opt-out?redirect=<current URL>`)
    and, at `requestIdleCallback` (not with Save-Data), `<link rel="prefetch" crossorigin>` for the build's boot files — the
    same-site script sources, modulepreloads and stylesheets of the served index.html. Verified in Chromium 1194 (toggle + hints,
    no page error). English only (no access to the classic locale). **For F5:** extend `classic.js` (e.g. register the service
    worker so the precache is filled from classic pages) rather than adding another header include.
  - **Flake `TestLivesyncHubSlowConsumer/sse` — root cause.** The failing assertion was `received > 0` ("frames were written until
    the socket was full"). The test inserted 400 comments of ≈ 8.5 KB (with their HTML) as fast as it could; when the tailer was
    behind (full runs under load), one `Hub.Deliver` received more than `SEND_BUFFER` (64 KiB in the test) of them for the
    session: the queue overflowed **inside that one call** — B5's final review made `Deliver` wake the writers only after the
    hub position is stored — so the session ended with `resume_from_cursor` before a single frame was written. Reproduced
    deterministically with a scratch test inserting the 400 comments in one transaction (one `Deliver`): 0 comments received on
    both WS and SSE, on PG. Not a hub bug: the bound is per session and a delivery larger than it disconnects (by design; the
    client resumes from its position, replays wait for room). The test was wrong to assume the writer runs between the test's
    inserts.
    **Round 0's fix did not work** (review round 1, reproduced by a reviewer: 0 of 84 received under CPU load): its
    `livesyncWaitHub` read the log head right after the commit — before the asynchronous materialization — so it never waited, and
    several transactions still reached the hub in one `Deliver`. **Fix (round 1):** `livesyncWaitHub` is a real barrier: it reads
    `capture.LastAssignedID` after the commit, waits until the outbox holds no id ≤ it (`Consume` deletes consumed rows in the
    transaction that appends their entries), then reads the head and waits for `Hub.Stats().Position`; after the first delivery the
    test also waits for `forgejo_livesync_frames_total` to grow (the writer took it), so the client is sure to receive something.
    With real pacing a session only overflows once the socket buffers are full (≈ 4 MB: the server's send buffer, tcp_wmem max;
    the client's receive buffer stays at tcp_rmem's default since autotuning grows it only as the application reads), so the test
    now uses **24-comment transactions (≈ 200 KB) and `SEND_BUFFER` 1 MiB** (WS ≈ 7 s, SSE ≈ 2.5 s; typically ~1850 of ~1970
    comments received on WS, 480–720 on SSE), and **no longer shrinks the client's receive buffer**: a 4 KiB window drains at
    ≈ 100 KB/s on loopback (delayed ACKs) and stays slow after `SetReadBuffer` raises it, so the server's 10 s write timeout cut a
    frame mid-message — and the Go `coder/websocket` client then returns the truncated compressed message as complete (`read.go`:
    `ErrUnexpectedEOF && fin && flate` ⇒ EOF; browsers fail the connection instead; B10's conformance client should not rely on
    it), SSE's `bufio.Scanner` likewise returns the partial last line. Verified: 3 × on PG and MySQL, 3 × on PG with 8 busy loops on
    the 4 vCPUs (green, ≤ 30 s for WS under that load).
    **Product note (resolved 2026-10-08, see *Burst backpressure* below):** a burst above `SEND_BUFFER` (default 4 MiB) for one
    session in one tailer batch (≤ 500 entries) disconnected even a client that reads fast (bulk imports with large bodies), and
    every subscriber of the group at once.
  - **Burst backpressure (issue round 1, 2026-10-08; fixes the product note above).** *Root cause:* the slow-consumer criterion
    was the size of one session's queue at one instant (`addedLocked`: queue > `SEND_BUFFER` ⇒ `resume_from_cursor`), and
    `Deliver` fans a whole tailer batch out under the hub lock before it wakes any writer (B5 final review: the frame must claim
    the delivery's position) — so a batch carrying more than `SEND_BUFFER` for a session overflowed it inside one call, whatever
    the client's speed; every subscriber of the group was disconnected at once (reconnect storm), and the resume replayed the same
    burst into `MAX_REPLAY` (`bootstrap_required{replay_too_long}`) or the same bound. *Fix (`services/livesync/hub`):* the queue
    size no longer decides who is slow, time does; memory stays bounded by the queue:
    - **A live change that does not fit makes its subscription fall behind instead of closing the session**
      (`conn.enqueueDelivered` → `Hub.fallBehindLocked`). Changes may fill ¾ of `SEND_BUFFER` (`conn.fitsLocked`; ¼ stays for
      control messages, so a pong / `bootstrap_required` / `barrier_ok` during a burst does not overflow; one change larger than
      that may still enter an empty queue). The subscription goes to `stateRecheck` with **`sub.behind`**, cursor = hold = `v − 1`
      (everything of its group up to there is queued), `busy++` — for the client it stays caught up (frames claim ≤ its hold,
      `barrier_ok`/`caught_up` wait for it; *superseded by issue round 3: they no longer wait for it, they claim ≤ its hold*). Nothing of the burst is kept in memory: the session's worker **pages through the log**
      (`Hub.catchUp`: `waitRoom` first, then `synclog.ReadKeys(group, cursor, until, 500)` + payloads, `replayPlan` per page —
      newest state per entity within the page, markers capped as in replays) **without `MAX_REPLAY`** (the client is connected and
      reads; it would have got these live) and **raises the hold to each page's end once the page is queued**
      (`conn.raiseHold`, in `process` under the hub lock, after the page's changes are queued — so a frame never claims an entry not
      yet queued, and a session that breaks mid-catch-up resumes from the last page instead of the burst's start); at the hub's
      position it goes live (`goLiveLocked` clears `behind`). Per-group order: entries ≤ `v−1` were queued live, the catch-up
      queues `(v−1, …]` after them, live entries follow after `goLive`. A `subscribe` with `since` on a behind subscription clears
      `behind` (a client-requested replay keeps `MAX_REPLAY`). Epochs, markers, `Skipped`, revocation work unchanged (it is a
      non-holding `stateRecheck`: an epoch sets `recheck`, the check runs before the next page; `permission_changed` caps at the
      hold; a trimmed cursor ⇒ `restartLive{cursor_trimmed}` at the hold).
    - **Same for entries held for a re-check:** held beyond the session's share (`holdLocked`) or not fitting in the queue at
      release (`releaseHeldLocked` now returns false without touching anything; it used to queue them as bounded live changes and
      overflow the session) ⇒ the subscription is `behind` and pages from its cursor (it used to replay with `MAX_REPLAY` ⇒
      `replay_too_long` on a large burst after a touch epoch, which bulk writes nearly always carry).
    - **Slow consumer = not drained in time** (*criterion changed in issue round 2: no frame finished within `DRAIN_TIMEOUT` while
      messages wait, see below; the 630 KB/s figure in this bullet no longer holds*) (`conn.checkDrain`, `[livesync] DRAIN_TIMEOUT`, default 5 s, > 0): a session whose
      oldest queued message has waited longer than that for the writer (`conn.pendingSince`, reset when the writer takes the
      queue; a per-session `time.AfterFunc`, armed when the queue becomes non-empty, re-armed for the remainder, stopped by `stop`;
      never counts a stopped session) is closed exactly as before (`slowLocked`: queue dropped, `resume_from_cursor{lastTo}`, WS
      1013, `slow_consumer_disconnects_total`). A client that does not read hits it DRAIN_TIMEOUT after its socket filled; a client
      that reads must drain what one writer step took (≤ ¾ `SEND_BUFFER` + control) within it — ≈ 630 KB/s with the defaults while
      it is fully behind, nothing while it is not. `Config.WriteTimeout` is raised to ≥ 2 × `DrainTimeout`, so a stuck write
      (10 s) never pre-empts the `resume_from_cursor`. Control messages beyond `SEND_BUFFER` still close at once (a ping flood).
      Memory per session: the queue (≤ `SEND_BUFFER`) + held entries (≤ `SEND_BUFFER`) + one page being sent (≤ 500 entries) — as
      for replays.
    - **Also fixed (found while testing the catch-up): own-profile order.** `fanOutLocked` sent the viewer's own `User` entry
      through the "own profile" path whenever its group's subscription was not live (replaying, held, behind): it arrived before
      older entries of the group the subscription had not sent yet, and a client resuming the group from the highest `v` it got
      skipped them (pre-existing for replays/re-checks; bursts made it likely). Now any subscription of the group sends it (as live
      ones always did: "or may not, by unit"); the path is for viewers not subscribed to the group.
    - **Metric added:** `forgejo_livesync_send_buffer_catch_ups_total` (subscriptions that fell behind and caught up from the log);
      `slow_consumer_disconnects_total`'s help text now names `DRAIN_TIMEOUT`. **Setting added:** `DRAIN_TIMEOUT` (5s, > 0).
      Wire protocol unchanged (`gen-protocol.sh --check` up to date).
    - **Tests (unit, `hub/burst_test.go`, SQLite):** `TestBurstReachesFastClient` (1000 changes ≈ 12 × `SEND_BUFFER` 8000 in one
      `Deliver`, two groups, `MAX_REPLAY` 5: both subscriptions behind, catch-up metric up, every change once and in order per
      group, no frame's `to` claims an entry not yet received, sampled queue ≤ `SEND_BUFFER`, live again, `barrier_ok`, no close,
      no holds left), `TestBurstCatchUpFrameTo` (manual writer, 1000 entries in one group = 3 pages: no frame claims past what was
      sent, a claim between the pages exists and a new session resuming from it gets exactly the rest), `TestHeldReleaseCatchesUp`
      (held entries that do not fit at release ⇒ behind, everything arrives, no `resume_from_cursor`), `TestSlowConsumer` (moved
      here: a burst does not close a non-reading client at once; DRAIN_TIMEOUT later it is closed with `resume_from_cursor{1}` +
      1013, unsent changes dropped, metric +1), `TestSlowReader` (a client reading at 5 B/ms is closed, queue ≤ `SEND_BUFFER`),
      `TestControlRoomDuringBurst` (pongs queued behind a full queue of changes), `TestSelfProfileInOrderWhileBehind`.
      `TestControlMessagesBounded` unchanged. Against the old overflow rule (`enqueueDelivered` ignoring the fit)
      `TestBurstReachesFastClient`, `TestBurstCatchUpFrameTo` (`resume_from_cursor`) and `TestSlowConsumer` (closed at once) fail;
      `TestSelfProfileInOrderWhileBehind` fails with the old own-profile condition. **Integration:** **`TestLivesyncHubBurst`**
      (`ws` + `sse`; `SEND_BUFFER` 256 KiB, `MAX_REPLAY` 50; two subscribers of `issue:1`; 150 comments of ≈ 17 KB with HTML ≈
      2.5 MB in **one transaction**: both clients get all 150 (≈ 1 s), then `barrier_ok`; catch-up metric up, no slow-consumer
      disconnect) — with the old rule it fails on both DBs with `resume_from_cursor` after **0 of 150** comments (the B8 repro);
      `TestLivesyncHubSlowConsumer` keeps its scenario with `DRAIN_TIMEOUT = 2s` (WS ≈ 1850 of ≈ 2400 comments, SSE 480–720 of
      ≈ 1000–1300 before `resume_from_cursor` at a position it was sent, 1013).
    - **Commands:** hub package `-race -count=20` green (145 s), the new tests `-race -count=40`; livesync + `routers/livesync`
      unit tests `-race`; `TestLivesync*|TestVersion` on PG 16 (`gtestschema`: 50 pass, 3 MySQL-only skips) and MySQL 8.0 binlog
      on (52 pass, 1 skip), `TestLivesyncHub*` `-test.count 3` on both, no testlogger "FATAL ERROR"; gofumpt clean, golangci-lint
      `services/livesync/...`, `routers/livesync/...`, `models/livesync/...`, `tests/integration/...` (0 issues), `go vet`,
      deadcode diff clean, `gen-protocol.sh --check` up to date; fork diff unchanged (`assets/go-licenses.json`, `cmd/web.go`,
      `go.mod`, `go.sum`). MariaDB not run (no trigger change).
    - **Issue round 2 (2026-10-08): `DRAIN_TIMEOUT` also disconnected slow-but-steady clients.** *Root cause:* `pendingSince` was
      reset only by `take()`, and the writer cannot take again before it has written everything it took last time; so a session was
      closed whenever writing **one writer step** took longer than `DRAIN_TIMEOUT` while anything waited behind it. Replays, catch-ups
      and log tails refill the queue to `SEND_BUFFER/2` through `waitRoom` right after each take, so each step is ≈ 2 MiB with the
      defaults and the client needed ≈ 420–630 KB/s (≈ 3.4–5 Mbit/s): mobile links got `resume_from_cursor`, reconnected and replayed
      again with at most one step of progress per round (none when the welcome alone was slow); a live burst that fits in the buffer
      (1–3 MiB) disconnected a slow reader as soon as any later message (change, pong) waited 5 s behind it. Before B8's fix replays
      and log tails just waited for room (only `WriteTimeout` 10 s per frame of ≤ 256 KiB, ≈ 26 KB/s), and such a burst only failed
      beyond 4 MiB. *Fix (`conn.write`):* the criterion measures **progress**, not the wait behind the in-flight step: every frame
      written while something is queued resets `pendingSince` to now. A session is slow when messages wait and the writer finished no
      frame for `DRAIN_TIMEOUT` (`checkDrain` unchanged otherwise: the timer re-arms for the remainder). Requirement: one frame
      (≤ `maxFrameBytes` 256 KiB; replays/catch-ups pack changes into full frames, log messages are ≤ 128 KiB, live frames are usually
      small) per `DRAIN_TIMEOUT` while something waits — ≈ 52 KB/s worst case with the defaults (vs ≈ 26 KB/s before B8, when a frame
      had the 10 s `WriteTimeout`; raise `DRAIN_TIMEOUT` for slower links — the settings doc says so). A client that does not read is
      still closed `DRAIN_TIMEOUT` after its socket filled (the writer is stuck in one write, nothing completes); memory is still
      bounded by the queue (catch-ups and replays wait for room), so a slow reader that keeps up frame by frame stays connected and
      pages through the log. Doc comments (`Config.DrainTimeout`, package doc, `settings.go` `DRAIN_TIMEOUT`, `SlowConsumers` metric)
      updated. No wire, setting or metric change.
      *Tests (`hub/burst_test.go`):* client reading 2000 B/ms (a frame of 2 × 100 KiB changes ≈ 100 ms; a step of half / three
      quarters of `SEND_BUFFER` 2 MiB ≥ 500 ms), `DRAIN_TIMEOUT` 250 ms: **`TestSlowSteadyReplay`** (since = 0, 24 changes ≈ 2.4 MB:
      all in order, `caught_up`, no close, no slow-consumer metric), **`TestSlowSteadyBurst`** (12 live changes ≈ 1.2 MB that fit,
      then one more change + a ping 50 ms later: all 13 + pong, no close), **`TestSlowSteadyLogTail`** (100 lines of 20 KiB ≈ 2 MB,
      job done: every line, offsets contiguous, `done`, no close). With the old `conn.go` all three fail with `resume_from_cursor`
      (after 11 of 24 changes, 12 of 13, 60 of 100 lines). `TestSlowConsumer` (non-reading client) and `TestSlowReader` (a frame
      takes 300 ms > 200 ms) still close. **Also fixed: `TestSlowReader` flaked** (2/60 under `-race`, before and after this change):
      the client read at 5 B/ms from the start, so the ≈ 2 KB welcome took ≈ 400 ms and `caught_up`, when queued after the writer
      had taken the welcome alone, waited past `DRAIN_TIMEOUT`; the rate is now set after `caught_up` (`fakeTransport.setRate`, under
      its mutex — the field was read unsynchronised by the writer).
      *Commands:* hub package `-race -count=10` green (103 s), `TestSlowReader|TestSlowSteady` `-race -count=40` green, livesync +
      `routers/livesync` unit tests; `TestLivesync*|TestVersion` on PG 16 (`gtestschema`: 50 pass, 3 MySQL-only skips) and MySQL 8.0
      binlog on (52 pass, 1 skip), `TestLivesyncHub*` `-test.count 3` on both, no testlogger "FATAL ERROR"; gofumpt, `go vet`,
      golangci-lint (`services/livesync/...`, `routers/livesync/...`, `models/livesync/...`: 0 issues), deadcode diff clean,
      `gen-protocol.sh --check` up to date; fork diff unchanged (`assets/go-licenses.json`, `cmd/web.go`, `go.mod`, `go.sum`).
      MariaDB not run (no trigger change).
    - **Issue round 3 (2026-10-08): a permanently behind subscription blocked the session's worker.** *Root cause:* `Hub.process`
      ran a subscription until it was live: a behind one called `catchUp` page after page until `cursor ≥ h.pos`. When the group is
      written faster than the client reads (≈ 50 writes/s of ≈ 1 KiB to one group against a client at ≈ 52 KB/s, within PLAN §4.11's
      10× target; or a client holding a revoked token that reads slowly on purpose) it never got there, so the worker never returned
      to `drainWork`: no periodic token/account re-validation (`SESSION_CHECK_INTERVAL`; the revalidate ticker was not even read, it
      lives in `workLoop`'s `select`), and nothing else in `c.work` ran (replays of new subscriptions, re-checks of other suspended
      subscriptions). Old since B5; round 2 made it reachable (before it, such a client was closed with `resume_from_cursor` and its
      reconnect re-authenticated). Also, `caught_up` and `barrier_ok` waited for `busy == 0`, which counted behind and rechecked
      subscriptions, so even with the worker free they never came while one subscription stayed behind. *Fix:* (1) `process` does
      **one step** (a permission check, one replay range up to the hub's position, or one catch-up page) and, unless `s` is live or
      gone, appends it back to `c.work` (no kick: the worker is in `drainWork`); `MaxReplay`'s count moved from a local to
      `sub.scanned` (reset when a replay starts — `subscribeLocked`'s `gen++` — and in `goLiveLocked`). (2) `drainWork` polls the
      revalidate ticker between steps (non-blocking; `workLoop` passes the tick it consumed as `due`), so `revalidateSession` runs
      between two pages. (3) `conn.busy` → **`conn.replaying`** / `sub.replaying`: only replays the client asked for (hello /
      subscribe with a since, set in `subscribeLocked`'s replay branch, also for a re-subscribed `stateRecheck` subscription; cleared
      in `goLiveLocked` / `removeSubLocked`). `caught_up` waits for `replaying == 0` and claims `c.position()` (≤ every hold);
      `checkBarrierLocked` answers when `replaying == 0` and `position() ≥ head`, with `position()`, and runs again after each page
      raised a hold. Rechecked/behind subscriptions are caught up for the client (frames were already capped by their holds), so
      this keeps the protocol's meaning (`caught_up`: every replay asked for is done, every group complete up to `sync_id`;
      `barrier_ok`: everything up to the barrier's head was sent); when no subscription is rechecked or behind, `position()` is the
      hub's position, as before. Latency bounds now: re-validation and other work wait at most one step — a catch-up page (≤ 500
      entries) or one replay range (≤ `MAX_REPLAY` in total for a replay); keep-alive pings still run only when the worker is idle
      (data flows during a catch-up). Doc comments (package doc, `process`, `drainWork`, `caughtUpLocked`, `checkBarrierLocked`,
      `conn.replaying`) updated; no wire, setting or metric change.
      *Tests (`hub/behind_test.go`):* `behindClient`: SEND_BUFFER 256 KiB, DRAIN_TIMEOUT 1 s, client reads 500 B/ms after
      `caught_up`, a writer appends 5 × 1 KiB labels to `repo:1` and delivers every ≈ 2 ms (≈ 1.7 k entries/s here); the test requires
      `repo:1` behind, and still behind 1 s later. **`TestBehindRevalidates`** (`RevalidateInterval` 50 ms; the authenticator starts
      refusing: `session_invalid` + close 1008 within 5 s), **`TestBehindOtherWork`** (a barrier, then `subscribe
      repo:2` since before its 2 delivered entries: `subscribed`, both replayed, `caught_up` and `barrier_ok ≥ head` while `repo:1` is
      still behind, neither claiming an entry of `repo:1` not yet received — checked against the log). With the old `conn.go`/
      `hub.go`/`replay.go`/`session.go` (`go test -overlay`) both fail: no `session_invalid` within 5 s; no `caught_up`/`barrier_ok`
      within 20 s. `TestBurstReachesFastClient` asserts `replaying == 0` instead of `busy == 0`.
      *Commands:* hub package `-race -count=8` green (136 s) and `-count=1` without race; every livesync / `routers/livesync` /
      `models/livesync` unit test package; `TestLivesync*|TestVersion` on PG 16 (`gtestschema`: 50 pass, 3 MySQL-only skips) and
      MySQL 8.0 binlog on (52 pass, 1 skip), `TestLivesyncHub*` `-test.count 3` on both, no testlogger "FATAL ERROR"; gofumpt,
      `go vet`, golangci-lint (`services/livesync/...`, `routers/livesync/...`, `models/livesync/...`: 0 issues), deadcode diff
      clean; fork diff unchanged (`assets/go-licenses.json`, `cmd/web.go`, `go.mod`, `go.sum`). MariaDB not run (no trigger change);
      protocol untouched (`gen-protocol.sh` not needed).
    - **B9 gap (one log-tail poller per job) left as is:** sharing a poller across sessions means cross-session state in the hub
      (one reader per job feeding sessions with different offsets/tasks, per-session permission checks every 10 s, per-session
      room waits and pending lines, restarts handed between goroutines) — a new concurrency surface, not a cheap change; still
      noted in B9's known gaps.
  - **Open items (issue round 3 re-review, 2026-10-08):** none left. The re-review confirmed the round-3 fix (new tests green with
    `-race -count=2`, `TestBehind*` `-race -count=10` under 4 CPU burners, `TestLivesyncHub*` `-test.count 2` on PG 16 and MySQL 8.0;
    a second, actively written group's replay still got `caught_up`/`barrier_ok` within ≈ 0.3–6.5 s while `repo:1` stayed behind;
    no defect found in the round-robin, `replaying`, `position()` or barrier logic). Its one open item (an ending session's worker
    busy-spins until the writer gives up; reviewer's evidence: 14.6 M `process` calls in 3 s after one slow-consumer close, 667
    full replay re-reads of ≈ 300 KB in 2 s; 52 M / 655 against the pre-burst-fix hub) is fixed by issue round 4 below.
    - **Issue round 4 (2026-10-08): an ending session's worker busy-spun until the writer gave up.** *Root cause:* the worker's
      only stop condition was `c.ctx.Err()`, but `endLocked` (slowLocked / `DRAIN_TIMEOUT`, `session_invalid`, shutdown notice, no
      hello, …) only sets `c.ending` and broadcasts `room`; the context is cancelled when `writeLoop` returns, after the frame it is
      writing (up to `WriteTimeout`, 10 s default, for a client that does not read). In that window `waitRoom` returns false at once,
      so a catch-up page (`catchUp`) or a replay (`sendKeys`) failed, `process` handed `s` back (guard `c.ctx.Err() == nil`) and
      `drainWork` took it again with nothing blocking: `h.mu` twice + `c.mu` per step on the catch-up path, plus `synclog.ReadKeys`
      (≤ `MaxReplay`+1 rows) and `ReadEntries` (≤ 500 payloads) through the shared check slots on the replay path. Pre-existing since
      B5. *Fix (`services/livesync/hub`):* **`conn.ended()`** (under `c.mu`: `ending || ctx.Err() != nil`) is the worker's stop
      condition: `drainWork` checks it (via `conn.next`) on entry — before `skipIdle`'s log read — and after every step, and returns;
      `process` no longer re-queues a subscription once the session ended. `waitRoom`'s false is documented as final (callers give
      up). The session's remaining work is dropped (nothing queued after the final message is sent anyway; `stop` removes the
      subscriptions). *Audit of the other loops:* every other `ok=false` step of `process` blocks or progresses — a permission check
      (one DB check; on error `retryLater` pauses `retryPause`), a stale `gen` (a new replay), a trimmed cursor / `MAX_REPLAY`
      (`restartLive`: live, or a check next), a read error (`retryLater`); `ok=true` steps advance the cursor (a full page ends at its
      last key > cursor). `workLoop` only re-enters `drainWork` on a tick or a kick (nothing kicks an ending session: `Deliver` queues
      nothing for it, `fallBehindLocked` is skipped when ending), so the worker blocks. **Log tails**: `waitRoom` false already
      returned, but a tail with nothing new kept polling its job (`LogSource.Job` + a permission check every `logRecheck`) every
      `LogInterval` until the context ended, its `logSend` silently dropped — `runLogTail` now loops `for !c.ended()` and `logSend`
      returns false once the session ended. Writer (`writeLoop`) and keep-alive were already bounded (they block on the transport).
      New test hook `conn.onStep` (tests only, set before `start`, like `onWake`; called by `conn.next`). No wire, setting or
      metric change.
      *Tests (`hub/ending_test.go`):* **`TestEndingWorkerStops/catch-up`** (SEND_BUFFER 64 KiB, DRAIN_TIMEOUT 200 ms, WriteTimeout
      10 s; a caught-up `repo:1` client stops reading, a 200 × 1 KiB burst: `repo:1` behind, `slowLocked` while the catch-up waits
      for room; over 300 ms with the writer still stuck — context alive — the worker takes ≤ 2 decisions while ending; actual 1),
      **`TestEndingWorkerStops/replay`** (300 × 1 KiB entries, gate before the hello, hello replay since 0: same bound),
      **`TestEndingWorkerShutdown`** (24 sessions replaying with a stuck writer, `Hub.Shutdown`: ≤ n + 4 decisions in all over
      300 ms; actual 24; every session closed 1001 once the writers are released), **`TestEndingLogTailStops`** (a tail polling
      every 5 ms, the writer stuck on `session_invalid`: no `Job` poll over 300 ms; `fakeLogs.polls` added). Against the old
      `replay.go` (`go test -overlay`, hook placed at the top of the old loop): 1.8 M decisions (catch-up; ≈ 140 k under `-race`),
      111 (replay; 22 under `-race`), 330 (shutdown; ≈ 180 under `-race`); against the old `logs.go`: 57 polls in 300 ms.
      *Commands:* hub package `-race -count=20` green (378 s), `TestEnding*` `-race -count=5`; every livesync / `routers/livesync` /
      `models/livesync` unit test package `-race`; `TestLivesync*|TestVersion` on PG 16 (`gtestschema`: 50 pass, 3 MySQL-only skips)
      and MySQL 8.0 binlog on (52 pass, 1 skip), `TestLivesyncHub*` `-test.count 3` on both; gofumpt, `go vet`, golangci-lint
      (`services/livesync/...`, `routers/livesync/...`, `models/livesync/...`: 0 issues), deadcode diff clean; fork diff unchanged
      (`assets/go-licenses.json`, `cmd/web.go`, `go.mod`, `go.sum`). MariaDB not run (no trigger change); protocol untouched.
  - **Settings added:** `TRIGGER_CHECK_INTERVAL` (1m, ≥ 0), `ASSETS_DIR` (""), `OAUTH_REDIRECT_URIS` ("").
  - **livesync_meta names added:** `oauth_client_id`, `oauth_scope`.
  - **APIs for later milestones.** `livesync_service.{Disable, State, InitError, OAuthApp, CollectStatus}`, `StateRunning/
    Degraded/Stopped`, `ErrInvalidSettings`; `capture.{Uninstall, UninstallReport, TablesScript}`, `Status.{Installed,
    UninstallStatements, UninstallScript}`, `Batch.Seen`; `hub.Hub.Stats(top)` (`Stats`, `UserStats`, `TransportWebSocket/SSE`);
    `metrics.*` (add a metric there and register it in `Register`); `oauthapp.{Ensure, Scope, Name, RedirectURIs, App,
    ErrOAuth2Disabled}`; `capture.Batch.Consumed`; `/-/next/classic.js` + `classic_header.tmpl` (round 1); `protocol.{NextConfig, NextOAuth, NextConfigElementID, NextUICookie(Value), TrustedTypesPolicy, RUMReport,
    RUMMark*, RUMEvent*}`; `routers/livesync.spaRoutes` (the route table). Test helpers: `livesyncMetric(t, name, labels…)`
    (default registry), `livesyncWaitHub(t)`, `livesyncScopedToken`, `livesyncPKCE`, `livesyncDist`.
  - **Tests.** Unit: `routers/livesync` — `TestSPARoute`, `TestRewriteBase`, `TestDocumentCSP`, `TestSPAServing` (fixture dist,
    with and without AppSubURL: immutable/compressed/304 assets, no maps or manifest, sw.js header, document + config + CSP hash,
    canonical route only with cookie + `Sec-Fetch-Dest: document` + GET), `TestSPANoBuild`, `TestOptInOut` (+ `localRedirect`),
    `TestInsertConfig`, `TestAdminSessionAuth` (fake upstream probe: admin, user, anonymous, prohibited 200 page, password redirect),
    `TestDegradedHandler`, `TestRUM`, `TestRateLimiter`, `TestSPAEmbedded` (tag `livesync_embed`); `services/livesync` — settings,
    `TestInitWithoutDatabase/{invalid,degraded}`; `capture` — `TestUninstallStatements`. Round 1: `TestSPACompression` (on the fly
    before the background variants, precompressed siblings only without a rewrite and never served directly, new build re-warmed and
    a removed chunk dropped), `TestBootFiles`, `TestClassicScript` (config, sub-path, header template rendered with Forgejo's func
    map), `TestAdminPageClassicAndOAuth`, `TestDocumentCSP` (only `forgejo-next`), `TestInitWithoutDatabase/disabled with invalid
    settings`, `TestConsumeHot` (deferred row not counted); integration `TestLivesyncUninstallMonotonicIDs`, `TestLivesyncOAuth`
    (write:user / write:organization endpoints 403; "client id forgotten" ⇒ adopted, a user's app of that name is not),
    `TestLivesyncSPA` (`classic.js`), `TestLivesyncHubSlowConsumer` (barrier). Also fixed: `TestReaderOutboxRecreatedEmpty`
    (capture unit test, flaked under `-race`: the reader's late `Commit` overwrote the cursor the test had just set). Test helper
    `spaHandler` waits for the background warm (`spa.warms`), so no goroutine reads settings a later test mocks. Integration (**PG 16 `gtestschema` and
    MySQL 8.0 binlog on**): **`TestLivesyncOAuth`** (provisioned once, idempotent across 2 restarts, edits put back, extra dev
    redirect URI, full PKCE flow from the classic consent page for both `ENABLE_ADDITIONAL_GRANT_SCOPES` values ⇒ token works for
    API v1 GET/POST and a WebSocket `hello` (welcome, `repo:1` granted), package scope 403, refresh without secret, no-PKCE refused,
    grant scope; scope change revokes old grants; deleted ⇒ recreated; OAuth2 off ⇒ livesync runs, config `oauth: null`),
    **`TestLivesyncSPA`** (ASSETS_DIR fixture: immutable asset, map 404, sw.js, `/-/next/callback` document with the client id and
    CSP hash; `/user2/repo1/issues/1` classic without cookie / with fetch dest / without dest, SPA after `/-/next/opt-in`, classic
    for unsupported routes and after opt-out), **`TestLivesyncAdminDegraded`** (verify mode, label trigger dropped: degraded handler,
    health 503 degraded, anonymous ⇒ login redirect, non-admin session / non-admin token / admin token without `read:admin` ⇒ 403,
    bad token 401, admin session ⇒ HTML with the repair and uninstall DDL, admin token ⇒ JSON (problems, scripts = `Script()` /
    `UninstallScript()`, pending), metric `up{state="degraded"}`), **`TestLivesyncAdminRunning`** (sessions, writer, OAuth, `/metrics`
    via `routers/web.Metrics` lists every livesync family after real traffic, a keyed replay counts as `replay`),
    **`TestLivesyncDisable`**, **`TestLivesyncTriggerWatch`**, `TestLivesyncHubSlowConsumer` (rewritten, see above).
  - **Commands run:** gofumpt (clean), `golangci-lint run ./services/livesync/... ./routers/livesync/... ./models/livesync/...` and
    `./tests/integration/...` (0 issues), `go vet` (also with `-tags livesync_embed`), deadcode diff (clean), `go mod tidy -diff`
    (clean; no go.mod change), unit tests of every livesync package with `-race`, `next/tools/gen-protocol.sh --check` (up to date)
    + `npm run typecheck` in `next/` (needs `npm ci`; removed again afterwards), full `-test.run 'TestLivesync|TestVersion'` on PG 16
    (`gtestschema`) and MySQL 8.0: **all pass, no testlogger "FATAL ERROR"**; `TestLivesyncHubSlowConsumer|TestLivesyncTriggerWatch|
    TestLivesyncDisable` `-test.count 3` on both (green); the scratch burst repro (above); the real `next/dist` in Chromium under the
    CSP (above); fork-diff check unchanged (`assets/go-licenses.json`, `cmd/web.go`, `go.mod`, `go.sum`). MariaDB not run (the
    uninstall's `ALTER TABLE … AUTO_INCREMENT` is plain MySQL syntax MariaDB shares; no trigger body change).
  - **Review round 1 — commands run:** gofumpt, golangci-lint (`./services/livesync/... ./routers/livesync/... ./models/livesync/...
    ./tests/integration/...`, 0 issues), `go vet`, deadcode diff (clean), `go mod tidy -diff` (clean), unit tests of every livesync
    package with `-race` (routers/livesync 8 × in a row), `gen-protocol.sh --check`, full `-test.run 'TestLivesync|TestVersion'` on
    PG 16 (`gtestschema`) and MySQL 8.0: all pass, no testlogger "FATAL ERROR"; the changed tests 3 × on both; the slow-consumer
    test under CPU load (above); classic.js in Chromium; fork diff unchanged. With `-tags livesync_embed` the non-embed unit tests
    (`TestSPANoBuild`, `TestHandlerRouting`) fail as before (they assume no embedded build; only `TestSPAEmbedded` is meant for that tag).
  - **Not done / known gaps.** A degraded instance does not retry Init (restart after the DBA's DDL). No admin action buttons
    (read-only page; the kill switch is the setting). The classic-page header is installed by the operator (no upstream change). Commit → reader delay not measured (no outbox timestamp). No concurrent-bootstrap
    limit (B6's note) — the bootstrap metrics show the load. Session-based admin access depends on upstream's `/admin/system_status`
    (SURFACE.md).

#### B9 — Gap endpoints
- [x] **Status** — done 2026-10-08 (final check: `TestLivesyncAPI` + `TestLivesyncAPILogTail` + `TestVersion` green on PG 16/`gtestschema` and MySQL 8.0 binlog on (17 pass / 0 skip each), no testlogger "FATAL ERROR"; unit tests of every livesync package, `go vet` clean; `gen-protocol.sh --check` up to date; fork diff = `assets/go-licenses.json`, `cmd/web.go`, `go.mod`, `go.sum`; review round 1 (9 findings) fixed, no open items)
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
  - **Files.** `services/livesync/protocol/{api,logs}.go` (wire types + the route table, regenerated
    `next/src/protocol/types.gen.ts`; `next/tools/tygo.yaml` unions gain `LogTailMessage`/`LogUntailMessage`,
    `LogMessage`/`LogClosedMessage`, `LogClosedReason`, `ViewedState`; `TestTypeScriptUnions` checks them);
    `routers/livesync/{api,api_boards,api_body,api_viewed,api_git,api_markdown}.go` (+ `api_test.go`), `routes.go`
    (`registerAPI`), `wrap.go` (write dispatch), `idempotency.go` (`serveKeyed` target, `serveSynced`), `auth.go`
    (`authenticateResult`, `hasScope`); `services/livesync/hub/logs.go` (+ `logs_test.go`) and `conn.go`/`session.go`/`hub.go`
    (`Config.Logs`, `LogInterval`); `services/livesync/actionslog/actionslog.go` (+ SQLite test); `materialize/render.go`
    (`RenderPreview`); `settings.go` (`LOG_TAIL_INTERVAL`), `livesync.go` (hub wiring); `SURFACE.md`;
    `tests/integration/livesync_api_test.go` (+ log fields in `livesyncMsg`).
  - **Scope decision: the Actions log tail is done here** (the tracker deferred it to F7; the orchestrator asked for it
    with B9). It is a session feature of the B5 hub, not an HTTP endpoint.
  - **Contract (the only definition: `services/livesync/protocol/api.go` + `logs.go`, mirrored in `types.gen.ts`).**
    Routes (ids are database ids — issue id, not number; repositories by id so renames do not break immutable caches):
    `POST /-/sync/api/projects/{id}/columns` (`APIColumnCreate{title, color?}` → 201 `APICreated{id}`; 422 at 20
    columns), `PATCH …/columns/{column}` (`APIColumnEdit{title?, color?, default?}` → 200 `APICreated`), `DELETE
    …/columns/{column}` (204; 422 for the default column; its cards move to the default column), `PUT
    /-/sync/api/projects/{id}/column-order` (`APIColumnOrder{column_ids}` = every column once, else 409), `POST
    …/columns/{column}/cards` (`APICardMove{issue_id, position?}` — index among the target column's cards **the viewer may
    read**, applied to the column as it is when the move runs (review round 1), or `{cards:[{issue_id, sorting}]}` = the
    column's full order as the classic board sends it; every issue must already be on the board (409) and readable (404);
    503 + Retry-After when concurrent moves kept it failing), `PATCH /-/sync/api/issues/{id}/body` and
    `/comments/{id}/body` (`APIBodyEdit{body, expected_version}` → 200 `APIBodyEdited{content_version}`, **409
    `APIBodyConflict{message, body, content_version}`** = the current text/version, the 3-way-merge base), `GET
    /-/sync/api/issues/{id}/viewed[?head=sha]` and `PUT …/viewed` (`APIViewedUpdate{commit_sha?, files:{path: bool}}` →
    `APIViewedFiles{pull_id, commit_sha, files:{path: viewed|unviewed|has_changed}}`), `POST /-/sync/api/markdown`
    (`APIMarkdownRequest{repo_id?, items}` → `APIMarkdownResponse{html}`, ≤ 64 items / 1 MiB), and the immutable reads
    `GET /-/sync/api/repos/{id}/tree/{commit}[/{path}]` (`APITree{commit, path, sha, entries:[{name, type
    blob|tree|commit|symlink, mode "100644", sha, size?}]}`), `/raw/{commit}/{path}` and `/blobs/{sha}` (bytes,
    `application/octet-stream`, nosniff, sandbox CSP, Content-Length), `/blame/{commit}/{path}[?bypass_ignore=1]`
    (`APIBlame{commit, path, parts:[{sha, start_line, lines, previous_sha?, previous_path?}], commits:{sha:{summary,
    author_name, author_email, author_id, authored_at, committed_at}}, uses_ignore_revs, faulty_ignore_revs_file}` — no
    line text: the lines are the raw file's), `/diff/{commit}` (against the first parent, or the empty tree for a root
    commit) and `/diff/{base}/{head}` (`git diff -M`, `text/plain`, streamed). Errors are `{message}`: 401 token, 403
    account / missing write scope / readable but not changeable, **404 = missing or not readable (never told apart) and
    every non-SHA address** (branch, tag, abbreviated, uppercase), 400 malformed, 409 stale view, 422 refused by state,
    503 + Retry-After while livesync is stopped.
  - **Writes reuse B7.** `handler.ServeHTTP` sends a write below `/-/sync/api/` (`apiWrite`: POST/PUT/PATCH/DELETE except
    the read-only `POST /markdown`) with an `Idempotency-Key` through `serveKeyed(w, req, path, h.own)` — the B7 layer
    with livesync's router as the target instead of API v1 (new `keyedWrite.target`; store, hash, wait, replay, 409/422,
    credential and account checks unchanged). **Without a key a write gets the sync-id echo too** (`serveSynced`: outbox
    position before/after, response buffered, `synced` = B7's bounded `WaitSynced` / `SyncedNow` for errors), so every gap
    write answers with `X-Livesync-Sync-Id` (B7 contract). Write bodies are acknowledgements (`{id}`, `{content_version}`,
    the viewed state); **entities arrive as deltas** (no DTO building outside the materializer). No crash-window check for
    gap creates (a column create interrupted by a crash runs again on retry; documented in `protocol/api.go`). The
    markdown preview ignores the key (no record, no sync id).
  - **Auth / scopes.** `authenticate` (B4 rules: read scopes, account checks) for every endpoint; writes additionally
    need `write:issue` (boards — API v1 has no projects API and cards are issues —, body edits) or `write:repository`
    (viewed files: API v1's pull routes are in the repository category). The Next UI's OAuth scope (B8) has both.
  - **Permissions (equivalent to the classic UI; deliberate differences in bold).** Writes use
    `access_model.GetUserRepoPermission` like the repository context; reads use `perm.Cache.Check` (B4's API-v1-equivalent
    decisions, cached for the viewer's repositories). Boards: repository project = `MustEnableProjects` (globally enabled,
    unit readable, else 404) + `CanWrite(projects)` (403) + not archived; organization project = organization visible +
    `Organization.UnitPermission(projects)` ≥ read (else 404) / ≥ write (else 403); user project = its owner (403 for
    others who may see the owner, else 404); card moves check repository / owner like the classic board and **also that
    the viewer may read each moved issue** (upstream does not). Body edits: issue readable (`checkIssueRights`), poster or
    `CanWriteIssuesOrPulls`, **comments also need the issue readable** (classic only needs repository access), another
    user's pending-review comment is 404. Viewed files: a readable pull request; PUT refuses archived repositories. Immutable
    reads: the code unit. Markdown with `repo_id`: the repository readable. **Archived repositories answer 403 "archived"**
    (the classic UI answers 404; the viewer may read it, so 403 is honest and leaks nothing).
  - **Immutable responses.** `Cache-Control: private, max-age=31536000, immutable` + **`Vary: Authorization`** (a
    browser cache shared by two accounts must not serve one's private blobs to the other; the HTTP cache therefore keys by
    token, i.e. per access-token lifetime — F7's IDB/SW cache by SHA is the real cache) + strong ETags: tree = tree SHA,
    raw/blobs = blob SHA, blame = hex SHA-256 of commit, path and bypass flag (review round 1), diff = commit or
    `base..head`; `If-None-Match` ⇒ 304 after the
    permission check and before reading content (trees/raw resolve the path first). A blob SHA is checked to be a blob
    (cat-file batch-check type). SHA-256 repositories accept 64-hex ids. Blame refuses files ≥ `[ui]
    MAX_DISPLAY_FILE_SIZE` (422); diffs and blobs are streamed without a size limit.
  - **Viewed files.** GET returns the newest state (`GetNewestReviewState`); with `?head=` (another commit) the files
    changed since the state's commit that were viewed are reported `has_changed` **without writing** (the classic files
    view stores that marker when it renders). PUT = `UpdateReviewState` (merge), default commit = the pull request's
    head. The rows are synced as `ReviewState` in `user:{viewer}` (unit self), so F7 normally reads them from the pool.
  - **Markdown preview = the materializer's rendering** (`materialize.RenderPreview` shares `renderMarkdown`): the preview
    is byte-for-byte the `body_html` the sync log will carry for that text (asserted against a real IssueBody entry),
    i.e. rendered without a viewer (@mentions link public users only, B3). Without `repo_id`: plain markdown.
  - **Actions log tail (hub).** C→S `log_tail{job_id, task_id?, offset?}` / `log_untail{job_id}`; S→C `log{job_id,
    task_id, offset, lines:[{t (Unix ms), c}], steps?, done?, expired?}` and `log_closed{job_id, reason:
    forbidden|limit|error}`. Offsets are 0-based line indexes of one task; a re-run (another task) restarts at 0 with the
    new `task_id`; resume = tail again with `task_id` + `offset` = lines held. `steps` (as the classic job page,
    `actions.FullSteps`: name, status, log_index, log_length, started, stopped) in the first message and whenever they
    change. Each tail is a goroutine of the session (≤ 8 per session; ended by `log_untail`, a restart of the same job, the
    session's end — `stop` waits for them — or completion): every `[livesync] LOG_TAIL_INTERVAL` (default 1s) it reads the
    job, its task and steps through `hub.LogSource` (`actionslog.Source`: 3 primary-key queries; `setting.Actions.Enabled`
    off ⇒ not found), sends the new lines in messages of ≤ 500 lines / 128 KiB after waiting for room in the send buffer
    (like replays: never overflows the session), takes the hub's check slots for its reads, and checks the permission
    (`perm.Cache.Check(repo:{id})` with the `actions` unit) at the start, before every message with lines and at least every
    10 s — a lost permission or missing job ⇒ `log_closed{forbidden}`. Done = job and task finished and every line sent:
    at once when the log is archived (`LogInStorage`, the runner's "no more"), else after 2 quiet polls; an expired log ⇒
    `log{expired, done}`. Not in the sync log (logs are files; `action_task` is untracked); job status still comes as
    `ActionRunJob` deltas in `repo:{id}`.
  - **For F4–F7.** F4/F5: body edits through `PATCH /-/sync/api/issues|comments/{id}/body` with `expected_version` =
    the `content_version` the intent's `baseText` came from (IssueBody/Comment DTOs carry it); on 409 merge `baseText` /
    `body` / local and retry with the conflict's `content_version` (and a **new** Idempotency-Key — a retry with the same key
    replays the 409); drop the overlay at `X-Livesync-Sync-Id`. F6: boards — move-card intents send `{issue_id,
    position}` with `position` = the index among the cards the pool shows in that column (the server applies it to the
    column as it is then: cards the viewer cannot read keep their places, a card moved out meanwhile stays out — a full
    `cards` order would overwrite concurrent moves); on 503 retry after Retry-After; column CRUD/order as above; created
    column ids come back as `{id}` for temp-id remapping; markdown preview for the composer (batch up to 64). F7:
    tree/raw/blob/blame/diff by `(repo_id, sha)` with the head SHA from the synced `Branch`; cache by SHA in IDB/SW forever
    **only responses read to their end without an error** (a diff git fails mid-stream is cut: reading the body rejects);
    blame's `author_id` is a display hint resolved at response time (may go stale; nothing else changes); viewed files via
    `PUT …/viewed` (offline intent;
    `GET ?head=` for the has-changed marks); logs over the session with `log_tail`. F3–F7 still extend `spaRoutes` (B8)
    for their routes; B9 adds none.
  - **Settings added:** `LOG_TAIL_INTERVAL` (1s, > 0).
  - **Tests.** Unit: `routers/livesync` `TestValidSHA`, `TestAPIWrite`, `TestImmutable`, `TestViewedFiles`,
    `TestHandlerRouting` (gap reads/writes 503 while stopped, 405, 404, sub-path); `hub` **`TestLogTail`** (fake
    `LogSource`, real `perm.Cache` on fixtures: first message with lines + steps, only new lines later, steps-only message,
    done with an archived log, resume from task+offset, re-run ⇒ new task from 0, done after quiet polls, unreadable /
    missing ⇒ forbidden (also for the owner of a repository without the actions unit), permission lost while tailing,
    the 8-tail limit, untail, `stop` ends every tail; `-race -count=10`), `TestCutLines`; `actionslog` `TestSource`
    (fixture job 192 / task 47 with a DBFS log: state, steps, lines by offset, not found, actions disabled); `protocol`
    `TestTypeScriptUnions`; settings. Integration (**PG 16 `gtestschema` and MySQL 8.0 binlog on**):
    **`TestLivesyncAPI`** — a WebSocket session of user2 (repo:1, issue:1, user:2) receives the deltas of the writes;
    *boards*: create (201, sync id covers the `ProjectColumn` entry, delta), invalid title/colour/body 400, edit (title,
    colour removed, default moved: both columns' entries covered), unknown / other project's column 404, order (reversed,
    DB checked; incomplete 409), card moves by position (top, end) and by full order (DB sortings), not on board 409, other
    repository's / missing issue 404, delete default 422, delete other ⇒ cards in the default column + `D` entry,
    organization and user projects, user5 403 on repo1/user2 projects, private project 404, unknown 404, read-only token
    403, keyed create twice ⇒ one column + replay with the same body and sync id, same key other body ⇒ 422; *body*: edit ⇒
    `content_version + 1`, IssueBody entry covered and delta with rendered HTML; stale version ⇒ 409 with the current
    text/version and nothing changed; 403 (not poster/writer, read-only token), 404 (private, missing); comment edit by
    its poster, 409, by the repository owner, 403 for another user, 422 for a label event, keyed replay; *viewed*: empty,
    PUT ⇒ state + `ReviewState` entry/delta, merge, `?head=`, 400 for non-SHA, per-user states, read-only token 403,
    non-pull 404, private pull 404/200; *git*: tree (entries, sizes, mode, ETag = tree SHA, 304), non-SHA refs and unknown
    SHAs 404, raw = blob bytes (headers, Content-Length, 304), blob by SHA, a tree SHA as blob 404, diffs equal `git diff
    -M` (root commit vs empty tree, base/head, first parent), blame of a file written by two API commits (exact parts,
    previous commit, author id, summary), private repository 404 / owner 200; *markdown*: preview = the IssueBody
    `body_html` of an issue created with that text, no repository ⇒ plain, key ignored (no record, no sync id), private
    repository 404, 413 limits; *auth* 401s/404. **`TestLivesyncAPILogTail`** — fixture job 192 (public repo4) with a DBFS
    log written as the runner does: `log_tail` over WebSocket ⇒ lines + steps, appended lines, finish ⇒ done, resume from
    offset, job moved to private repo2 and a missing job ⇒ `log_closed{forbidden}`, user5 over SSE reads the public log.
  - **Commands run:** gofumpt (clean), `golangci-lint run ./services/livesync/... ./routers/livesync/... ./models/livesync/...`
    and `./tests/integration/...` with sqlite tags (0 issues), `go vet`, deadcode diff (clean), `go mod tidy -diff` (clean),
    unit tests of every livesync package with `-race` (hub `TestLogTail` `-race -count=10`), `next/tools/gen-protocol.sh`
    + `--check` (up to date), in `next/`: `npm ci && npm run typecheck && npm test` (193 pass; `node_modules` removed
    again), `TestLivesyncAPI*` on PG 16 (`gtestschema`) and MySQL 8.0 binlog on (green, several runs), full
    `-test.run 'TestLivesync|TestVersion'`: **PG 49 pass / 3 MySQL-only skips, MySQL 51 pass / 1 skip, no testlogger
    "FATAL ERROR"**; each commit builds on its own; fork-diff check unchanged (`assets/go-licenses.json`, `cmd/web.go`,
    `go.mod`, `go.sum`). MariaDB not run (no trigger/DDL change).
  - **Known gaps / for later.** (1) Log tails poll per tail (3 small queries per `LOG_TAIL_INTERVAL`); many viewers of one
    job each poll — a shared per-job poller (or a doorbell from the runner API's `UpdateLog`, which would be an upstream
    change) is the optimisation if needed (re-assessed with B8's burst fix, 2026-10-08: not cheap, left as is). Lines of a step summary (`renderStepSummaries`) are not sent. (2) No
    crash-window dedupe for gap creates (columns). (3) No project create/edit/close endpoints (scope was columns, cards,
    ordering; projects themselves are edited in the classic UI). (4) Tree entries' sizes cost one batch-check round trip
    per blob (fine for directories of hundreds; immutable, so cached). Diffs and blobs are streamed without a size limit
    (the client should not fetch huge ones eagerly); an error mid-stream cuts the response (not under FastCGI; review
    round 1). (5) The markdown preview
    renders anonymously like the materializer (limited/private @mentions are not linked; the classic preview links them
    for a signed-in viewer) — by design, preview = synced HTML. (6) The browser HTTP cache keys immutable responses by
    token (`Vary: Authorization`), so it only helps within one access token's lifetime. (7) Org projects whose owner is
    a user's project of another type, or issues moved between repositories, follow upstream's checks (plus readability).
  - **Review round 1 (2026-10-08).** Nine findings, all fixed:
    1. *Diffs cached broken.* `apiDiff` streamed git into the response after the immutable headers: a git failure before
       the first byte gave 200 + an empty body cached forever, a later one a short body that ended cleanly. Now
       `apiRequest.stream` runs git into a pipe and peeks: failure before the first byte ⇒ 500 without Cache-Control/ETag;
       after it ⇒ `abortResponse`. **Forgejo's `ProtocolMiddlewares` recovers every panic, also `http.ErrAbortHandler`, and
       would append an error page to the started body**, so the handler only sets a per-request flag (context value,
       `abortable`) and `handler.ServeHTTP` panics with `http.ErrAbortHandler` after livesync's router returned, where
       net/http aborts (HTTP/1.1: no final chunk; HTTP/2: stream reset). Not under FastCGI: `net/http/fcgi` recovers no
       panic (Forgejo would crash) and cannot abort; there a cut diff is only logged (documented in `protocol/api.go`).
       `TestStream` (real server through `newRouter`'s middlewares): ok, empty, early failure ⇒ 500 / no-store, late
       failure ⇒ `io.ErrUnexpectedEOF` (fails without the panic). The reviewer's `git mktree --missing` repro is not an
       integration test: its 500 is a genuine `log.Error` (a broken repository), which the harness reports as "FATAL ERROR".
    2. *Log tail re-read O(n²).* `LogSource.Lines` takes a byte budget: `actionslog.linesWithin` bounds the read by the line
       index (`LogIndexes`, `LogSize`) to ~128 KiB before the file is opened; the hub keeps lines it read but did not send
       (`pending`) for the next message instead of reading them again. `TestLogTailLongLines` (40 × 64 KiB lines from a
       source that ignores the budget: 40 messages, one read, each line read once), `TestLinesWithin`, a budget case in
       `TestSource`.
    3. *Card move lost update / MySQL 500s.* The position move read the target column outside any transaction and wrote
       every card back. Now `boardTx` runs the move in one transaction that first locks the moved cards **and** the target
       column's cards in one `SELECT … FOR UPDATE` ordered by id (two moves between the same columns lock their common
       cards in the same order, so they do not deadlock each other: none seen in 4 runs × 12 concurrent pairs per DB),
       checks that the cards are on the board (409; before, a concurrent change gave the model's error ⇒ 500), computes the
       order from the locked rows and calls `MoveIssuesOnProjectColumn` inside it (`db.WithTx` nests). The column order
       locks the project's columns before its comparison the same way. Deadlocks, serialization failures, lock wait
       timeouts and duplicate sortings (a classic board move does not lock) are retried (3 attempts), then **503 +
       Retry-After** (`concurrencyFailure`, `uniqueViolation`). `concurrent card moves` subtest (the reviewer's scenario, 12
       iterations over the real listener; the old code fails it on both DBs: a 500 on PG, issue 3 moved back on MySQL).
    4. *Tail restarts unbounded.* One goroutine per job (`runTails`): a restart, or a tail after an untail, while the job's
       goroutine still finishes the stopped tail is handed to that goroutine (the newest request wins). `tailRunners` counts
       goroutines (≤ `maxLogTailRunners` = 16, else `limit`); `maxLogTails` = 8 still counts wanted tails. Tails wait for
       slots and room with **their own** ctx (`withSlotCtx`; `waitRoom(ctx)` wakes on the tail's cancellation through
       `context.AfterFunc`), and a session's tails take turns for the hub's check slots (`tailSlot`: one read at a time, as
       replays are serialised). `TestLogTailRestarts` (a source whose read hangs ignoring ctx: 50 restarts ⇒ one goroutine;
       tail/untail of 47 jobs ⇒ never > 16 goroutines, back to 1 while the read hangs; ≤ 1 hub slot).
    5. *Positions vs hidden cards.* `position` counts the cards the viewer may read as the synced pool decides it
       (`perm.Cache.CheckGroups`, issues / pulls unit); the card goes right before the readable card at `position`, hidden
       cards keep their places. `cardIssues` no longer loads the whole project (the on-board check is the locked lookup of
       the moved ids). `board positions` subtest (user project 4: issue 18 of repo55, which has no issues unit, stays first).
    6. *Webhook payload of body edits.* `apiIssueBody` calls `issue.LoadAttributes` before `ChangeContent` (as
       `GetActionIssue`); the subtest activates webhook 1 and checks that the `issues` payload carries the poster's
       permission (admin; it was anonymous).
    7. *Pending-review comment 403/404.* The pending check runs before `bodyIssue`: another user's draft is 404 for every
       viewer (comment 4: user5 and user2 ⇒ 404).
    8. *Blame ETag / author_id.* ETag = hex SHA-256 of (commit, path, bypass) (`blameETag`: paths with `,`, `"`, non-ASCII;
       `TestBlameETag`; subtest: 64 hex digits, 304 inside a list, bypass differs). `author_id` stays (the client has no
       users' emails to resolve it) but is **documented as a display hint resolved at response time that may go stale in a
       cached copy** (`APIBlameCommit`); the F7 note above no longer says the responses never change.
    9. *Missing contract tests.* viewed `?head=` after an API commit that changes README.md (README.md `has_changed`,
       other.txt `viewed`, nothing stored) and `TestViewedFiles` with a state; expired log (`log_expired` ⇒ `log{expired,
       done}`) in `TestLivesyncAPILogTail`, task row gone ⇒ expired in `TestSource`; user5 404 / owner 200 for each of tree,
       raw, blobs, blame and diff of private repo2; commitsonpr without its code unit ⇒ 404 for every immutable read by
       its owner (once the permission change reached the cache).
    *Commands run:* gofumpt, golangci-lint (`./routers/livesync/... ./services/livesync/... ./tests/integration/...`: 0
    issues), go vet, deadcode diff (clean), `next/tools/gen-protocol.sh --check` (regenerated: doc comments), unit tests of
    every livesync package with `-race` (`TestLogTail*` `-race -count=10`), `TestLivesyncAPI*` on PG 16 (`gtestschema`)
    and MySQL 8.0 binlog on (several runs, no testlogger "FATAL ERROR"), full `-test.run 'TestLivesync|TestVersion'` on
    both.

#### B10 — Headless TS conformance suite (Phase 1 exit)
- [x] **Status** — done 2026-10-08 (final check: `next/tools/dev-forgejo.sh conformance all` green, 48/48 on PG 16 and MySQL 8.0 binlog on, 0 `[E]`/`[F]` server log lines; `npm run typecheck` and ESLint on `conformance/` clean; `package-lock.json` unchanged, `package.json` +1 script line; fork diff = `assets/go-licenses.json`, `cmd/web.go` (1 line + import), `go.mod`, `go.sum`; review round 1 closed, no open findings). **PLAN Phase 1 exit met.**
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
  - **PLAN Phase 1 exit: met (2026-10-08).** The suite (35 scenario tests; 48 with the oracle self-tests added in review
    round 1) is green against a real Forgejo binary on PG 16 and
    MySQL 8.0 (binlog on): bootstrap → live → reconnect from cursor → `group_revoked` purge → idempotent replay → no
    duplicates after a forced crash between the commit and the idempotency record, plus everything listed below. Fork diff
    unchanged: `cmd/web.go` (1 line + import), `go.mod`, `go.sum`, `assets/go-licenses.json`.
  - **The one command.** `next/tools/dev-forgejo.sh conformance all` (or `pg` / `mysql`): builds its binary, starts the dev
    DBs if needed, `npm ci` in `next/` if `node_modules` is missing, then per database starts a **fresh, isolated** Forgejo
    with the suite's settings (`conformance_ini`), runs `npm run test:conformance` against it and stops it (≈ 1.7 min for
    both; ≈ 37 s of tests per database). **It never touches the dev servers of §1.2** (other sessions' Playwright /
    integration runs use them): its own binary and work dirs under `/var/tmp/forgejo-next-conformance`
    (`NEXT_CONFORMANCE_ROOT`), ports **3020** (pg) / **3030** (mysql) (`NEXT_CONFORMANCE_PG_PORT` / `_MYSQL_PORT`), database
    **`forgejo_conformance`**, dropped and created again at the start of every run (the work dir is wiped too). A passing run
    drops the database and the work dir except its logs and prints the server log's `[E]`/`[F]` count; a failing run keeps
    everything for debugging; `NEXT_CONFORMANCE_KEEP=1` leaves the instance running. Arguments after the database go to
    Vitest (a file filter: `… conformance pg 7-restart`); `NEXT_CONFORMANCE_NO_BUILD=1` reuses the binary. The suite's
    kill/stop/start hooks name that instance explicitly (`env NEXT_DEV_ROOT=… NEXT_FORGEJO_PORT=… NEXT_FORGEJO_DB_NAME=…
    dev-forgejo.sh kill pg`), and `conformance-one` refuses to run on the dev root or the `forgejo` database. For that,
    `dev-forgejo.sh` gained `NEXT_FORGEJO_DB_NAME` (default `forgejo`; created when missing). New
    `dev-forgejo.sh kill [pg|mysql]` = SIGKILL (a crash). Settings the suite expects (in `conformance_ini`, extended by
    `NEXT_FORGEJO_EXTRA_INI`): `[livesync] ENABLED, MAX_REPLAY = 100, TRIGGER_CHECK_INTERVAL = 2s, IDEMPOTENCY_SYNC_WAIT =
    30s`, `[actions] ENABLED`. Manual run against any server: `FORGEJO_URL=… npm run test:conformance` in `next/` (other
    variables in `conformance/env.ts`; without `FORGEJO_URL` the run fails with instructions instead of passing empty).
  - **In the Go harness (as the Scope asked):** `tests/integration/livesync_conformance_test.go` `TestLivesyncConformance`
    (`make 'test-pgsql#TestLivesyncConformance'` / `test-mysql#…`): `livesyncServeWith(MAX_REPLAY 100, TRIGGER_CHECK_INTERVAL
    2s)` + `onApplicationRun`, runs `npm run test:conformance` with `FORGEJO_URL`, fixture admin `user1/password`, and
    `CONFORMANCE_SQL` built from `setting.Database` (psql with `PGOPTIONS=-c search_path=<schema>` for `gtestschema`; mysql
    with the DSN's `?…` stripped). Skipped without `next/node_modules` (or npm) and on SQLite. `7-restart.test.ts` is skipped
    there (the in-process server cannot be stopped or killed): 33 pass / 2 skipped, ≈ 23 s.
  - **Files.** `next/conformance/`: `vitest.config.ts` (own config, `name: conformance`, Node, `fileParallelism: false`,
    a name-order sequencer so `7-restart` runs last, `cacheDir` = `next/node_modules/.vite` — with the root at
    `conformance/` Vitest otherwise writes `conformance/node_modules/`, which `/node_modules/` in `.gitignore` does not
    cover), `setup.ts`, `env.ts` (capabilities: `canSQL`, `canCrash`, `canRestart`), `forgejo.ts` (API v1 helpers, users
    via the admin API with `all`-scope PATs, repositories, `WebSession` for classic-UI forms, `eventually`), `sync.ts`
    (`Session`: raw protocol client), `sse.ts` (`FetchEventSource`: Node has no EventSource), `replica.ts` (`load` of
    bootstrap/load NDJSON with the 503 gate retried, read by `parseLoaded` as strictly as the app's loader: one header of
    the group asked for first, one end line last, nothing after it, a cut response throws; `Replica`, `stateOf`),
    `forgejo.ts` `keyed()` (a keyed API v1 write that must succeed: body + echo), `sql.ts` (psql/mysql CLI: `run`, `OpenTx`,
    `sql.meta/setMeta/dropLabelTrigger/holdLogHead/count`), seven scenario files and `0-oracle.test.ts` (the suite's own
    oracles without the server: `deltaViolations`, `parseLoaded`). `setup.ts` is only the `FORGEJO_URL` guard; the Node
    stubs of `window`/`localStorage` come from F2's `integration/setup.ts`, listed first in `setupFiles` (reused, not
    copied). `next/package.json`: one script line
    (`"test:conformance": "vitest run --config conformance/vitest.config.ts"`). `next/tools/dev-forgejo.sh` (`kill`,
    `conformance`, `conformance-one`). **No new dependency; `package-lock.json` unchanged; no other `next/` source touched.**
  - **Deviations from the Scope text.** (1) `next/package.json`/`tsconfig` already existed (F1); `conformance/` was already in
    `tsconfig.node.json` and the ESLint node block, so lint/typecheck cover the suite. (2) Its own Vitest config instead of
    the F1 note's project in `vitest.config.ts` (orchestrator: keep clear of F5's edits; `npm test` = unit only, unchanged).
    (3) "a minimal raw client, not the app's sync client" — kept for the wire assertions, but **built on the app's code where
    that adds no interpretation**: the transports are F2's `openWebSocket`/`openSSE` (`src/sync/transport.ts`), NDJSON lines
    come from F2's `ndjsonLines`, all wire shapes from `types.gen.ts`; and `6-client.test.ts` drives F2's `openData`
    (SyncClient + pool + IndexedDB via fake-indexeddb) unmodified (orchestrator's preference). Nothing of `src/` was changed
    or copied.
  - **The raw client (`sync.ts`).** Keeps every message; `next(type, pred, {from, timeout})` / `change(pred)` wait for a
    message at or after an index (`mark`); tracks grants, caught-up groups and **positions per the B5 contract** (highest `v`
    received, raised by `delta.to`/`caught_up`/`pong`/`barrier_ok`/`resume_from_cursor` for caught-up groups). It checks
    invariants on every delta (`violations`, asserted empty by every file): no `*`/`!…` group, no change of a group the
    session does not hold (except an upsert of the viewer's own `User`, `id === welcome.viewer_id` — anyone else's profile
    outside a held group is a leak), sync-id order per group within a frame, payload iff upsert (`deltaViolations`).
    `closedAfterAll()` gives a file its session list: after the file all are closed, then the violations of all of them
    are asserted together. `expectConverged(s, replica, token, group)` is the convergence check (see below).
    `Replica` applies changes (`v` newer only, tombstones), complete bootstraps (lines authoritative at the watermark,
    replacement of the group / its `models` scope) and purges; scenarios compare it with a fresh bootstrap (`stateOf`).
  - **Scenarios.** `1-protocol` (WS and SSE each): invalid token ⇒ `session_invalid` + close (1008 on WS); a message before
    the hello ⇒ `error{hello_required}` + close; welcome (viewer, implicit grants with units, own profile, schemas); bootstrap
    (summary header, `v` = watermark, `end.count`) → subscribe `since` = watermark (grant units = header units) → keyed write
    ⇒ echo > watermark, delta with watermark < `v` ≤ echo, `barrier_ok` ≥ echo, position ≥ echo; unkeyed write ⇒ no echo;
    ping/pong; lazy `issue:` load; **reconnect from a cursor** (offline: create, three renames, create + delete; hello with
    `since` ⇒ each entity once at its newest state, the deleted label as one `D`, then live; replica = fresh bootstrap).
    `bootstrap_required` (WS): `cursor_unknown` (subscription stays live), `replay_too_long` (MAX_REPLAY + 1 labels; nothing
    of the group replayed; the re-bootstrap has them), `cursor_trimmed` (SQL: `log_floor` set to the head, restored after),
    `trigger_repaired` (SQL: the label insert trigger dropped; a label created meanwhile is not captured; the 2 s trigger watch
    repairs ⇒ `bootstrap_required{model: Label}` ⇒ `?model=Label` re-bootstrap contains the lost label; captured again).
    `2-permissions`: unreadable / missing / `!perm` / `*` refused alike (`forbidden`), bootstrap 404 bodies identical;
    collaborator added ⇒ `grants`; bootstrap + subscribe; issues unit disabled ⇒ `bootstrap_required{permission_changed}`,
    re-bootstrap without Issues; **units rule on resume** (unit re-enabled while away: the resumed grant's units differ from
    those held); collaborator removed ⇒ `group_revoked`, purge, nothing of the group after it (barrier), bootstrap 404,
    subscribe refused; public repo made private ⇒ `group_revoked` for `repo:` and `issue:` of an on-demand subscriber, the
    owner still gets comments. `3-idempotency`: same key twice (one issue, same bytes/Content-Type/echo, replay header, one
    delta, `v` ≤ echo); key reused with another body ⇒ 422; 8 concurrent duplicates ⇒ exactly one run, the rest 409 +
    Retry-After or replay, a later retry gets the stored answer, one issue; keyed delete replayed (204, same echo, `D` with
    `v` ≤ echo); no key / GET with a key ⇒ untouched; keyed write without token ⇒ 401. `4-gap`: issue body edit (200 +
    `content_version + 1`, echo ≥ the IssueBody delta with rendered HTML; stale ⇒ 409 with current text/version; reader ⇒
    403; keyed replay), **board** (project created through the classic form — Forgejo uses Go's cross-origin protection, no
    CSRF token — and the issue put on it with `/{o}/{r}/issues/projects`; column create 201 + delta ≤ echo; card move 204 +
    `ProjectIssue.column_id` delta; column order 204, incomplete 409; reader 403; keyed create replayed), viewed files
    (`ReviewState` delta in `user:{me}` ≤ echo; per viewer: bob's state does not reach alice), immutable tree/raw/blob/blame/
    diff (Cache-Control, ETag = SHA, 304, nosniff, raw = API v1 raw, non-SHA / abbreviated / unreadable / missing ⇒ 404),
    markdown preview = the IssueBody `body_html`. `5-logtail`: a runner registered with `POST /repos/{o}/{r}/actions/runners`
    speaks the runner protocol (Connect JSON: `Declare`, `FetchTask`, `UpdateLog`, `UpdateTask`) for a workflow pushed via
    the contents API; the job id comes from its `ActionRunJob` delta; `log_tail` ⇒ steps, lines by offset as uploaded, `done`
    after the result + `noMore`; resume over SSE from `task_id`/`offset` 1 ⇒ the rest; another user / a missing job ⇒
    `log_closed{forbidden}`. `6-client` (WS and SSE): F2's `openData`: workspace bootstrap → live; keyed write ⇒
    `whenSynced(group, echo)` resolves with the issue in the pool; a second session on the same IndexedDB resumes from the
    persisted positions and has the offline edits (asserted as a resume: the persisted issues are in the pool once hydrated,
    and the data layer, given a recording `fetch`, never bootstraps the group again; a client without persisted positions
    fails both); collaborator added ⇒ appears in the pool, removed ⇒ `revoked` event and
    purged. `7-restart`: graceful stop ⇒ `notice{shutdown}` + close 1001, resume after the restart converges (nothing lost of
    writes made just before); **forced crash**: below.
  - **How the crash is forced.** A SQL session holds `livesync_meta` `log_head` `FOR UPDATE` (every writer transaction locks
    it to append, B3), so the materializer stalls; a keyed issue create commits (visible through API v1) and then waits in
    `WaitSynced` (`IDEMPOTENCY_SYNC_WAIT` 30 s) with its `livesync_idempotency` row in flight (`state = 0`, asserted);
    `dev-forgejo.sh kill` (SIGKILL); the client's request fails; the SQL session rolls back; start. The retry with the same
    key ⇒ 201 with the created issue (B7's crash-window path: the log shows the synthetic GET), exactly one issue in API v1,
    the record completed (`state = 1`), a further retry is a replay with the same echo, a session resuming from its pre-crash
    position gets that one issue (`v` ≤ echo), and its replica equals a fresh bootstrap. **Sensitivity checked:** with B7's
    crash-window lookup disabled (`if res.Recovered && false` in `routers/livesync/idempotency.go`, reverted) the scenario
    fails (`expected [165, 164] to deeply equal [165]`: a duplicate issue).
  - **Contract detail learnt (for F2/F5/F8 tests):** "a replay sends each entity once, at its newest state" holds up to the
    hub's position when the subscription goes live. If the tailer has not delivered the client's latest writes yet, the replay
    stops before them and they follow live (an entity can then arrive as a replayed `U` and a live `D`). The first
    reconnect scenario failed once on MySQL in the Go harness for exactly that reason (the deletes were unkeyed, so not yet
    in the log at their response). A test that wants "one state per entity" first makes its writes keyed (in the log at the
    response) and lets the hub catch up (`barrier_ok` in any session) before resuming — as `1-protocol` now does. Not a
    server bug. **Corrected in review round 1 — two more things a test must know:**
    (a) *A barrier covers only what is in the sync log when it arrives* (`barrier_ok.sync_id` = the head read then). An
    unkeyed API v1 write is answered before the materializer has logged it, so "write, barrier, assert nothing arrived"
    is vacuous whenever the barrier wins the race (reproduced: ≈ 1 run in 6). Every negative check after a write
    (`group_revoked`, repo made private, `4-gap`'s per-viewer state) now uses a keyed (or gap) write and asserts
    `barrier_ok.sync_id ≥ echo`; `replay_too_long` keys its last create (MAX_REPLAY + 1 entries must all be in the log at
    subscribe time; the hub needs strictly more than MAX_REPLAY), and `cursor_trimmed` keys the write that moves the head
    above the watermark (it failed once on PG for that reason during this round).
    (b) *Some writes are followed by asynchronous writes of the same entity.* `UpdateLabel` queues a label stats
    recalculation (`stats.QueueRecalcLabelByID`); the queue's `Update(&Label{})` ~1–2 s later bumps `updated_unix`
    (`xorm:"updated"`), a second captured change with its own sync id, logged after the keyed rename's echo and possibly
    after any barrier (milestones and other `stats.Queue*` users likewise). So "the replica after barrier B equals a
    bootstrap taken later" is a race (the MySQL failure: replica `updated_at` :48, bootstrap :49). Convergence is now
    asserted only over a quiet window (`expectConverged`): barrier B1, bootstrap (watermark W, B1 ≤ W), barrier B2
    (W ≤ B2); if no change of the group arrived between B1 and B2, the replica (state at B1) must equal the bootstrap
    (state at W); otherwise try again (until 20 s, then the last comparison fails with its diff — a lost change never
    converges). Used by `1-protocol`'s reconnect and both `7-restart` scenarios. F5/F8: compare a client with a bootstrap
    the same way, never "after a barrier".
  - **Data.** Every file creates its own users (`<prefix>-<base36 time+seq>`, via the admin API) and repositories, so files
    are independent; with `dev-forgejo.sh conformance` they live in `forgejo_conformance`, dropped at the start of the next
    run (or at the end of a passing one). Pointed at another server (`FORGEJO_URL`), the suite leaves them, a PAT per file
    on the admin, a dropped-and-repaired label trigger and a raised-then-restored `log_floor` behind: use a throwaway one.
  - **Known gaps.** (1) Slow consumers (`resume_from_cursor`, 1013) are not exercised: a Node client cannot stop reading a
    WebSocket, and the kernel absorbs ≈ 4 MB; B5/B8's Go tests cover it. (2) OAuth tokens are not used (PATs with `all`
    scopes; B8's `TestLivesyncOAuth` covers the PKCE flow and that its token passes `hello`). (3) Crash *before* the commit
    (runs once) is B7's Go test only. (4) MariaDB not run. (5) In the Go harness `7-restart` is skipped (in-process
    server). (6) No permessage-deflate assertion (Node's WebSocket client negotiates what it supports; B5's Go client
    covers compression). (7) **Follow-up (duplication):** `conformance/sse.ts` `FetchEventSource` is a near copy of the
    class inside F2's `integration/sync.test.ts` (they already differ: the suite's accepts `data:` without the space, as
    the SSE spec allows, and treats a non-2xx response as an error). It cannot be shared without editing F2's test file,
    which B10 was told not to touch; whoever next edits `integration/` should move it to one module (e.g.
    `integration/sse.ts`) that both import.
  - **For F5/F8.** Reuse `conformance/sync.ts` (`Session`, positions, invariant checks, `closedAfterAll`,
    `expectConverged`), `replica.ts` and `forgejo.ts`
    (`WebSession` for classic-UI forms) rather than re-writing them; `dev-forgejo.sh kill/stop/start` and `sql.holdLogHead()`
    are the fault-injection hooks; the Go wrapper shows how a Node suite runs in the harness.
  - **Commands run.** `next/tools/dev-forgejo.sh conformance all` three times (34/34 per database before the graceful-restart
    scenario was added, then 35/35 twice; ≈ 31–39 s of tests per database; no `[E]`/`[F]` line in either server log);
    single files during development; `./integrations.pgsql.test -test.run TestLivesyncConformance` with `tests/pgsql.ini`
    and `tests/mysql.ini` (3× each after the replay fix, last with the final suite: 33 pass, the 2 `7-restart` tests
    skipped, ≈ 23 s; no testlogger "FATAL ERROR"); the sensitivity check above; in `next/`: `npm run lint`, `npm run typecheck`, `npm test` (292 unit tests, unchanged);
    gofumpt, `go vet` and golangci-lint (`./tests/integration/...`, 0 issues) on the Go test; `git diff package-lock.json`
    empty; fork-diff check (§2.2) unchanged.
  - **Review round 1 (2026-10-08), all seven findings fixed.** (1) Reconnect convergence flaked on async label recalcs ⇒
    `expectConverged` (quiet window), contract note corrected (above). (2) `conformance` took over the shared dev server
    (same port/work dir/pidfile/database, rewrote its `app.ini`, killed and stopped it, left data behind) ⇒ isolated
    instances (above); verified the §1.2 dev `app.ini` and `forgejo` database untouched by a run. (3) The leak invariant
    exempted every `User` upsert ⇒ only the viewer's own (`viewer_id` stored from the welcome); `0-oracle.test.ts` tests it.
    (4) Unkeyed write + barrier negative checks ⇒ keyed writes, `barrier_ok ≥ echo` asserted (also `cursor_trimmed`,
    `4-gap`), `replay_too_long` keys its last create. (5) `6-client`'s resume could not tell a resume from a re-bootstrap ⇒
    asserts the persisted issues after hydration and no bootstrap of the group (recording `fetch` passed through
    `env.transport.fetch`); **sensitivity checked**: with the second session on a fresh `IDBFactory` both assertions fail
    (`expected [] to deeply equal ArrayContaining ["two"]`; `expected [ 'repo:1', … ] to not include 'repo:1'`), WS and SSE.
    (6) `load` accepted framing the app rejects ⇒ `parseLoaded` (strict, self-tested with 8 malformed bodies). (7)
    Duplicated harness ⇒ `integration/setup.ts` reused via `setupFiles`, one `closedAfterAll()` (closes every session
    first, then asserts all violations) replaces the five copied `afterAll` blocks; `FetchEventSource` recorded as a
    follow-up (Known gaps 7). Commands: `dev-forgejo.sh conformance all` 3× (the last two with the final code; 48/48 per database, 0 `[E]`/`[F]` lines),
    `1-protocol` + `7-restart` 4× per database (one `cursor_trimmed` failure on PG led to (4)'s fix there), the sensitivity
    check above; `TestLivesyncConformance` on PG and MySQL (46 pass, 2 `7-restart` skipped); `npm run typecheck`, ESLint
    on `conformance/`, `npm test` (292, unchanged); `package.json`/`package-lock.json` unchanged.

#### Backend audit
- [x] **Round 1** — 2026-10-08: the 14 verified findings of the backend audit of B1–B10 fixed (none rejected). Details per
  finding below; the earlier milestones' notes are left as written, the corrections are here.
- **Notes/decisions:**
  - **(1, blocker) One oversized payload jammed the sync log; a failing batch was retried forever.** Root causes fixed one
    by one. *Bounded bodies:* the bodies of IssueBody, Comment, Review and Release carry at most `protocol.MaxBodyBytes`
    (64 KiB) of body and `MaxBodyHTMLBytes` (256 KiB) of HTML, measured as JSON-encoded (`materialize.jsonLen`: a control
    character counts 6 bytes; `truncateJSON` cuts at a character boundary). A longer body is sent as a prefix with
    `body_html: ""` and **`body_truncated: true`**; HTML that is too long, not rendered in time or failed also gives
    `body_html: ""` + `body_truncated` with the complete body. The entity's change hash includes the complete source when
    it is cut, so an edit of the tail is still a change. **New gap endpoint `GET /-/sync/api/bodies/{model}/{id}`**
    (`IssueBody|Comment|Review|Release`) → `protocol.APIBody{body, body_html, truncated, content_version}`: the entity is
    placed exactly as the materializer places it (`materialize.LoadBody`, same specs) and readable by whoever may read
    that group+unit (`apiRequest.readable`, 404 otherwise); rendered on request like upstream. *Backstop:* any payload
    over `maxPayloadBytes` (1 MiB; e.g. a diff hunk of a minified line) is a DTO error (logged, skipped) instead of an
    INSERT the database refuses. *Byte-bounded appends:* `Writer.Append` inserts with one hand-written multi-row INSERT per
    chunk of ≤ 100 rows **and** ≤ 2 MiB of payload (a larger entry alone), well below MariaDB's 16 MiB
    `max_allowed_packet`. *No payloads in SQL logs:* payloads are passed as `synclog.payloadArg` (a `driver.Valuer` whose
    `String()` is `<payload of N bytes>`), so upstream's `[Error SQL Query]` / `[Slow SQL Query]` / `LOG_SQL` lines, which
    print every argument with `%v`, stay small (SURFACE.md). *Isolation instead of retrying forever:* a batch that fails
    is retried once whole; the next attempt (`Materializer.failures > 0`) materializes it **row by row**
    (`Materializer.isolate`), each row in its own writer transaction without the acknowledgement, then one transaction
    acknowledges the batch. A row that fails alone while an empty writer transaction succeeds (the database works) is
    tried once more and then **skipped** (Error log) and its table's schema epoch is bumped in the acknowledging
    transaction (`capture.BumpEpoch`, now exported and locking the row `FOR UPDATE` in a transaction so the
    materializer's and `Ensure`'s bumps cannot overwrite each other): `HandleEpochs` turns it into re-bootstrap markers
    (reason `trigger_repaired`, whose doc now says "changes may have been lost") and a repair walk, exactly like a change
    lost while a trigger was missing. Any other failure (database down, `ErrNotWriter`, shutdown) is returned and the
    reader retries; rows already written are written again then and their unchanged index hashes make that a no-op.
    *Bounded reads:* the tailer reads 100 entries per batch (was 500) and replays read payloads 100 at a time
    (`replayPayloadBatch`; keys still 500), so one read holds a few tens of MB at worst. Tests: `TestJSONLen`,
    `TestTruncateJSON`, `TestConsumeLongBody` (70 000 control characters: cut, no render, LoadBody returns all of it, a
    tail edit emits), `TestConsumeIsolatesPoisonRow` (a label row xorm cannot load: first Consume fails, the second emits
    the good row, skips the bad one, bumps `schema_epoch.label`, acknowledges; HandleEpochs writes the Label marker),
    `TestAppendChunks` (row and byte bounds, gap-free, `payloadArg` formatting), integration `TestLivesyncAuditBodies`
    ("long body": a 300 KiB control-character comment through API v1 ⇒ bounded entry, `body_truncated`, the full body
    and HTML from the endpoint for a reader of the public repository, 404 for an unknown entity, a model without a body,
    and a private repository's comment for a non-reader).
  - **(2) Markdown rendering inside the 1-minute writer transaction.** Every body is rendered with its own context
    (`renderContext`): not derived from the transaction's (a lookup cut off on the transaction's session would abort it,
    and a deadline on a derived context does not reach the session's queries at all), cancelled when the caller's
    context ends or after `renderTimeout` (5 s): the markup service's user lookups then fail at once and the result is
    discarded (`body_html: ""`, `body_truncated`). The lookups run on other pooled connections, i.e. outside the writer
    transaction. Each writer transaction has a render budget (`txRenderBudget`, 30 s, within `writerTxTimeout`); a
    strict loader (the normal batch transaction) returns `errRenderBudget` once it is used up and the batch is then
    materialized row by row (finding 1's `isolate`), each row with a budget of its own, where an exhausted budget leaves
    the remaining bodies without HTML instead. Snapshots and previews use the per-render timeout only. With bodies cut at
    64 KiB a single render has at most ≈ 9 000 mentions. Tests: `TestConsumeHTMLLimits` (60 KB of `#1 ` ⇒ HTML over the
    limit; `renderTimeout` = 1 ns ⇒ no HTML), `TestConsumeRenderBudget` (budget 1 ns: the batch of two comments is
    isolated and both are rendered completely; strict vs lenient loader).
  - **(3) Synced body_html kept file preview code.** `renderMarkdown` replaces every `div.file-preview-box` with a
    paragraph linking the previewed lines (`stripFilePreviews`, golang.org/x/net/html: the last link of the box header's
    title, i.e. the file link, `…?display=source#L1-L2` for a rendered file type; boxes without a header link — written
    by hand in the markdown — are left as they are); the client can show the lines through the permission-checked
    `/-/sync/api/repos/{id}/raw/{commit}/{path}`. `RenderPreview` (POST /-/sync/api/markdown) and the bodies endpoint
    render the same way. **Purging what was kept:** `renderVersion` ("1") is part of the render environment hash, so
    snapshots no longer reuse logged HTML; and a new mechanism, **content versions** (`materialize.contentVersions`,
    `livesync_meta materialized_content.<tbl>`): when a table's version moves, `HandleEpochs` writes re-bootstrap markers
    (reason `placement_changed`, its doc widened to "or changed what they carry") **without** an index walk (groups and
    units are unchanged, so bootstraps are not held by the gate). issue, comment, review, release are at version 1:
    **at the upgrade every client re-bootstraps those models once.** Tests: `TestStripFilePreviews`, the content-version
    case of `TestHandleEpochs`, integration `TestLivesyncAuditBodies` ("no file previews": API v1's `/markdown` renders a
    `file-preview-box` for a README permalink of user2/repo1, the synced comment and the preview endpoint link it).
  - **(4) Organization projects ignored the projects unit.** Organization Project/ProjectColumn are now in `org:{id}`
    with **unit `projects`**, granted as upstream's `Organization.UnitPermission(viewer, TypeProjects)` decides it: a
    viewer in one of the organization's teams by their teams' projects access (any for an owner team), anyone else only
    on a public or limited organization — **not a site administrator who is not a member of a private one** (they keep
    `org:{id}` with `members`). `perm.checkOrg` calls `UnitPermission`; the implicit grants and `CheckGroups` use the
    batched `viewerInputs.orgTeamProjects` / `orgProjectsByVisibility` (by team membership, whatever `org_user` says, as
    upstream; a fixture with a `team_user` row but no `org_user` row showed the difference). Team unit / membership
    changes are already permission epochs naming the members (`t<id>`, `u<id>`). Placement versions: project 4,
    project_board 2 (markers + repair walk). Tests: `TestOrgProjectsUnit` (owners team, public org, user5's team without
    the unit in private org23, a non-member site admin; with the unit added; grants agree), `TestOwnerGroupReachable`
    corrected (user5 and admin user1 get no Project/columns in `org:23` and no `projects` unit; after giving team 17 the
    unit user5 does), `TestProjectRefPlacement`, `TestGrants`, hub `TestPermissionChanged*` (org3 is public: a leaving
    member keeps `projects`).
  - **(5) INSTALL_MODE=verify: triggers dropped and reinstalled by a DBA while disabled went unnoticed.** `Disable` in
    verify mode now records **every tracked table** in `capture_pending` (`capture.MarkAllPending`, under the schema
    lock) on a database livesync ran on: the next `Ensure` that finds the triggers healthy bumps every epoch (markers +
    repair walks). Conservative: one full re-bootstrap after a verify-mode disable/enable cycle even when nothing was
    lost. Test: `TestLivesyncDisable` extended (verify mode: the DBA runs `UninstallStatements`, a label is written,
    the DBA runs `Statements()`; enabling in verify mode bumps every epoch and writes the Label marker).
  - **(6) No log incarnation id.** `livesync_meta log_id` (24 hex characters) is created by the writer's `init` with the
    head row (and anew whenever the head row is missing: new tables, wiped bookkeeping; added once to an existing log).
    `synclog.LogID`; **`WelcomeMessage.log_id`, `BootstrapHeader.log_id`** (omitted while unknown), and
    **`HelloMessage.log_id`**: when the client's is not the server's, every position of that hello is answered with
    `bootstrap_required{cursor_unknown}` (the subscription stays live), even if the new head has passed it. A hello
    without `log_id` (older clients) is not checked. **Client contract (F2):** store the `log_id` of the welcome /
    bootstrap your positions come from, send it in every hello, and on a welcome with another `log_id` drop all positions
    (re-bootstrap). **Restores:** a backup that contains livesync's tables restores its old id; after such a restore run
    `DELETE FROM livesync_meta WHERE name = 'log_id'` before starting Forgejo (documented on `synclog.LogID`; positions
    ahead of the restored head were already `cursor_unknown`). Tests: hub `TestForeignLogID` (foreign id ⇒
    `cursor_unknown`; own id or none ⇒ replay), synclog `TestLogID` (created, kept, new after the meta is wiped).
  - **(7) Writer lease failover waited hours for a dead holder.** `TryLease` configures the lease's session to be ended by
    the server after `LeaseIdleTimeout` (30 s) without a statement: PostgreSQL `idle_session_timeout` (14+) and TCP
    keepalives (`tcp_keepalives_idle/interval/count`, for PG < 14 and dead peers), MySQL/MariaDB `SET SESSION
    wait_timeout`; a keepalive goroutine pings the held lease every `LeaseKeepalive` (5 s) whatever its holder is busy
    with (a long trim or a materializer transaction can delay the writer loop's own `Check`), and records a failed ping
    for `Check`. The connection is closed on `Release` instead of going back to the pool with these settings. So a holder
    whose host vanished frees the lock within ≈ 30 s. Test: integration `TestLivesyncLeaseIdleTimeout` (keepalive off,
    timeout 2 s ⇒ another session takes the lock within seconds and the silent holder's `Check` fails; keepalive on ⇒
    still held after 4 s), both databases.
  - **(8) Repair walk skipped rows in no group.** In repair mode `BackfillStep` deletes the index rows of entities that
    are in no group now **and of the rows they place** (`grouplessDependents`: a draft release's attachments, a comment's
    reactions, transitively) when those are in no group either; and a re-bootstrap marker of a table now also names the
    models of its dependents (`markedTables`: release ⇒ Release + Attachment; comment ⇒ + Attachment, Reaction,
    ContentHistory; review ⇒ + Comment …), since a lost change of a release moves its attachments too. Test:
    `TestRepairDropsGrouplessIndexRows` (release set back to draft during a gap ⇒ Release and Attachment markers, both
    index rows gone; published again unchanged ⇒ both emitted).
  - **(9) Idempotency records for read-only API v1 POSTs.** `keyed()` passes `POST /api/v1/{markup,markdown,markdown/raw}`
    and the same below `/api/v1/repos/{owner}/{repo}/` through without a record (`apiV1ReadOnlyPost`), and
    `maxResponseBody` is 1 MiB (larger responses are streamed and stored without body, as before). Test: `TestKeyed`.
  - **(10) PG trigger NOTIFY serialised all commits.** The capture function (body marker **v2**) no longer calls
    `pg_notify`; the reader is woken by the in-process `commitObserver` on PostgreSQL too, and writes made through
    **another instance** are found by polling: `POLL_INTERVAL`'s default for the reader is now **100 ms on both
    databases** (the tailer keeps 250 ms + LISTEN on PostgreSQL; the writer's single `pg_notify('livesync_log')` per
    materializer commit is unchanged). Upgrade: in auto mode the stale v1 function is repaired once (all epochs bumped,
    markers); **in verify mode livesync stays degraded until the DBA runs the new DDL** (the admin page shows it). Tests:
    `TestPostgresDDL` (no `pg_notify`, v2), `TestLivesyncCaptureDoorbell` (PG now behaves like MySQL: observer for
    autocommit and COMMIT, a raw write from another connection waits for the poll).
  - **(11) TeamUser/TeamRepo went to every org member.** New group kind **`team:{id}`** (`protocol.TeamGroup`,
    `GroupPrefixTeam`) holds a team's TeamUser and TeamRepo rows (unit none); readable by the team's members, the
    organization's owners and site administrators (`perm.checkTeam`: `IsTeamMember`, `IsOrganizationOwner`, as API v1's
    `reqTeamMembership`, plus `IsOrganizationMember` as `GET /teams/{id}/members` wants — a fixture `team_user` row without
    `org_user` showed the difference). Team and TeamUnit stay in `org:{id}` `members` (upstream shows teams to members). Implicit
    grants list the viewer's **own** teams (an owner's other teams are granted on demand: an organization can have many);
    the workspace lists them with reason `member`; bootstraps of `team:{id}` read `team_user`/`team_repo` by `team_id`;
    the hub routes TeamUser/TeamRepo markers to `team:` and (for clients holding the old placement) `org:` groups.
    Placement version 1 of team_user and team_repo. **For F2/F6:** subscribe the `team:{id}` grants like the other
    implicit ones; who is in another team (as an owner) needs a `subscribe`/bootstrap of that `team:{id}`. Tests:
    `TestTeamGroup`, `TestCheckGroups` (now with 25 team groups), `TestSnapshotFilters`, `TestConsumePlacement`,
    `TestLivesyncPermDifferential` (every team × fixture user against API v1 `GET /teams/{id}/members`),
    `TestLivesyncPermEpochs` (a removed member's TeamUser delete goes to `team:2`, which they can no longer read).
    Hub tests with `SendBuffer: 2000` now use 2400: user2's welcome grew by its team grants and the projects unit.
  - **(12) Collaboration.permission revealed admins.** `protocol.Collaboration.permission` is `read` or `write`
    (`collaboratorPermission`: admin/owner read as write): assignability stays visible, administration does not. Content
    version 1 of collaboration (markers, no walk). Test: `TestCollaboratorPermission`.
  - **(13) SURFACE.md gaps.** Added: `db.TxContext` (the "one quiet transaction" coupling), the SQL log hooks' argument
    printing (why `payloadArg`), `GetCommentByID`/`IsErrCommentNotExist`, `IsErrOrgNotExist`, `db.ListOptionsAll`,
    `timeutil.TimeStampNow`, the notification status/source constants, and this round's new symbols
    (`Organization.UnitPermission`, `OrgFromUser`, `GetTeamByID`, `IsTeamMember`, `IsOrganizationOwner`, `perm.AccessMode`,
    the file preview markup, the lease session settings); the commit observer row says it runs on PostgreSQL too.
  - **(14) OAuth scope rationale.** `oauthapp.Scope`'s comment now states what the scope does not protect: with
    `write:repository` a stolen token can add webhooks, writable deploy keys and admin collaborators (lasting access) on
    every repository the user administers. Decision: keep the scope (the UI needs `write:repository`; API v1 has nothing
    narrower) and the refresh token lifetime (`[oauth2] REFRESH_TOKEN_EXPIRATION_TIME` is instance-wide; livesync cannot
    shorten it for its client); instances that want less exposure lower that setting. **For F3:** keep the access token
    in memory only and the refresh token in IndexedDB of the `/-/next` origin, never in a cookie or `localStorage`
    readable by classic pages. `TestLivesyncOAuth` now shows a deploy key (writable), a webhook and an admin
    collaborator added with the Next token on user2/repo1 (and removed again).
  - **Upgrade effect, all together:** one re-bootstrap of every model at the first start of this version (placement
    versions project/project_board/team_user/team_repo with repair walks, content versions issue/comment/review/release/
    collaboration, and in auto mode the v2 capture function bumping every epoch).
  - **Also changed on the way.** `routers/livesync.authenticateResult` logs a token lookup that failed because the request
    went away at Debug, not Error (seen once in `TestLivesyncOAuth` on MySQL). `perm.checkTeam` finds the owners team with
    `GetOwnerTeam` instead of `IsOrganizationOwner`, which logs an Error for an organization without one (a fixture).
  - **Known, not fixed (pre-existing):** the SQLite unit tests of `services/livesync/capture` are flaky: with `-count=8`,
    2 of 3 runs on the **unchanged** branch failed too (`no such table: system_setting` from `resetOutbox` once the
    shared in-memory database is gone, first in `TestWithQuietTx` / `TestReaderDefer` after `TestReaderBatchSize`). A
    single run usually passes. Worth a separate fix: something closes every pooled connection, perhaps a reader left
    running by an earlier test or the outbox drop/recreate tests.
  - **Commands run.** gofumpt (clean); golangci-lint `./models/livesync/... ./services/livesync/... ./routers/livesync/...`
    and `--build-tags 'sqlite sqlite_unlock_notify' ./tests/integration/...` (0 issues); `go vet`; deadcode diff (clean);
    `go mod tidy -diff` (clean); `next/tools/gen-protocol.sh` then `--check` (up to date; `npm run typecheck` in `next/`
    green with the new types); unit tests of `models/livesync`, `services/livesync/...`, `routers/livesync` (all green
    except the flaky capture tests above); `./integrations.pgsql.test -test.run TestLivesync` on **PG 16 (`gtestschema`):
    52 pass** and **MySQL 8.0: 54 pass**, 0 fail, then the tests changed after that run (`TestLivesyncPermDifferential`,
    `TestLivesyncOAuth`, `TestLivesyncAuditBodies`, `TestLivesyncLeaseIdleTimeout`) again on both, green, with no testlogger
    "FATAL ERROR"; `next/tools/dev-forgejo.sh conformance all` (48/48 on pg and on mysql, 0 `[E]`/`[F]` lines in the server
    logs); the fork-diff check (§2.2) is unchanged (`assets/go-licenses.json`, `cmd/web.go`, `go.mod`, `go.sum`).
- [x] **Round 2** — 2026-10-08: 1 verified finding (major) fixed.
- **Notes/decisions:**
  - **(R2-1, major) Round 1's fix 2 was incomplete: anyone could stall the sync log by posting bodies that are cheap to
    post and expensive to render.** The writer renders every body serially for everyone (upstream renders on the viewer's
    own request); round 1 bounded one rendering (5 s) and one transaction (30 s), not what a poster can take over time
    (API v1 has no default rate limit; 9 000 `@user2` took 1.45 s and produced HTML over `MaxBodyHTMLBytes` that was
    thrown away). Measured per markup feature (scratch test with `markup.Init(markup_service.ProcessorHelper())`, repo 1,
    SQLite) before choosing the fix: @mention 0.13–0.15 ms per occurrence (DB lookup each); **a SHA-like word that is not
    a commit ≈ 4 ms** (`IsReferenceExist`'s error on a missing object discards the cat-file process, so each spawns
    `git`: 1 000 took 4 s); a file permalink of this instance 15 ms (repository, permission and blob read, for a preview
    box we strip anyway); **cross-repository references are quadratic per text node** (1 000 on one line 0.36 s, 3 000
    3.6 s, 21 000 2 min 40 s) **and `renderTimeout` does not interrupt them** — the deadline only makes lookups fail; CPU
    work (goldmark, the processors' regexps) runs to completion. Plain text, `#1` refs, URLs, emoji are linear and cheap
    (64 KiB ≤ ~250 ms). Three bounds (`services/livesync/materialize/rendercost.go`):
    1. **Cost estimate before rendering** (`renderCost`, in `loader.render`, so writer and snapshots alike — it is a
       function of the body, so a snapshot carries what the log carries): bytes × 0.5 µs + mention occurrences
       (`references.FindAllMentionsBytes`) × 150 µs + distinct SHA-like words × 70 µs + `/src/commit/` permalinks × 15 ms +
       `#N` refs × 10 µs + (cross-repo refs)² × 0.4 µs. Over **`maxRenderCost` = 250 ms** the body is **not rendered**:
       `body_html: ""` + `body_truncated` with the complete body; the client gets the HTML from `GET
       /-/sync/api/bodies/{model}/{id}`, which renders on request (like upstream's page view; no cost check there, nor in
       `POST /-/sync/api/markdown`). That takes ≈ 1 600 mentions, 16 permalinks, 800 cross refs or 3 500 SHA-like words;
       the estimates were checked against measured times for each feature at 100–21 000 tokens (within ~2×; the
       quadratic term over-estimates refs spread over lines, which is safe). The audit's 9 000-mention body costs no
       writer time now.
    2. **SHA lookups in one process** (`prefillCommits`, in `renderMarkdown`): every distinct SHA-like word of the body is
       checked through the repository's one `git cat-file --batch-check` (write a name, `git.ReadBatchLine`, a missing
       object is `ErrNotExist` and keeps the process) and the answers prefill `RenderContext.ShaExistCache`, which
       `hashCurrentPatternProcessor` consults first; kept per loader and repository (`loader.commits`). Same answers as
       `IsReferenceExist`; the process runs with the repository's context (it is reused), the loop stops at the render
       deadline. 1 000 missing SHAs: 4 s → 66 ms. Applies to the bodies endpoint and previews too.
    3. **Render share of the writer** (`renderShare`, `Materializer.share`, used by the writer's loaders only): token
       buckets of render time filled with wall time — **overall 25 % (burst 20 s) and per repository 10 % (burst 10 s)**;
       a body is rendered while both of its buckets hold time, and the time it took is charged to both (overdraft ≤ one
       rendering). Otherwise it is sent with `body_truncated` (fetched on request) instead of the log falling behind:
       rendering can no longer take more than a quarter of the writer's time whoever posts, and one repository not more
       than a tenth, so other repositories keep their HTML. At most 1 000 per-repository buckets are kept (full ones are
       dropped). Not used by snapshots (on the requester's request) or the bodies endpoint. A body sent without HTML for
       lack of share stays so until it changes (its index hash does not include the HTML), and snapshots reuse that entry
       — consistent with the log; the client fetches it like any truncated body.
    New metrics `forgejo_livesync_render_seconds_total` and `forgejo_livesync_render_skipped_total{reason=cost|share|timeout}`.
    `protocol` comment on long bodies widened (free comment, not in `types.gen.ts`); SURFACE.md's markup row lists the
    new upstream couplings (`ShaExistCache`, `WithCatFileBatchCheck`/`ReadBatchLine`/`IsErrNotExist`,
    `FindAllMentionsBytes`, and the measured processor costs — re-measure on upstream merges). Unchanged: per-render
    `renderTimeout`, `txRenderBudget` + isolation (round 1). **Not addressed (upstream behaviour):** the bodies endpoint
    and `POST /-/sync/api/markdown` render on request without a cost check, so one such request can still take seconds
    of CPU (as upstream's issue page and `/api/v1/markdown` do); it runs on the requester's goroutine, not the writer.
    Tests: `TestRenderCost` (ordinary and 64 KiB plain bodies under the limit; 9 000 mentions, 20 permalinks, 1 000
    cross refs, 5 000 SHA-like words over), `TestConsumeRenderCost` (production markup helper: a 2 000-mention issue body
    is sent truncated without being rendered — `renderCount` — while the other issue's body of the batch gets its mention
    link; `LoadBody`+`Render` renders all 2 000), `TestConsumeRenderShare` (repository 1's share used up ⇒ its body has
    no HTML, repository 2's has; after 20 s (fake clock) it renders again), `TestRenderShare` (per-repository and overall
    buckets, refill, bounded map), `TestPrefillCommits` (existing full and short SHA true, missing false, preset entries
    kept, the process still answers `IsReferenceExist`, rendered links), integration `TestLivesyncAuditBodies` "expensive
    body" (2 000 mentions through API v1 ⇒ comment entry truncated without HTML, the next comment rendered, the bodies
    endpoint returns the 2 000 mention links). **Sensitivity checked:** with `maxRenderCost` = 1 h and `allow` always
    true, `TestConsumeRenderCost` and `TestConsumeRenderShare` fail.
  - **Commands run.** gofumpt (clean); golangci-lint `./models/livesync/... ./services/livesync/... ./routers/livesync/...` and
    `--build-tags 'sqlite sqlite_unlock_notify' ./tests/integration/...` (0 issues); `go vet`; deadcode diff (clean);
    `next/tools/gen-protocol.sh --check` (up to date, no protocol type changed); unit tests of `models/livesync`,
    `services/livesync/...`, `routers/livesync` (green); `./integrations.pgsql.test -test.run TestLivesync` on **PG 16
    (`gtestschema`): 52 pass** and **MySQL 8.0: 54 pass**, 0 fail (incl. `TestLivesyncConformance` and the new "expensive
    body" subtest); the only testlogger "FATAL ERROR" is the known upstream MySQL `Error 1213` deadlock in `CreateComment`
    under `TestLivesyncBootstrapConvergence`'s concurrent comment writers (B6 notes; the test passes);
    `next/tools/dev-forgejo.sh conformance all` (48/48 on pg and on mysql, 0 `[E]`/`[F]` lines); the fork-diff check (§2.2)
    is unchanged (`assets/go-licenses.json`, `cmd/web.go`, `go.mod`, `go.sum`).
- [x] **Round 3** — 2026-10-08: 1 verified finding (major) fixed.
- **Notes/decisions:**
  - **(R3-1, major) Round 2's `renderCost` missed CPU-bound inputs: one cheap post still froze the global writer for
    17–43 s, and the render share let it repeat.** The audit's bodies: 13 000 × `# a` (52 KB, any repository: goldmark's
    heading ids `a`, `a-1`, … are found by trying every suffix in turn, quadratic) — estimated 26 ms, rendered 17.5 s
    in `Consume`; and 10 900 × `ABC-1 ` in a repository whose external tracker has the alphanumeric style (any owner can
    set it) — `issueIndexPatternProcessor` runs `FindRenderizableReferenceNumeric` and the style's pattern over the rest
    of the text node before each reference it links — estimated 33 ms, 43 s. `renderTimeout` cannot interrupt CPU work,
    and the share's `allow` (before) / `charge` (after) let any one body run to its end, so a second 43 s body followed the
    first. **Root cause:** the writer ran the rendering itself, so any input the estimate did not know cost the writer its
    full rendering time. A scratch probe of ~110 body shapes (CommonMark's pathological inputs, Forgejo's processors,
    external tracker styles; 64 KiB each, SQLite) found more of the class: 16 000 empty headings 43 s, a table header of
    1 000 cells over 30 000 one-`|` rows 31 s (rows are padded to the header), 8 000 setext headings 6 s, `a**b` +
    21 000 × `c* ` 3.4 s, 32 000 nested `-\t` markers 2.6 s, `*a_ ` × 16 000 2.4 s, `[a](b` × 13 000 1 s, 5 000
    fenced `go` blocks 0.5 s, `!1 ` × 20 000 then one `ABC-1` (alphanumeric style) 103 s. Two changes:
    1. **The writer waits for a rendering for at most `renderWait` (1 s) and abandons a slower one**
       (`loader.renderBounded`, used by `loader.render`, i.e. the writer and snapshots). `renderMarkdown` is split into
       `prepareRender` (on the caller's goroutine: the metas, the loader's git repository and SHA cache, the render
       context) and `renderJob.run` (only what the job holds; a markup panic becomes an error). The job runs on its own
       goroutine; when the wait ends first the job's context is cancelled (its lookups fail at once), the body is sent
       with `body_truncated` (HTML from `GET /-/sync/api/bodies` on request), the loader gives the job its git
       repository and SHA cache (`l.gitRepos` / `l.commits` entries removed; the next rendering of that repository opens
       another), and a goroutine waits for the job's end, closes the repository and charges the time beyond the wait to
       the repository's render share (`renderShare.chargeRepo`; the overall bucket is charged only what the writer
       waited, and `renderShare` now has its own mutex). **At most `maxAbandonedRenders` (2) abandoned renderings run at
       a time** (`abandonedRenders`); while they do, `loader.render` renders nothing (reason `busy`), so abandoned work
       takes at most two cores; a loader rendering at that moment may add one beyond the cap (the writer is one goroutine;
       snapshots being built concurrently are not counted ahead). So one body costs the writer at most ≈ 1 s, the share's
       overdraft is bounded by `renderWait` instead of by the rendering, and the worst an attacker gets is bodies without
       HTML (fetched on request) while two cores run their renderings — not a frozen sync log. Unchanged: on-request
       renderings (`FullBody.Render`, `RenderPreview`) stay synchronous with `renderTimeout` (upstream behaviour, see
       round 2).
    2. **`renderCost` counts the superlinear constructs** (`structureCost`, a line scan that errs on counting more; it now
       takes the repository's metas): (headings + footnotes)² × 170 ns (any ATX heading after container markers, any line
       of only `=`/`-` as a setext underline, every `[^`; the ids are made of rendered text, so which headings collide is
       not knowable from the source and all are counted), Σ per line (block quote/list markers)² × 3 ns, table cells
       ((max `|` per line + 1) × lines × 1 µs, when a delimiter row exists), fence lines × 50 µs, per paragraph (`*` + `_`)²
       × 8 ns and `[`² × 6 ns, and for the alphanumeric/regexp tracker styles, per text node (a line with
       `EnableHardLineBreakInComments`, else a paragraph) containing a match of the style's pattern, (style matches +
       `#N`/`!N` refs) × bytes × 100 ns. Each constant is the slowest measured rate of its construct; the slow bodies
       above are all over `maxRenderCost` now (estimates about 1–5× the measured time), and ordinary long documents (100
       sections with lists, code, tables), 64 KiB of text, an alphanumeric changelog and one reference per line stay under
       it. Linear but slow-ish inputs are left to the bounded wait: chroma highlights a fenced block at up to ≈ 5 µs per
       byte (64 KiB of `html` or `c`: 0.25–0.35 s). The estimate is the first line (most bodies of the class never reach
       a goroutine); the bounded wait is what makes an unknown slow input harmless.
    **Also fixed on the way:** `issueIndexPatternProcessor` writes `Metas["index"]` into the map it is given, and
    `renderMarkdown` passed `repo.ComposeMetas`'s cached map, so a rendering with an external tracker reference changed
    the repository's `renderEnv` (and so entity change hashes) for later loaders using that repository object — and an
    abandoned rendering would have written the map concurrently. `prepareRender` renders with a copy. New label values of
    `forgejo_livesync_render_skipped_total{reason}`: `abandoned`, `busy`. SURFACE.md's markup row lists the measured
    constructs, the `Metas["index"]` write and the reliance on the markup service being safe on several goroutines.
    Tests: `TestRenderCost` (the audit's two bodies and every probe shape above over the limit with their measured
    times in the case names; ordinary long document, text, changelog, numeric refs in an alphanumeric repository,
    alphanumeric refs in a numeric one under it; without hard line breaks a paragraph is one text node),
    `TestConsumeRenderAbandoned` (`maxRenderCost` = 1 h so that 5 000 empty headings reach the writer, `renderWait`
    = 100 ms: `Consume` returns in < 1 s with that body truncated and the batch's other body rendered; with
    `maxAbandonedRenders` = 1 the next body is not rendered (`renderCount`); after the abandoned rendering ends its time
    is charged to repository 1's share and rendering resumes), `TestRenderBounded` (fast render waited for; slow one
    abandoned with the loader's git repository and SHA cache handed over; the next rendering opens another repository
    and links a commit), `TestRenderKeepsMetas` (repo 48, alphanumeric tracker: no `index` in the cached metas, same
    `renderEnv` after rendering — fails without the copy), integration `TestLivesyncAuditBodies` "superlinear body" (a
    comment set to 13 000 × `# a` with SQL — upstream's own API v1 post of it takes ≈ 50 s in mention/reference
    parsing — then a comment posted through API v1: its entry arrives within 5 s, rendered; the slow one is truncated
    without HTML). **Sensitivity checked:** with `structureCost` disabled and `renderWait` = 1 h (round 2's behaviour)
    the integration subtest fails (16 s); with only `structureCost` disabled it passes through abandonment (the log shows
    the abandon warning).
  - **Commands run.** gofumpt (clean); golangci-lint `./models/livesync/... ./services/livesync/... ./routers/livesync/...`
    and `--build-tags 'sqlite sqlite_unlock_notify' ./tests/integration/...` (0 issues); `go vet`; deadcode diff (clean);
    `next/tools/gen-protocol.sh --check` (up to date, no protocol type changed); unit tests of `models/livesync`,
    `services/livesync/...`, `routers/livesync` (green), `services/livesync/materialize` also with `-race` (green);
    `./integrations.pgsql.test -test.run TestLivesync` on **PG 16 (`gtestschema`): 52 pass** and **MySQL 8.0: 54 pass**,
    0 fail, no testlogger "FATAL ERROR", no rendering abandoned in the suite; `next/tools/dev-forgejo.sh conformance all`
    (48/48 on pg and on mysql, 0 `[E]`/`[F]` lines); the fork-diff check (§2.2) is unchanged (`assets/go-licenses.json`,
    `cmd/web.go`, `go.mod`, `go.sum`).
  - **Seen, not in scope:** posting such a body through API v1 takes upstream ≈ 28 s in `references.FindAllMentionsMarkdown`
    + `FindAllIssueReferencesMarkdown` alone (both render it with goldmark), inside the comment's request; that is upstream
    behaviour and no livesync path.
- [ ] **Open after round 3** — 2026-10-08: 1 verified finding (major) recorded, not fixed.
- **Notes/decisions:**
  - **(R4-1, major, open) Round 3's fix runs each repository's own external-tracker regexp over every body on the writer,
    before any bound applies, so one cheap post still freezes the global writer for seconds to minutes, on every edit**
    (`services/livesync/materialize/rendercost.go`). ef2ad5e passes the repository's metas to `renderCost`; for the
    regexp tracker style `structureCost` calls `scan()`, which runs `trackerRefs.FindAllStringIndex(segment, -1)` over
    each paragraph, with `trackerRefs = regexplru.GetCompiled(metas["regexp"])` — whatever the owner set in
    `ExternalTrackerRegexpPattern`. Nothing validates the pattern (no binding tags in `services/forms/repo_form.go:181`;
    API v1 PATCH copies it as is). Go's regexp is O(len(input) × program size) and a small pattern can expand to a very
    large program. `renderCost` runs synchronously on the writer goroutine in `loader.render`, before the busy check,
    before `share.allow` and outside `renderBounded`, so neither `renderWait`, the render share, the abandoned-render cap
    nor `l.budget` limits it, and it runs again on every body change in that repository with no duty cycle. Round 2's
    `renderCost` did not take metas: a regression of this fix, in the same class as the finding it fixed.
    **Evidence** (HEAD ef2ad5e, `go test -overlay` scratch tests, no repository file changed; body
    `strings.Repeat("abcdefghijklmnop", 4000)`, 64 000 bytes; `renderCost` alone): pattern `(\w{1,999}Z)` (12 bytes)
    1.17 s; `(\w{1,999}Z|...)` with 10 alternatives (111 bytes) 13.15 s; with 100 alternatives (1 101 bytes) 4 m 52.6 s —
    each time an estimate of 32 ms (no `Z` in the body, so k = 0 and nothing is counted). End to end: repo_unit 68
    (repo 48) set to style regexp with the 10-alternative pattern, `Materializer.Consume` of issue 9 with that body plus
    one cheap issue took 13.77 s; the rendering itself was then abandoned after 1 s, so almost all of the stall is
    `renderCost`. Each later edit of the body repeats the full stall (renderCost runs before the share check). Any user
    can create a repository and set this style through API v1 or the settings page; upstream runs the pattern only when
    someone views the page, for that viewer.
    **Possible remedies:** do not execute the owner's regexp on the writer — for style=regexp charge a conservative cost
    from `len(content)`, the program size and the line count, or skip writer rendering for that style altogether; or
    compute `renderCost` inside the bounded job so that `renderWait` covers it.
    **Verified otherwise:** the round-3 finding's two cases are fixed (the writer abandons a rendering after
    `renderWait`); materialize unit tests pass with `-race` (SQLite); the other `services/livesync/...`,
    `routers/livesync` and `models/livesync` unit tests pass; PG 16 integration `TestLivesyncAuditBodies` (including
    "superlinear body") and `TestLivesyncConformance` pass; the working tree was clean.


### Frontend

#### F1 — Toolchain, tokens, primitives, shell
- [x] **Status** — done 2026-10-07. `npm ci && npm run check` is green: lint, typecheck, 106 Vitest tests, build, and the budget at 81.8 KB br JS / 4.5 KB br CSS. All 13 Playwright tests pass. Three review rounds; the last found no remaining blocker or major.
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
  * **Ran ahead of B10.** F1 created `next/package.json` + `package-lock.json` (B10 has not run).
    For B10: add a `conformance` project next to `unit` in `vitest.config.ts` and a
    `"test:conformance": "vitest run --project conformance"` script. `npm test` is already
    pinned to `--project unit`, and `conformance/` is already in `tsconfig.node.json` and in
    the ESLint node-globals block.
  * **Commands (in `next/`):**
    * `npm ci`, `npm run dev` (Vite on :5173, base `/-/next/`; the gallery is at `/-/next/gallery`).
    * `npm run lint` (ESLint + Stylelint) · `npm run typecheck` (two tsconfigs) · `npm test` (Vitest, jsdom).
    * `npm run build` · `npm run budget` · `npm run check` (all of these in order).
    * `npm run test:browser` (Playwright: `e2e/boot.spec.ts` against `vite build && vite preview` on :4173,
      and `e2e/gallery.spec.ts` against the dev server on :5173). In this sandbox run
      `PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium npm run test:browser`: Playwright 1.63's own
      Chromium (build 1243) is not preinstalled any more, and the config passes this env var as
      `executablePath`. Final run: lint/typecheck clean, 106 unit tests, 13 browser tests, boot JS
      81.8 KB br / 150, CSS 4.5 KB br / 30.
  * **Versions (exact pins):**
    * vite 8.3.3 (Rolldown), react/react-dom 19.3.0, typescript 6.0.3, tailwindcss + @tailwindcss/vite + @tailwindcss/node 4.3.3.
    * lightningcss 1.33.0, eslint 10.12.0 + typescript-eslint 8.71.1 (strictTypeChecked + stylisticTypeChecked) + react-hooks 7.1.1.
    * stylelint 17.16.0 (+ config-standard, declaration-strict-value), vitest 5.0.3 + jsdom 30.1.2, @playwright/test 1.63.0.
    * radix-ui 1.7.0 (the umbrella package), lucide-react 1.52.0 (the one icon set).
    * TS 7.0 (tsgo) is out, but typescript-eslint supports TS < 6.1, so we stay on 6.0.3.
    * `npm audit`: 8 high-severity issues, all dev-only (stylelint → globby → micromatch → braces); `--omit=dev` is clean.
  * **Layout deviations from §2.1:**
    * `src/dev/gallery/` (dev-only; not scanned by app.css, ships its own `gallery.css`). Stylesheets may live
    only in `src/styles` and `src/dev` (`src/styles/files.test.ts`).
  * `lint/stylelint-plugin-motion.ts`: the `@keyframes` rule (only transform and opacity may be animated).
    * `lint/eslint-plugin-tokens.ts` (local rules) and `src/test/` (setup, `conflicts.ts`, `lint-fixtures/`).
    * `tools/vite-plugin-shell.ts`, `tools/budget.ts`, `tools/boot.ts`, `tsconfig.node.json`, `playwright.config.ts` + `e2e/` (F8 extends these).
  * **Root ESLint interaction (needs an orchestrator decision; I edited nothing at the root).**
    * Root `make lint-js` runs `npx eslint` with ESLint 9, which uses only the root flat config. It therefore lints `next/` with upstream's rules.
    * Measured with root `npm ci` in this sandbox: about 400 errors in `next/` sources, including `import-x/no-unresolved` for react when `next/node_modules` is absent, and 382 errors in B3's `src/protocol/types.gen.ts`. A locally built `next/dist` adds more than 40 000.
    * So root `make lint-frontend` already failed before F1, because of `types.gen.ts`.
    * Nothing inside `next/` can exclude it: ESLint 9 has no ignore file for flat configs, and does not pick up nested configs without a flag.
    * Decision: `next/` is linted only by `next/eslint.config.ts`. The fork runs upstream's JS lint as `npx eslint --max-warnings=0 --ignore-pattern 'next/'` (verified to work); `sync-upstream.sh` and the canary should do the same instead of `make lint-js`.
    * If `make lint-frontend` must pass unchanged, the only fix is adding `'next/'` to the root `ignores` in `eslint.config.ts`. That is a one-line edit of an upstream file, so it is left to the orchestrator.
    * Root `tsconfig.json`, `vitest.config.ts` and `STYLELINT_FILES` do not include `next/`.
  * **Design tokens: `src/styles/tokens.css` is the only place values live.**
    * Each token is a Tailwind `@theme static` variable, so every token is also a utility. Tailwind's default theme is not imported, so `bg-white`, `text-red-500` and `shadow-sm` do not exist.
    * Dark theme: `:root[data-theme="dark"]` overrides exactly the colour tokens (tested).
    * Colours (`--color-*`; utilities `bg-*`, `text-*`, `border-*`):
      * surfaces: `canvas` (app background, sidebar), `surface` (content), `raised` (menus/dialogs), `overlay`;
      * fills: `hover`, `selected`, `skeleton`, and `raised-hover` (the highlighted menu row, on `raised`);
      * hairlines: `border`, `border-subtle`, `border-strong`;
      * text: `fg`, `fg-muted`, `fg-subtle`, `fg-on-accent`;
      * accent: `accent`, `accent-hover` (fills), `accent-fg` (accent text), `accent-subtle`, `focus`;
      * status: `success`, `warning`, `danger`, `done`, each with a `-subtle` tint, plus `danger-solid` / `danger-solid-hover` fills;
      * `shadow` (the colour used inside the shadows).
    * Contrast is tested (`tokens.test.ts`) in both themes:
      * every text and status colour ≥ 4.5:1 on canvas, surface, raised, hover and selected;
      * each status colour on its own `-subtle` tint;
      * `fg-on-accent` on the accent and danger fills;
      * `focus` ≥ 3:1 on surfaces;
      * state fills against what they sit on: `raised-hover` on raised, hover and selected on surface, and
        `border-strong` on selected (chip and avatar edges). These are not WCAG pairs, but they must stay visible.
    * Type: system font stack `--font-sans` / `--font-mono` (no webfont).
      * Sizes `text-xs` 11, `text-sm` 12, `text-base` 13 (the UI base), `text-md` 14, `text-lg` 16, `text-xl` 20 (px, each with its line height).
      * Weights `font-normal`, `font-medium`, `font-semibold`.
    * Spacing: `--spacing: 4px`. The lint rule only allows the steps listed in `spacingSteps` (0–96, e.g. `p-1.5`, `gap-2`, `w-64`).
    * Sizes: `h-control-sm` 24, `h-control` 28, `h-row` 32, `h-header` 44, `w-sidebar` (= runtime `--sidebar-width`, default 232), `w-pane` 280.
    * Containers: `max-w-xs` 280 (tooltips), `max-w-sm` 320 (menus), `max-w-md` 560 (dialogs), `max-w-lg` 720 (prose).
    * Radii `rounded-sm` 4, `rounded-md` 6, `rounded-lg` 8, `rounded-full`. Shadows `shadow-popover`, `shadow-dialog` (floating surfaces only).
    * Non-Tailwind `:root` tokens:
      * `--sidebar-width`, `--focus-ring-width` / `--focus-ring-offset` (2px / 2px, the ring sits outside the control);
        `--focus-ring-inset` (utility `focus-inset`, used by ListRow, whose ring is drawn inside because rows are edge to edge);
      * `--opacity-disabled` (utility `opacity-disabled`);
      * `--z-sticky` 10, `--z-dialog` 50, `--z-popover` 60, `--z-tooltip` 70 (utilities `z-sticky`, …). Floating
        content stacks above dialogs because it is always opened from whatever is on top; a menu inside a dialog is tested in e2e.
      * The `max-h-popper` utility caps menus and popovers at Radix's available height, and they scroll beyond it.
    * Motion:
      * `--speed-in: 0s`, `--speed-out: .15s`, `--speed-quick: .1s` (reserved for press feedback, unused so far), `--ease-out`;
      * `animate-exit` (fade) and `animate-exit-pop` (fade + scale .97); popovers scale from `origin-popper`, which Radix sets.
      * `prefers-reduced-motion` sets the speeds to 0 and the exit animations to `none`, so Radix unmounts immediately (tested in the browser).
    * The one transition in the app is the `interactive` utility (`app.css`):
      * it transitions only colour, background, border and opacity;
      * entering hover, active, focus-visible, highlighted, selected, pressed, open, checked or on is instant;
      * leaving fades over `--speed-out`.
    * Other custom utilities and variants in `app.css`:
      * `bg-label` (a label's server colour, passed as `--label-color`) and `splash-initial`;
      * variants `logged-out:` and `shape-detail:`, keyed on the splash attributes on `<html>`.
  * **Enforcement:**
    * **ESLint `tokens/tokens-only`.** A raw colour string is rejected anywhere. Class checks apply only to class
      contexts, so prose such as `'- [ ] '` or `'transition'` is fine:
      * every string in `src/ui`;
      * `className` and `cx(…)` expressions elsewhere, following same-file consts, `table[key]` and `list.map((x) => …)` parameters.
      In those contexts it rejects:
      * arbitrary values/properties/variants (except `data-[…]` / `aria-[…]`), `dark:`, `*:` / `**:`;
      * every `transition*` / `ease-*` / `duration-N` / `delay-N` utility;
      * bare numbers that bypass tokens (`z-10`, `leading-5`, `opacity-50`, `border-2`, `scale-95`, `decoration-4`, …), off-scale spacing (`p-3.25`, `w-37`, `indent-37`) and colour `/` modifiers (`bg-accent/50`);
      * filters, gradients and ad hoc rings and shadows (`brightness-*`, `bg-linear-*`, `from-*`, `ring*`, `inset-ring*`, `shadow-*` other than `shadow-popover` and `shadow-dialog`);
      * whole-string raw colours (`'#fff'`, `'rgb(…)'`; `'Fixes #123'` is fine).
    * **ESLint `tokens/no-literal-style`:** no literal values in `style={{…}}`, including templates without expressions.
    * **ESLint `tokens/no-restyle`:**
      * outside `src/ui`, a primitive's `className` may only place or size it (margins, w/h/size, flex/grid placement, position, `hidden`, `sr-only`, `truncate`);
      * `<Icon>` may also take a text colour;
      * menu items, menu/popover contents and rows take no `className` or `style` at all: the props are `Omit`ted, and a test asserts the type error;
      * size classes a primitive owns through its size prop are rejected (`h-*` and `size-*` on Button, Input, IconButton, Avatar and Icon);
      * a `className` that is not literal (or a same-file const of literals) is rejected;
      * so are `style` on a primitive, spreads of `className`/`style`, and any spread that is not an object literal;
      * namespace imports (`<UI.Button>`) are checked too;
      * bare lucide icons outside `src/ui` are rejected: render them through `<Icon icon={X}/>`.
    * **ESLint `no-restricted-imports`:** only `src/ui` imports Radix or `ui/recipes.ts`.
    * **Stylelint:**
      * `transition` / `transition-property` must use an allowlist (opacity, transform, translate, scale, rotate and colour properties) with `var()` durations. This also catches `transition: .2s`, which means `all`.
      * The transition properties are banned outside `app.css`.
      * Raw values are banned outside `tokens.css` (`declaration-strict-value` with `expandShorthand`):
        * colours (no hex or named colours) and `font*`, line height, letter spacing;
        * z-index, `border*`, `outline*`, shadow, opacity, filter;
        * animation, durations;
        * margin, padding, gap, inset, `(min-|max-)width/height` (% and viewport units are allowed);
        * text decoration.
      * `motion/keyframes-transform-opacity`: `@keyframes` may only animate transform and opacity.
    * **Tests:**
      * `src/styles/classes.test.ts` compiles every class used in `src/` against the theme, via `@tailwindcss/node` `__unstable__loadDesignSystem`; unknown classes fail.
      * The same test runs Tailwind's own scanner (`@tailwindcss/oxide`) over app.css's `@source` set. Every candidate that becomes CSS must pass `classProblem()`, however the code produced it (helper functions, spreads, prose: a comment word "ring" really did ship `.ring`).
      * `src/test/conflicts.ts`, used in `App.test.tsx` and `ui.test.tsx`, fails when an element sets the same property twice (e.g. `text-fg text-danger`). It runs on the whole gallery, so on every primitive and variant.
      * `lint/lint.test.ts` runs the real configs on `src/test/lint-fixtures/` (`bg-[#fff]`, `transition: all`, …).
    * **Tailwind sources:** `app.css` uses `source(none)` and scans all of `src/` except `src/dev`, `src/test`, `src/protocol` and `*.test.*`. Future `src/data`, `src/sync`, … are covered, and fixtures, docs and the gallery cannot add CSS.
    * `budget.ts` also fails on raw colours (hex, `rgb()`, `hsl()`, `oklch()`) outside custom properties, and on `all` or layout-property transitions, in the built CSS.
  * **Primitives (`src/ui`, barrel `src/ui/index.ts`; side-effect free, see below):**
    * `Button {variant: primary|secondary|ghost|danger, size: sm|md, icon, tooltip, shortcut, asChild}`. Use `asChild` to render a router `<Link>`.
    * `IconButton {icon, label (aria-label + tooltip), shortcut, variant, size, pressed}`. `pressed` makes it a toggle (`aria-pressed`).
    * `Input {size, invalid}`. It has no width of its own; size it with `className` (`w-full`, `w-64`).
    * `Kbd`, and `Shortcut {keys: "⌘K" | "G I"}`.
    * `Tooltip {content, shortcut, side}` and `TooltipProvider`. Mount the provider once around the app shell in F3; Radix throws without it, and the boot route does not need it.
      * When the trigger also opens a menu or popover (`aria-haspopup`), the tooltip stays shut while the menu is open.
      * After the menu closes, it stays shut until the pointer leaves or focus moves on (tested in e2e).
    * `Menu` / `MenuTrigger` / `MenuContent` with `MenuItem {icon, shortcut, danger}`, `MenuCheckboxItem`, `MenuRadioGroup` + `MenuRadioItem`, `MenuLabel`, `MenuSeparator`, `MenuSub {label, icon}`.
    * The identical `ContextMenu*` set is built from the same item factory, so row context menus and "…" menus match.
    * `Popover` / `PopoverTrigger` / `PopoverClose`, and `PopoverContent {width: sm|md}`.
    * `Dialog {open, onOpenChange, trigger, title, description, footer, size: sm|md|lg}`, plus `DialogTrigger` and `DialogClose`.
      * Without a `description`, the content has no `aria-describedby`.
      * Children are wrapped in a block, so a lone Button doesn't stretch.
    * `Avatar {name, src, size: sm|md|lg}`; the fallback is `bg-border-strong` so it stays visible on a selected row; `fromSplash` is for the boot shell only.
    * `Badge {tone: neutral|accent|success|warning|danger|done}` and `LabelChip {name, color}`. Neutral and label chips are outlined (`border-strong`). A label's colour from the server goes in through a CSS variable.
    * `ListRow {role: option|row|presentation, selected, active, leading, trailing}`.
      * `active` is the keyboard cursor (`data-active`), separate from `selected`.
      * With `role="row"` the slots are gridcells.
      * The height is fixed (`h-row`) with `contain: content`, and the focus ring is drawn inside.
      * Missing for F4: roving tabindex, J/K, and link rendering (`asChild`/`href`, so middle-click opens a new tab).
    * `Skeleton {round: sm|md|full}` (static, no shimmer), `EmptyState {icon, title, description, action}`, `Icon {icon, size: sm|md|lg}` (lucide, stroke 1.75), and `cx`.
    * Shared class recipes live in `src/ui/recipes.ts` (`surface`, `floating`, `menuItem`, `iconSlot`, `control`, `controlHeight`); features never use them directly (lint).
    * In `src/app/LoggedOut.tsx`, `CenteredScreen` is the centred full-height layout used by the boot shell and Home.
    * Known trade-off: input borders are 1.27:1 against the surface. That is Linear-like, but below WCAG 1.4.11's 3:1 for control boundaries.
    * Missing, to add as variants when needed: Select/Combobox (F4/F6), Toast (F5), a NavItem (sidebar, F3), a Text/section-label primitive, and `--color-hover` on `canvas`. Hover there is only 1.07:1 against the canvas, so the F3 sidebar may want a stronger hover token.
  * **Boot sequence (PLAN §5.2).** `index.html` holds two placeholders that `tools/vite-plugin-shell.ts` fills:
    * `<!--next:splash-->` becomes `src/app/splash.ts` `applySplash`, minified and inlined. It is the first thing in `<head>`: `performance.mark('appStart')`, then it reads `localStorage.splash` and applies it to `<html>`:
      * `data-theme` (light/dark; `system` resolves via `matchMedia`);
      * `--sidebar-width` (clamped to 180–480);
      * `data-shell="app|logged-out"` (logged-out when there is no `splash.user` DB marker);
      * `data-skeleton="list|detail"`;
      * a `<style>` hiding the skeleton rows beyond `skeleton.rows` (0–40, default 14);
      * `--splash-initial`.
      It never throws (blocked storage, garbage JSON).
    * `<!--next:boot-shell-->` becomes `src/app/BootShell.tsx`, rendered to static HTML at build time (sidebar, header, 40 `ListRow` skeleton rows, the detail shape, and the logged-out screen).
    * Splash shape (F2/F3 write it with `writeSplash()`; read it with `readSplash()`):
      `{theme?: 'light'|'dark'|'system', sidebarWidth?: number, skeleton?: {shape?: 'list'|'detail', rows?: number}, user?: string, initial?: string}`.
      **F2 must set `user`** (the id of the user whose IDB exists) and clear it on logout.
    * The theme switch at runtime is `setThemePreference()` in `src/app/theme.ts`, and `followSystemTheme()` keeps following the OS while the preference is `system`.
    * **The boot route is never rendered through Suspense.** React holds a Suspense reveal for up to 300 ms after a fallback commits, which the perf reviewer measured at about 390 ms to content. `main.tsx` therefore awaits `loadRoute()` (`src/app/routes.ts`) before the first render, and the route chunk is modulepreloaded, so the await costs nothing.
    * F3 must keep both rules with TanStack Router: lazy route chunks, and `await router.load()` before `createRoot().render()`.
    * The logged-out boot shell and React's first commit are identical, wrapper included.
      * Unit test: outerHTML equality.
      * Playwright: the bounding boxes of the button, title, text and icon with app JS blocked equal those after React mounts. A CLS sum would not work, because React inserts new nodes, which the layout-shift API ignores.
    * If the route chunk fails to load (e.g. an old build was deleted after a deploy), `main.tsx` reloads once (`sessionStorage.bootRetry`), then shows `BootFailed` (a Reload screen; tested in e2e).
      * **B8: serve `index.html` with `Cache-Control: no-cache`**, so the reload fetches the current build.
      * F5's service worker should make this rare.
    * `hasUser()` (splash.ts) is the one "signed in on this device" test: applySplash's inline copy and the app agree.
    * The signed-in boot frame is still replaced by the `Home` placeholder until F3 renders the real shell, so a layout shift there is expected until F3.
  * **Build.** `vite.config.ts`:
    * base `/-/next/`; `target`/`cssTarget: 'esnext'`; lightningcss transformer and minifier; no modulepreload polyfill;
    * `build.manifest: true` (`dist/.vite/manifest.json`, for B8 and the F5 service worker);
    * `sourcemap: 'hidden'`: `.map` files are written but not referenced, so B8 and F5 must not serve or precache `*.map`.
  * **Vendor chunks** (`vendorChunk()`): one chunk per npm package, with these exceptions:
    * each Radix primitive the app uses (`tooltip`, `dropdown-menu`, `context-menu`, `menu`, `dialog`, `popover`) gets its own chunk;
    * Radix internals share `vendor-radix-ui-internal`, floating-ui shares `vendor-floating-ui`, and react-remove-scroll's dependency tree shares `vendor-react-remove-scroll`;
    * why the Radix internals are grouped: left to default splitting, they landed in the Home chunk, which then formed an import cycle with `vendor-radix-ui-tooltip` and broke boot with "x is not a function". The cost is that internals only a lazy route needs (menu/dialog ones) load at boot, about 5 KB br once such a route exists;
    * lucide icons are not grouped: each stays with the route that draws it, and only lucide's base module is `vendor-lucide-react`.
    * Add a new Radix primitive to `radixPrimitives`.
    * Rolldown's `codeSplitting.includeDependenciesRecursively: false` is required; otherwise react lands in `vendor-lucide-react`. It allows chunk cycles, so the budget fails on any static import cycle between chunks (`chunkCycles`), and the e2e boot test runs the real build.
  * **Tree-shaking.** `treeshake.moduleSideEffects` marks `src/ui/*` side-effect free, so importing one primitive from the barrel doesn't pull in Menu/Dialog. This took boot JS from 100 to 81 KB br. Keep `src/ui` modules pure, and wrap any top-level calls in them with `/* @__PURE__ */`. A package-level `"sideEffects"` field was removed because it silently drops side-effect-only imports such as an SW registration.
  * **Shell plugin (build):**
    * the whole app stylesheet is inlined as `<style>` (4.4 KB br), so the first paint makes no CSS request; the CSS file is deleted from `dist/` and from the manifest;
    * modulepreloads are emitted for the boot routes in `tools/boot.ts` (`BOOT_ROUTES`) and their static closure, right after the entry script;
    * the budget caps inline CSS at 10 KB br. Beyond that, inline only tokens, base and shell, and link a hashed stylesheet.
    * B8: the inline script and style have no CSP hash/nonce. If Forgejo ever sends a CSP for the SPA document, hash them at build time.
    * B8: under a Forgejo `AppSubURL`, the fixed base `/-/next/` needs Vite `experimental.renderBuiltUrl` or rewriting when served.
    * The favicon is `data:,` for now (no request); B8 can point it at Forgejo's.
  * **Budget (`tools/budget.ts`, `npm run budget`).** Sizes are brotli q11, with 1 KB = 1000 B:
    * JS: inline scripts plus every `<script src>` and `<link rel=modulepreload>` in `dist/index.html` (attributes parsed in any order). Limit 150 KB.
    * CSS: inline `<style>` plus any linked stylesheet. Limit 30 KB, of which inline at most 10 KB.
    * It fails when:
      * any chunk in the static closure of the entry, or of a `BOOT_ROUTES` module, is not preloaded (no late discovery);
      * such a chunk has CSS of its own, which would be fetched late; import CSS from app.css instead;
      * there is a chunk import cycle.
    * Current boot route: 81.3 KB br. react-dom alone is 55 KB; the Radix tooltip, internals and floating-ui are about 22 KB because `Button`/`IconButton` include `Tooltip`. F3's shell needs tooltips at boot anyway.
    * CI: this fork has no CI for `next/` (GitHub has no workflows, and `.forgejo/workflows` are upstream's). Until F8 writes the CI recipe, `npm run check` is the gate.
  * **Typecheck:** `tsconfig.json` covers browser code (`src/`, no node types, `noUncheckedSideEffectImports`). `tsconfig.node.json` covers tests, tools, lint, e2e, conformance and configs. Both are strict, with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `erasableSyntaxOnly` (tools run under Node's type stripping: `node tools/budget.ts`).
  * **Reviews.** Round 1 used three adversarial reviewers (correctness/tooling, design system, performance), with 14 + 21 + 10 findings. Fixed:
    * the Suspense 300 ms throttle on boot (blocker);
    * banned and arbitrary utilities leaking into the built CSS from fixtures/docs;
    * the invisible focus ring on primary buttons;
    * WCAG contrast failures;
    * instant-in missing for selected/pressed/checked states;
    * the token-lint bypasses (`z-10`, `p-3.25`, `bg-accent/50`, `*:`, `@[…]`) and the Stylelint gaps (`transition: .2s`, raw shorthand durations, named colours);
    * primitives that could be restyled via `className`;
    * the missing primitive APIs (asChild, ContextMenu parity, Sub/Radio, badge tones, dialog sizes);
    * class conflicts (`text-fg` vs `text-danger`, `z-popover` vs `z-tooltip`, radius);
    * the BootShell duplicating primitives;
    * radix and lucide getting into boot chunks; the budget missing boot-route closures and attribute order; the stale manifest CSS entry; source map comments; the `sideEffects` field dropping imports;
    * Playwright reusing a foreign preview server; the favicon 404 console error; vacuous motion tests;
    * Node types visible to browser code.
    Not changed:
    * whole-sheet inlining, now capped at 10 KB br inline;
    * 40 static skeleton rows (about 20 KB raw, about 1 KB br);
    * unused `--speed-quick`.
    Round 2 used two reviewers (correctness/perf and design system): no blockers, 2 + 6 majors. Fixed:
    * the layout-shift tests were vacuous;
    * classes in unscanned directories silently went missing from production CSS, and classes.test missed consts;
    * menus opened under dialogs;
    * the menu highlight was invisible in dark mode;
    * the ListRow focus ring was clipped;
    * the no-restyle bypasses (consts, spreads, namespaces, `inset-ring`, recipes, template styles, bare icons);
    * the CSS-file route (shorthands, keyframes, file location);
    * Input `w-full` beat `className` sizing.
    Also fixed:
    * the tooltip reopening on its menu trigger;
    * `tokens-only` flagging prose and missing filter/gradient utilities;
    * ListRow `active` and gridcells; chip and avatar colour collisions; menu max height and scrolling; duplicated layout strings;
    * Dialog describedby and the child wrapper; Shortcut keys;
    * the budget missing boot-chunk CSS, the absolute `outDir` crash, the dev server reuse in Playwright, and the gallery.css layer;
    * reload-once on a failed boot chunk.
    Ungrouping the Radix internals, as the reviewer suggested, produced the chunk cycle described above, so it was reverted and is now guarded.
    Round 3 was one verification reviewer, who confirmed the round-2 guards fail on mutation. Its 2 majors are fixed:
    * class strings from functions or spreads bypassed the lint (now the shipped-class scanner test, plus a ban on non-literal spreads);
    * `className` on menu items replaced their recipe (now `Omit`ted).
    Also fixed: `[data-active]` is instant-in (tested); the shared `hasUser`; the reload screen after a second boot failure.

#### F2 — Data layer
- [x] **Status** — done 2026-10-08. `npm run check` is green: lint, typecheck, 193 Vitest tests, build, and the budget, which is unchanged (boot 81.8 KB br JS / 4.5 KB br CSS). All 14 Playwright tests pass, the hydration benchmark included. The integration test (3) passes against a dev Forgejo on PG with livesync enabled. Four review rounds (correctness, protocol, performance); the last found no remaining blocker or major.
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
  * **Files.**
    * `src/data/`:
      * `models.ts`: the catalogue — DTO type, schema version, the group kinds a model lives in (mirrored from
        `hub/models.go`, which `models.test.ts` parses) and the pool's index fields;
      * `entity.ts` (Entity, lazy atoms); `pool.ts` (ModelStore + Pool, which is the delta applier);
      * `idb.ts` (schema and upgrades), `meta.ts` (MetaCache), `persist.ts` (Persister), `hydrate.ts` (Hydrator).
    * `src/sync/`:
      * `client.ts` (SyncClient), `groups.ts` (GroupTable);
      * `bootstrap.ts` + `ndjson.ts` (HTTP loads), `replace.ts` (replacement scope and floors);
      * `transport.ts` (WebSocket, or SSE + POST), `tabs.ts` (Web Locks + BroadcastChannel);
      * `data.ts` (`openData`, the entry point), `rum.ts`.
    * Tests sit next to the code; `src/test/fakeSync.ts` is a scripted server.
    * `integration/` (a real Forgejo, its own Vitest project); `src/dev/bench/` + `e2e/hydrate.bench.spec.ts`
      (benchmark, dev-only route `/-/next/dev/hydrate?n=10000,50000,40000x200`).
    * `app/splash.ts` gained `forgetUser()`; `routes.ts` the dev route; `playwright.config.ts` the bench spec; the
      `integration` project goes into `vitest.config.ts`, `tsconfig.node.json` and the ESLint node block.
  * **Commands:** as F1, plus `npm run test:integration`. With `NEXT_FORGEJO_URL` unset, the integration tests are
    skipped. `npm run test:browser` includes the benchmark.
  * **Dependencies (exact pins):**
    * mobx 7.0.4 (7.0.6 was 6 days old) and mobx-react-lite 5.1.0, for F3's `observer`; F2 does not use it.
    * Dev: fast-check 4.10.2, fake-indexeddb 6.2.5.
    * **No `idb`** (deviation from PLAN §5.1): a few raw requests per transaction are enough, and a promise wrapper per
      request buys nothing for bulk work.
    * The data layer is not on the boot route yet. MobX is 13 KB br and our code ≈ 12 KB br, which fits F3's
      budget (boot 81.8 / 150 KB).
  * **API for F3–F8.**
    * `openData({userId, auth, endpoint?, buildId?, transport?, route?, env?}) → Data` (`src/sync/data.ts`). `Data` has:
      * `pool`;
      * `status`: an observable `SyncStatus`, mirrored in follower tabs (F3's sync indicator). Fields:
        * `connection`: idle | connecting | catching_up | live | offline | unauthorized | stopped;
        * `transport`, `loading` (bootstraps queued or running), `groups`, `serverSyncId` (≤ 1 update/s), `lastError`;
      * `role.leader` (observable);
      * `firstRoute` / `hydrated` (promises, see *Hydration*);
      * `hold(group)` / `release(group)`: this tab shows a group. Ref-counted, and forwarded to the leader;
      * `pin(group, on)`, `barrier()`, `loadClosedPage(repoGroup, before?, limit?) → {next, count}`. Requests made
        before a leader exists wait for one; this tab's own are run locally once it leads;
      * `on(event)`:
        * `revoked`, `issueDropped`, `newBuild` (also sent on a protocol version mismatch), `schemaMismatch`, `wrongUser`;
        * `caughtUp`: F5 flushes the queue on it;
      * `close()`.
    * `deleteUserData(userId)`, for logout: deletes the DB and removes the splash DB marker. F3 warns about unsynced
      intents first and broadcasts. `openData` writes `splash.user` (F1 asked for it).
    * `SyncAuth {token(): Promise<string>; refresh(): Promise<string | null>}`, which F3 implements:
      * `null` means signed out, and sets status `unauthorized`;
      * `session_invalid` and HTTP 401 call `refresh` and reconnect;
      * there is no in-session token refresh (B5).
    * Pool: `pool.model('Issue')` is a `ModelStore` with:
      * `get(id)`: reacts to arrival and removal;
      * `all()` / `size`: react to membership;
      * `by(field, value)`: typed to the model's `index` fields in `models.ts`; a live `ReadonlySet`, so iterate it
        inside the reaction and do not keep it.
    * `Entity`:
      * `get(field)` (one lazily created atom per field observed) and `data` (the whole state);
      * `group`, `version`, `record()`;
      * values are the wire DTOs from `types.gen.ts`: treat them as immutable;
      * plain reads outside reactions allocate nothing.
    * Pool indexes are added in `models.ts`, never in components.
    * `pool.batch(fn)` is one MobX action. `pool.onApplied(fn)` reports the changes of each batch; `Applied.dropped`
      means the server deleted or replaced the entity away.
    * F5's overlay goes on top of `Entity` (server value + local override per field) and must not write server state.
    * **Holding.** The groups the client holds are those reachable from a root, through each group's `refs` (B6
      `end.refs`) and the `pageRefs` of its closed pages. Roots are:
      * persistent holders:
        * `workspace`: GET /-/sync/workspace, fetched every session and on `grants`;
        * `recent`: on-demand groups, LRU per kind — issue 300, repo 30, org/profile/owner 50;
        * `pin`;
      * this or another tab's holds.
      Unreachable groups are unsubscribed, purged, and deleted from IndexedDB.
  * **Delta applier** (the pool's primitives; see the `pool.ts` header).
    * Entities are keyed by (model, id). A state is kept only if its `v` is newer than what is held.
    * `del(g, v)` leaves a tombstone **scoped to (model, id, group)**, so a move (D in g1, U in g2) converges in either
      order. `evict(g, maxV)` drops only what is held in that group.
    * A completed full/summary bootstrap sets a **group floor** at its watermark: a state of the group at or below it
      that is not held is stale.
      * The property test found the case: an embedded profile from another group's older bootstrap resurrected an
        entity.
      * What the response's scope leaves out is exempt: the closed tier in a summary, old read notifications in a user
        group (`replace.ts` `outOfScope`).
    * A bootstrap's own lines are **authoritative** at their watermark: they pass a tombstone, floor or purge *at* that
      watermark. On a quiet server a re-bootstrap returns the same watermark as the purge before it (review round 1
      blocker).
    * `purgeGroup` leaves a floor at the highest version seen. `welcome.server_sync_id` is noted, so a purge covers
      every persisted record.
    * Tombstones: two generations of 25 000, O(1) eviction. They are dropped once a floor or purge covers them.
    * Loads of one group never overlap (`SyncClient.exclusive`). A bootstrap reads its group state, and applies
      `loaded()`, inside that lock.
  * **Positions** (messages.go). Per group, in meta `group:<name>` (`GroupState`):
    * The highest `v` received through the group's subscription. The viewer's own profile, which can arrive outside
      it, raises nothing.
    * Raised to `delta.to`, `caught_up`, `pong`, `barrier_ok` and `resume_from_cursor` only for groups caught up in
      this session.
    * A bootstrap sets `max(position, watermark)`; a model-filtered one never raises it.
    * Positions go to meta **at most once a second** (`GroupTable.raise`/`persistRaised`): never ahead of the entities
      they cover, only sometimes behind.
    * Answers are matched to their request: welcome/subscribed answer the hello/subscribes in order, and a FIFO of
      request ids per session means a late answer to a superseded subscribe never counts (review round 2 major).
    * `needs` (a pending re-bootstrap, of all models or some) stays persisted until a covering bootstrap completes.
    * Units rule:
      * a grant's units are compared with the group's `units` (those of the last full bootstrap);
      * if they differ, the group needs a full bootstrap, whose replacement covers the whole group, closed tier
        included;
      * a model re-bootstrap never overwrites the held units.
  * **Session.**
    * Order: bootstrap first, then `subscribe {since: watermark}`. Held groups with a position resume in `hello`.
      Groups that gained a position between hello and welcome are subscribed after the welcome.
    * `bootstrap_required{model}` triggers a `?model=` re-bootstrap; the subscription stays.
    * `cursor_unknown` **resets** the group: entities, tombstones, floor, IndexedDB buckets and position are all
      forgotten, then a full bootstrap runs.
    * `group_revoked`, a `forbidden` refusal and a bootstrap 404 purge the group and fire `revoked`.
    * A `limit` refusal is retried when a release frees room, or in the next session.
    * An Issue that is deleted or replaced away (`Applied.dropped`, not a move within a frame) releases `issue:{id}`
      and fires `issueDropped`.
    * Deltas of groups not granted in the session, or released meanwhile, are ignored, except the viewer's own User
      (B5).
    * Barriers: at most 16 pending. `too_many_barriers` rejects the newest.
    * Bootstraps run 4 in parallel. Priority: tab holds > structure groups > workspace repos (in workspace order) > the
      rest. On failure:
      * 503: retry after `Retry-After`;
      * 401: refresh the token;
      * 400 or 403: give up for the session;
      * otherwise: backoff from 1 s up to 60 s.
    * Closed pages hold their refs and apply the units rule.
    * Reconnect:
      * exponential backoff, 500 ms · 2ⁿ up to 30 s, with jitter, reset after a `caught_up`;
      * `shutdown`: at least 1 s; `too_many_connections`: 30 s;
      * reacts to `online`/`offline`;
      * keep-alive: `ping` every 25 s, and no `pong` within 10 s means reconnect.
    * **SSE fallback**: after two consecutive transports that never opened, the other one is tried (`transport:
      'auto'`; `'ws'`/`'sse'` force one). SSE POSTs are sequential.
    * Schemas: meta `schemas` holds the versions of the stored data, `serverSchemas` the server's.
      * At start, a model whose stored version differs from this build's is dropped (pool + store), unless the server
        still sends that version. It is then re-bootstrapped in every held group of a kind that can hold it.
      * A model new to the catalogue is bootstrapped the same way.
      * `welcome.schemas` and the header `schemas` drop a model whose version changed.
      * A server version different from this build's fires `schemaMismatch` (F5 updates the app).
  * **IndexedDB** (deviation from §5.3: buckets, and no hot-field indexes in IndexedDB).
    * One DB `forgejo-next:<userId>`, `IDB_VERSION` 2, with these stores:
      * `meta` (`{k, v}`);
      * `intents` (keyPath `seq`, autoIncrement; F5 adds indexes with a version bump);
      * `drafts` (`key`); `blobs` (`sha`, index `atime`);
      * `m:<Model>`, one per model, holding **one value per (group, bucket)**: `{g, b, r: EntityRecord[]}` with key
        `[g, b]` and `b = id mod n(kind)` — repo 32, profiles 32, user/org 8, owner 4, issue/profile 2 (`pool.ts`
        `KIND_BUCKETS`).
    * Measured in Chromium, 30 000 records, fresh context each:
      * one value per record: 2.6 s (85 µs each); 4.6 s with a group index; 5.6 s with group + `repo_id` indexes;
      * the same records as 30 values of 1 000: 82 ms to write; reads 47 ms instead of 210 ms.
    * A group is one key range, so no index is needed. A live change rewrites one bucket (~1 600 records in a
      50 000-issue repository, ~7 ms).
    * Hot-field queries go through pool indexes. An IndexedDB index would cost every write and serve no reader.
    * Upgrades (`reconcile`):
      * a model store whose key or indexes changed is dropped and recreated, and its model recorded in meta
        `droppedModels` (re-bootstrapped at the next start);
      * version-1 databases (id mod 512) get all model stores recreated (`MODEL_LAYOUT`);
      * unknown model stores are deleted;
      * `meta`, `intents`, `drafts` and `blobs` are never dropped: their indexes are fixed in place, and a key change
        throws instead.
      * Bump `IDB_VERSION` (and `MODEL_LAYOUT` when records move) for any layout change, `KIND_BUCKETS` included.
  * **Persistence (leader only).**
    * The pool marks changed buckets. A flush writes them as they are then:
      * debounced 40 ms, at most 400 ms under load, immediately on `pagehide`/`close`;
      * in transactions of ≤ 5 000 records and ≤ 500 values, with relaxed durability;
      * meta and `flushedSeq` go in the last transaction.
    * Nothing of a group is written while it is being loaded or before it is hydrated — buckets and meta
      `group:<g>` alike (`defer`). So a bootstrap is written once at its end, never rewritten per flush.
    * Released, revoked and reset groups are deleted by key range (`dropGroups`), together with their meta in the same
      transaction. `clearModels` empties stores first.
    * A failed flush marks everything dirty again and backs off up to 30 s. A flush with only deferred work writes
      nothing.
  * **Hydration** (PLAN §5.2 step 2).
    * Phase 1 (`firstRoute`): the held structure groups (user, profile(s), org, owner) and the `route` groups, in one
      transaction, one key range per (group, model of its kind).
    * Phase 2 (`hydrated`): every store, keys first so hydrated groups are skipped. Chunks adapt toward ~4 000
      records, read between idle periods (MessageChannel once `eager`).
    * **The leader's sync client starts after phase 1.**
      * Later reads go through the version check.
      * A group is never written before it is hydrated (`defer`), and is hydrated before a replacement or reset
        (`ensureHydrated`).
      * Groups purged or reset, and models cleared, in this session are skipped by later reads (`Pool.unloadable`;
        review round 2 blocker/majors).
    * Not in a worker (deviation from §5.2 "data worker"): the records would be cloned into the main thread anyway.
    * Phase 1 is not chunked: 50k records give ~100 ms tasks before first paint. Acceptable, revisit if F3 measures
      it.
  * **Tabs.**
    * The leader is the holder of Web Lock `forgejo-next:<userId>:leader`. Without Web Locks every tab leads.
    * Followers never write IndexedDB. They hydrate from it and **mirror** it:
      * the leader posts every committed transaction (`commit {seq, buckets, cleared, dropped}`);
      * every read also reads meta `flushedSeq`;
      * a follower keeps, per entity, model (cleared) and group (dropped), the flush its state is from, so reads and
        announcements apply in any order (`Pool.mirror`/`mirrorBucket`/`mirrorDropGroup`).
    * Followers send `hold`/`alive` (every 20 s; a tab silent for 60 s loses its holds), `bye`, and requests (`barrier`,
      `closedPage`, `pin`; F5 adds intents), which are answered with `res` and re-sent to a new leader.
    * Taking over:
      * a tab that saw another leader finishes hydration, reads everything again and drops what that read did not see
        (`retainSeen`), which catches a commit announcement lost when the old leader died;
      * then it starts a persister continuing the flush sequence and a client resuming from the persisted positions;
      * the first tab skips the re-read.
  * **RUM marks:** `wsOpen`, `caughtUp`, `dataOpen`, and the measures `hydrate:route` / `hydrate:all`.
    `firstPaintFromCache` is F3's. F8 posts them.
  * **Benchmark** (`e2e/hydrate.bench.spec.ts`, Chromium 141 headless in this sandbox, median of 3 runs). N issues + N
    IssueLabels; times in ms:

    | N (repositories) | bootstrap: parse + apply + replace (NDJSON MB) | persist | hydrate group(s) | hydrate all | of which pool | query `by(repo_id)` | delta | delta flush |
    |---|---|---|---|---|---|---|---|---|
    | 10 000 (1) | 109 (5.3) | 50 | 59 | 89 | 16 | 1.1 | 0.2 | 2.2 |
    | 50 000 (1) | 437 (27) | 232 | 249 | 259 | 94 | 4.8 | 0.1 | 6.9 |
    | 40 000 (200) | 758 (22) | 559 | 482 | 365 | 74 | — | 0.1 | 1.2 |

    * Bulk loads create no MobX atoms (asserted).
    * Before the bucket layout (one value per entity, with a group and a hot-field index), persisting 50 000 + 50 000
      took 24.7 s and hydrating them 0.9 s.
    * The review's 200 × 200 case went from 4.4 s to 0.6–0.9 s to persist.
  * **Tests** (193 unit + 3 integration + the browser benchmark).
    * `pool.test.ts`:
      * primitives, reactivity (atom release, no allocation outside reactions), follower mirror and bucket mirror,
        stale-copy cleanup, authoritative lines, `Applied.dropped`, tombstone rotation;
      * **convergence property**: random server histories with moves and deletes; every group covered by a bootstrap at
        a random watermark plus its later entries; noise of duplicated and stale entries and extra (incomplete)
        bootstraps; any interleaving, with lines split around other messages. The result must be the server's final
        state (20 000 runs once, 600 in CI);
      * idempotency; revoke and re-grant at the same head.
    * `replace.test.ts`: summary and closed tier, units change, models filter, user notifications, closed page ranges,
      floors.
    * `idb.test.ts`:
      * layout;
      * an upgrade that drops a changed model store but keeps `intents`/`drafts`/`blobs`, and the version-1 layout
        upgrade;
      * a layout forgetting `drafts`;
      * **persist → hydrate round-trip property**;
      * chunking by records and by values, `defer`, `dropGroups`, failure, `clearModels`, phases.
    * `models.test.ts`: the catalogue equals the protocol; kinds equal `hub/models.go`.
    * `bootstrap.test.ts`: NDJSON chunking property (including multi-byte characters), embedded profiles, incomplete
      responses, errors, release mid-stream.
    * `client.test.ts`: 25 scenarios against `src/test/fakeSync.ts`, including every review regression.
    * `data.test.ts`:
      * two tabs: the leader syncs, the follower mirrors, forwards a hold and a barrier, takes over and resumes from the
        persisted positions;
      * logout wipe;
      * requests before the takeover.
    * `startup.test.ts`: release before hydration, close before hydration, schema drop during hydration.
    * **Integration**: a real dev Forgejo on PG with `[livesync] ENABLED = true`.
      * Bootstrap, then an API v1 write arrives in the pool as a delta (≈ 30 ms locally).
      * A field reaction to a rename; a lazy issue load with the rendered body; a comment delta; a barrier.
      * A second session hydrates everything from IndexedDB before the network, then resumes.
      * The same over SSE + POST.
  * **Reviews.** Three adversarial reviewers (correctness/convergence/tests, protocol conformance against
    `services/livesync` + `routers/livesync`, performance/memory), three rounds.
    * **Round 1:**
      * correctness: 3 majors (same-watermark re-bootstrap rejected, issue groups released by any Issue removal,
        requests before promotion hung) + 5 minors;
      * protocol: 4 majors (cursor_unknown, no subscribe between hello and welcome, own profile raising positions,
        units overwritten by a model re-bootstrap) + 6 minors;
      * performance: 6 majors (bucketing, rewriting during streaming, a meta write per delta, phase 2 re-reading,
        live sync waiting for full hydration, tombstone memory) + 6 minors.
      * All fixed, except two minors:
        * incomplete responses keep their own-group lines: every line is a real state at the watermark, and the
          group's lines stop on release; embedded lines wait for the end line;
        * phase 1 is not chunked.
    * **Round 2:**
      * correctness: 1 blocker (a dropped group's position persisted without its records) and 2 majors (released
        groups and dropped models coming back from hydration). All three came from syncing during hydration.
      * protocol: 1 major (stale subscribe answers).
      * performance: no major; 5 minors (tombstone eviction at the cap, `bucketOf` parsing, empty flushes fixed;
        1 600-record buckets per delta in 50k repositories and the `dropGroups` transaction scope accepted).
      * All majors and the blocker fixed.
    * **Round 3** (correctness verification): round 2's findings fixed. One new major: the drop transaction persisted a
      re-held group's *current* state, i.e. a new position ahead of its deferred records. Fixed: the drop transaction
      writes a sanitized state (no position, watermark or units; `needs: all`), and the real state goes with the
      records. A throwing request now aborts its flush transaction.
    * **Round 4** (verification of that fix): no blocker or major. One cosmetic minor: `needs.reason` `'dropped'` is a
      client-only label, not a protocol `BootstrapReason`.
    * The reviewers' reproductions are ported as regression tests (`client.test.ts` "review regressions",
      `data.test.ts`, `startup.test.ts`, `idb.test.ts`, `pool.test.ts`).
    * Merged the B6 follow-up (`ProjectRef`, `Label` schema 2) before the PR; the catalogue gained `ProjectRef` (kind
      `owner`).
  * **Known gaps / for later.**
    * The convergence fuzz covers one model and the full tier; the summary/closed tier and units are covered by unit
      tests.
    * Follower per-entity sequence maps only grow (≈ 18 B per id ever mirrored).
    * Whole-group synchronous blocks: replacement or purge of 50k ≈ 50–80 ms.
    * Bucket counts are fixed per kind: a 200k-issue repository would rewrite ~6 000 records per delta flush (≈ 30
      ms). Growing them with the group size needs an `IDB_VERSION` bump.
    * `navigator.storage.persist()` is requested at `openData` (F3 may move it to sign-in).
    * LRU by count, not by quota.
    * The SHA blob store is created but unused (F7).

#### F3 — Auth, router, app shell, shortcuts, ⌘K
- [x] **Status** — done 2026-10-08. `npm run check` is green: lint, typecheck, 251 Vitest tests, build, and the budget (boot 144.3 KB br JS / 5.0 KB br CSS). All 25 Playwright tests pass, 11 of them against a dev Forgejo on PG with livesync serving the build. Sub-path deployment verified by script. Two review rounds (security, correctness/tests, UI, performance, then a verification round); no open blocker or major.
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
  * **Files.**
    * `src/auth/`: `pkce.ts` (S256), `oauth.ts` (token endpoint: code and refresh grants, `GrantRefused`, 15 s timeout, always this page's origin), `tokens.ts` (refresh tokens: DB `forgejo-next-auth`, store `tokens`, one record per user), `session.ts` (`AuthSession`, the `SyncAuth`), `signin.ts` (lazy chunk: `startSignIn`, `completeSignIn`), `optin.ts` (`ui=next` cookie through `/-/next/opt-in`), `signout.ts` + `wipes.ts`.
    * `src/app/`: `config.ts` (the B8 config block, `sitePath`/`uiPath`, `redirectUri`, `isLocalPath`), `boot.ts` (`bootApp`, `rememberListRows`), `router.tsx` (route table), `search.ts` (typed search params), `repo.ts` (`findRepo`, `loadRepo`, `useHold`), `session.ts` (open/sign out/sign in again/follow other tabs/switch to classic), `store.ts` (`App`, `useApp`, `useSession`), `lazy.tsx` (`lazyView`, `lazyComponent`, `whenIdle`), `reload.ts`, `RouteStatus.tsx`, `shell/*` (Frame, Shell, Sidebar, AccountMenu(+Real), PageHeader, SyncIndicator, Overlays), `shortcuts/*` (keymap, registry, hooks), `palette/*` (Palette, search).
    * `src/features/`: `auth/Callback.tsx`, `home/Home.tsx`, `my/MyWork.tsx` (`/issues`, `/pulls`), `inbox/Inbox.tsx`, `repo/RepoViews.tsx` (repo issues/pulls, one issue/PR). F3's pages are the frames F4/F6 fill: header, typed filters, data holding; the lists, timeline and inbox are placeholders.
    * `src/ui/`: `NavItem.tsx` (`NavItem`, `NavGroup`, `NavHeading`), `Command.tsx` (cmdk parts), `ItemBody.tsx` (shared by menu and command rows), `StatusDot.tsx` (`StatusDot`, `Status`), `SectionHeading.tsx`, `ResizeHandle.tsx`, `returnFocus.ts`; recipes `menuRow`, `overlay`, `dialogPanel`, `sectionLabel`. Tokens `canvas-hover`, `canvas-selected` (contrast-tested); dark `fg-subtle` lightened to #999aa2 (AA on `raised-hover`, now in the test).
    * `tools/vite-plugin-preview-config.ts` (vite preview serves a config block, as B8 does), `tools/subpath-proxy.ts` (dev Forgejo under a sub-path), `e2e/forgejo.spec.ts`.
    * F2 changes: `data.ts` (`workspace` observable, `hydrate(groups)`, `countIntents()`, `peek(model)`, `peekModels`, leader modules loaded lazily, `onFatal`), `hydrate.ts` (`peek`), `client.ts` (`workspace` event, `onOnline` restores the status of a surviving session and pings it, `SignedOut` ⇒ `unauthorized`), `models.ts` (Notification indexed on `status`).
  * **Dependencies:** `@tanstack/react-router` 1.170.39, `cmdk` 1.1.1 (its `@radix-ui/react-dialog` dedupes with radix-ui's).
  * **Boot (PLAN §5.2; F1 rules kept).** `main.tsx` → `bootApp()`: config → `openSession` (only if the splash has a user: `openData` + `firstRoute`, before any network) → router → `await router.load()` → one render. The current route's chunk is preloaded in parallel with IndexedDB (`preloadRoute`, including the splash route behind the base URL), and the leader's sync modules too. Route views are `lazyView`s: preloaded by the router, a failed chunk rejects ⇒ route error ⇒ reload once (main.tsx: `BootFailed` after the second). No Suspense on boot. `firstPaintFromCache` is marked when the shell mounts. Network work (token, sync, `/-/sync/workspace`, opt-in cookie) starts afterwards. A repo loader waits ≤ 3 s for API v1 (repositories outside the pool), never longer.
  * **Router.** basepath = `app_sub_url` (deviation from the B8 note "basepath = base": the routes are Forgejo's canonical URLs, which live at the site root; the UI's own pages are `/-/next/callback`, `/-/next` (base: resumes the splash `route`, else `/`), dev gallery/bench). Router paths are relative to the basepath, so `/-/next/callback` is right under any sub-path; but a source string that is *exactly* the base is rewritten by B8, so the base route is written `/-/next` (`routes.test.ts` fails on such a literal). `trailingSlash: 'preserve'`, `defaultPreload: 'intent'` (50 ms), `defaultPendingMs` 1 s. **`routes.test.ts` parses B8's `spaRoutes` and checks the canonical routes both ways.**
    * **Adding a route:** a `createRoute` in `router.tsx` (`component: lazyView(() => import(…), 'Name')`, `staticData: {skeleton: 'list' | 'detail'}`, `validateSearch` for typed params in `search.ts`), the view under `src/features/<area>/` starting with `<PageHeader>` + `<PageBody>`; for a canonical URL also add it to `spaRoutes` (backend) — the test fails until both agree. Views read params with `useParams({strict: false})` or `getRouteApi('/shell/…')`.
    * Repository routes: `loadRepo` (pool by full name, case-insensitive; `Data.peek('Repository')` before hydration; else API v1) + `data.hydrate(['repo:N'])`; the view holds the group with `useHold(data, group)`.
  * **Auth (PLAN §4.9).**
    * Sign-in: `startSignIn(config, returnTo)` → `{authorize_url}` on this origin with `response_type=code`, `client_id`, `redirect_uri`, exactly `oauth.scope`, `state` (16 random bytes), S256 challenge (verifier 32 bytes). Verifier/state/returnTo in sessionStorage (this tab), taken on first read; ≤ 15 min. `redirect_uri` = config's when it is this origin, else this origin's callback (dev loopback URIs). `{base}callback` checks state, exchanges the code, reads `/api/v1/user`, stores the refresh token, writes the splash marker, opts in (`ui=next`), broadcasts `login`, and `location.replace(returnTo)` (local paths only, never the callback). The callback page does not follow other tabs (its own broadcast would reload it).
    * Tokens: access token in memory only (each tab; shared over BroadcastChannel `forgejo-next:auth`), refresh token in IndexedDB. Refresh tokens are single-use (Forgejo rotates them): every write of a user's refresh token (refresh, adopt after sign-in, delete at sign-out) runs under the Web Lock `forgejo-next:auth:<userId>`; the new token is stored before the lock is released; a tab that waited for the lock takes a broadcast token instead of refreshing. Background refresh 2 min before expiry. A refused refresh (`GrantRefused`: 400/401) ⇒ `expired` (the stored token is deleted only if it is still the refused one); network errors ⇒ `offline`, retried. `token()` rejects with `SignedOut` when expired; the sync client then stops as `unauthorized` (followers mirror it).
    * Render first: the app renders from IndexedDB whether or not a token can be had; "Signed out" + "Sign in" in the sync indicator when the session ended; the database and its unsynced intents stay (keyed by userId). Another user signing in: the previous user's database is deleted unless it holds intents (then kept for that user's next sign-in); their refresh token is deleted.
    * Sign-out (`requestSignOut`): with unsynced intents a dialog warns first. Then (`signOut`): splash marker, last route and sidebar prefs forgotten; the wipe listed (`forgejo-next:wipe`, resumed at the next boot if interrupted); `logout` broadcast (other tabs close their data and go to the base); refresh token deleted under the lock; data closed; IndexedDB deleted (≤ 5 s, then resumed later); **Forgejo's classic web session ended** (POST `/user/logout`, same-origin passes upstream's cross-origin protection) — otherwise the next person on the device signs back in with one click on the consent page. **No token revocation** (no endpoint, B8): the grant stays in the user's Applications settings.
    * `index.html` has `<meta name="referrer" content="no-referrer">` (the code in the callback URL never goes into a Referer).
  * **Shell.** `ShellFrame` (sidebar `aside` + `main`), `SidebarTop`/`SidebarBody`, `HeaderBar`, `PageBody`, `NavSkeleton` — shared by `BootShell` and the app (an e2e test compares their geometry). Sidebar: account (menu loads on intent/first click: Radix menus are not on the boot route), Search (⌘K), Inbox (unread count: `Notification.by('status','unread')`), My issues, My pull requests, Workspace (owners from `data.workspace` — viewer first, then by name — each a collapsible `NavGroup` of repositories by name, 10 then "N more"; collapsed owners persisted in `forgejo-next:sidebar`). Resizable (drag/arrows/Home/End; `--sidebar-width` and `splash.sidebarWidth` written on release). `PageHeader {icon, context (breadcrumb), title, children (controls)}` ends with the `SyncIndicator`: Live / Catching up / Connecting / Offline / Signed out (+ Sign in), "· N pending" from `app.ui.pendingIntents` (read at boot from `countIntents()`; **F5 keeps it current**).
  * **Shortcuts (PLAN §5.6).** `src/app/shortcuts/keymap.ts` is the one table (`KEYMAP`: id → keys, label, scope, `anywhere`); `shortcutHint(id)` formats hints (⌘K on Apple, "Ctrl K" elsewhere; "G I"), used by tooltips (`NavItem`/`Button` `shortcut`), menus, the palette and the `?` dialog (lists the bound ones). `useShortcut(id, run)` binds while mounted (latest `run`, no rebinding); `useShortcutScope('list' | 'issue' | 'diff')` activates a scope; innermost scope then latest binding wins. Text fields, menus, listboxes and dialogs keep their keys except `anywhere` bindings (⌘K, ⌘↵). Sequences time out after 1.5 s; held keys repeat only `list.next/prev`; IME (`isComposing`, keyCode 229) ignored; non-Latin layouts match letters by `code`. F3 binds ⌘K, `?`, G I / G P / G N. **For F4+:** bind `create` (F6), `go.board` (F6), J/K/X (list scope), S/L/A/M/P/E (issue scope), ⌘↵, `[ ]`/R (diff).
  * **Palette (⌘K).** Its own chunk, preloaded on idle; `CommandDialog` (cmdk keyboard/selection only, `shouldFilter={false}`). `searchPool(pool, query, {extraRepos, narrow})` (`palette/search.ts`): repositories by full name, issues/PRs by title words, `#N`/`N`, and words naming the repository; one pass without per-issue allocation (lower-cased text cached per state object; repository words scored once per query); each keystroke narrows the previous one's matches (≤ 20 000 kept), typing is `useDeferredValue`d, all untracked (no MobX subscriptions). Measured: 0.2–1.4 ms per keystroke in the browser (400 issues); 50k issues in Node: first keystroke 10–25 ms, then < 16 ms. `performance.measure('palette:search')`. Commands: navigation, shortcuts, themes, classic UI, sign out. **For F6:** the MiniSearch worker replaces the scan beyond ~50k issues; add commands to `COMMANDS`.
  * **Splash (F1 boot script).** Theme (`setThemePreference`, now also an observable `themeState`), `sidebarWidth`, `route` (last path, local) and `skeleton {shape, rows}` per route (`staticData.skeleton`; `rows` 0 for F3's pages; **F4's lists call `rememberListRows(n)`**), `user`/`initial` (sign-in).
  * **Deviations / limits.**
    * **One signed-in browser per user (needs an orchestrator/backend decision).** Forgejo keeps one OAuth2 grant per (user, app) and, with `[oauth2] INVALIDATE_REFRESH_TOKENS = true` (default), a token issuance invalidates every older refresh token of the grant: signing in on a second browser (or device) makes the first one "Signed out" at its next refresh (verified). Tabs of one browser are fine (lock). Options: recommend `INVALIDATE_REFRESH_TOKENS = false` for Next deployments, or a livesync-side token scheme (backend).
    * Two tabs signing in at the same moment: upstream keeps one PKCE challenge per classic session, so one of them ends on Forgejo's "Bad Request"; the back button after a sign-in lands on the consent page (authorizing again then says the link is not valid any more).
    * The refresh token is in origin-wide IndexedDB: an XSS on a classic page (no Trusted Types there) could read it (same-origin decision, PLAN §4.10).
    * Without a service worker (F5) a fully offline reload cannot load the document; the e2e "network blocked" test blocks API v1, `/-/sync/*` and the token endpoint, and the app renders from IndexedDB.
    * `ui=next` stays after sign-out (it is the UI choice, not a credential).
    * Signing out offline cannot end the classic web session (the POST fails, ≤ 3 s, and is swallowed); local data is wiped regardless.
    * `no-referrer` makes same-origin POSTs (`/-/next/opt-in`, `/user/logout`) carry `Origin: null`; upstream's cross-origin protection then relies on `Sec-Fetch-Site`, which browsers before Safari 16.4 lack (they would get 403 there). Current Chromium/Firefox/Safari are fine.
    * Very narrow windows: the header's breadcrumb and title shrink to ellipses (no breakpoints in the token theme yet; mobile layout is Phase 5).
    * Not virtualized: the sidebar (owners × ≤ 10 repositories, "N more").
    * Boot JS 144.3 / 150 KB br (F2: 81.8): router ≈ 23 KB, data layer ≈ 12 KB, mobx ≈ 12 KB, the shell. **F4 has ≈ 6 KB left**: TanStack Virtual must fit, or the logged-out screen / Radix internals (≈ 5 KB br of menu/dialog internals in `vendor-radix-ui-internal`) move off the boot route.
  * **Commands / verification.** `npm run check` (lint, typecheck, 251 Vitest tests, build, budget). Playwright: `npm run test:browser` (needs nothing else; the `forgejo` project is skipped without `NEXT_FORGEJO_URL`). Against Forgejo:
    `NEXT_FORGEJO_EXTRA_INI=$'[livesync]\nENABLED = true\nASSETS_DIR = <repo>/next/dist\nOAUTH_REDIRECT_URIS = http://127.0.0.1/-/next/callback' next/tools/dev-forgejo.sh restart pg` (`next/dist` must exist when Forgejo starts), then `NEXT_FORGEJO_URL=http://127.0.0.1:3000 PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npx playwright test` (all 25: boot, gallery/bench, 11 Forgejo tests; the build project rebuilds `dist`, which Forgejo re-warms), or `NEXT_E2E_NO_SERVERS=1 … --project forgejo --no-deps` against what is already built. The Forgejo tests cover: PKCE sign-in through the classic consent page (tokens only in memory/IndexedDB, opt-in cookie), refresh rotation on reload, warm boot from IndexedDB with the data network blocked (issue page, sidebar, `firstPaintFromCache`, splash shape), a refused refresh token ("Signed out", content still there, signing in again resumes), the sync indicator offline/online, ⌘K finding a repository and an issue (`palette:search` < 16 ms) and opening it, G I / G P / G N / `?` / hints / typed search params, sidebar width in the next first frame, sign-out across two tabs (IndexedDB, token, splash, wipe list, web session ended), the unsynced-intents warning, a logged-out tab following another tab's sign-in, and boot-shell geometry. Sub-path: Forgejo (MySQL, `ROOT_URL = http://127.0.0.1:3011/git/`) behind `node tools/subpath-proxy.ts 3011 3010 git` with a build in `ASSETS_DIR`: sign-in, links, palette, canonical reload, shortcuts, base resume and sign-out verified by script (not in the suite).
  * **Reviews.** Round 1: four adversarial reviewers. Security: 0 blockers, 2 majors (classic session survived sign-out; a refresh in flight could write a token back after the wipe), 6 minors — all fixed except the documented same-origin/XSS note. Correctness/tests: 1 blocker (base route under a sub-path; already fixed by the guard), 5 majors (own `logout` broadcast reloaded the signing-out tab before `/user/logout`; boot blocked on a stalled API in a repo loader; `SignedOut` kept the sync client reconnecting; a failed leader-module import wedged the leader lock; the 16 ms palette target untested at scale) — fixed; minors fixed except the upstream two-tab/back-button sign-in quirks (documented). UI: 0 blockers, 6 majors (header overlap, focus lost after dialogs, stale theme radio, resize handle motion/focus, dark contrast on palette rows, palette parity) — fixed, plus most minors (alignment, boot shell sidebar, shared item body/section label, Status primitive, focus ring inside nav rows, kbd hints on Home, memoized owner groups). Performance: 0 blockers, 2 majors (route chunk discovered after IndexedDB at boot; palette search O(pool) per keystroke) — fixed (parallel preload; narrowing + deferred value); minors: resize no longer restyles the document per move, the workspace is not re-set when unchanged, leader modules start with the session; the budget headroom is noted above.
    Round 2 (one verification reviewer, every round-1 major re-tested in the browser, sub-path included): all fixed; 0 blockers, 1 new major — palette narrowing dropped repository-name matches when a second word was typed (one word must be in the title, two may name the repository): fixed (no narrowing from one word to several; regression test). Minors fixed: the classic logout POST times out after 3 s; a failed leader-module import reloads at most once a minute (`forgejo-next:leaderRetry`); the sub-path proxy survives client socket errors. Noted above: narrow header, `Origin: null` on old Safari.

#### F4 — Lists, issue detail (read), online optimistic edits
- [x] **Status**
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
  * **Files.**
    * `src/intents/` (the overlay/intent seam, see *For F5*): `overlay.ts` (`Overlay`), `intents.ts` (typed intents, `intentOps`, `describeIntent`, `IntentStore` + `MemoryIntentStore`), `executor.ts` (`Intents`: online send/confirm/reject, `effectHeld`), `rest.ts` (`requestFor`: intent → API v1 call), `view.ts` (pool + overlay readers: `issueState`, `issueMilestone`, `issueLabelIds`, `issueAssigneeIds`, `serverMembers`, `membersAsOf`), `session.ts` (`editing(app)`: one overlay + executor per session, created on first use, rejection notices with Retry).
    * `src/features/issues/` (lists; chunk `ListPage`): `query.ts` (pure filter/sort/group: `runQuery`, `parseSearch`, `kindLabel`, `SORTS`/`GROUPS`), `list.ts` (`IssueListModel`, `queryOf`, `poolContext`), `labels.ts` (scoped labels → status/priority: `exclusiveScope`, `scopedValue`, `labelKind`, `statusStage`, ranks), `IssueList.tsx` (virtualized listbox, cursor/selection, context menu), `cells.tsx` (observer cells shared with the detail view), `ListBar.tsx` (`ListControls`: state, search, Filter and Display menus), `ListPage.tsx` (`useListModel`, `ListBody`, empty/loading states, closed footer), `actions.ts` (`issueActions`: one list for the context menu and the palette), `edits.ts` (edits → intents, one action per bulk edit), `Picker.tsx` (S/P/L/A/M pickers, own chunk), `candidates.ts`, `closed.ts` (closed-tier pager), `flags.ts` (`KeyedFlags`, `ListCursor`), `format.ts` (cached `Intl` dates).
    * `src/features/issue/` (detail; chunk `IssueView`): `IssueView.tsx`, `Sidebar.tsx`, `Timeline.tsx` (Virtuoso from 50 items, its own chunk), `Reactions.tsx`, `Markdown.tsx`. `src/features/repo/repoPage.tsx` (shared by both chunks); `RepoViews.tsx` and `my/MyWork.tsx` render the lists.
    * `src/app/`: `trusted.ts` (the `forgejo-next` Trusted Types policy + `scrub` allowlist), `notices.ts` + `shell/Notices.tsx` (notices with pausable timers), `search.ts` (list search params: `state`, `labels`, `milestone`, `assignee`, `poster`, `sort`, `q`, `group`), `store.ts` (`ui.notices`, `ui.issueTarget`, `ui.picker`), `shell/Shell.tsx` (PickerHost, NoticeViewport), `palette/Palette.tsx` (issue actions group), `shortcuts/registry.ts` (`data-shortcuts`: an element that opts in to letter shortcuts, the list's listbox).
    * `src/ui/`: `Notice`, `NoticeViewport` (one persistent live region), `Property`/`PropertyValue` (labelled `dl` rows), `Prose` (+ `@utility prose`, `src/styles/prose.css`), `sprite.ts` + `Icon` (lucide icons as one inline SVG sprite: `<use>` per icon instead of a tree each), `Hint`, `Text.tsx` (`Code`, `TextLink`), `ListRow` (`rowBase`, `row-cursor`, `ListGroupHeader`), `LabelDot`/`LabelIcon` (Badge.tsx), `AvatarGroup`, `Input {icon}`, `CommandItem {checked}`. Tokens: `--hairline`, `--prose-*`, `--cursor-width`, `--label-ink` (label text = label colour mixed 50 % into `fg`; contrast-tested light/dark for white, black and saturated labels).
    * F2 changes: `sync/client.ts` (`position(group)`, `whenAt(group, v, signal)`, `loadsDone(group)`; a message in flight no longer overwrites `offline`), `sync/groups.ts` (`onPosition`), `sync/data.ts` (`whenSynced(group, v, signal)`; the follower request `synced` waits for the position, the group's loads, then a flush), `data/models.ts` (indexes: Issue `number`, `poster_id`; Review `reviewer_id`), `data/pool.ts` (`by()` returns a shared empty set outside a derivation when there is no bucket).
    * `e2e/issues.spec.ts`, `e2e/helpers.ts` (shared with `forgejo.spec.ts`), `tools/seed-issues.ts` (`node tools/seed-issues.ts <repo> <n>`: labels incl. `status/*`, `priority/*`, milestones, assignees, comments, closed issues).
  * **Dependencies:** `@tanstack/react-virtual` 3.14.13 (lists), `react-virtuoso` 4.18.15 (long timelines; lazy chunk).
  * **Lists.** `IssueListModel(app, overlay, source, defaultGroup)`; `source` = `{kind: 'repo', repoId, pulls}` or `{kind: 'my', pulls, type}` (`assigned` / `created_by` / `mentioned` / `review_requested` / all of the workspace). The page owns it (`useListModel`), `fromUrl(search)` in a layout effect; `setSearch` applies the view in the frame of the click and then writes the URL. `result` is a computed (`{rows, ids}`, equal when the rows are) over `runQuery(candidates, query, poolContext(pool, overlay))`, recomputed at most once per frame after relevant deltas (`concerns()`: models the list reads, of this repository; User only when grouped by assignee) and on overlay changes; `performance.measure('list:query')`.
    * `runQuery` is pure: filter (state, labels incl. negated, assignee incl. none, poster, milestone incl. none, `q` words or `#N`), sort (the classic UI's names + `priority`), group (`status`, `priority`, `assignee`, `milestone` (due first), `repo`). Per run it caches label facts and group keys, ranks the groups once and sorts on numbers; timestamps are parsed once per issue version. While no edit is pending it reads the pool directly (`overlay.size === 0`).
    * Scoped labels (PLAN §7.3): exclusive `status/*` and `priority/*` (any scope ending in that word) show as a status icon (stage from the value: backlog/todo/started/review/done/canceled) and a priority icon (urgent…low, P0–P4), not as chips; other labels as chips. A closed issue with a non-terminal status shows the closed state icon.
    * `mentioned` and `review_requested` are not in synced tables: the list asks `/api/v1/repos/issues/search` once per state and shows those issues from the pool (plus review requests of PRs whose timeline is held).
    * Closed tier (B6): a repo list that can show closed issues (state closed/all, or a search) pages older closed issues in (`closedPager(data, group)`: `Data.loadClosedPage`, newest first) while the list is short (< 60 rows) or the user is near its end; failures retry with backoff (reset on `online`); a footer tells what is loaded.
    * `IssueList`: TanStack Virtual (32 px rows, overscan 8), one `role=listbox` with `aria-activedescendant`; rows are memoized observers whose cells observe one field each (state, title, labels via one `labelView` computed per issue, assignees, milestone, updated). J/K move the cursor (`ListCursor.active`, a `KeyedFlags`: only the two rows concerned re-render), X or Shift-click selects, Enter opens, Esc clears; S/L/A/M/P open pickers on the selection or the cursor; the context menu and the palette show the same `issueActions`.
  * **Detail.** The issue comes from the pool (`Issue.by('number')` in the repository); title, state, labels and sidebar render at once; body HTML, timeline (comments, reviews with their code comments, events), reactions come from the lazy `issue:{id}` group (B6), with a placeholder for the body only. An issue not in the summary is looked for through the closed tier's pages (`NotHere`), then "Not found". Sidebar: status (state + status label), priority, labels, assignees, milestone, project, dependencies, due date — editable fields open the same pickers. Markdown: server `body_html` through the `forgejo-next` policy and `scrub` (allowlisted elements/attributes, `href`/`src` schemes, no `style`, `rel=noopener noreferrer` on links with a target, `loading=lazy`, `preload=none`); same-origin links to SPA routes navigate in-app (paths with encoded `.`, `/`, `\` are not intercepted).
  * **Optimistic edits.** `editing(app).intents.submit(input)` → `Overlay.add` in the same action (the UI paints the change in the next frame: 11–16 ms measured), stored (`IntentStore`), sent after earlier intents of the same issue (at most 6 requests in flight across issues: a bulk edit queues). API v1: state/milestone `PATCH /repos/{o}/{r}/issues/{n}`, labels `POST/DELETE …/labels[/{id}]` (an exclusive scoped label also drops its siblings in the overlay; the server drops them itself), assignees `PATCH` with the full list as the user saw it (`membersAsOf`). Each intent has an `Idempotency-Key` (UUID) used for every retry of the same request (the request is built once). 409 (in flight) waits without spending attempts (≤ 60 s); network/429/5xx retry 4 times with backoff; 401 refreshes once. On 2xx with `X-Livesync-Sync-Id = v`: the layer is dropped when `Data.whenSynced('repo:N', v)` resolves (the pool holds the write: no flicker, verified in the DOM), with one `barrier` at a time after 3 s (one more if asked meanwhile); without the header, when the pool shows the intent's own effect, or when a later intent of the issue is confirmed by its echo (that effect may never show); ≤ 60 s either way. Redirects are refused (the token never follows one). Rejected (4xx, offline, retries spent): the layer is removed and a danger notice says what failed with **Retry** (a new intent).
  * **For F5 (the seam).** The overlay keeps no state of its own: `intentOps(intent)` is a pure function, so F5 replays stored intents by `overlay.add(i.id, intentOps(i))`. `IntentStore` (`put`/`delete`/`list`, sync or async) is where the durable IDB queue plugs in (`new Intents({…, store})`); `submit` already awaits `put` before sending. Missing for F5: queueing instead of rejecting when offline (`Rejection.reason === 'offline'` today), rebasing over deltas (layers are value overrides; a remote change under a pending layer stays hidden until the layer goes), per-intent dependencies beyond per-issue order, follower-tab forwarding (each tab has its own executor), `ui.pendingIntents` (F4 does not update it), the rest of PLAN §5.4's intent types.
  * **For F6–F8.** F6: create/body/comment intents reuse `Intents` (add kinds to `intents.ts`, `rest.ts`, `view.ts`); the list's `GROUPS`/`SORTS` and pickers are the board's; MiniSearch can replace `matches`. F7: `Timeline.tsx` renders review cards (code comments only), PR detail reuses `IssueView` (`pulls`). F8: `e2e/issues.spec.ts` against `tools/seed-issues.ts` data.
  * **Deviations / limits.**
    * Grouped queries over a very large repository exceed one frame in this sandbox (8.5k open: 17–29 ms; ungrouped 1–8 ms; ≤ 3 ms at 341 rows): grouping pays one label/assignee lookup per issue. The e2e asserts < 16 ms up to 5k open rows and < 33 ms above. In Node (≈ 3× faster) 8.5k issues take 3.6–4 ms ungrouped and 6–8.6 ms grouped, pending edit or not. Next step if needed: walk the label buckets without per-issue arrays, or cache a per-issue group key by (issue version, bucket revision).
    * Click → DOM / next frame (React mounting the rows that come into view) is recorded, not asserted (shared vCPUs, software raster: 5–30 ms).
    * The palette searches when the query changes, not when the pool does (F3): a repository that arrives after typing shows at the next keystroke.
    * Open UI minors: group headers are not sticky and are `presentation` in the listbox (no group announced to screen readers); the cursor edge looks the same whether or not the list has focus; "Esc clears" works only with the list focused; `aria-activedescendant` can name a row scrolled out of the virtual window; notices are live regions inside a live region; selected vs hovered rows differ only by a faint tint; the `#N` reference style is repeated in four places (an `IssueRef` primitive is due); code comment cards and `pre` are two inset looks; reactions show "you reacted" by colour only.
    * Each tab sends its own intents (no forwarding to the leader).
  * **Measured** (this sandbox: shared vCPUs, software raster; Chromium; `e2e/issues.spec.ts`, numbers attached to the test results).
    * `f4` (400 issues, 341 open): warm reload paints the list from IndexedDB at 138 ms (query 0.8 ms); filter/group/sort 0.2–2.7 ms; click → DOM 5–43 ms; scrolling: no long task; an issue from the pool opens in 87–172 ms with no spinner (body placeholder only); optimistic label painted in the next frame (11–16 ms) and confirmed without the DOM ever showing the old value; rollback with a notice on a refused write; a title change by another user in the open list 0.2–0.25 s, a comment in the open issue 0.16–0.26 s.
    * `big` (10 000 issues, 8 571 open): warm reload paints at 260–310 ms (first query 13 ms, 8 571 rows); ungrouped filter/search/sort 1.2–8.5 ms; grouped by status/priority/assignee 12–29 ms (see Deviations); scrolling the whole list a half viewport per frame: 641 frames, p50 17 ms, p95 24–25 ms, no long task > 50 ms (one 51 ms task in one of five runs), 35 rows in the DOM.
    * Boot JS 146.8 / 150 KB br (F3: 144.3): lists, detail, pickers and Virtuoso are route/lazy chunks; **3.2 KB left**: F5 must keep its queue/service-worker code off the boot graph.
  * **Commands / verification.** `npm run check` (lint, stylelint, typecheck, 291 Vitest tests, build, budget). Seed: `node tools/seed-issues.ts f4 400`, `node tools/seed-issues.ts big 10000` (as `dev`, with `alice` as a second user). Against Forgejo (§F3 command, `ASSETS_DIR = next/dist`): `NEXT_E2E_NO_SERVERS=1 NEXT_FORGEJO_URL=http://127.0.0.1:3000 PLAYWRIGHT_CHROMIUM=… npx playwright test --project forgejo --no-deps` (16 tests; one worker: both files share the server's data), and `NEXT_E2E_REPO=big NEXT_E2E_ISSUES=10000 … e2e/issues.spec.ts` (5 tests). `--project build --project dev`: 14 tests.
  * **Reviews.** Round 1, four adversarial reviewers. Correctness/B7: 7 majors (a retry could send a different request under the same key; 409 spent attempts; confirmation without a sync id dropped the layer on any unrelated delta; an earlier echo could drop a later layer; no barrier for a slow echo; the follower's `synced` answered before the state was persisted; a rejected intent below a pending one) — fixed with regression tests; minors fixed except the exclusive-label `drop` being a snapshot (harmless: the server drops siblings itself). UI: 8 majors (among them two h1s per page, unlabelled properties, notices without a persistent live region, duplicated link/code styles, status shown twice) — fixed, most minors too. Performance: 3 majors (bulk edits notified per issue, query hot path, irrelevant deltas recomputed) — fixed. Security: 0 blockers/majors, 3 minors fixed (ARIA references, `preload`, encoded path segments in link interception).
    Round 2: correctness 2 majors (an earlier no-echo layer could resurface after a later intent confirmed; bulk edits sent every request at once) — fixed with tests; performance 2 majors (one pending edit sent every issue down the overlay path; per-issue allocations when grouping) — fixed (per-issue `touches`, numeric group keys, cached names); UI and security: no blockers/majors, security minors fixed (label colours, `.`/`..` names, in-app link shape, `target`, redirects), UI minors partly fixed, the rest listed above. Round 3 (verification of the round-2 majors): 1 major — two intents of an issue both confirmed without a sync id could still bring the earlier layer back — fixed (an intent confirmed by its own effect also drops the earlier waiting layers whose fields/members it sets; test); minors fixed: a freed send slot goes straight to the next waiter (the cap is exact), a barrier asked for while one is pending is sent again afterwards, a connection lost mid-request is reported as an unknown outcome (no "undone"). Not changed: a slow send (409/Retry-After waits) keeps its slot. No blockers or majors remain.

#### F5 — Offline intents + service worker
- [x] **Status** — done 2026-10-08. `npm run check` is green: lint, stylelint, typecheck, 340 Vitest tests, build, and the budget (boot 148.6 KB br JS / 5.9 KB br CSS). All 36 Playwright tests pass (6 in `offline.spec.ts`) against a dev Forgejo on PG with livesync serving the build; the convergence property passed 3000 runs. Three review rounds (data integrity, conflict policy/UX, service worker, UI/performance, then two verification rounds); no open blocker or major.
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
  * **Files.**
    * `src/intents/` (built on F4's seam; F4's overlay/ops/rest/view were extended, not replaced):
      * `intents.ts` — every offline-capable kind of PLAN §5.4 (see *Intent kinds*), `intentOps`, `describeIntent`,
        `intentText`, `POLICY`, `CREATES`, `chainOf` (serial queue per entity), `groupOf` (echo group), `tempNum`/`isTemp`,
        `tempRefs`, `remapIntent`.
      * `overlay.ts` — F4's overlay plus string set members (reaction contents, viewed paths), `create` ops (locally
        created entities as real `Entity` objects under a negative temporary id: `created(model)`, `createdEntity`) and the
        `DELETED` pseudo-field.
      * `executor.ts` — `Intents`: the queue mirror in every tab, the flusher in the leader, conflict policies, drafts.
      * `store.ts` — `IntentDb` over the user's IndexedDB (`intents`, `drafts`, remaps in `meta`).
      * `rest.ts` — API v1 / B9 requests (`api: 'v1' | 'sync'`), `NotReady` (wait) vs `UnsendableIntent` (fail).
      * `effects.ts` — `effectHeld`, `serverScalar`, `lastChangedBy` (who made the change a scalar overrides).
      * `merge3.ts` — line-based diff3 with git's markers. `view.ts` — every UI reader through the overlay.
      * `session.ts` — `startEditing(app)` (boot) / `editing(app)`, the BroadcastChannel, notices, pending count.
    * `src/sw/` — `sw.ts` (the worker), `routes.ts` (pure decisions: `isSpaRoute`, `sitePathOf`, `strategy`, build meta);
      `tools/vite-plugin-sw.ts` builds `dist/sw.js` with rolldown.
    * `src/app/` — `sw.ts` (registration, update path, page-side kill switch, `removeServiceWorker`), `online.ts`
      (`connectivity`, `onlineOnly()`), `Available.tsx` ("available on this device"), `shell/Unsynced.tsx` (the panel),
      changes to `boot.ts`, `session.ts`, `trusted.ts` (`workerScriptURL`), `notices.ts` (`sticky`), `store.ts`
      (`ui.unsyncedOpen`), `RouteStatus.tsx`, `shell/{Shell,SyncIndicator,AccountMenuReal}.tsx`, `palette/Palette.tsx`.
    * `src/features/issue/Editing.tsx` (description editor, comment composer/edit/delete, conflict UI, override callouts),
      `IssueView.tsx` (temporary issue URLs), `Timeline.tsx`, `Sidebar.tsx`; `features/issues/cells.tsx` (`PendingCell`,
      `TitleCell` through the overlay), `IssueList.tsx`; `features/repo/repoPage.tsx`.
    * `src/ui/` — new primitives `Callout`, `Entry`/`EntryList`, `TextArea`, `ProseSource`, `PendingIcon`/`PendingBadge`;
      `Status {onClick, label}`, `Notice` tone `warning`, `SectionHeading {id}`; recipes `field`, `ghostHover`, `message`
      (Input/TextArea, Button ghost/Status, Notice/Callout share them). Tokens: `--delay-pending` (1 s) and
      `--animate-pending` (fade in after the delay; `none` with reduced motion).
    * `src/data/idb.ts` — `IDB_VERSION` 3: index `id` on `intents` (fixed in place; records kept). `src/sync/data.ts` —
      `Data.db`, `countIntents()` counts queued intents + failed drafts.
    * Tests: `intents/{executor,converge,regressions,merge3}.test.ts`, `sw/routes.test.ts`, `data/idb.test.ts` (v2→v3
      migration + property), `app/App.test.tsx`; harness `src/test/{fakeForgejo,fakeTabs}.ts`; `e2e/offline.spec.ts`.
  * **The queue (PLAN §5.3–§5.4).**
    * **Submit (any tab):** the overlay layer is applied in the same action (≤ 1 frame), the record
      `{id, intent, state: queued, attempts}` is added to `intents` (autoIncrement `seq` = the queue's order across tabs)
      with a fresh `Idempotency-Key`, then announced (`added`) on `BroadcastChannel forgejo-next:<userId>:intents`. A
      follower's hand-over **is** the stored record: nothing is lost if the leader dies before hearing about it.
    * **Leader only sends.** Gate: leader ∧ `status.connection === 'live'` (F2 sets `live` only when every subscription of
      the session caught up; a socket that survives a short offline spell stays live) ∧ `navigator.onLine` ∧ not held.
    * **Per entity serial** (`chainOf`: `i:<issueId>`, `n:<notificationId>`): one intent in flight, and an **acked**
      intent holds back the entity's next one until its echo is in the pool (it is then prepared against the state that
      includes it). Exceptions: a **parked** conflict holds back only later edits of the same text (`textTarget`:
      `body:<issue>`, `comment:<id>`); an intent that refers to an entity created offline waits for the create without
      holding the entity back. ≤ 6 sends in flight across entities.
    * **Before each send** the leader reads `intents` from IndexedDB (`unknownBefore`): records stored by a tab that died
      before announcing them are learnt, and an earlier unsent intent of the entity goes first (two ordering bugs the
      property test found).
    * **Request frozen with its key:** built at the first attempt against the freshest pool (`requestFor`) and stored in
      the record (`req`) **before** it is sent; every retry — by this tab or the next leader — is the same request under
      the same key (B7: replay, never a 422). New keys only for a B9 rebase, a resolved conflict, a retried draft.
    * **Answers:** 2xx ⇒ `acked {v, created}` (+ remap, below) then confirm; network error / 429 / 5xx ⇒ backoff
      (base 1 s, cap 5 min, `Retry-After` honoured), same key, no attempt limit (shown in the panel after 2 attempts);
      409 + `Retry-After` (B7 in flight) ⇒ wait without spending attempts; 409 with `{body, content_version}` (B9) ⇒
      merge (below); other 409 ⇒ done if the effect is held, else failed; 404 on a removal ⇒ done; 401 ⇒ refresh once;
      other 4xx / redirect / 422 ⇒ **failed**. A missing repository/issue/profile in the pool ⇒ `NotReady` (backoff, note).
    * **Confirmation (no flicker):** with `X-Livesync-Sync-Id = v` the layer is dropped when `Data.whenSynced(group, v)`
      resolves (barrier after 3 s), else when the pool shows the effect; ≤ 60 s. A group this tab does not hold is done
      at once. Followers drop the layer on `done {group, v}` after their own `whenSynced` (mirror). An entity whose
      confirmation timed out is `stale` until its queue empties: no "already on the server" shortcut and no pool-based
      rebase for it (the server's 409 decides).
    * **"Already done":** an intent whose effect the pool already shows (`effectHeld`) is done without a request.
    * **Signed out:** `token()` rejecting with `SignedOut` (or a refresh returning null) **holds** the queue (PLAN §4.9)
      until the session is live again; the queue is keyed by user (DB per user); other token errors back off.
    * **Take-over:** the new leader re-reads `intents`, drafts and remaps, posts `leader` (followers re-read), confirms
      acked records again (no resend) and resends queued ones with their frozen request. Tabs re-read on
      `visibilitychange` too. Without Web Locks every tab leads (F2): B7 dedupes identical keys; not otherwise guarded.
  * **Conflict policies (PLAN §5.4, `POLICY`).**
    * Sets: add/remove against the current server set (assignees: the whole list from `membersAsOf`).
    * Scalars (state, title, milestone, due date): last writer wins; if the server value differs from the intent's `base`
      (and from the new value) when it is prepared, an `Override {who, field, theirs, mine, undo}` is raised after the
      ack: an inline `Callout` on the issue ("You overrode @alice's change to the title · Undo · Dismiss") and a notice when
      the issue is not on screen. Undo submits the inverse intent. Dismiss/undo is broadcast (`overrideGone`).
    * Description: `{text, baseText, baseVersion}`; the base is taken **when the editor opens** (`EditBase`, stored with
      the draft). If the server text moved: `merge3(base, theirs, mine)`; clean ⇒ sent under a new key with the server's
      version; conflict ⇒ **parked** with `{theirs, version, merged}` — the editor shows the merge with markers ("Keep
      mine" / "Use theirs" / edit and Save, refused while markers remain); `resolve` replaces the parked record **in its
      queue position** (same `seq`) with a new intent based on theirs. `baseVersion: -1` (an unsynced edit's text) lets
      the server's 409 provide the current text.
    * Comment edit: parked when `updated_at` changed and the text differs from the base (PLAN: compare `updated_unix`);
      B9's `expected_version` checks again (409: same text ⇒ new version + key, else parked). Deleting a comment fails
      its parked edit to the drafts (text kept).
    * Creates (issue, comment, review): the overlay holds an `Entity` under `tempNum(tempId)`; the answer's id is
      remapped **in the ack's transaction** (dependent records + `meta.intentRemaps`, newest 500), then broadcast
      (`remap`). `remapKnown` rewrites later intents made under the temporary id (the page still shows it until the
      echo). Views hide a created entity once its server copy is in the pool (`issueComments`). URL: an issue created
      offline is at `/{owner}/{repo}/issues/new-<tempId>` (`tempIssuePath`); the page replaces it with the real number
      (`router.navigate({replace: true})`) once created.
    * Failed (4xx, target deleted, group revoked, issue dropped, dependency failed/discarded): **one transaction** moves
      the record to `drafts` (`failed:<id>` with the intent, its text, the reason); the layer is removed; a danger notice
      offers Retry. Dependents of a failed or discarded create fail too (`orphans()`, also after a crash).
  * **Intent kinds** (API in parentheses): `issue.create` (POST issues), `issue.state`/`issue.title`/`issue.deadline`/
    `issue.milestone` (PATCH issue), `issue.body` (B9 PATCH `/issues/{id}/body`), `issue.pin` (POST/DELETE pin),
    `issue.lock` (PUT/DELETE lock), `issue.label` (POST/DELETE labels), `issue.assignee` (PATCH assignees),
    `issue.dependency` (POST/DELETE dependencies), `issue.subscribe` (PUT/DELETE subscriptions/{user}),
    `issue.reviewer` (POST/DELETE requested_reviewers), `reaction` (issue or comment reactions), `comment.create`,
    `comment.edit` (B9 PATCH `/comments/{id}/body`), `comment.delete`, `review.submit` (POST reviews with `commit_id` and
    the locally drafted comments), `board.move` (B9 card move with `position`), `pr.viewed` (B9 PUT viewed),
    `notification.status` (PATCH threads `?to-status=`). UI wired in F5: state/labels/assignees/milestone/priority (F4
    pickers), title display, description, comments (create/edit/delete). The rest have intents, requests, effects,
    overlay readers (`view.ts`) and tests, for F6/F7 to wire.
    * **Adding a kind (F6–F8):** a variant in `intents.ts` + `intentOps` + `describeIntent` (+ `intentText` if it carries
      text) + `POLICY` (+ `CREATES` and `createdId` for a create, + `tempRefs`/`remapIntent` if it can refer to a created
      entity) + `chainOf`/`groupOf` if not issue-scoped; its request in `rest.ts`; `effectHeld` (and `removes()` if a 404
      means done) in `effects.ts`/`executor.ts`; a reader in `view.ts`; a case in `executor.test.ts`.
    * **Online-only** actions are not intents: disable them offline with `connectivity.online` and say why with
      `onlineOnly('Merging')` (`app/online.ts`). F5 applies it to "Switch to the classic UI" (menu, palette). F7: merge,
      branch, file edits, releases, actions, stopwatch, settings.
  * **Drafts and the panel (APIs for F6–F8).**
    * `editing(app).intents`: `submit(input)`, `records`/`drafts`/`remapped`/`overrides` (observable maps/array),
      `pending`, `failedCount`, `pendingOn(issueId)` (one key observed), `conflictOf(kind, id)` (one key observed),
      `resolve(id, text)`, `retry(draftKey)`, `discard(id)` (never-sent or parked only: `discardable`), `resubmit(i)`,
      `discardDraft`, `restoreDraft`, `keepText({key, title, issueId, repoId, text, base?})`, `undoOverride`,
      `dismissOverride`.
    * Texts being typed are kept as `text:*` drafts (debounced 400 ms; `TextEditor` in `Editing.tsx`): a reload or a crash
      never loses them; Esc/Cancel discards with an Undo notice. F6's CodeMirror composer should keep using `keepText`.
    * The "Unsynced changes" panel (`app.ui.unsyncedOpen`; the sync indicator is a button that opens it): Conflicts
      (Resolve → the issue), Not sent (Retry / Copy / Discard with Undo), Syncing/Waiting (discard with Undo while never
      sent), Drafts. The indicator shows "· N pending" (queued + failed); the sign-out warning counts the same.
    * Pending marks: `PendingCell` after the title in rows and the page header, `NotSynced` on unrendered text; both fade
      in only after 1 s (online edits confirmed sooner never show them).
  * **Boot.** The queue's chunk is imported in parallel with IndexedDB; the first frame waits for it only when
    `countIntents() > 0` (then the stored layers are in the overlay before the first frame), never on an empty queue.
    Boot JS 148.6 / 150 KB br (F4: 146.8): the sync indicator button, `sw/routes.ts` (opt-in guard), chunking. **≈ 1.4 KB
    left** — F6 must move something off the boot route before adding to it.
  * **Service worker (`src/sw/sw.ts`, `dist/sw.js`, B8 serves it at `{base}sw.js`, scope `{app_sub_url}/`).**
    * Registered after the first paint (idle) by `app/sw.ts`, through the `forgejo-next` Trusted Types policy's
      `createScriptURL`, which allows exactly `{base}sw.js`.
    * **Install** (versioned): fetches the shell `{base}` (no-cache), checks its `<meta name="forgejo-next-build">` equals
      the worker's build version (else the install fails: the server runs another build, whose sw.js will install), then
      `cache.addAll` every hashed asset (no `.map`, not sw.js) and stores the shell last. Waits (no skipWaiting).
    * **Activate:** deletes other `forgejo-next-*` caches, enables navigation preload, claims clients.
    * **Assets** `{base}assets/*`: cache first (only this build's files are added).
    * **Navigations** (top-level documents only; frames untouched): `navigator.onLine === false` ⇒ the cached shell.
      Online ⇒ the browser's own navigation request (navigation preload) — **a fetch made by the worker is not a document
      navigation for B8** (`Sec-Fetch-Dest`), which would serve the classic page; without preload, app pages fetch the
      shell from the network and other pages pass through. App pages (`isSpaRoute`, below the base) fall back to the
      shell after 4 s without an answer; classic pages wait for the network; a failed request ⇒ the shell (the app's
      "Not available offline / Not available here" page lists what is). Classic documents' bodies are never read.
    * **Update path:** an app document carrying another build's meta ⇒ `registration.update()`; `notice{new_build}`
      (Data `newBuild`) ⇒ `update()`; a new worker installed and waiting ⇒ sticky notice "A new version is ready ·
      Reload" ⇒ `skipWaiting` ⇒ `controllerchange` ⇒ reload (another tab's Reload just reloads). Unsynced intents are
      durable: the reload is safe.
    * **Kill switch:** the page calls `update()` at start; sw.js 404/410 ⇒ unregister + delete caches. The worker checks
      sw.js at most every 30 min (time kept in its cache) and when one of the app's own pages answers 404 ⇒ deletes its
      caches and unregisters. A build made with `NEXT_SW_KILL=1` installs a worker that unregisters itself.
      "Switch to the classic UI" unregisters the worker; boot opts in again only on the app's own pages.
    * The build plugin fails if `sw.js` loses the exact base literal B8 rewrites under a sub-path.
  * **Not available offline** (PLAN §5.5): unknown routes (the worker's fallback for classic pages), an unknown
    repository and an issue not on this device say so and list Home, My issues, My pull requests, Inbox and the
    repositories on this device (`AvailableOffline`); no spinner offline (the closed-tier search stops).
  * **Measured.** Offline warm boot (service worker shell + IndexedDB, list of 12 issues): `firstPaintFromCache` 87–176 ms
    (12 × 3 warm reloads, sandbox Chromium); the first boot served by a newly installed worker (cold code cache for
    cache-storage responses) 175–345 ms, logged but not asserted. The test first waits until the repository's group is
    stored (a group lands in IndexedDB once its bootstrap finished: a page seen for a moment before going offline is
    honestly "not on this device"); local apply in the same frame (F4's measurement holds; F5 adds one IndexedDB write
    after the layer).
  * **Commands / verification.** `npm run check` (lint, stylelint, typecheck, unit tests, build, budget).
    `CONVERGE_RUNS=3000 npx vitest run --project unit src/intents/converge.test.ts` for a long property run (default 60;
    timeout scales). Playwright: as F4 (`NEXT_FORGEJO_URL=…`, `ASSETS_DIR = next/dist`); `e2e/offline.spec.ts` is in the
    `forgejo` project (6 tests: offline labels/description/comments with a second user, the description conflict UI,
    offline warm boot < 300 ms + "not available offline", two tabs with the leader closed mid-flush (one comment), the
    update path, the kill switch). The update and kill-switch tests rewrite `dist/sw.js` / `index.html` in place and
    restore them (they need Forgejo serving `next/dist`).
  * **Deviations / limits / for later.**
    * Background prefetch of lazy tiers (PLAN §5.5) is not in F5's tracker scope: left for F6/F8.
    * `notice{new_build}` compares Forgejo's version (`buildId` = `config.version`), not the app build: deploying a new
      `ASSETS_DIR` build without a Forgejo upgrade is found by the worker's navigations (meta mismatch) and at boot, not
      pushed to open tabs. **Backend follow-up:** send/compare the build meta.
    * B7's crash-window dedupe matches comments by user + issue + body within the window: two identical comments queued
      back to back whose second first attempt hits a 5xx could be merged into one (not reproduced). Backend follow-up.
    * Online reload of a temporary issue URL (`new-<tempId>`) before it is created reaches the server, which does not
      know it (classic 404); offline the worker serves the app.
    * Overrides are kept in memory (lost on reload); a crash between the ack and the notice loses the notice (the change
      itself is on the server).
    * The `editing()` autorun and visibility listener live as long as the page (one session per page load).
    * The worker's self-kill (an app page answered by the server with a classic document, i.e. opted out) also fires
      where the server's `spaRoute` is stricter than `isSpaRoute` (reserved owner names, `{repo}.git/…`) or a proxy answers
      a 200 challenge page; harmless (the next app boot registers it again) but it drops the offline cache. A server
      header marking classic documents (B8 follow-up) would make it exact.
    * Reactions, dependencies, subscriptions, reviewers, pin/lock, deadline, board moves, viewed files, inbox status and
      review submit have no UI yet (F6/F7).
  * **Reviews.** Round 1, four adversarial reviewers. Data integrity: an effect-held skip past an unconfirmed earlier
    intent, a resolved conflict moved to the end of the queue, a new leader sending before learning an earlier stored
    intent, no flush after reconnecting without `caught_up`, temp-id remaps lost on reload — all fixed with regression
    tests (`regressions.test.ts` R1–R5) and found again by the property where applicable. Conflict policy/UX: overrides
    and conflicts notified while the issue is open, comment edit on a deleted comment, drafts lost on Esc, parked edits
    blocking their chain — fixed (M1–M9). Service worker: navigations fetched by the worker got the classic page (now
    navigation preload), the kill switch never ran (explicit `update()`), stale shell after deploy, Trusted Types for
    the script URL — fixed. UI/perf: the pending badge animation, live-region noise, duplicated callout styles, the
    indicator not being a button — fixed. Round 2 (verification): follower discards resolved before the leader acted,
    cached shells re-opting-in opted-out users, classic pages served the shell, reduced motion, focus after the editors —
    fixed. Round 3 (verification): a follower took a send's `done` for its discard (Undo could post twice) — the leader
    now answers every discard (`discarded {ok}`) and blocks the send while removing; the comment menu dropped focus on
    Escape; Undo could overwrite a reopened editor (the text goes to the Unsynced drafts instead); worker-fetched shells
    without preload were unmarked; minor items fixed. Open (minor, documented above): the self-kill's false positives.

#### F6 — Inbox, boards, search, saved views, create flows, comments
- [x] **Status** — done 2026-10-08. `npm run check` is green: lint (ESLint + Stylelint), typecheck, 377 Vitest tests, build, and the budget (boot 146.2 KB br JS / 6.2 KB br CSS; F5 left 148.6). Playwright: all 42 tests pass — 14 build/dev, and 28 against a dev Forgejo on PG with livesync serving `next/dist`, 6 of them F6's (`e2e/f6.spec.ts`). Four review rounds (correctness/tests, UI/design system, performance, security); the last found no remaining blocker or major.
- **Scope:** inbox (notifications, read/unread/pin, offline-capable), project boards with
  drag and drop (move-card intent → B9), MiniSearch worker over the pool + server issue
  search fallback, saved views (local, synced later), create issue flow (temp id), comment
  composer (CodeMirror 6 markdown + batch preview), reactions.
- **Depends on:** F5
- **Acceptance:** Playwright: create issue offline → appears with temp id → online ⇒ real
  number, URL replaced; drag card between columns reflects in classic UI; search returns
  local results < 16 ms; notifications mark-read sync across tabs.
- **Notes/decisions:**
  * **Files.**
    * `src/features/inbox/` — `Inbox.tsx` (the page: `InboxModel`, virtualized listbox, row menu), `inbox.ts` (pure rows: pinned first, newest first, optional by-repository groups), `actions.ts` (`setStatus`: `notification.status` intents).
    * `src/features/board/` — `board.ts` (pure layout: columns, cards, pending moves replayed in order; `moveTo` gap → position), `model.ts` (`BoardModel`: scoped recomputes, per-column computeds), `dnd.ts` (`BoardDnd`: pointer drag and drop), `columns.ts` (online column CRUD), `BoardView.tsx` (`/-/next/projects/$id`), `BoardsList.tsx` (`/-/next/boards`).
    * `src/workers/searchIndex.ts` (MiniSearch index), `src/workers/search.worker.ts` (Comlink `expose`), `src/features/search/local.ts` (`LocalSearch`: feeds the worker from the pool), `src/features/search/server.ts` (API v1 issue search).
    * `src/features/views/` — `views.ts` (`ViewStore`, validation), `SaveView.tsx`, `SidebarViews.tsx`.
    * `src/features/create/CreateIssue.tsx` (the C dialog), `src/features/editor/` — `MarkdownEditor.tsx` (CodeMirror 6, its own chunk), `Composer.tsx` (`MarkdownField`: Write/Preview, batched `renderPreview`, `preloadEditor`).
    * `src/features/issue/` — `Reactions.tsx` (toggle, picker), `Sidebar.tsx` (`SubscribeValue`), `Editing.tsx` (`TextEditor` uses `MarkdownField`; `focusShortcut`), `paths.ts` (`tempIssuePath`, `TEMP_PATH`).
    * `src/app/` — `api.ts` (`online()`: online-only requests), `create.ts` (`openCreate`), `lastBoard.ts`, `trusted.ts` (`appWorkerURL`), `router.tsx` (two routes), `search.ts` (`InboxSearch`), `store.ts` (`ui.unread`, `ui.create`, `ui.repoOpen`), `shell/Sidebar.tsx` (New issue, Boards, Views on idle), `shell/Shell.tsx` (C, G B, CreateHost), `palette/Palette.tsx` (create/boards/views/"On this page" commands, local + server results), `shortcuts/` (keymap entries, scopes `inbox`/`board`/`editor`, `registry.available/run/shadowed`, `activeHint`).
    * `src/intents/` — `overlay.ts` (`fieldOverrides`, `fieldLayers`), `intents.ts` (`chainOf`: board moves one queue per board), `effects.ts` (board.move never "already done"), `view.ts` (`issueSubscribed`), `session.ts` (the overlay-aware unread count).
    * `src/ui/` — `Board.tsx` (`BoardColumn`, `BoardCard`, `DropIndicator`), `PromptDialog.tsx`, `ChipButton` (Badge.tsx), `EditorFrame` (Input.tsx), `Button {pressed}`, `StatusDot {off, tone accent}`; `issues/cells.tsx` `AgoCell`. Tokens `--spacing-card` (96px), `--spacing-column` (288px), `--card-title-lines`; utilities `drag-layer`, `clamp-title`, `focus-ring-within`, `focus-visible-within`.
    * `vite.config.ts` — `vendor-radix-ui-focus` (see Budget). `tools/` unchanged. Tests listed below.
  * **Dependencies (exact pins, each ≥ 2 weeks old):** minisearch 7.2.0, comlink 4.4.2, @codemirror/state 6.7.6, @codemirror/view 6.43.13, @codemirror/commands 6.11.1, @codemirror/language 6.12.4, @lezer/markdown 1.7.2, @lezer/highlight 1.2.4, @lezer/lr 1.4.10 (pinned so the transitive 1.4.11, one day old, is not taken). No `@codemirror/lang-markdown`: it pulls lang-html/css/javascript; the markdown `Language` is built from `@lezer/markdown` (GFM) directly, highlighted with lezer's `classHighlighter` (`tok-*` classes) styled through an `EditorView.theme` that names tokens only. No drag-and-drop library (`dnd.ts`).
  * **Routes (deviation).** Boards live under the UI's base: `/-/next/boards`, `/-/next/projects/{id}` (project ids are global; repository, organization and user projects alike). Canonical URLs (`/{owner}/{repo}/projects/{id}`, `/{org}/-/projects/{id}`) would need B8's `spaRoutes` extended — a backend change outside F6's files. **Backend follow-up.** The new-issue flow is a dialog, not a route; an issue created offline keeps F5's `/{owner}/{repo}/issues/new-<tempId>` until numbered.
  * **Inbox (`/notifications`, G N).** Notifications of the user group, through the overlay: `InboxModel` keeps a sorted list (recomputed only on notification deltas, once a frame) and partitions it on every overlay change (triage is linear: 10k notifications 0.6–1.7 ms in Node). Pinned first, newest first; "Unread" filter and "Group by repository" are URL search params (`?filter=unread&group=repo`). J/K, X, Enter (opens and marks read), E read, U unread, Shift+P pin/unpin, Shift+E all read; the row menu and the palette ("On this page") list them with their keys. A row that leaves the list (read in the Unread view) hands the cursor to the next one. Statuses are `notification.status` intents (offline, synced across tabs by the queue and across devices by the echo); the sidebar's count is overlay-aware (`ui.unread`, an autorun in `intents/session.ts`, so the boot route does not load the overlay). Titles come from the Issue in the pool; a notification about an issue not on this device says so. **Limit:** "Mark all read" is one intent (and one PATCH) per notification; API v1's bulk `PUT /notifications` is online-only and not an intent. Fine for hundreds; a bulk intent is a follow-up if needed.
  * **Boards (G B: the last board opened, else the list).**
    * Layout (`board.ts`): columns by (sorting, id); a card in column 0 or an unknown column is in the default one; cards by (sorting, ProjectIssue id). Pending moves are the overlay's `~board:<project>` field layers (F5's `board.move` ops), **all** of them in the order made (`Overlay.fieldLayers`), each replayed (remove the card, insert it) against the layout the earlier ones left, starting from the server's layout with every card in its server place — exactly what B9 does applying the positions one after the other (a property test checks this over random boards and move sequences). To make the server see them in that order, `chainOf(board.move)` is `b:<project>`: a board's moves are one serial queue (F5: an acked intent holds the next until its echo). `effectHeld` is always false for moves (the column does not show the position).
    * Position (B9): the index among the cards the user saw in the target column, the moved card left out (`moveTo`; gaps are counted with the card in place). B9 counts every *readable* card, also those not on this device: a repository board therefore pages the repository's closed tier in while it is open (at most `CLOSED_PAGES` = 4 pages ≈ 2000 issues; a badge says while it loads and when some stay out). The pager wakes its callers when the connection returns (`closed.ts`, a board opened offline). **Limits:** organization/user boards show cards of the repositories on this device only; older closed cards beyond the cap are not shown and do not count in positions (a card dropped next to them can land a row off until the echo). **Backend follow-up:** an anchor in `APICardMove` (`after_issue_id`) would make positions independent of what the client holds; a per-project card count would let the client say exactly what is missing.
    * Rendering: `BoardModel.concerns` recomputes only for this board's columns/cards and its issues arriving or leaving (a title edit re-renders that card alone); `columns` and `hiddenCount` are computeds with equality, each column observes `cards(columnId)` (structural equality): a move re-renders the source and target columns only (measured on 800 cards: keydown 3–6 ms). Columns are virtualized listboxes (fixed 96px card + 8px gap = `SLOT`), `aria-activedescendant` on the cursor's card, focus outline on the column (`focus-visible-within`).
    * Drag and drop (`dnd.ts`): pointer events (mouse/pen; touch scrolls — the card menu's "Move to" and the keys move without a pointer), 4px threshold, a cloned ghost (`drag-layer`) and the `DropIndicator` moved by `transform` once per frame, reads before writes, gap by arithmetic (no per-card measuring), edge auto-scroll of columns and the board, Escape or releasing outside the board cancels, the click after a drag is swallowed. Measured: frame interval p50/p95 16.7 ms (3 cards and 800 cards).
    * Keyboard (scope `board`, innermost — `L` is the next column, not labels): J/K and ↑/↓ within a column, H/L and ←/→ across, Shift+J/K/H/L or Shift+arrows move the card, Enter opens, S/A/M/P pickers on the cursor's card; labels through the card menu or the palette. Hints a deeper scope has taken are not shown (`registry.shadowed`, `activeHint`); `registry.test.ts` fails on any new key shared by scopes a view pushes together.
    * Columns (online only, `columns.ts` → B9): add (the lane after the last column), rename (`PromptDialog`), make default, move left/right (column order), delete (dialog); disabled offline with `onlineOnly`. The column arrives as a delta.
  * **Search.**
    * Local: `LocalSearch` (one per session, started when the palette opens) feeds a MiniSearch index in a dedicated worker (Comlink): title, `owner/repo`, number; prefix and typo-tolerant (`fuzzy` 0.2 above 3 letters), AND. Loaded in 5000-issue slices between yields; then the pool's changes every 250 ms — an issue is sent again only when its title, number or repository name changed, a repository's issues only when it is renamed; removals decided from the pool's state. The palette keeps F3's synchronous pool scan for exact/substring matches (same frame) and adds the index's other hits (prefixes, typos) when they arrive.
    * Server: API v1 `/repos/issues/search?q=` (titles and bodies, open and closed, every repository the viewer can read) after typing pauses 300 ms, online only; hits not already listed show under "On Forgejo" (also issues on this device that only the server matched, e.g. by their body). Answers are kept per query family (no flicker), deduped at render, and no state update happens when there is nothing new.
    * **Measured** (Chromium headless in this sandbox, `f6search` = 3 040 issues on the device, 109 keystrokes): palette scan p50 0.5 / p95 2.1 / max 5.5 ms; worker round trip p50 1.2–1.3 / p95 5.3–5.9 / max 8.7–14.9 ms; time inside the worker p50 0.5 / p95 1.7 ms. Node, 10 000 documents: < 5 ms per query. Both asserted < 16 ms (p95) in e2e. First open of the index on 3k issues ≈ 11 ms main-thread document building (now sliced).
    * Worker URL: Vite's `?worker&url` gives `/-/next/assets/…`, which B8 does not rewrite under a sub-path; `local.ts` rebases it on `config.base`. `new Worker` is a Trusted Types sink: `appWorkerURL` (trusted.ts) admits only same-origin paths below the base ending in `.js`. CSP `worker-src 'self'` allows it.
  * **Saved views.** A list page (`/issues`, `/pulls`, `/{owner}/{repo}/issues|pulls`) with its search params under a name: Shift+V or Display → "Save view…" (`PromptDialog`); in the sidebar (Views, below the workspace, loaded when idle) and the palette; the list header shows the view's name when the page matches one. Per user in localStorage (`forgejo-next:views`, the user's id inside; LOCAL_PREFS: cleared at sign-out), shared by tabs through the `storage` event. Stored views are validated like the URL (`isListPath`, `listSearch`/`myListSearch`): a stored view never navigates elsewhere. Right-click removes one. **Deviation:** local only ("synced later" per the tracker); clearing at sign-out loses them (as the user's data is).
  * **Create (C anywhere, the palette, the sidebar's New issue).** A dialog on the page's repository (else the last one used in this tab): repository, labels (status and priority are exclusive scoped labels: a second one of a scope replaces the first), assignee, milestone, title, description (`MarkdownField`); ⌘↵ creates an `issue.create` intent under a temporary id and goes to `/…/issues/new-<tempId>`, replaced by the number when it is created (F5). Drafts per repository (`text:new-issue:<repoId>`), written on close too; "Draft restored · Discard". The form is an observable model (typing re-renders the field only). **Not Linear-like yet:** bordered title, status/priority inside Labels.
  * **Composer.** `MarkdownField` = Write (CodeMirror 6; a text area stands in while its chunk loads, preloaded on idle on issue pages) | Preview (Forgejo's rendering via B9 `POST /-/sync/api/markdown`, batched: previews asked in the same task share one request per repository, ≤ 64 items; cached; through `Markdown`/`setMarkup`: Trusted Types + `scrub`; offline it says so and shows the source). ⌘↵ submits, Esc cancels (editors with a cancel), Tab leaves the editor (no trap; ⌘]/⌘[ indent), ⌘⇧P toggles the preview (handled by the field; the preview region takes focus so it toggles back). R focuses the comment box. F5's `TextEditor` plumbing (drafts, conflicts, Undo) is unchanged.
  * **Reactions and subscribing.** Reaction chips toggle the viewer's reaction (`reaction` intents, counted at once through the overlay); a menu adds one of Forgejo's eight defaults (named in words); a comment created offline gets reactions once it exists. Subscribe/unsubscribe (Shift+S, the sidebar's Notifications row) are `issue.subscribe` intents; the state follows Forgejo's `CheckIssueWatch`: a pending change, else IssueWatch, else watching the repository's issues (Watch), or taking part (poster, comment/code/review comments on this device).
  * **Shortcut map (PLAN §5.6).** New: C, G B, Shift+V, R, Shift+S, ⌘⇧P (editor), inbox E/U/Shift+P/Shift+E, board H/L and Shift+H/J/K/L. Every one is shown in a tooltip or a menu; the palette's "On this page" group lists the bound shortcuts of the active scopes (`registry.available()`, run with `registry.run()`), so page actions are also commands.
  * **Labels and milestones management views:** not in F6 (the tracker scopes them nowhere yet; PLAN §7.1 lists them under Core). Left for a later milestone.
  * **Budget.** Boot JS 146.1 / 150 KB br. F6 added ≈ 1.4 KB br to the boot route (routes, keymap, create/lastBoard, sidebar items, icons) and freed 4.6 KB by splitting Radix's focus internals (focus-scope, focus-guards, roving-focus, collection, direction, use-previous: only menus and dialogs use them) into `vendor-radix-ui-focus` (no cycle: they import the shared internals, never the reverse; boot e2e green). Lazy: CodeMirror (`MarkdownEditor` + `vendor-codemirror-*`, `vendor-lezer-*`), MiniSearch (inside `search.worker-*.js`), Comlink (Palette chunk), board, inbox, create dialog, saved views. **F7 has ≈ 3.8 KB left.**
  * **Security (review: no findings).** Previews, titles, palette results, column names, reaction contents are text or go through `setMarkup`; tested live with malicious titles/bodies under the real CSP + Trusted Types (no violation, no script). The drag ghost clones already-rendered DOM. `api.ts`: token in the header only, `credentials: 'omit'`, `redirect: 'manual'` (an opaque redirect is a failure), Idempotency-Key on writes.
  * **Tests.** Unit: `board.test.ts` (layout, default column, moves replayed in order — two cards and one card moved twice — vs a sequential server replay, `moveTo` property test, `fieldOverrides`), `inbox.test.ts`, `searchIndex.test.ts` (prefix/typo/repo/number, replace/remove, 10k docs), `server.test.ts`, `views.test.ts` (validation, per user, storage event), `preview.test.ts` (batching per repository, cache, errors), `subscribed.test.ts`, `registry.test.ts` (scope conflicts, `available/run/shadowed`), `closed.test.ts` (wake after offline). Playwright `e2e/f6.spec.ts` (forgejo project; seeds `f6` and `f6search` with `tools/seed-issues.ts`, `NEXT_E2E_SEARCH_REPO`/`NEXT_E2E_SEARCH_ISSUES` override): inbox triage with a second tab and the server; a board created through the classic UI — drag and drop seen by alice and by the classic page, drop outside cancels, plain H/L, Shift+L/H (offline too), Shift+K reorder converging card for card, column add, G B; create offline → temporary URL → comment → online → numbered URL, exactly one issue and one comment; search latencies on 3k issues, a typo, a body-only server hit; saved views (sidebar, palette, reload, remove); the composer (R, CodeMirror, preview with `<script>`/`onerror`/`javascript:` scrubbed and no dialog, ⌘↵), reactions, subscribe both ways. `e2e/offline.spec.ts`'s conflict test reads the CodeMirror text. Commands as F5 (`NEXT_FORGEJO_URL=…`, `PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`); seeding 3000 issues takes ≈ 8 min once.
  * **Reviews.** Round 1, four adversarial reviewers. Security: no findings. Correctness: 5 majors — several pending moves laid out and sent in the wrong order, positions not counting old closed cards, L opening the labels picker on a board, Tab trapped in CodeMirror, a drop outside the board still moving the card — and 11 minors (draft lost on a quick close, orphan draft per repository, inbox cursor after triage, stale index entries, palette duplicates, subscription participants, row names…); all fixed or documented. UI: 1 blocker (the same L), 8 majors (inbox rows lost their names, stale activedescendant, no arrow keys, invisible focus on empty columns, empty context menus, the Tab trap, actions missing from menus/palette, duplicated toggle styling) — fixed (Button `pressed`, PromptDialog, AgoCell, palette "On this page", row/card menus with keys, sidebar New issue); minors fixed except those listed above. Performance: 2 majors (every board change re-rendered every column; any repository change re-indexed its issues) and 5 minors (index load in one task, create dialog re-renders, palette renders, inbox re-sorts, views chunk at first paint) — fixed and re-measured. Round 2: correctness — 1 major (a board opened offline never paged the closed tier after reconnecting) + 2 minors (a card moved twice, the cap invisible) — fixed; UI — 2 majors (hints for keys an inner scope took; one global new-issue draft overriding the page's repository) + 8 minors — fixed; performance — 1 major (a board paged the whole closed tier) — capped, 1 minor fixed. Round 3 (verification of round 2): all fixed but 1 major — the replay dropped moved cards from the starting layout, so an earlier move counted with a later-moved card in its column landed a slot off (two ordinary drags) — fixed (moved cards start in their server places) with the reviewer's property as a unit test (it fails on the old code); 2 minors fixed (C right after Esc ignored while the dialog faded out: a closing overlay no longer holds the keys; switching the dialog's repository could overwrite that repository's own draft: it now comes back instead). Round 4 (verification): no blocker or major (the reviewer's 3000 random move sequences and 5000 echo-while-pending cases: 0 mismatches).
  * **For F7/F8.**
    * `MarkdownField` is the review/comment composer for F7's diff comments (pass `repoId`; `focusShortcut`); `renderPreview` batches.
    * `online()` (app/api.ts) for F7's online-only actions (merge, branches, …).
    * Workers: `appWorkerURL` admits build workers below the base; follow `local.ts` for the Shiki/diff workers (rebase the `?worker&url` on `config.base`).
    * Keymap: new scopes must keep `registry.test.ts`'s scope-conflict table true; use `activeHint` for hints in menus/palette.
    * F8: `e2e/f6.spec.ts` assumes `tools/seed-issues.ts`; the board test creates projects through the classic form (`template_type=basic_kanban`) — API v1 has no projects API. Event Timing assertions for board keyboard moves and palette typing would catch re-render regressions (the reviewers measured with a render counter).
    * Backend follow-ups (recorded above): canonical `spaRoutes` for project boards; `after_issue_id` in `APICardMove`; a per-project card count.

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
