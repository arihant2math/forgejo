# Forgejo Next — a Linear-class frontend for Forgejo

> Status: plan, revision 2 (decisions locked, see §0.1). Nothing is implemented yet.
> Inputs: the performance.dev breakdowns of Linear, Conductor, ChatGPT and
> Wealthsimple, plus a read of this Forgejo tree (`08ba2d68b6`, Oct 2026).

---

## 0. TL;DR

* **New SPA, written from scratch.** It renders on the client and is local-first: the UI
  reads from an in-memory object graph that is loaded from IndexedDB. The client syncs
  with the server but never waits on it.
* **New backend module "livesync"**, built into the Forgejo binary as new packages:
  1. **Change capture with DB triggers** (MySQL and Postgres). Each trigger writes
     `(table, id, op)` into an outbox table in the same transaction as the change.
     No upstream Go code changes.
  2. A **materializer** turns those rows into normalized entity snapshots that are
     the same for every viewer, and appends them to a gap-free **sync log** (`syncId`).
  3. A **WebSocket hub** fans deltas out to clients. Each client gets only the sync
     groups it may see, checked with Forgejo's own permission code.
  4. **Bootstrap and partial-load** endpoints stream NDJSON snapshots at a watermark.
  5. An **idempotency layer in front of the unchanged REST API v1**. It makes offline
     write replays safe and returns the `syncId` that confirms each write.
  6. A few **gap endpoints** for things API v1 lacks (project boards, viewed files,
     conflict-checked edits, blame, immutable SHA-addressed blobs).
* **Offline:** everything already synced can be read offline. **Issue and PR
  metadata writes** are queued offline and replayed with conflict handling.
  Code operations (merge, branch, file edits, releases, actions) need a connection.
* **Auth:** OAuth2 with PKCE against Forgejo's built-in provider. The app renders
  first and authenticates second.
* **Upstream patch: one line in `cmd/web.go`**, plus a dependency entry in
  `go.mod`/`go.sum`. Everything else is in new directories. We are not upstreaming
  anything, so the fork is designed to carry this tiny patch forever. A nightly
  canary job catches drift.

### 0.1 Decisions (from review)

| Question | Decision | Consequence in this plan |
|---|---|---|
| Databases | **MySQL and Postgres only** | Two trigger dialects. On SQLite, livesync disables itself and Forgejo runs normally. CI matrix is MySQL + Postgres |
| Deployment | **Same origin** | Assets under `/-/next/`, SPA served on canonical URLs via opt-in. No CORS, no extra origins |
| Scale | **Team instance, but no dead ends** | Build single-instance first. Every design choice must permit horizontal scale-out without redesign (§4.11) |
| Offline | **Reads: everything synced. Writes: issues and PRs only** | Typed offline-capable intents, idempotent replay, conflict policy (§5.4). Code operations are online-only |
| Upstreaming | **No** | Keep the patch minimal and mechanical. Gap endpoints are permanent fork code, written against stable seams (§6) |
| Names | `next/` (frontend), `livesync` (backend) | As below |

---

## 1. What the reference articles say about speed, and how we apply it

| Lesson (source) | What we do in Forgejo Next |
|---|---|
| **The network is the enemy; the database lives in the browser** (Linear) | An IndexedDB-persisted object pool, hydrated on boot, so most reads never hit the network |
| **Mutations apply locally first** and sync in the background (Linear) | A durable transaction queue with an optimistic overlay and rollback on reject |
| **One delta, one cell** through per-property observables (Linear/MobX) | MobX models with per-field observables and `observer()` leaf components |
| **Lazy hydration of heavy tables** (Linear: Issue, Comment) | Two tiers: structure and issue summaries at bootstrap; bodies, timelines and reviews per issue, on demand |
| **Render first, authenticate second** (Linear, ChatGPT) | An inline boot script checks `localStorage` for a local DB marker and renders from IDB. The token refreshes in the background, and only a 401 means "logged out" |
| **Inline the app shell; set the theme before paint** (Linear, ChatGPT) | Critical CSS and the splash config (theme, sidebar width, last route skeleton) inlined in `index.html` |
| **Ship less JS; split aggressively; per-package vendor chunks; ESM only** (Linear) | Vite/Rolldown, `target: esnext`, `manualChunks` per npm package, route-level splitting, no polyfills |
| **Modulepreload the critical path; let the service worker precache the rest** (Linear) | The build emits a modulepreload list for the boot route. The service worker precaches all hashed chunks after first paint |
| **Load fonts correctly** (Linear, Wealthsimple) | System font stack by default (ChatGPT). If we use a webfont: one variable woff2, content-hashed, preloaded with matching `crossorigin`, `font-display: swap` |
| **Avoid extra origins and CORS preflights** (ChatGPT) | **Same origin** (decision). No third-party CDNs |
| **Cache the *shape* of the page** (Wealthsimple) | Persist skeleton counts, avatar initials and column widths so the first frame matches the final layout |
| **Prefetch on intent with identical cache keys** (Wealthsimple) | Prefetch route chunks and lazy data groups on hover/focus. One canonical key function per resource |
| **Stable references stop re-render cascades** (Conductor) | TanStack Router (structural sharing on params/search). MobX instead of prop-drilled arrays |
| **Virtualize long lists; memoize rows** (Conductor) | TanStack Virtual for lists and diffs. Virtuoso for timelines and log streams |
| **Measure in the real environment** (Conductor, ChatGPT) | RUM marks (`appStart`, `firstPaintFromCache`, `wsLive`, `caughtUp`), a profiler flag in `localStorage`, perf assertions in CI |
| **Keyboard first; ⌘K palette over local data** (Linear) | A global shortcut registry and a `cmdk` palette that searches the in-memory pool |
| **Animate only transform/opacity; appear instantly, fade out in ~150 ms** (Linear) | Motion tokens: `--speed-in: 0s`, `--speed-out: .15s`, `--speed-quick: .1s`. A lint rule bans `transition: all` and layout properties |
| **Use boring, proven primitives** (all four) | React, Radix, Tailwind with CSS-variable tokens, CodeMirror 6, Shiki |
| **Use a service worker only if it buys value** (ChatGPT) | Offline reads are a requirement, so we use one. It has a kill switch and versioned activation |

