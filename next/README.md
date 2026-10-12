# Forgejo Next

Forgejo Next is a local-first single-page frontend for Forgejo, served by the same Forgejo binary on the same origin.
The UI reads from an in-memory object pool persisted in IndexedDB, so navigation, filtering and edits never wait on
the network. A backend module, **livesync**, captures database changes with triggers, turns them into a gap-free
sync log, and streams them to clients over a WebSocket. Writes go through Forgejo's REST API v1 behind an
idempotency layer, so offline edits to issues and pull requests can be queued and replayed safely. Pages the app does
not cover link out to the classic UI, which keeps working unchanged.

* [ARCHITECTURE.md](ARCHITECTURE.md): backend, protocol, boot, data layer, intents, workers, service worker, code
  rendering, styling.
* [lint/README.md](lint/README.md): the lint rules.
* `services/livesync/SURFACE.md`: every upstream Forgejo symbol livesync depends on.

**Stack:** React 19, `@primer/react` + `@primer/primitives` + `@primer/octicons-react`, Tailwind 4 mapped onto
Primer's tokens, TanStack Router and Virtual, react-virtuoso, MobX, Comlink workers, `@pierre/diffs` and Shiki for
code, CodeMirror 6 for markdown, MiniSearch, Vite 8 (Rolldown, Lightning CSS), Oxlint + Stylelint, `tsgo`, Vitest,
Playwright. Backend: Go, in the Forgejo tree (`models/livesync`, `services/livesync`, `routers/livesync`).

## Layout

| Path (in `next/`) | Contents |
|---|---|
| `index.html`, `vite.config.ts` | The document template (filled by `tools/vite-plugin-shell.ts`), build config, vendor chunking |
| `src/main.tsx` | Entry: `bootApp()` then one render |
| `src/app/` | Boot, config, router, session, store, shell (sidebar, header, sync indicator, notices), shortcuts, ⌘K palette, Trusted Types gate (`trusted.ts`), RUM |
| `src/auth/` | OAuth PKCE sign-in, tokens, sign-out and wipes |
| `src/data/` | Pool, entities, model catalogue, IndexedDB layout, persistence, hydration |
| `src/sync/` | Sync client, transports (WS / SSE), bootstrap/NDJSON, tabs (leader election), `openData` |
| `src/intents/` | Optimistic overlay, durable intent queue, conflict policies, 3-way merge |
| `src/code/` | Code reads by SHA, cache, diff parsing, review anchors, Pierre surfaces, highlighter driver, logs |
| `src/features/<area>/` | Pages and their logic: `issues`, `issue`, `pull`, `code`, `board`, `inbox`, `home`, `repo`, `owner`, `search`, `create`, `editor`, `meta`, `settings`, `usersettings`, `views`, `wiki`, `activity`, `new`, `my`, `auth` |
| `src/workers/` | Code (Shiki), Pierre diff parse, search (MiniSearch) workers |
| `src/sw/` | Service worker and its pure routing decisions |
| `src/styles/` | `tokens.css`, `app.css`, `base.css`, `fonts.css` (the only stylesheets) |
| `src/protocol/types.gen.ts` | Wire types generated from `services/livesync/protocol` (never edit by hand) |
| `src/test/` | Test setup, fakes (`fakeSync`, `fakeForgejo`, `fakeTabs`, `fakeSession`), `conflicts.ts`, lint fixtures |
| `src/dev/` | Dev-only pages (the hydration benchmark at `/-/next/dev/hydrate`) |
| `lint/` | Oxlint JS plugins, Stylelint plugin, their tests |
| `tools/` | Dev servers, CI runner, budget, build plugins, seeding (below) |
| `integration/` | Data layer against a real Forgejo (Vitest project `integration`) |
| `conformance/` | Headless protocol conformance suite (its own Vitest config) |
| `e2e/` | Playwright: `boot.spec.ts`, `hydrate.bench.spec.ts`, `forgejo/*.spec.ts`, shared helpers in `lib/` |

## Requirements

