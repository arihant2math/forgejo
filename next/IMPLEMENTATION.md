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
    - **Backpressure**: per-session queue bounded by `SEND_BUFFER` bytes, **live changes and control messages** (review round 1: pongs,
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
      is held; ≤ 16 pending.
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
  - **Settings added:** `SEND_BUFFER` (4194304 bytes, changes + control messages), `MAX_SUBSCRIPTIONS` (1000),
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
      holds), `pong` (`position()` reads the holds under `conn.mu`; queued after `group_revoked` now). **Residual, by design:** a writer
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
- [ ] **Status**
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
    `org:` the org's profile, memberships, teams (+ users/repos/units), org labels, org projects/columns.
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
    4. *(major) referenced org groups left partial.* Contract: an embedded profile line only adds the entity — it is no bootstrap of its
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
      fixed); the closed-page cost (item 2); org labels of organizations the viewer may not see (item 4).
    - **Commands run (round 1):** gofumpt (clean), `golangci-lint run ./services/livesync/... ./routers/livesync/... ./models/livesync/...
      ./tests/integration/...` (0 issues), `go vet` (+ integration with sqlite tags), deadcode diff (clean), livesync unit tests with
      `-race` (every package but `capture`, which needs a real DB), `next/tools/gen-protocol.sh --check` (regenerated: `before`,
      `repo_owner`, doc comments), `TestLivesyncBootstrapConvergence` 5× PG / 3× MySQL, and `./integrations.pgsql.test -test.run
      'TestLivesync|TestVersion'` on PG 16 (`gtestschema`: 35 pass, 3 MySQL-only skips) and MySQL 8.0 binlog on (37 pass, 1
      skip), no testlogger "FATAL ERROR". No `go.mod` change; fork diff unchanged (`assets/go-licenses.json`, `cmd/web.go`, `go.mod`,
      `go.sum`). The first full PG run failed once in the convergence test: a fixture reload resets id sequences, so the paused
      phase's comment reused the id of a comment an earlier test created (its reload delete was in the log); the check now reads
      the log from a cursor taken before the pause (`9da58e8`).
  - **Sandbox note:** the root filesystem reports little free space (≈ 0.3 GB at one point although only 39 GB of 252 GB were used:
    the host disk is shared). Leftover `/tmp/prepared-forgejo*` / `/tmp/appdata*` dirs of killed unit-test runs (≈ 2.4 GB) and MySQL
    binary logs (the large bootstrap test writes ≈ 0.7 GB per MySQL run) were the reclaimable part: `rm -rf /tmp/prepared-forgejo*`,
    `FLUSH BINARY LOGS; PURGE BINARY LOGS TO '<newest>'`. A full disk shows up as `collect2: ld returned 1 exit status` / `[build failed]`.

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