---

## 2. Goals and non-goals

### Goals
1. Local interactions reflect in **≤ 1 frame (16 ms)** and never show a spinner.
   This covers filtering, navigating between synced views, opening an issue that is
   already in the pool, and state/label/assignee changes, both online and offline.
2. Warm boot (returning user) reaches an interactive issue list in **< 300 ms p75**
   on a laptop and **< 800 ms** on a mid-range Android. This holds offline too.
3. A commit reaches other clients in **< 150 ms p95**.
4. Correct permissions. A client can never receive data its user couldn't fetch
   through API v1. Differential tests enforce this (§9).
5. Offline issue/PR edits are **never silently lost and never duplicated**.
6. The fork rebases mechanically onto upstream Forgejo.
7. Capacity targets (§4.11): a team instance with no architectural ceiling.

### Non-goals (initially)
* Parity with every page of the classic UI. Long-tail pages link out to the classic
  UI, which keeps working unchanged on the same server.
* SQLite support.
* Offline code operations: merge, branch create/delete, file edits, releases,
  actions dispatch/rerun, repo/org settings.
* Real-time collaborative text editing (Yjs). See §12.

---

## 3. Architecture overview

```
 Browser (one leader tab per origin via Web Locks)                     Forgejo process(es)
┌──────────────────────────────────────────────┐            ┌──────────────────────────────────────────────┐
│ React 19 + MobX object pool (in memory)      │            │ livesync.Wrap(NormalRoutes())  ← 1-line patch│
│   ▲ observer() leaf components               │            │  ├─ /-/sync/ws        WebSocket hub          │
│ Optimistic overlay + durable intent queue    │  WebSocket │  ├─ /-/sync/*         bootstrap/load/gaps    │
│   (IDB, idempotency keys, conflict policy)   │◄─────────► │  ├─ /api/v1/* + Idempotency-Key → dedupe,    │
│   ▲                                          │            │  │     add X-Livesync-Sync-Id, pass through ─┐│
│ Sync client ── IndexedDB (entities, meta,    │  HTTP      │  ├─ SPA document for opted-in users          ││
│   drafts, SHA-blob cache)                    │──────────► │  └─ everything else → upstream Forgejo ◄─────┘│
│   │ BroadcastChannel → follower tabs         │            │        services ── models ── MySQL/PG ◄──┐    │
│ Service worker: precache, offline shell      │            │ capture: triggers → livesync_change ─────┘    │
│ Workers: Shiki, diff parse, search index     │            │ materializer → livesync_log (syncId) → hubs   │
└──────────────────────────────────────────────┘            └──────────────────────────────────────────────┘
```

Two kinds of data, two strategies:

1. **Mutable relational metadata** goes through the **sync engine**: issues, PRs,
   labels, milestones, boards, comments, reviews, notifications, branch→SHA,
   commit statuses, action runs, repos, orgs, teams, users.
2. **Immutable git content** (trees, blobs, commits, diffs between two SHAs) is
   **content-addressed and cached forever** in the HTTP cache, the service worker and
   IDB. The only mutable part is ref→SHA, which the sync engine already tracks through
   the `branch`/`release` tables. So staleness is decided locally, offline included.

---

## 4. Backend plan ("livesync")

### 4.1 Code layout (new directories only)

```
models/livesync/        # own tables (created with x.Sync at init, NOT Forgejo migrations)
services/livesync/
  capture/              # trigger DDL per dialect (mysql, postgres), installer, doorbell, outbox reader
  catalog/              # tracked-table catalog: table → model, group resolver, lazy tier
  materialize/          # row → DTO (normalized, viewer-independent)
  synclog/              # append, read-since, retention, tailer (multi-instance)
  perm/                 # group grants per user, cache, epoch invalidation
  hub/                  # connections, subscriptions, fan-out, coalescing, backpressure
  idempotency/          # Idempotency-Key store + replay for API v1 writes
  protocol/             # message types (Go structs → TS via tygo)
  oauthapp/             # auto-provision first-party public OAuth2 client
routers/livesync/       # Wrap(): ws, bootstrap, load, gap endpoints, idempotency, SPA serving
next/                   # the new frontend (own package.json / lockfile / toolchain)
```

These are new directories inside Forgejo's standard roots, so Forgejo's existing
lint/test/`GO_DIRS` tooling covers them, and upstream never touches them. Settings
come from a `[livesync]` section read through `setting.CfgProvider.Section("livesync")`
inside our own package. `modules/setting` stays untouched.

### 4.2 Upstream patch: one line

```go
// cmd/web.go, serveInstalled()
webRoutes := livesync_router.Wrap(routers.NormalRoutes())   // was: routers.NormalRoutes()
```

`Wrap(inner http.Handler) http.Handler` does the following:
* Runs `livesync.Init` once (DB, settings and models are ready at this point because
  `InitWebInstalled` has run). If livesync is disabled, the DB is SQLite, or triggers
  can't be verified, it logs why and **returns `inner` unchanged**.
* Handles `/-/sync/ws` **before** Forgejo's middleware stack. It gets the raw
  `net/http` `ResponseWriter`, which supports `Hijack`. Forgejo's
  `context.Response` wrapper hides `Hijack`/`Unwrap`, which is why we don't mount the
  socket inside `NormalRoutes`. This removes the `response.go` patch from revision 1.
* Serves its other HTTP endpoints through its own `web.Route` that reuses the
  exported `common.ProtocolMiddlewares()` and `routers/api/shared.Middlewares()`
  (panic recovery, process manager, access log, API auth) without modifying them.
* Intercepts `/api/v1/*` requests that carry `Idempotency-Key` (§4.8). All other
  requests go straight to `inner`.
* Serves the SPA document for opted-in users on supported canonical URLs (§4.10).
* Registers WebSocket shutdown with `graceful.GetManager()`.

The other "patch" is the WebSocket library dependency in `go.mod`/`go.sum`
(`github.com/coder/websocket`, which has no dependencies of its own). Conflicts in
those files are resolved mechanically: the sync script takes upstream's version and
re-runs `go get` + `go mod tidy` (§6).

