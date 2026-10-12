# Forgejo Next — architecture

How Forgejo Next works: the `livesync` backend inside the Forgejo binary, and the local-first SPA in `next/`.
[README.md](README.md) covers running, testing and the rules.

```
 Browser (one leader tab per user, Web Locks)                  Forgejo
┌──────────────────────────────────────────────┐   ┌───────────────────────────────────────────────────┐
│ React 19 views (observer leaves)             │   │ cmd/web.go: livesync_router.Wrap(NormalRoutes())  │
│ MobX pool  ◄─ intents overlay (optimistic)   │   │  ├─ /-/sync/ws | sse+send   sync sessions (hub)   │
│   ▲            durable queue in IndexedDB    │WS │  ├─ /-/sync/bootstrap|load|workspace  NDJSON      │
│ Sync client ── IndexedDB (entities, meta,    │◄─►│  ├─ /-/sync/api/*           gap endpoints         │
│   intents, drafts, blobs)                    │   │  ├─ /api/v1/* + Idempotency-Key → dedupe, echo    │
│ BroadcastChannel ⇄ follower tabs             │   │  │     X-Livesync-Sync-Id, pass to API v1         │
│ Service worker: precache, offline shell      │   │  ├─ /-/next/*   the SPA build, config, opt-in     │
│ Workers: code (Shiki), pierre (diffs),       │   │  └─ everything else → upstream Forgejo            │
│   search (MiniSearch)                        │   │ triggers → livesync_change → materializer         │
└──────────────────────────────────────────────┘   │   → livesync_log (syncId) → tailers → hubs        │
                                                   └───────────────────────────────────────────────────┘
```

Two kinds of data:

* **Mutable metadata** (issues, PRs, labels, milestones, projects, comments, reviews, notifications, branches,
  releases, statuses, action runs, repositories, users, orgs, teams) goes through the sync engine.
* **Immutable git content** (trees, blobs, diffs between two SHAs, blame) is addressed by SHA and cached forever
  (HTTP `immutable`, IndexedDB `blobs`, service worker). Only ref → SHA is mutable, and that comes from the synced
  `Branch` / `Release` entities, so "latest" resolves locally, offline too.

## Backend: livesync

| Path | Contents |
|---|---|
| `models/livesync/` | Own tables (`livesync_change`, `livesync_log`, `livesync_entity`, `livesync_meta`, `livesync_idempotency`), created with `x.Sync` at init (not Forgejo migrations); the writer lease |
| `services/livesync/` | `Init`, settings (`settings.go`), writer role, permission glue; `SURFACE.md` lists every upstream symbol livesync relies on |
| `services/livesync/capture` | Trigger DDL per dialect, installer/repair, outbox reader, doorbell, hole tracking |
| `services/livesync/catalog` | Every upstream table classified as tracked (with its group resolver and tier) or ignored |
| `services/livesync/materialize` | Row → viewer-independent DTO, coalescing, permission epochs, markdown rendering |
| `services/livesync/synclog` | Append, read-since, retention, cross-instance tailer |
| `services/livesync/perm` | Grants per user (group → units), cache, epochs and touches |
| `services/livesync/hub` | Sessions, subscriptions, replay, fan-out, backpressure, Actions log tails; WebSocket and SSE |
| `services/livesync/bootstrap` | Snapshot streaming, workspace |
| `services/livesync/idempotency` | `Idempotency-Key` store, replay, crash-window dedupe, sync-id wait |
| `services/livesync/protocol` | Wire types; TypeScript generated into `next/src/protocol/types.gen.ts` |
| `services/livesync/oauthapp` | The SPA's first-party public OAuth2 client |
| `services/livesync/{actionslog,pullmerge,metrics}` | Log tails, merge helpers, Prometheus metrics |
| `routers/livesync/` | `Wrap`, route table (`routes.go`), sync endpoints, gap endpoints (`api*.go`), SPA serving (`spa*.go`), admin page, classic-UI integration (`classic*.go`) |
| `tests/integration/livesync_*_test.go` | DB-backed tests (`TestLivesync*`) |

### Entry point

`cmd/web.go` serves `livesync_router.Wrap(routers.NormalRoutes())`. `Wrap` runs `livesync.Init` once:

* `ENABLED = false`, SQLite, or invalid settings → `Wrap` returns the upstream handler unchanged (when disabled it
  also removes capture triggers left by an earlier run).
* Enabled but `Init` fails (triggers missing or stale, …) → classic UI plus the admin page and the health check
  (degraded mode; the admin page shows the DDL to install).
* Otherwise `Wrap` serves `/-/sync/*` and `/-/next/*` itself, serves the SPA document to opted-in browsers on the
  routes it supports, runs API v1 writes that carry an `Idempotency-Key` through the idempotency layer, and passes
  everything else to upstream. `/-/sync/ws` and `/-/sync/sse` are dispatched before Forgejo's middlewares (which hide
  `Hijack`); other endpoints use `common.ProtocolMiddlewares()`.

### Change capture

* Per-row `AFTER INSERT/UPDATE/DELETE` triggers on every tracked table write `(tbl, row_id, op)` into
  `livesync_change` in the writing transaction. **Triggers reference only `id`**, so upstream column migrations can
  never break a write; "which columns changed" is never decided in a trigger.
* PostgreSQL: one `plpgsql` function, schema-qualified DDL (respects `[database] SCHEMA`). MySQL: generated triggers,
  no `DEFINER`, deterministic. With binary logging on, MySQL needs `SUPER` or `log_bin_trust_function_creators=1`
  to create triggers.
* `INSTALL_MODE = auto` creates/repairs triggers at start and every `TRIGGER_CHECK_INTERVAL`; `verify` only checks
  and `/-/sync/admin` prints the DDL for a DBA. Missing or stale triggers ⇒ livesync refuses to serve.
* Deletes are scoped through `livesync_entity` (row → group), so triggers need no `repo_id`. Forgejo cascades in Go,
  not with DB `ON DELETE CASCADE`; a contract test asserts tracked tables have no DB-level cascades.
* Doorbell: an observer of the master engine's statements rings after each COMMIT/DML; polling (`POLL_INTERVAL`,
  100 ms) is the safety net and the cross-instance path. Ids are assigned at insert, not commit: the reader tracks
  holes below its high-water mark for up to `HOLE_TIMEOUT`.
* Every upstream table is tracked or explicitly ignored (`catalog`); `CheckCatalog` at init and
  `TestLivesyncCatalogContract` fail on unclassified or vanished tables.

### Materializer and sync log

* One writer instance (PostgreSQL advisory lock / MySQL `GET_LOCK`) reads the outbox, coalesces by `(tbl, row_id)`,
  loads rows through Forgejo's typed models, and appends `(sync_id, group, model, entity_id, op, payload, schema)` to
  `livesync_log`. `sync_id` is gap-free and monotonic. Every instance tails the log (PostgreSQL also `NOTIFY` /
  `LISTEN`) and fans out to its own sessions.
* Hot tables (`notification`, `commit_status`, `action_run_job`) are materialized at most once per `HOT_COALESCE`.
* **Viewer independence:** a payload in a shared group never depends on who reads it. Viewer-specific facts live in
  the user's own group.
* **Groups:** `user:{id}`, `org:{id}`, `team:{id}`, `repo:{id}`, `issue:{id}` (lazy tier: comments, reviews,
  reactions, timeline), `owner:{id}`, `profile:{id}`, `profiles:public|limited`. Each entity is in exactly one
  group; repo-scoped entities also carry the unit (`issues`, `pulls`, `code`, `actions`) they need.
* Retention: `LOG_RETENTION` / `LOG_MAX_ROWS`; a client behind it gets `bootstrap_required`.

**Scale invariants** (keep them, so running more instances stays additive):

* The database is the only durable state (sync log, idempotency records); hubs rebuild from it and from grants.
* One writer, many tailers: a single instance runs both roles in one process.
* Fan-out is indexed by group: per-entry cost is O(subscribers of that group), per-session memory O(its groups);
  nothing loops over all sessions.
* Snapshots are viewer-independent, so a `(group, watermark)` bootstrap could be cached and shared.
* Everything is bounded: send buffers, replay windows, subscriptions and connections per user.

### Permissions