* Node ≥ 22.18 and pnpm (`packageManager` in `package.json`); tools run as `node tools/x.ts` (type stripping).
* Go, at the version `go.mod` asks for (for the Forgejo binary, `gen-protocol.sh`, Go tests).
* For anything against a real server: PostgreSQL 16 and/or MySQL 8, which `tools/dev-db.sh` provides.
* For browser tests: Playwright's Chromium, or a preinstalled one through `PLAYWRIGHT_CHROMIUM=<path>`.

## Develop

```sh
cd next
pnpm install
pnpm run dev            # Vite on http://127.0.0.1:5173/-/next/ (no backend: the signed-out shell)
```

Against a real Forgejo (dev server proxies everything outside the UI to it, WebSockets included):

```sh
next/tools/dev-db.sh start
NEXT_FORGEJO_EXTRA_INI=$'[livesync]\nENABLED = true\nOAUTH_REDIRECT_URIS = http://127.0.0.1/-/next/callback' \
  next/tools/dev-forgejo.sh restart pg          # http://127.0.0.1:3000/, admin dev / devdevdev1
cd next && NEXT_FORGEJO_URL=http://127.0.0.1:3000 pnpm run dev
```

Serving the build from Forgejo itself (as in production): `pnpm run build`, then start Forgejo with
`[livesync] ASSETS_DIR = <repo>/next/dist` (it must exist at start). Opt a browser in at `/-/next/opt-in` (or the
"Forgejo Next" pill on classic pages, which `dev-forgejo.sh` installs) and open any supported URL. To compile the
build into the binary instead, copy `next/dist` to `routers/livesync/next_dist` and build with `-tags livesync_embed`.

Under a sub-path: give the MySQL dev instance (:3010) `ROOT_URL = http://127.0.0.1:3011/git/` and put
`node tools/subpath-proxy.ts 3011 3010 git` in front. Large data: `node tools/seed-issues.ts --repo big --issues 10000` (`--plain` for titles/bodies only).

### Scripts (`pnpm run …` in `next/`)

| Script | Does |
|---|---|
| `dev` / `build` / `preview` | Vite dev server (:5173), production build to `dist/`, preview of the build (:4173, with a stand-in config block) |
| `lint` | `lint:js` (Oxlint, type-aware, `--deny-warnings`, plugins in `lint/`) + `lint:css` (Stylelint on `src/**/*.css`) |
| `typecheck` | `tsgo` on `tsconfig.json` (browser code) and `tsconfig.node.json` (tests, tools, lint, e2e, conformance, configs) |
| `test` | Vitest projects `unit` (Node) and `unit-dom` (jsdom) |
| `test:watch` | Vitest in watch mode |
| `test:integration` | Vitest project `integration` (needs `NEXT_FORGEJO_URL`, skipped without) |
| `test:conformance` | The conformance suite (needs `FORGEJO_URL`; normally run through `dev-forgejo.sh conformance`) |
| `test:browser` | Playwright (all projects) |
| `budget` | `node tools/budget.ts`: boot-route size budgets on `dist/` |
| `check:cheap` | `lint`, `typecheck`, `build` |
| `check` | `check:cheap`, then `test` and `budget` |

### Tools (`next/tools/`)