Integration tests that call `routers.NormalRoutes()` directly are unaffected. Our
tests wrap it themselves.

### 4.3 Change capture: triggers → outbox → doorbell

**Why triggers (re-checked for MySQL + Postgres only):**

| Option | Coverage | Transactional | Ops cost | Upstream diff |
|---|---|---|---|---|
| `services/notify` notifier | partial: misses label/milestone CRUD, boards, pins, deadlines, deps, team/collab changes… | after the fact | none | none |
| xorm `contexts.Hook` | complete | **no**: statements can't be tied to their tx (sessions start from the engine's default ctx) | none | none |
| PG logical decoding + MySQL binlog CDC | complete | yes | PG: `wal_level=logical` (restart) + REPLICATION role. MySQL: REPLICATION grants + a binlog client library. Two very different pipelines | none |
| **Per-row triggers → outbox** | **complete** | **yes** | PG: none (the table owner can create triggers). MySQL: see privileges below | **none** |

**Trigger design (robust against upstream migrations):**
* The body only runs
  `INSERT INTO livesync_change(tbl, row_id, op) VALUES ('<tbl>', NEW.id|OLD.id, 'I'|'U'|'D')`.
  It references only `id`, so upstream ALTER/DROP column migrations never conflict with it.
  This is a hard invariant, not an optimisation: a trigger that names any other column
  turns an upstream rename/drop of that column into a failure of **every** UPDATE of the
  table (MySQL `ERROR 1054`), including during the upgrade's own later migrations, in
  `INSTALL_MODE=verify` (triggers are not replaced) and with livesync disabled but
  triggers left installed. Livesync must never be able to break an upstream write, so
  "which columns changed" is never decided in a trigger (see §4.5 for how permission
  changes that are undone before the materializer reads the row are still caught).
* **Postgres:** a single `plpgsql` function using `TG_TABLE_NAME` that also calls
  `pg_notify('livesync','')`. That doorbell fires at commit, across instances.
  All DDL is **schema-qualified** to respect Forgejo's `[database] SCHEMA`
  (`models/db/sql_postgres_with_schema.go`).
* **MySQL:** generated `AFTER INSERT/UPDATE/DELETE` triggers per table, with no
  explicit `DEFINER`. They are deterministic (no `UUID()`/`NOW()`), so they are safe
  under row and statement binlog formats.
* **MySQL privileges (important ops note).** `CREATE TRIGGER` needs the `TRIGGER`
  privilege. **With binary logging on (the default since MySQL 8.0)** it also needs
  `SUPER` or `log_bin_trust_function_creators=1`. The installer therefore has two modes:
  * `INSTALL_MODE=auto`: create or repair triggers at startup.
  * `INSTALL_MODE=verify`: only check that they exist. A site-admin page,
    `/-/sync/admin`, prints the exact DDL for a DBA to run as a privileged user.

  Either way, if triggers are missing or stale, livesync **refuses to serve**.
  `Wrap` falls back to plain Forgejo and the SPA shows "live sync unavailable → classic
  UI". It never runs silently wrong.
* **Drift repair:** upstream migrations sometimes rebuild tables
  (`base.RecreateTables`), which drops triggers. At startup the installer compares
  the catalog with the triggers that actually exist (`information_schema.triggers` /
  `pg_trigger`), reinstalls missing ones, runs a **reconciliation scan** over the
  `updated_unix` columns for the affected tables, and bumps a per-table `schemaEpoch`.
  In the worst case that forces affected clients to re-bootstrap those models.
* **Cascades:** Forgejo deletes related rows in application code
  (`models/db/foreign_keys.go`), not with DB-level `ON DELETE CASCADE`. So MySQL's
  "triggers don't fire on FK actions" rule doesn't apply. A contract test asserts that
  tracked tables have no DB-level cascades. `TRUNCATE` (which skips triggers) is only
  used in tests.
* **Scope for deletes** (which repo did a deleted row belong to?) comes from our own
  `livesync_entity(tbl, row_id, group, last_sync_id)` index, which the materializer
  maintains. That's why triggers don't need `repo_id`.
* **Doorbell:**
  * In process: a passive xorm `contexts.Hook`, added from *our* init, sees
    `COMMIT` and autocommit DML and pokes the reader. No SQL parsing.
  * Postgres: `LISTEN livesync` through pgx, which is already a Forgejo dependency.
  * MySQL across instances: tail the log by polling (100 ms default). See §4.11.
  * Safety net: polling every 250 ms.
* **Commit-order gaps:** auto-increment IDs are assigned at insert time, not commit
  time. The reader processes every committed row it sees, tracks holes below the
  high-water mark, and re-checks them for up to `HOLE_TIMEOUT` (default 30 s).
  Clients see a **gap-free, monotonic** `syncId`, assigned by the single-writer
  materializer.
* **Tracked tables** (initial catalog):
  * *structure/summary tier:* `repository`, `user` (public subset), `org_user`,
    `team`, `team_user`, `team_repo`, `team_unit`, `collaboration`, `access`,
    `repo_unit`, `label`, `milestone`, `project`, `project_board`, `project_issue`,
    `issue` (summary), `issue_label`, `issue_assignees`, `pull_request`,
    `pull_auto_merge`, `branch`, `release`, `commit_status` (summary),
    `action_run`, `action_run_job` (status), `notification`, `stopwatch`,
    `issue_watch`, `watch`, `star`, `forgejo_blocked_user`.
  * *lazy tier (per-issue group):* `comment` (Forgejo stores timeline events as
    comment types), `reaction`, `review`, `review_state`, `attachment`,
    `issue_dependency`, `tracked_time`, `issue_content_history` (fetched on demand only).
  * Everything else is explicitly ignored. A contract test fails CI when upstream
    adds a table that is neither tracked nor ignored.
* **Write amplification:** one small extra insert per tracked write. The hot tables
  (`notification`, `commit_status`, `action_run_job`) are coalesced in the
  materializer. Phase 0 benchmarks this on both databases.

### 4.4 Materializer → sync log