* `perm` computes a user's grants (group → units) from Forgejo's own permission code, cached per user
  (`PERM_CACHE_TTL` safety net).
* Changes to permission tables (`access`, `collaboration`, `team*`, `org_user`, `repository`, `repo_unit`, `user`,
  `forgejo_blocked_user`) bump epochs for the affected users/repos; sessions recompute grants. A lost grant sends
  `group_revoked`: the client purges the group from memory and IndexedDB and fails its queued intents to drafts.
* Because triggers carry no columns, an update to a busy permission row (`repository`, `user`) that leaves the
  stored state unchanged is a **touch** carrying the row's permission fingerprint; cached grants computed from another
  fingerprint are re-checked. This catches a change undone before the materializer read the row.
* Public repositories outside the workspace are subscribed on demand only; admins get no implicit subscriptions.

### Protocol and transport

WebSocket at `/-/sync/ws` (`coder/websocket`, JSON frames). The same protocol runs over SSE (`/-/sync/sse`) +
`POST /-/sync/send` for proxies that break WebSockets.

| Direction | Messages |
|---|---|
| client → server | `hello`, `subscribe`, `unsubscribe`, `barrier`, `ping`, `log_tail`, `log_untail` |
| server → client | `welcome`, `subscribed`, `delta`, `caught_up`, `bootstrap_required`, `group_revoked`, `barrier_ok`, `session_invalid`, `notice`, `pong`, `grants`, `resume_from_cursor`, `error`, `log`, `log_closed`; over SSE first `session` (the id `POST /-/sync/send` uses) |

* The bearer token goes in `hello`, never the URL. Sessions are re-validated every `SESSION_CHECK_INTERVAL`.
* Deltas carry full entity states with version `v = sync_id`; a state is applied only if newer, so overlaps between
  bootstrap and stream are harmless.
* Limits: `SEND_BUFFER`, `DRAIN_TIMEOUT` (slow readers get `resume_from_cursor`), `MAX_SUBSCRIPTIONS`,
  `MAX_CONNECTIONS_PER_USER`, `MAX_REPLAY`.

### HTTP endpoints

| Endpoint | Purpose |
|---|---|
| `GET /-/sync/bootstrap?group=…[&model=…]` | Brotli NDJSON: a `{watermark, schema}` line, then entities. The watermark is read before the snapshot. A repo's summary tier is open items plus those updated within `SUMMARY_RECENCY`; older closed items page in on demand |
| `GET /-/sync/load?group=issue:N` | The lazy tier of one issue/PR |
| `GET /-/sync/workspace` | Repositories kept hot (owned, collaborating, team, watched; at most `WORKSPACE_MAX_REPOS`) |
| `GET /-/sync/grants`, `/-/sync/health` | Grants; health check |
| `POST /-/sync/rum` | Anonymous RUM reports → Prometheus counters |
| `GET /-/sync/admin` | Site-admin status page (triggers, lag, DDL) |
| `/-/sync/api/*` | Gap endpoints for what API v1 lacks: projects, columns and card moves; conflict-checked issue/comment body edits (`expected_version` → 409); review-thread resolve; PR viewed files; issue project; merge check; SHA-addressed tree/raw/blob/blame/diff (`Cache-Control: immutable`); code search; activity and contributors; markdown preview and file markup; workflows; artifacts; attachments; user options. Registered in `routers/livesync/api.go` |

### Writes

Clients write through **API v1** with their OAuth2 token, so Forgejo keeps validation, permissions, notifications,
webhooks and mail. Every client write carries `Idempotency-Key`; `Wrap` intercepts it:

1. Reserve `(user, key)` in `livesync_idempotency`. Completed ⇒ replay the stored response; in flight ⇒ `409` with
   `Retry-After`.
2. Run the unchanged API v1 handler in-process with a buffered response.
3. Wait (≤ `IDEMPOTENCY_SYNC_WAIT`) until the materializer has passed the write, then set `X-Livesync-Sync-Id`. The
   client drops its optimistic layer once its pool reaches that id: no flicker, no extra round trip.
4. Store status, body and sync id for `IDEMPOTENCY_TTL`. Creates found in flight after a crash are deduplicated
   against recent identical entities by the same user.

### Auth