| Tool | Does |
|---|---|
| `dev-db.sh {start\|stop\|status\|env\|reset} [pg\|mysql\|mariadb\|all]` | Throwaway PostgreSQL 16 (:5432) and MySQL 8 (:3306, binlog on; `NEXT_MYSQL_BINLOG=off` for off) under `/var/tmp/forgejo-next-db`; MariaDB 11 (:3307, docker) is opt-in. Accounts `forgejo/forgejo` (no SUPER) and a superuser. `eval "$(next/tools/dev-db.sh env)"` exports Forgejo's `TEST_PGSQL_*` / `TEST_MYSQL_*` variables |
| `dev-forgejo.sh {start\|stop\|kill\|restart\|status\|build\|logs} [pg\|mysql]` | Builds this tree and runs a dev Forgejo: pg on :3000, mysql on :3010, admin `dev` / `devdevdev1`; `NEXT_FORGEJO_EXTRA_INI` appends app.ini lines. `kill` simulates a crash |
| `dev-forgejo.sh conformance [pg\|mysql\|all] [vitest args]` | Fresh instances (:3020 / :3030) with livesync; runs `conformance/` against each |
| `dev-forgejo.sh e2e [pg\|mysql\|all] [playwright args]` | Fresh instances (:3040 / :3050) with livesync, Actions and metrics, serving this checkout's `next/dist` (built first); runs the Playwright `forgejo` project |
| `ci.sh [steps…]` | Every check (below), with a summary and perf report |
| `gen-protocol.sh [--check]` | Regenerates `src/protocol/types.gen.ts` from `services/livesync/protocol` (tygo, `tools/tygo.yaml`); `--check` fails when stale |
| `budget.ts` | Bundle budgets (below) |
| `boot.ts` | `BOOT_ROUTES`: modules the boot route renders (preloaded and counted); `ON_DEMAND`: assets the service worker caches on first use |
| `seed-issues.ts` | Seeds a repository with labels, milestones, a second user, issues and comments |
| `subpath-proxy.ts` | Serves a dev Forgejo under a sub-path, like a reverse proxy |
| `vite-plugin-shell.ts` | Fills `index.html`: splash script, static boot shell, inlined CSS (minus `theme`-layer custom properties nothing reads), boot modulepreloads, a preload of the body font |
| `lightningcss-color-mode.ts` | Drops Primer's `[data-color-mode=auto]` rules, which never match (the app resolves the mode itself) |
| `vite-plugin-sw.ts` | Builds `dist/sw.js` with the build's version and asset list (`NEXT_SW_KILL=1`: a self-unregistering worker) |
| `vite-plugin-primer-layer.ts` | Wraps every `@primer/react` stylesheet in the `primer` cascade layer |
| `vite-plugin-preview-config.ts` | Gives `vite preview` the server's config block |

Every local instance gets its own work dir and internal socket, so dev, conformance and e2e instances can run side
by side. When running as root, `dev-db.sh env` also exports `GITEA_I_AM_BEING_UNSAFE_RUNNING_AS_ROOT=true`, which
Forgejo's tests and binary need.

## Test

| Suite | Command | Notes |
|---|---|---|
| Unit | `pnpm test`, or `pnpm exec vitest run <path>` | `*.test.tsx` run in jsdom (`unit-dom`); `*.test.ts` in Node unless they start with a `// @vitest-environment jsdom` docblock. Includes `tools/**` and `lint/**` tests. Long property run: `CONVERGE_RUNS=3000 pnpm exec vitest run src/intents/converge.test.ts` |
| Integration | `NEXT_FORGEJO_URL=http://127.0.0.1:3000 pnpm run test:integration` | Needs a Forgejo with livesync enabled |
| Conformance | `next/tools/dev-forgejo.sh conformance all` | `conformance/*.test.ts`: protocol (bootstrap → live → reconnect), permissions and revocation purge, idempotent replay, gap endpoints, log tails, the real sync client, crash/restart; on PostgreSQL and MySQL. Also runs in Go as `TestLivesyncConformance` (minus the restart scenario) |
| Browser (no server) | `pnpm exec playwright test --project build --project dev` | `build`: `boot.spec.ts` against `vite build && vite preview`; `dev`: the hydration benchmark against the dev server |
| End to end | `next/tools/dev-forgejo.sh e2e all [--grep …]` | `e2e/forgejo/*.spec.ts`, one worker; multi-user, multi-tab, offline, permission changes, service-worker update and kill switch, perf assertions, RUM |
| Link crawler | `next/tools/ci.sh crawl` | `crawl.spec.ts` (`@crawl`): clicks through the app and fails on dead ends, unmarked exits to classic pages, console errors and HTTP errors |
| Go unit | `go test -tags 'sqlite sqlite_unlock_notify' ./services/livesync/... ./routers/livesync/...` | Livesync disables itself on SQLite: trigger/outbox behaviour needs the integration harness |
| Go integration | `eval "$(next/tools/dev-db.sh env)"; make 'test-pgsql#TestLivesync'` (and `test-mysql#…`) | `tests/integration/livesync_*_test.go`; PostgreSQL runs with a non-default `[database] SCHEMA` |