* Reads batches from `livesync_change` and coalesces them by `(tbl,row_id)`. It loads
  rows through **Forgejo's typed models**, so an upstream change surfaces as a compile
  error in the canary, not as silent drift. Processed change rows are deleted in
  batches.
* Emits **normalized DTOs**: references are IDs, and field names follow API v1.
  They are Go structs in `services/livesync/protocol` with **generated TS types** (tygo).
* **Viewer-independence rule:** a payload in a shared group never depends on who reads
  it. Viewer-specific facts go into per-user entities in `user:{id}`: my subscription,
  my notification state, my stopwatch, my viewed files, email visibility. This keeps
  fan-out cheap, makes snapshots cacheable (§4.11), and makes leaks unlikely.
* **Markdown:** lazy-tier entities include `bodyHtml` rendered by Forgejo's markup
  service, which is authoritative and sanitized. Phase 0 must check that rendering
  doesn't depend on the viewer (cross-repo refs, mentions). If it does, render per
  request instead.
* Appends `(sync_id, group, model, entity_id, op, payload, schema_ver)` to
  `livesync_log`. Retention is configurable (default 30 days or N rows). A client
  whose cursor is older gets `bootstrap_required`.
* **Groups:** `user:{id}`, `org:{id}`, `repo:{id}`, `issue:{id}` (lazy tier).
  Each entity belongs to exactly one group. Repo-scoped entities carry a required
  unit (`issues`, `pulls`, `code`, `actions`), checked with `Permission.CanRead(unit)`.

### 4.5 Permissions

* `perm.Grants(user) → {(group, units)}` is computed from
  `access_model.GetUserRepoPermission`, org/team membership, and repo/org visibility.
  It is cached per user and shared across that user's connections.
* **Permission epochs:** any change to `access`, `collaboration`, `team*`,
  `org_user`, `repository` (visibility/owner), `repo_unit`, `user`
  (visibility/active/admin) or `forgejo_blocked_user` bumps an epoch for the affected
  users/repos. The hub then recomputes their grants. A lost grant sends
  `group_revoked`, and the client **purges** that group from memory and IDB. It also
  fails any queued offline intents for that group, keeping the user's text as a draft.
* **Undone changes (B4):** because triggers carry no column information (§4.3), the
  materializer only sees a row's stored and current state, which are equal when a
  permission change was undone before it read the row (repo made public and private
  again). Any update of a row of the rarely-updated permission tables therefore names
  that row's subjects; for the busy ones (`repository`, `user`: counters, sign-ins) an
  update that leaves the state as stored is a **touch** carrying the row's current
  permission fingerprint. Every cached grant and every decision records the
  fingerprints of the repository/user rows it was computed from; a touch drops or
  re-checks only those that recorded another fingerprint (i.e. were computed in the
  undone state), so a counter update costs no recomputation (a running grant
  computation is not split or discarded by a touch either: it is compared with the
  touched states when it finishes). Touches travel in the
  same `P` log entries as epochs, so every instance applies them.
* Public repos you're not a member of are subscribed only on demand. Nothing is
  broadcast instance-wide. Admins get no implicit "see everything" subscription.

### 4.6 Transport and protocol

**WebSocket** at `/-/sync/ws` (`coder/websocket`). Messages use a JSON envelope with
permessage-deflate (switch to msgpack only if measurements justify it). The server
batches deltas into frames of at most 16 ms. **The same protocol also runs over SSE +
POST** as a fallback for proxies that break WebSockets.

```
C→S  hello        {token, clientId, schema, lastSyncId, groups:[{id, since?}]}
S→C  welcome      {serverSyncId, viewerId, granted:[…], revoked:[…], buildId}
C→S  subscribe    {groups:[{id, since?}]}     unsubscribe {groups}
S→C  delta        {to: syncId, changes:[{v, g, m, id, op, d}]}   # full entity state ⇒ idempotent
S→C  caught_up    {syncId}                     # replay finished; client may flush offline queue
S→C  bootstrap_required {group, reason}       group_revoked {group}
C→S  barrier      {id}   → S→C barrier_ok {id, syncId}
S→C  session_invalid | notice {kind:"new_build"} | pong
```

* The bearer token is sent in `hello`, not the query string. An invalid token gets
  `session_invalid`.
* Deltas are **full entity snapshots with version `v = syncId`**. A delta is applied
  only if `v > entity.v`, so overlap between bootstrap and the stream is harmless.
* A group subscribed mid-session replays from its watermark before it is marked live.
* **Backpressure:** each connection has a bounded send buffer. A slow consumer is
  disconnected with `resume_from_cursor` instead of letting server memory grow.

### 4.7 Bootstrap and partial loads (HTTP)

* `GET /-/sync/bootstrap?group=repo:12` streams NDJSON (br/gzip): a
  `{watermark, schema}` line followed by the entities. There is one request per group,
  so they run in parallel over HTTP/2 and can be cancelled.
* Consistency: read `max(sync_id)` *before* taking the snapshot. Later deltas are
  idempotent.
* **Data-level code splitting:** a repo's summary tier holds open issues/PRs plus
  everything updated in the last 90 days. Older closed items load lazily on
  search/filter. `GET /-/sync/load?group=issue:123` returns the lazy tier.
* **Workspace** = the groups kept hot and available offline. By default these are
  repos you own, collaborate on, reach through a team, or watch. The set is capped
  and you can pin more. Other repos are loaded on visit and subscribed while open.

### 4.8 Writes: API v1 + idempotency + sync-id echo

* The client writes through the **normal REST API v1** with its OAuth2 bearer token.
  Forgejo keeps owning validation, permissions, notifications, webhooks, mail and
  federation.
* Every client write carries `Idempotency-Key: <uuid>`. `Wrap` intercepts these
  requests:
  1. Reserve `(user_id, key)` in `livesync_idempotency` (unique). If the key is
     already *completed*, **replay the stored response**. If it is *in-flight*,
     return `409 retry-later`.
  2. Call the unchanged API v1 handler in-process, with the response buffered.
  3. After it returns, read the outbox high-water mark, wait (bounded, usually a few
     ms) until the materializer has processed through it, and set
     **`X-Livesync-Sync-Id`**. The client drops the optimistic overlay once its pool
     reaches that `syncId`, with no flicker and no separate barrier round-trip.
  4. Store status + body + syncId, kept for 7 days.
  * **Crash window:** the API commit and the idempotency record are not one
    transaction. For *creates* (issue, comment, review), when a key is found
    in-flight after a restart, the server checks for an entity created by the same
    user with the same content on the same target in the last N minutes before letting
    the replay through. Duplicates are therefore prevented in practice, not just in
    theory.