`oauthapp` keeps one public OAuth2 client (PKCE required, redirect `{AppURL}-/next/callback`, plus
`OAUTH_REDIRECT_URIS` for dev servers) with scope
`write:issue write:repository write:user write:organization write:notification`. The SPA's own exact sign-in request
skips the consent page (`routers/web/auth/oauth.go`). The SPA keeps the access token in memory and the refresh token
in IndexedDB.

### Serving the SPA

* The build (`next/dist`) is served from `[livesync] ASSETS_DIR`, or embedded with the `livesync_embed` build tag
  (copy `next/dist` to `routers/livesync/next_dist` first). Assets under `/-/next/assets/*` are `immutable`; the
  service worker is `/-/next/sw.js` with `Service-Worker-Allowed` for the site.
* **Opt-in:** `/-/next/opt-in` / `/-/next/opt-out` set or clear the `ui` cookie. With it, document navigations
  (`Sec-Fetch-Dest: document`) to routes in `spaRoutes` (`routers/livesync/spa.go`) get the SPA document; everything
  else falls through to the classic UI. `?ui=classic` forces the classic page. Classic pages get a "Forgejo Next"
  pill through `classic_header.tmpl` (installed as `custom/templates/custom/header.tmpl`) and `/-/next/classic.js`.
* The document carries the config block (`protocol.NextConfig`), a strict CSP (`script-src 'self'` + hashes of the
  inline scripts, `require-trusted-types-for 'script'`, one Trusted Types policy), and `Link: rel=modulepreload`
  headers for the route's view chunk from Vite's manifest (`spa_preload.go`).
* Under a Forgejo sub-path the server rewrites the build's exact `/-/next/` literals; client code builds every URL
  from the config's `app_sub_url` / `base`.

### Settings (`[livesync]`)

Parsed only in `services/livesync/settings.go` (`modules/setting` is untouched). Every key has a default and a doc
comment there.

| Key | Default | |
|---|---|---|
| `ENABLED` | `false` | Master switch |
| `INSTALL_MODE` | `auto` | `auto` \| `verify` |
| `ASSETS_DIR` | — | The SPA build to serve |
| `OAUTH_REDIRECT_URIS` | — | Extra redirect URIs (dev servers) |
| `POLL_INTERVAL`, `HOLE_TIMEOUT` | 100 ms, 30 s | Outbox reader |
| `LOG_RETENTION`, `LOG_MAX_ROWS` | 720 h, 1 000 000 | Sync log trimming |
| `HOT_COALESCE` | 1 s | Hot-table coalescing |
| `PERM_CACHE_TTL` | 10 m | Grant cache safety net |
| `SEND_BUFFER`, `DRAIN_TIMEOUT` | 4 MiB, 5 s | Per-session backpressure |
| `MAX_SUBSCRIPTIONS`, `MAX_CONNECTIONS_PER_USER`, `MAX_REPLAY` | 1000, 16, 10 000 | Per-user limits |
| `SESSION_CHECK_INTERVAL` | 5 m | Token/account re-check |
| `SUMMARY_RECENCY`, `WORKSPACE_MAX_REPOS` | 2160 h, 200 | Bootstrap scope |
| `IDEMPOTENCY_TTL`, `IDEMPOTENCY_SYNC_WAIT` | 168 h, 2 s | Idempotency layer |
| `TRIGGER_CHECK_INTERVAL` | 1 m | Trigger health check/repair |
| `LOG_TAIL_INTERVAL` | 1 s | Actions log tail polling |

Metrics go to Forgejo's `/metrics` (`[metrics] ENABLED = true`).

## Frontend: `next/`

### Boot

Goal: the first frame comes from local knowledge, online or offline, before any network request.

1. `index.html` (built by `tools/vite-plugin-shell.ts`) declares the cascade-layer order, then inlines the splash
   script (`src/app/splash.ts` `applySplash`): `performance.mark('appStart')`, then `localStorage.splash` → `<html>`:
   colour mode (`data-color-mode`), sidebar width/collapse, `data-shell="app|logged-out"` (from the local DB marker
   `splash.user`), skeleton shape and row count, avatar initial. It never throws.