Against an already running server: `NEXT_E2E_NO_SERVERS=1 NEXT_FORGEJO_URL=… pnpm exec playwright test --project
forgejo --no-deps`. That server needs `ASSETS_DIR` = this checkout's `next/dist`, `[actions] ENABLED`,
`[metrics] ENABLED` and the admin `dev` / `devdevdev1`.

**Writing Go integration tests:** use the helpers in `tests/integration/livesync_helpers_test.go`
(`livesyncConfig`, `livesyncInstallCapture`, `livesyncStart`, `livesyncServe`, `livesyncWaitLog`, `livesyncSettle`, …)
and `livesyncDial` (`livesync_hub_test.go`) for a raw protocol client. Fixture reloads (`PrepareTestEnv`, also inside
`onApplicationRun`) fire the capture triggers, so tests install triggers themselves and remove them in cleanup; call
`livesyncServe` before `onApplicationRun` and do not nest `PrepareTestEnv`. A `log.Error` during a test is printed as
`FATAL ERROR` by the harness's logger (it does not fail the test yet): keep tests free of expected errors.

**`tools/ci.sh`** runs the steps `install` (`pnpm install --frozen-lockfile`), `check`, `protocol`
(`gen-protocol.sh --check`), `browser`, `conformance`, `e2e` (without the crawler) and `crawl`. Every step runs even
after a failure; it exits 1 if any failed. Logs and `perf.jsonl` go to `$NEXT_CI_OUT`. `ci.sh check e2e` runs only
the named steps; `NEXT_CI_DBS=pg` limits the databases; `CI=1` is exported, so a stray `.only` fails.

| Variable | Effect |
|---|---|
| `NEXT_FORGEJO_URL` | The Forgejo for `pnpm run dev`'s proxy, integration and e2e tests |
| `NEXT_FORGEJO_EXTRA_INI` | Extra app.ini lines for `dev-forgejo.sh` |
| `PLAYWRIGHT_CHROMIUM` | A Chromium executable for Playwright |
| `NEXT_E2E_NO_SERVERS` | Playwright starts no web servers (run against what is up) |
| `NEXT_E2E_KEEP`, `NEXT_E2E_NO_BUILD` | Keep the e2e instance running; reuse the binary and `dist/` |
| `NEXT_E2E_STRICT_FPS` | Assert no frame > 32 ms in the 5k-line scroll (real hardware) |
| `NEXT_E2E_PERF_OUT` | Where perf samples are appended |
| `NEXT_CI_OUT`, `NEXT_CI_DBS`, `NEXT_CI_NO_INSTALL` | `ci.sh` output dir, databases, skip install |
| `CONVERGE_RUNS` | Runs of the intent convergence property (default 60) |
| `NEXT_SW_KILL` | Build a self-unregistering service worker |

## Budgets and performance targets

`tools/budget.ts` (`pnpm run budget`, part of `check`) measures what `dist/index.html` executes or preloads, brotli
q11, 1 KiB = 1024 B:

| Budget | Limit |
|---|---|
| Boot-route JS (inline scripts, entry, every modulepreload) | 500 KiB |
| Boot-route CSS (inline `<style>` + linked sheets) | 48 KiB, of which inline 32 KiB |
| Service-worker precache (every asset but `ON_DEMAND`) | 1.5 MiB in total; no single file over 512 KiB raw |

It also fails when a chunk in the static closure of the entry or of a `BOOT_ROUTES` module is not preloaded, when
such a chunk has CSS of its own, on any import cycle between chunks, and on raw colours or `all`/layout transitions
in the built CSS. The JS limit is a ceiling, not an allowance: keep new code off the boot route (lazy views, lazy
chunks, idle loading).

`e2e/forgejo/perf.spec.ts` asserts the runtime targets against the real server (thresholds in its header):