* **Gap endpoints** under `/-/sync/api/`. These are permanent fork code and call
  Forgejo services. Each one has a contract test.
  * Project boards: columns CRUD and **move card**. API v1 has no projects API.
  * Conflict-checked body edit (`expectedVersion` → 409). API v1 passes the current
    `ContentVersion`, so it silently overwrites. Offline sync needs the check.
  * PR "viewed files" (`review_state`).
  * Blame.
  * Immutable SHA-addressed tree/blob/diff with `Cache-Control: immutable`; ETag = SHA.
  * Actions log tail over the socket (offset-based).
  * Batch markdown preview.

### 4.9 Auth

* At startup, `oauthapp` makes sure a first-party **public** OAuth2 app exists
  (`ConfidentialClient=false`, redirect `/-/next/callback`). Forgejo already
  **requires PKCE** for public clients (`routers/web/auth/oauth.go`).
* Flow: `/login/oauth/authorize` (classic login UI, unchanged) → one-time consent →
  code → access + refresh tokens. The access token stays in memory and the refresh
  token goes in IDB. CSP is strict, with Trusted Types and only the hashed inline boot
  script allowed.
* Phase 0 must confirm the scope behaviour (`ENABLE_ADDITIONAL_GRANT_SCOPES`).
  The token needs `write:issue write:repository read:user read:organization
  write:notification`.
* **Offline:** an expired access token doesn't block reads. Writes queue until the
  token is refreshed. If refresh fails, the queue is held (not dropped) until the user
  signs in again, *as the same user*. The queue is keyed by `userId`.
* Logout: revoke the grant, wipe IDB (after warning about unsynced intents), and
  broadcast `logout` to all tabs.

### 4.10 Serving the app (same origin)

* Hashed assets at `/-/next/assets/*` (`go:embed` behind a build tag, or a directory
  on disk) with `immutable`. The service worker is at `/-/next/sw.js` with
  `Service-Worker-Allowed: /`.
* **Canonical URLs:** with the opt-in cookie (`ui=next`), `Wrap` serves the SPA
  `index.html` for document navigations (`Sec-Fetch-Dest: document`) on supported
  routes (`/{owner}/{repo}/issues/{n}`, `.../pulls/...`, `/notifications`, …).
  Everything else falls through to the classic UI. Links, bookmarks and email links
  work in both UIs.
* The service worker answers navigations to supported routes **from cache when
  offline**. Unsupported routes get an offline page that offers the cached SPA views.
* Using `custom/templates/custom/header.tmpl` (no upstream diff), classic pages,
  including login, get prefetch hints and a "Try Forgejo Next" toggle. The app is then
  already cached by the time the user enters it.

### 4.11 Scale: team-sized now, no ceiling later

**Targets.** Design: 1k users, 300 concurrent sockets, 2k repos, 200k issues,
10 writes/s sustained. Phase 5 load test at **10×**: 3k sockets, 100 writes/s.

**Invariants that keep scale-out additive rather than a redesign:**
1. **The database is the only durable state.** The sync log and idempotency records
   live in the DB. Hubs are stateless and rebuild from DB + grants on restart.
2. **One writer, many tailers.** One materializer holds a lease (PG advisory lock /
   MySQL `GET_LOCK`). Every instance *tails* `livesync_log` and fans out to its own
   sockets. A single instance runs both roles in one process, which is today's
   deployment.
3. **Fan-out is indexed by group.** Per-delta cost is O(subscribers of that group).
   Per-connection memory is O(subscribed groups). Nothing loops over all connections.
4. **Snapshots are viewer-independent.** Bootstrap responses for `(group, watermark)`
   can be cached and shared, and later served from object storage or a CDN without
   protocol changes.
5. **Bounded everything:** send buffers, replay windows (`bootstrap_required`
   beyond retention), and per-user subscription caps.
6. **The materializer can be partitioned later** by hashing on group. The protocol
   only promises per-group ordering plus a global `syncId` watermark, so this stays
   compatible.

On Postgres, cross-instance wake-up uses `NOTIFY`. On MySQL it polls (100 ms), and a
peer doorbell can be added later. Forgejo's Redis is an optional faster doorbell.
Metrics go to Forgejo's Prometheus endpoint: capture lag, materialize lag, fan-out
time, connections, bootstrap bytes, `bootstrap_required` rate, idempotency replays,
and offline-queue conflict rate (from RUM).

---

## 5. Frontend plan (`next/`)

### 5.1 Stack

| Concern | Choice | Notes |
|---|---|---|
| UI runtime | React 19 | |
| State | **MobX** object pool | Per-field observables, `observer()` leaves (Linear) |
| Routing | **TanStack Router** | Typed search params, structural sharing, `preload="intent"` (Conductor) |
| Build | Vite → Rolldown, `target: esnext`, lightningcss | Per-package vendor chunks, route splitting |
| Styling | Tailwind v4 + CSS-variable design tokens | Theme switch = swap variables |
| Primitives | Radix | |
| Palette | `cmdk` | Searches the in-memory pool |
| Lists | TanStack Virtual; Virtuoso for timelines/logs | |
| Editor | **CodeMirror 6** (markdown) + preview | Markdown fidelity matters more than WYSIWYG in a forge |
| Highlighting | Shiki in a Worker, cached by blob SHA | |
| Workers / RPC | Comlink | Diff parsing, search index, highlighting |
| Persistence | `idb` | wa-sqlite/OPFS later if needed |
| Text merge | `diff3`-style 3-way merge | Offline body edits (§5.4) |
| Local search | MiniSearch in a worker | The server issue indexer covers full-text beyond the local set |
| Tests | Vitest + fast-check, Playwright | |