2. `<div id="root">` holds `src/app/BootShell.tsx` rendered to static HTML at build time; the app stylesheet is
   inlined (Primer's component stylesheet is the one linked file); boot-route chunks (`tools/boot.ts`
   `BOOT_ROUTES`) are modulepreloaded.
3. `main.tsx` → `bootApp()` (`src/app/boot.ts`): config → `openSession` (IndexedDB, before any network) → router →
   `await router.load()` → **one** render that replaces the boot shell. The boot route is never rendered through
   Suspense (React would hold the reveal), and the logged-out boot shell is identical to React's first commit.
4. After first paint: token refresh, sync session, workspace fetch, service-worker registration, idle warm-up of the
   likeliest next views (`warmViews`), RUM reporting. A failed chunk reloads once, then shows `BootFailed`.

### Routing

* TanStack Router (`src/app/router.tsx`), `basepath` = the instance sub-path. Routes are **Forgejo's canonical URLs**
  (`/{owner}/{repo}/issues/{n}`, `/notifications`, code addresses, …); the app's own pages live under `/-/next/`
  (callback, boards, projects). `defaultPreload: 'intent'`; loaders read IndexedDB and never show a spinner for
  local data.
* The server (`spaRoutes`), the service worker (`src/sw/routes.ts` `isSpaRoute`) and the router must agree;
  `src/app/routes.test.ts` parses `spaRoutes` and checks both directions.
* Adding a route: a `createRoute` with `component: lazyView(() => import(…))`, `staticData.skeleton`, and a
  `validateSearch` from `src/app/search.ts` (search params are plain strings, as the classic UI writes them); for a
  canonical URL also add it to `spaRoutes` and `isSpaRoute`.

### Data layer (`src/data`, `src/sync`)

* **Pool** (`data/pool.ts`): every synced entity in memory, one `ModelStore` per model, with `get(id)`, `all()` and
  `by(field, value)` over indexes declared in `data/models.ts` (never in components). `Entity.get(field)` creates
  one MobX atom per observed field, so a delta re-renders only the cells that read the changed field.
* **Delta applier:** the pool's primitives (`put` if newer, `del`, `evict`) are order- and duplicate-independent:
  group-scoped tombstones, group floors at bootstrap watermarks, authoritative bootstrap lines. Fuzzed in
  `pool.test.ts`.
* **IndexedDB** (`data/idb.ts`): one database `forgejo-next:<userId>` with `meta`, `intents`, `drafts`, `blobs` and
  one `m:<Model>` store per model holding **buckets** (one value per `(group, id mod n)`, `KIND_BUCKETS`). Schema
  changes bump `IDB_VERSION`; a changed model store is dropped and re-bootstrapped, `intents` and `drafts` are never
  dropped. Writes are debounced and done by the leader only (`data/persist.ts`).
* **Hydration** (`data/hydrate.ts`): structure groups and the current route's groups first (`firstRoute`), the rest
  in idle chunks (`hydrated`). The leader's sync client starts after phase 1.
* **Tabs** (`sync/tabs.ts`): the holder of Web Lock `forgejo-next:<userId>:leader` owns the socket, IndexedDB writes
  and the intent flush. Followers hydrate from IndexedDB, mirror the leader's committed flushes over
  BroadcastChannel, and forward holds and requests. A new leader re-reads and resumes.
* **Sync client** (`sync/client.ts`): bootstrap first, then subscribe from the watermark; resume from persisted
  positions in `hello`; handles `bootstrap_required`, `group_revoked`, schema changes, barriers; reconnects with
  jittered backoff; falls back to SSE after two transports that never opened. Every request has a deadline and the
  network epoch's abort signal (`sync/net.ts`).
* **Holding:** the groups kept are those reachable from the workspace, recent on-demand groups (LRU), pins and tab
  holds (`Data.hold` / `release`); unreachable groups are purged.
* `openData()` (`sync/data.ts`) is the entry point; `Data` exposes `pool`, observable `status`, `hold`, `whenSynced`,
  `loadClosedPage`, `tailLog`, `barrier` and events (`revoked`, `newBuild`, …).

### Intents (`src/intents`)

