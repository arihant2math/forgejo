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
next/tools/dev-forgejo.sh start mysql   # http://127.0.0.1:3001/  (MySQL DB `forgejo`)
next/tools/dev-forgejo.sh restart pg    # stop + rebuild + start
next/tools/dev-forgejo.sh stop pg | status pg | logs pg
NEXT_FORGEJO_EXTRA_INI=$'[livesync]\nENABLED = true' next/tools/dev-forgejo.sh restart pg
```

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
  `defer test.MockVariableValue(&testWebRoutes, livesync_router.Wrap(routers.NormalRoutes()))()`
  and use `onGiteaRun` (real listener ⇒ WebSocket hijack works). `tests/e2e/e2e_test.go`
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
  functions; updating `.deadcode-out` would be an upstream diff. Everything exported must
  be used by the binary or a test.
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
- [ ] **Status**
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
   its trigger tests against it once and record the result.
2. MySQL privileges in deployment — B2 implements both modes either way.
3. Offline PR creation stays online-only unless told otherwise.