`next/` has its own `package.json` and lockfile. **Never touch** the root
`package.json`, `web_src/` or `webpack.config.ts`.

### 5.2 Boot sequence (first frame from local knowledge, online or offline)

1. `index.html` (small, with inlined critical CSS) is served by the service worker
   when cached:
   * `performance.mark('appStart')`.
   * An inline script reads `localStorage.splash` (theme, sidebar width, last route,
     skeleton row counts, avatar initial) and applies it to `<html>`. If there is no
     local DB marker it shows the `logged-out` shell.
   * `<link rel=modulepreload>` for the boot-route chunks.
2. The data worker opens IDB, reads meta, and hydrates structure plus the *current
   route's* repo summaries first. The rest hydrates during idle time.
3. Render from the pool (`mark('firstPaintFromCache')`).
4. In the background: refresh the token → WS `hello{lastSyncId}` → catch-up deltas →
   `caught_up` (`mark('caughtUp')`) → flush the offline queue (§5.4).
5. After first paint, the service worker precaches the remaining hashed chunks and
   icons.

### 5.3 Sync client

* **Leader tab** via `navigator.locks.request('livesync-leader')`. The leader owns
  the socket, IDB writes and the queue flush. Followers receive deltas over
  `BroadcastChannel` and forward their intents to the leader. If the leader dies, the
  lock passes to another tab. SharedWorker isn't used because Android Chrome lacks it.
* **IDB:** one DB per `(origin, userId)`. One store per model, indexed on `group`
  and the hot query fields. Plus `meta` (lastSyncId, group watermarks, schema,
  buildId), `intents` (the offline queue), `drafts`, and `blobs` (SHA cache).
* **Schema evolution:** a per-model schema version. On mismatch, drop and
  re-bootstrap only that model. **Never** drop `intents` or `drafts`.
* **Storage:** call `navigator.storage.persist()` once the user is signed in.
  Structure is never evicted. Lazy `issue:{id}` groups and SHA blobs use LRU with a
  quota budget.

### 5.4 Writes: optimistic online, durable offline (issues & PRs)

**Intents, not HTTP calls.** A UI action creates an *intent*, for example
`{kind:'issue.addLabel', issueRef, labelId}` or
`{kind:'issue.editBody', issueRef, baseVersion, baseText, newText}`.
Each intent is applied **synchronously** to the pool as an overlay (server value +
local override per field), persisted to `intents` in IDB with a fresh
`idempotencyKey`, and queued. It is turned into REST calls **at flush time**,
against the freshest synced state.

**Offline-capable intents (issues and PRs):**

| Area | Intents |
|---|---|
| Issue lifecycle | create (temp ID), close/reopen, title, body, deadline, milestone, pin, lock |
| Sets | labels add/remove, assignees add/remove, reactions add/remove, dependencies add/remove, subscribe/unsubscribe |
| Boards | move card between columns |
| Conversation | comment create/edit/delete, PR review-comment drafts (pending review), **submit review** (pinned to the `commit_id` the user saw) |
| PR metadata | title/body/labels/assignees/milestone, requested reviewers, viewed files |
| Inbox | notification read/unread/pin |

**Online-only (disabled with an explanation when offline, never queued):** merge,
update branch, auto-merge scheduling, PR creation (needs a live compare), branch/tag
operations, file edits, releases, actions dispatch/rerun/cancel, stopwatch (time
sensitive), and all settings.

**Flush rules:**
1. Flush only after `caught_up`. This guarantees the base state is current.
2. Order: per entity, the queue is serial. Across entities, global order is
   preserved only for dependent intents (comment-on-new-issue waits for the create).
3. Retries use exponential backoff. The same `Idempotency-Key` on every retry makes
   replays safe (§4.8).

**Conflict policy (by intent type):**

| Type | Policy |
|---|---|
| **Set ops** (labels, assignees, reactions, deps, subscriptions) | Commutative. Rendered as add/remove against the current server set. API v1 has no add/remove for assignees, so we compute `current ∪ {x}` at flush time. Exclusive scoped labels drop the sibling, as Forgejo does |
| **Scalars** (state, title, milestone, deadline) | Last-writer-wins, **but** if the server value changed since the intent's base, the user gets an inline "you overrode @alice's change" notice with one-click undo |
| **Body** (issue/PR description) | 3-way merge of `baseText` / server / local. If clean, submit with `expectedVersion` through the gap endpoint. If it conflicts, show the conflict in the editor and park the intent until the user resolves it |
| **Comment edit** | Compare `updated_unix`. If it changed, show a conflict UI. Otherwise apply |
| **Creates** | Temp UUID → server ID remap in pool, queue and URL (`router.replace`). Idempotency prevents duplicates |
| **Target deleted / permission lost / 4xx** | Revert the overlay, **keep the typed text in `drafts`**, and show it in an "Unsynced changes" panel with retry/copy/discard |

**Rebase:** when a server delta arrives for an entity that has pending intents, the
*base* is updated and the override kept, so the display doesn't flicker. Most invalid
intents are rejected **before** they're created, using local permission bits, label
exclusivity and required fields.

**UX:** a global sync indicator (live / catching up / offline · N pending), a pending
badge on affected rows, and an "Unsynced changes" panel. Nothing is ever silently
discarded.

### 5.5 Offline reads

* **Always available offline:** everything in the workspace summary tier (issues,
  PRs, labels, milestones, boards, notifications, branches, checks/run status), plus
  the lazy tier of every issue/PR you have opened recently.
* **Background prefetch of lazy tiers** (when idle, online, and not on a metered
  connection): issues/PRs assigned to me, authored by me, mentioning me, review
  requested from me, the first N unread notifications, and starred/pinned issues.
* **Code offline:** every tree, blob and diff you have viewed (SHA cache). PRs
  awaiting your review get their diff and changed files prefetched, so you can *read*
  and *draft* a review offline and submit it when back online.
* Views that need data that isn't local show "Not available offline" with a list of
  what *is* available. No blank screens or spinners.

### 5.6 UI system and interaction model