A UI action creates an **intent** (`intents.ts`: `issue.state`, `issue.label`, `issue.body`, `comment.create`,
`review.submit`, `board.move`, `notification.status`, `pr.viewed`, … 24 kinds), never an HTTP call.

* `submit` applies an overlay layer (`overlay.ts`: server value + local override per field) in the same MobX action,
  stores the record in IndexedDB with a fresh `Idempotency-Key`, and announces it to other tabs. UI readers go
  through `view.ts`.
* The leader flushes (`executor.ts`) only after the session caught up, per entity serially (`chainOf`; some fields
  have their own chain), at most 6 in flight. The request is built against the freshest pool and frozen with its
  key before the first send, so every retry (also by the next leader) is the same request. Network/5xx/429 retry
  with backoff; `409` in flight waits; 4xx fails.
* Conflict policy (`POLICY`): sets are add/remove against the current server set; scalars are last-writer-wins with
  an "you overrode @x's change · Undo" callout; bodies 3-way merge (`merge3.ts`) and submit with
  `expected_version`, parking real conflicts for the user; creates use temporary ids remapped in queue, pool and URL
  (`/{owner}/{repo}/issues/new-<tempId>`).
* Confirmation: the layer drops when `whenSynced(group, X-Livesync-Sync-Id)` resolves (barrier after 3 s), or when
  the pool shows the effect. Hot kinds wait for their effect.
* Failures move the record to `drafts` with its text; the "Unsynced changes" panel offers Retry / Copy / Discard.
  Nothing is dropped silently. Signed out ⇒ the queue is held, keyed by user.
* Online-only actions (merge, branches, file edits, releases, Actions, settings) are not intents: they go through
  `app/api.ts` `online()` and are disabled offline with `onlineOnly()` (`app/online.ts`).
* Adding a kind: variant + `intentOps` + `describeIntent` + `POLICY` (+ `CREATES`/remap for creates) + `chainOf`
  if not issue-scoped; request in `rest.ts`; `effectHeld` in `effects.ts`; reader in `view.ts`; tests in
  `executor.test.ts`.

### Workers

| Worker | Purpose |
|---|---|
| `src/workers/code.worker.ts` (Comlink) | Shiki (`@shikijs/core`, JavaScript regex engine: no WASM under the CSP) for the app's own line renderer, configured by `src/code/shiki.ts`: one lazy chunk per grammar (`lang-*`), output as `(length, class code)` spans rendered as text nodes with `text-syntax-*` utilities. Driven by `src/code/highlighter.ts`: one highlight at a time, "now" and "idle" priorities, queued work dropped when its `AbortSignal` fires, a stall watchdog that terminates the worker |
| `src/workers/pierre.worker.ts` | Parses a diff's files into `@pierre/diffs` metadata, keeping the server's hunk coordinates |
| `@pierre/diffs` worker pool | Pierre's own Shiki highlighting (`shiki-js`, GitHub light/dark themes), started by `src/code/PierreProvider.tsx` |
| `src/workers/search.worker.ts` (Comlink) | MiniSearch index of issues/PRs (title, `owner/repo`, number; prefix and typo-tolerant), fed from the pool by `features/search/local.ts` |

Workers are created through `app/trusted.ts` `appWorkerURL` (a Trusted Types sink) and rebased on the config's
`base`.

### Code rendering

* Reads go through `src/code/source.ts` (`CodeSource`): everything addressed by SHA, cached in `src/code/cache.ts`
  (memory LRU + IndexedDB `blobs`, purged with a revoked `repo:{id}` group), with byte caps while streaming.
* **File view:** `src/code/FileSurface.tsx` renders `@pierre/diffs` `CodeView` in a worker pool, themed by
  `primerCodeCSS` (Primer variables). **Diff/review:** `src/code/ReviewSurface.tsx` renders Pierre's virtualized
  diff with review threads as line annotations, anchored by `(path, side, line, commit SHA)` (`code/anchor.ts`).
* Pierre writes HTML through `innerHTML`, which the page's Trusted Types policy forbids. Where Trusted Types exist
  (`pierreHTMLSupported()` false), and for blame and `#L` deep links, the app's own accessible line renderer is used
  instead (`features/code/Lines.tsx`, `DiffView.tsx`) with the code worker's highlighting. Never weaken the policy to
  accommodate the library.