| Target | Asserted |
|---|---|
| Served boot JS / CSS | ≤ `BUDGET` |
| Warm boot → interactive issue list, online and offline | median of 8 < 300 ms, no bootstrap fetched |
| Local mutation, key → DOM | median of 10 < 16 ms, before the server answers; next frame p95 < 33 ms |
| A commit reaches another client | p95 of 20 < 150 ms, every one arrives |
| Switch to a cached file | p50 and p90 of 15 < 100 ms, nothing fetched |
| Scroll a 5k-line PR diff | median run p50 < 20 ms, p95 < 34 ms, ≤ 3 % frames > 32 ms; 2 of 3 runs without a long task ≥ 50 ms |

Perf numbers are only meaningful on a quiet machine. `localStorage.profile = '1'` renders through React's profiling
build and records every commit as a `react:commit` measure.

## Rules

These bind every change to `next/` and livesync. Lint and tests enforce most of them.

### Data and performance

* Views read from the pool (`useApp()`, `pool.model(…).get/by/all`), never fetch-in-effect for synced data.
  `observer()` leaf components take ids or stable model refs; a component observes only the fields it renders.
* Pool indexes are declared in `src/data/models.ts`. Treat entity data as immutable wire DTOs.
* Writes to synced data are intents (`editing(app).intents.submit`), never direct API calls; online-only actions
  use `online()` and are disabled offline with `onlineOnly()`. Nothing the user typed is ever dropped silently:
  failures become drafts.
* Virtualize every list that can exceed ~50 rows (TanStack Virtual; react-virtuoso for timelines). Fixed row heights
  come from tokens so lists virtualize without measuring.
* No spinners for local data; the first frame after navigation shows content or a skeleton of the right shape.
* Keep the boot route small: new views are `lazyView`s, heavy dependencies load lazily, heavy work (highlighting,
  diff parsing for Pierre, search indexing) runs in workers.
* Every network request has a deadline and the network epoch's signal (`sync/net.ts`).
* Build every URL from the config's `app_sub_url` / `base` (`app/config.ts`); never concatenate `/-/next`.
* Wire shapes come only from `src/protocol/types.gen.ts`. After changing `services/livesync/protocol`, run
  `tools/gen-protocol.sh` and commit the result.
* IndexedDB layout changes bump `IDB_VERSION`; never drop `intents` or `drafts`.

### Styling

* Compose `@primer/react` components (and `@primer/react/experimental`). Never restyle one: `className` on a Primer
  component is for layout only (margins, sizes, flex/grid placement, position, `sr-only`, `truncate`); no `style`, no
  look classes, no spread of `className`/`style`. Size comes from the component's own props.
* Where Primer has no component (a board column, a dense issue row, a code line), compose Primer parts with Tailwind
  layout utilities in the feature folder.
* Colours, type, spacing, sizes, radii, shadows, z-index and motion exist only in `src/styles/tokens.css`. Use its
  utilities or `var(--…)`; need a new value? Add a token. No hex or named colours, no arbitrary values (`bg-[#fff]`,
  `p-[13px]`), no off-scale spacing, no `dark:` (themes swap tokens), no colour `/` modifiers.
* Stylesheets live only in `src/styles/` (and `src/dev/`). Plain CSS uses tokens; raw values are allowed only in
  `tokens.css`.
* Motion: appear instantly, fade out over `--speed-out` (150 ms). Only `transform`, `opacity` and colours animate. The
  `interactive` utility in `app.css` is the only transition; `@keyframes` animate only transform and opacity.
  `prefers-reduced-motion` drops exit animations.
* Router links are `RouterLink` / `RouterLinkButton` / `RouterNavItem` from `src/app/routerLinks.tsx`. Exits to the
  classic UI use `ClassicLink` / `ClassicMenuItem` (marked `data-classic`).
* Icons are Octicons; rendered markdown uses Primer's `markdown-body` styles.

### Security