* **Keyboard first:** a global registry with scoped contexts (list, issue, diff,
  palette). Hints are rendered in menus and tooltips. Initial map: `⌘K` palette ·
  `C` create · `G I`/`G P`/`G N`/`G B` go to issues/PRs/inbox/board · `J/K` move ·
  `X` select · `S` state · `L` labels · `A` assignee · `M` milestone · `P` priority ·
  `⌘↵` submit · `[ ]` previous/next file in diff · `R` start review · `E` edit.
* Radix context menus on rows, with the same actions as the palette.
* **Motion:** appear instantly, fade out in 150 ms, quick feedback ≤ 100 ms. Only
  `transform/opacity` (occasionally colours). A Stylelint rule bans layout-property
  transitions and `transition: all`. Lists don't animate. Popovers scale from their
  origin. `prefers-reduced-motion` is honoured.
* Accessibility: Radix focus management, roving tabindex in lists.

### 5.7 Code surfaces (content-addressed, online writes only)

* Repo browser: tree by `(repo, commitSHA)`, cached forever. The head SHA comes from
  the synced `branch` entity, so "latest" resolves locally.
* File view: Shiki in a worker, virtualized for large files, prefetched on hover.
* **PR diff:** the unified diff for `(baseSHA, headSHA)` is parsed and highlighted in
  a worker and rendered with a virtualized per-line renderer. Review comments are
  anchored by `(path, side, line, commitSHA)`.
* Actions: run/job status is synced, logs stream over the socket, and logs of
  finished jobs are cached by job ID.

### 5.8 Measuring

* RUM marks: `appStart`, `firstPaintFromCache`, `wsOpen`, `caughtUp`, INP, and for
  each mutation `localApplied → acked → confirmed`. Also offline-queue depth and
  conflict outcomes. These go to a first-party `/-/sync/rum`.
* `localStorage.profile=1` turns on React Profiler builds.
* CI budgets: boot-route JS ≤ 500 KiB br (raised from 150 KB by the project owner,
  2026-10-09: the limit is a ceiling, not an allowance; fast first load comes from
  keeping the boot route small, and later from server rendering and streaming the
  bundle), CSS ≤ 30 KiB br. Playwright perf
  assertions: local mutation < 16 ms, warm boot < 300 ms, offline warm boot < 300 ms.

---

## 6. Keeping the fork in sync (no upstreaming)

We aren't upstreaming, so the fork stays small through **structure**, not through
negotiation with upstream:

1. **Branches:** `upstream` (mirror of Codeberg `forgejo`) → `next` = upstream + **one
   commit** ("livesync: wrap web handler") + new directories. Production follows
   Forgejo **release branches**. A canary follows upstream `forgejo`.