* `src/code/shiki.ts` is the one Shiki configuration: the curated grammars, language resolution (fences by Shiki's
  ids and aliases, paths by name and extension), the input limits and the theme. The theme maps GitHub's TextMate
  scopes onto Primer's prettylights syntax tokens, so code follows every colour mode; highlights store class codes
  (`TOKEN_FORMAT` versions the stored ones), never colours.
* The code worker also highlights markdown code blocks, review-comment hunks and suggested changes
  (`code/DiffSnippet.tsx`), code search hits and the file editor (not cached: every version differs).
* Job logs stream over the socket (`log_tail`), ANSI colours mapped to tokens (`code/ansi.ts`).

### Service worker (`src/sw/sw.ts`, built by `tools/vite-plugin-sw.ts`)

* Registered after first paint (`app/sw.ts`). **Install** fetches the shell, checks its build meta, and caches every
  hashed asset except the `lang-*` grammar chunks (cached on first use); it waits (versioned activation). The page
  offers "Reload" when a new build is waiting.
* **Assets:** cache first. **Navigations:** network first via navigation preload; offline, failed, or an app page
  without an answer in 4 s → the cached shell, which renders from IndexedDB or says what is available offline.
  Avatars are cached network-first.
* **Kill switch:** `sw.js` answering 404/410, an app page answering 404, or a build with `NEXT_SW_KILL=1` ⇒ the
  worker deletes its caches and unregisters.

### Styling

* **Primer is the design system:** `@primer/react` components, `@primer/primitives` tokens (light and dark themes,
  chosen by `data-color-mode` on `<html>`), `@primer/octicons-react` icons, `@primer/css` markdown styles for
  rendered markdown, Mona Sans (`src/styles/fonts.css`, the family Primer's stacks name).
* **Tokens:** `src/styles/tokens.css` is a Tailwind `@theme static` that maps Tailwind's namespaces onto Primer's
  functional tokens, named per property after Primer: `bg-muted` = `--bgColor-muted`, `text-muted` = `--fgColor-muted`,
  `border-default` = `--borderColor-default`, `text-syntax-*` = Primer's syntax colours. Tailwind's default theme is
  not loaded; only these utilities exist. It also defines the spacing scale (4 px), fixed component sizes
  (`h-row`, `w-sidebar`, `spacing-card`, `spacing-line`, …), radii, shadows, z-index and motion tokens.
* **Cascade layers**, declared first in `index.html` and `app.css`: `theme, base, primer, components, utilities`.
  Primer's primitives go in `theme`, Tailwind preflight and `base.css` in `base`, every `@primer/react` stylesheet in
  `primer` (`tools/vite-plugin-primer-layer.ts` wraps them, since unlayered CSS would beat every layer), and Tailwind
  utilities last, so a layout utility on a Primer component wins over the component's own rules.
* `src/styles/app.css` is the one stylesheet: imports, `@source` (all of `src/` except tests, `dev`, `test`,
  `protocol`), custom variants keyed on splash attributes (`logged-out:`, `sidebar-hidden:`, `drawer-open:`, …), and
  custom utilities, including `interactive`, the only transition in the app.
* Code lines use one fixed line height (`--text-code`, `--spacing-line`) so code surfaces virtualize without
  measuring.

### Chunks

`vite.config.ts`: per-package vendor chunks (`vendorChunk`; `@primer/react` is one chunk and one stylesheet), an
`app-boot` group for the entry's static closure, workers as ES modules, `lang-*` grammar chunks, hidden source maps,
no modulepreload polyfill. React's profiling build is its own chunk, loaded only with `localStorage.profile = '1'`.

### RUM

`src/sync/rum.ts` collects (on the boot route, tiny): boot marks (`firstPaintFromCache`, `dataOpen`, `wsOpen`,
`caughtUp`, hydration), mutation timings (`mutationLocal`, `mutationAcked`, `mutationConfirmed`), intent and
conflict counts, worst INP per visible period. `src/app/rum.ts` posts them to `/-/sync/rum` when idle: fixed names
and numbers only, no credentials, rate-limited across tabs. Marks taken after the page was hidden or went offline are
dropped.