* The SPA document enforces Trusted Types with one policy (`forgejo-next`, `src/app/trusted.ts`). Server HTML goes
  through `setMarkup` / `textOfMarkup` (allowlist scrub); no `innerHTML`, `outerHTML`, `insertAdjacentHTML` or
  `DOMParser` elsewhere. Workers are created through `appWorkerURL`.
* Requests send the token in the `Authorization` header only (never in URLs or cookies) with `credentials: 'omit'`;
  API writes use `redirect: 'manual'` and carry `Idempotency-Key`. No third-party origins. The document sends no
  `Referer` (`no-referrer`), so the OAuth code in the callback URL never leaks.
* User content (titles, file names, logs, commit messages) renders as text, never markup.

### Keyboard and UI

* Every action is reachable from the shortcut registry (`src/app/shortcuts/keymap.ts` is the one table) and ⌘K.
  Bind with `useShortcut(id, run)` inside a `useShortcutScope(…)`; `registry.test.ts` fails on keys shared by scopes
  that are active together. Hints come from the keymap (`shortcutHint`).
* Destructive actions confirm or offer Undo.
* Every app page has a canonical URL; links are real anchors (middle-click works).

### Testing

* Tests sit next to the code (`x.ts` → `x.test.ts`). DOM-dependent `.ts` tests start with a
  `// @vitest-environment jsdom` docblock (`vitest.config.ts` runs them in the `unit-dom` project).
* Data-layer and intent changes need tests against the fakes in `src/test/` and keep the property tests
  (`pool.test.ts`, `converge.test.ts`, `idb.test.ts`) green.
* Bug fixes come with a regression test that fails on the old code.
* `src/styles/classes.test.ts` compiles every class in `src/` against the theme and runs Tailwind's scanner over the
  shipped CSS; `src/test/conflicts.ts` fails when an element sets the same property twice.
* e2e specs clean up what they create (repositories, toggled settings) and must pass on PostgreSQL and MySQL.
* Before committing: `pnpm run lint && pnpm run typecheck` and the affected tests; `pnpm run check` for anything
  touching the build or the boot route.

### Backend and fork

* New code goes in the livesync directories (`models/livesync`, `services/livesync`, `routers/livesync`,
  `tests/integration/livesync_*_test.go`) and `next/`. Keep edits to upstream files minimal and mechanical; the entry
  point is the `Wrap` line in `cmd/web.go`. Never touch the root `package.json`, `web_src/`, `webpack.config.ts` or
  `modules/setting`. Record every upstream symbol livesync starts or stops using in `services/livesync/SURFACE.md`.
* Root tooling does not know `next/`: upstream's `make lint-js` would lint it with the root ESLint config, so run
  upstream's JS lint as `npx eslint --max-warnings=0 --ignore-pattern 'next/'`. `next/` is checked only by its own
  scripts.
* Read typed models, write through API v1 or service-layer functions; gap endpoints call service-layer functions
  only and each has an integration test.
* `[livesync]` keys are read only in `services/livesync/settings.go`, each with a default and a comment.
  `ENABLED` defaults to false.
* Triggers reference only `id`. Livesync tables declare no foreign keys to upstream tables. Correctness-critical
  reads (outbox, lease) use the master engine.
* Payloads in shared groups are viewer-independent; viewer-specific facts go in the user's own group.
* Respect `setting.AppSubURL` in every path `Wrap` matches.
* Go style is Forgejo's (`.golangci.yml`): gofumpt, `forgejo.org/modules/json` (never `encoding/json`),
  `X_model` / `X_service` import aliases, logging through `forgejo.org/modules/log`, no dead code (`make lint-go` runs
  `deadcode`: every function must be reachable from the binary, use in tests does not count).
* Before committing Go: gofumpt and golangci-lint clean, `go vet`, unit tests, and `TestLivesync*` green on both
  PostgreSQL and MySQL.
* Every new file starts with the license header: `Copyright 2026 The Forgejo Authors. All rights reserved.` and
  `SPDX-License-Identifier: GPL-3.0-or-later`.
* Commits: `next: …` (frontend) or `livesync: …` (backend), imperative, with a short body saying what and why.