2. **`next/tools/sync-upstream.sh`:** fetch → merge (with `rerere`) → if `go.mod`/
   `go.sum` conflict, take upstream's and re-run `go get github.com/coder/websocket@<pin>
   && go mod tidy` → build → tests. The only hand-resolvable conflict is the one line
   in `cmd/web.go`, and that only if upstream rewrites `serveInstalled`.
3. **Nightly canary CI:** run the sync script, then the livesync contract tests on
   **MySQL 8.x and Postgres (oldest and newest supported)**, then the frontend e2e
   smoke tests. Breakage shows up within a day, while the upstream diff is still small.
4. **Contract tests that catch silent drift:**
   * *Table classification:* every table in `db.Tables()` is tracked or ignored.
   * *Trigger health:* triggers survive a full upgrade from the previous Forgejo
     release (migrations run with triggers installed, followed by a reconciliation check).
   * *Mutation coverage:* for every REST call and gap endpoint the client uses (a
     generated list), the expected delta arrives with the expected fields.
   * *Differential permissions:* bootstrap ∪ deltas ≡ API v1 visibility, for random
     users and repos.
   * *OpenAPI pin:* diff `templates/swagger/v1_json.tmpl` and flag changes to
     endpoints the client uses.
   * *No DB-level cascades* on tracked tables.
5. **Coupling rules:** write through API v1 (stable and versioned). Read through typed
   models (drift becomes a compile error). Gap endpoints call **service-layer**
   functions only (never internal helpers), and each has a contract test. Keep the
   list of Forgejo symbols livesync imports in `services/livesync/SURFACE.md` and
   review it on every upstream merge.

---

## 7. Product scope and mapping

### 7.1 Surfaces by phase
* **Core (Phases 2–3):** Inbox (notifications); My issues / My PRs / Review requests;
  repo issue and PR lists (filters, grouping, sorting, saved views); issue detail
  (timeline, comments, reactions, sidebar fields); labels/milestones; project boards
  (drag and drop); global search; ⌘K; create flows. All of it works offline per §5.4–5.5.
* **Code (Phase 4):** repo browser, file view, commits, branches/tags, compare, PR
  files/diff/review, checks/actions with logs, blame, releases.
* **Long tail (Phase 5):** org/team/user pages, wiki, packages (read-only), selected
  settings. Everything else deep-links to the classic UI.

### 7.2 i18n
Generate a client catalog from Forgejo's `options/locale*` for the keys we reuse
(states, unit names, timeline phrases). New strings go in our own catalog.

### 7.3 Linear concept → Forgejo concept
| Linear | Forgejo (existing) |
|---|---|
| Workspace | instance + the user's workspace of repos/orgs |
| Team | org (or repo) |
| Issue status (workflow) | open/closed + **exclusive scoped labels** (`status/…`, `Label.Exclusive`) |
| Priority | exclusive scoped label `priority/…` |
| Cycle | milestone with due date |
| Project / board | project + columns (`project_board`) |
| Sub-issues / blocking | issue dependencies |
| Triage / inbox | notifications |
| Estimates | none (skip, or use a scoped-label convention) |

---

## 8. Phased roadmap with exit criteria

### Phase 0: Spikes and decisions (≈ 2–3 weeks)
* Triggers on MySQL 8.x and Postgres:
  * install, verify and repair, including the Postgres `SCHEMA` setting;
  * the **MySQL privilege matrix** (binlog on/off, `log_bin_trust_function_creators`,
    managed MySQL);
  * an upgrade across a Forgejo release with triggers installed;
  * write-amplification benchmark.
* `Wrap` approach: socket hijack, graceful shutdown, reuse of
  `ProtocolMiddlewares`/API auth outside `NormalRoutes`, in-process API v1 call with a
  buffered response for idempotency.
* OAuth2 PKCE public-client auto-provisioning; scopes; consent UX.
* Is markdown rendering viewer-independent?
* Data sizing on a large imported dataset: bootstrap bytes, IDB hydrate time for
  10k/50k summaries, MobX pool memory.
* Offline conflict prototype: 3-way body merge, and set-op flush against a changed
  server state.
* **Exit:** an ADR for each decision. A throwaway prototype on both DBs: tab A
  (offline) edits labels and the body, a different browser edits the same issue,
  then A reconnects and converges correctly, with no duplicates.

### Phase 1: livesync core (≈ 5–7 weeks)
* Capture, materializer, sync log, groups, permissions with epochs, WS hub
  (backpressure), bootstrap, partial load, idempotency layer with sync-id echo,
  retention, metrics, kill switch, admin page.
* Single-instance deployment, but materializer lease and log tailer already split
  (§4.11 invariant 2).
* Contract and differential-permission tests in CI (MySQL + PG).
* TS type generation.
* **Exit:** a headless TS conformance suite passes on both DBs: bootstrap → live →
  reconnect from cursor → `group_revoked` purge → idempotent replay → no duplicates
  after a forced crash between commit and idempotency record. Fork diff = 1 line +
  go.mod.

### Phase 2: Frontend walking skeleton (≈ 4–6 weeks, overlaps Phase 1)
* `next/` toolchain, inline shell, boot sequence, service worker (offline shell), OAuth,
  IDB, pool, leader election, sync client, router, tokens/theme, palette, shortcuts,
  virtualized issue list, issue detail (read), and online optimistic
  state/label/assignee changes.
* **Exit:** perf budgets met. **Offline reads work** for the workspace (warm boot
  offline < 300 ms).

### Phase 3: Issues and PR metadata, including offline writes (≈ 7–9 weeks)
* Everything in §7.1 Core, board gap endpoints, inbox, search, saved views, create
  flows. **The full offline intent system:** queue, flush rules, conflict policy,
  drafts, the "Unsynced changes" panel, and multi-tab behaviour.
* **Exit:** property-based tests (any interleaving of offline intents and remote
  changes converges, with no loss and no duplicates) and Playwright offline scenarios
  pass. The team dogfoods Next for daily triage.

### Phase 4: Code surfaces (≈ 8–10 weeks)
* Repo browser, file view, PR diff and review (offline read and draft), checks/actions
  with live logs, blame, compare, releases. Immutable caching end to end.
* **Exit:** a 5k-line PR scrolls at 60 fps. Switching to a cached file takes < 100 ms.
  A prefetched PR can be reviewed offline.

### Phase 5: Long tail, polish, hardening (ongoing)
* Org/team/user/wiki/packages, accessibility audit, i18n coverage, mobile layout,
  security review (CSP, token storage, permission fuzzing).
* **Scale verification:** multi-instance deployment (lease + tailers), and a load test
  at 10× the targets (§4.11).
* **Exit:** opt-in beta through the `ui=next` toggle.

---

## 9. Testing strategy

* **Go** (unit + Forgejo's `tests/integration` harness, run on **MySQL and
  Postgres only**):
  * capture correctness: commit vs rollback, nested tx, long-tx hole filling,
    trigger repair after table recreation;
  * contracts from §6.4;
  * idempotency: concurrent duplicates, replay, crash-window duplicate detection;
  * reconnect, retention (`bootstrap_required`), revocation purge, backpressure;
  * fuzzing the delta applier for idempotency and ordering.
* **TS:** Vitest + fast-check for the pool, overlay/rebase, intent queue, conflict
  policies (convergence properties), and schema migration that never drops intents.
* **E2E:** Playwright against docker-compose Forgejo (MySQL and PG). Covers
  multi-user and multi-tab, permission change mid-session, offline/online
  (`context.setOffline`), service worker update path, and perf traces with assertions.

---

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **MySQL won't allow trigger creation** (binlog default → SUPER / `log_bin_trust_function_creators`) | `verify` install mode with DBA-run DDL from `/-/sync/admin`. Documented setup. Fail closed to the classic UI |
| Upstream migrations drop triggers (`RecreateTables`) | Startup verify/repair + reconciliation scan + per-model epoch. Upgrade test in the canary |
| **Permission leak** | Viewer-independent payloads, per-user groups, epochs, differential tests, security review |
| **Offline edits lost or duplicated** | Durable IDB intents, idempotency keys + server dedupe, drafts on every failure path, property-based tests |
| Offline edits clobber others' work | Per-type conflict policy (set-ops commute, 3-way body merge, LWW with visible override + undo) |
| Upstream churn breaks the materializer or gap endpoints | Typed models (compile errors), service-layer-only calls, `SURFACE.md`, nightly canary |
| Client memory / bootstrap size | Two tiers, recency-bounded summaries, LRU, measured in Phase 0 |
| Scale ceiling | §4.11 invariants from day one. 10× load test before beta |
| Stale service worker | Versioned activation, `notice{new_build}`, self-unregister kill switch |
| Scope creep | Deep-link escape hatch to the classic UI. Phases ordered by daily-use value |

---

## 11. Remaining open questions

1. **MariaDB:** is "MySQL" strictly MySQL 8.x, or should MariaDB be in the CI matrix
   too? The trigger syntax is the same, but the privilege and binlog defaults differ
   slightly.
2. **MySQL privileges in your deployment:** can Forgejo's DB user be given
   `SUPER`/`log_bin_trust_function_creators=1`, or should we plan for DBA-installed
   triggers (`verify` mode) by default?
3. **Offline PR creation:** this plan makes it online-only, because it needs a live
   compare. Is that acceptable?

---

## 12. Later / stretch

* Yjs collaborative editing of issue bodies, plus presence/typing over the same socket.
* A desktop shell (Tauri) reusing the SPA. Bearer token + WS already suit native clients.
* wa-sqlite on OPFS if client queries outgrow in-memory indexes.
* Server-evaluated first-party feature flags inlined into `index.html` for
  loading-strategy experiments.
