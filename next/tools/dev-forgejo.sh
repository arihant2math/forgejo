#!/usr/bin/env bash
# Copyright 2026 The Forgejo Authors. All rights reserved.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# dev-forgejo.sh — build this tree and run a throwaway Forgejo against the
# dev databases from dev-db.sh. Idempotent.
#
# Usage: next/tools/dev-forgejo.sh {start|stop|kill|restart|status|build|logs} [pg|mysql]
#        next/tools/dev-forgejo.sh conformance [pg|mysql|all] [vitest args…]
#        next/tools/dev-forgejo.sh e2e [pg|mysql|all] [playwright args…]
#
#   pg    -> http://127.0.0.1:3000/  database `forgejo` on 127.0.0.1:5432
#   mysql -> http://127.0.0.1:3010/  database `forgejo` on 127.0.0.1:3306
#
# A site admin `dev` / `devdevdev1` is created on first start.
# Extra app.ini lines can be appended via NEXT_FORGEJO_EXTRA_INI (e.g. a
# "[livesync]" section). Binary is built without bindata, so STATIC_ROOT_PATH
# points at this checkout (templates/options/public are read from disk).
#
# `kill` stops the server with SIGKILL (no graceful shutdown: a crash).
# NEXT_DEV_ROOT, NEXT_FORGEJO_PORT and NEXT_FORGEJO_DB_NAME (default `forgejo`)
# select another instance (work dir + binary, port, database).
#
# `conformance` (B10) runs the headless conformance suite (next/conformance)
# against its OWN instances, never the dev servers above (which other
# sessions' Playwright/integration runs use): binary and work dirs under
# /var/tmp/forgejo-next-conformance (NEXT_CONFORMANCE_ROOT), ports 3020 (pg)
# and 3030 (mysql) (NEXT_CONFORMANCE_PG_PORT / NEXT_CONFORMANCE_MYSQL_PORT),
# database `forgejo_conformance` (dropped and created again per run). It
# builds that binary, then per database starts a fresh instance with livesync
# enabled (conformance_ini below), runs the suite against it — with the hooks
# the suite uses to crash/restart that instance and to reach its database —
# and stops it; a passing run then drops the database and the work dir
# but its logs (NEXT_CONFORMANCE_KEEP=1 keeps the instance running and its
# data; a failing run keeps the data). NEXT_CONFORMANCE_NO_BUILD=1 reuses the
# binary. Arguments after the database are passed to Vitest (e.g. a file
# name filter).
#
# `e2e` (F8) runs the Playwright suite's `forgejo` project (next/e2e/forgejo)
# the same way: its own binary and work dirs under /var/tmp/forgejo-next-e2e
# (NEXT_E2E_ROOT), ports 3040 (pg) and 3050 (mysql) (NEXT_E2E_PG_PORT /
# NEXT_E2E_MYSQL_PORT), database `forgejo_e2e` (dropped and created again per
# run), livesync and Actions enabled and this checkout's build (next/dist,
# built first unless NEXT_E2E_NO_BUILD=1) served by B8 (ASSETS_DIR), and
# /metrics on (rum.spec.ts reads the RUM counters). A passing
# run drops the database; NEXT_E2E_KEEP=1 keeps the instance running.
# Arguments after the database go to Playwright (e.g. a file filter, --repeat-each).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEV_ROOT=/var/tmp/forgejo-next-dev
ROOT_DIR="${NEXT_DEV_ROOT:-$DEV_ROOT}"
BIN="$ROOT_DIR/forgejo"
DB_NAME="${NEXT_FORGEJO_DB_NAME:-forgejo}"
CONF_ROOT="${NEXT_CONFORMANCE_ROOT:-/var/tmp/forgejo-next-conformance}"
CONF_DB_NAME=forgejo_conformance
E2E_ROOT="${NEXT_E2E_ROOT:-/var/tmp/forgejo-next-e2e}"
E2E_DB_NAME=forgejo_e2e
cmd="${1:-status}"
db="${2:-pg}"
conf_dbs="$db"
if { [ "$cmd" = conformance ] || [ "$cmd" = e2e ]; } && [ "$db" = all ]; then conf_dbs="pg mysql"; db=pg; fi
if [ $# -ge 2 ]; then shift 2; else shift $#; fi

case "$db" in
pg|postgres) db=pg; PORT="${NEXT_FORGEJO_PORT:-3000}" ;;
mysql) PORT="${NEXT_FORGEJO_PORT:-3010}" ;; # not 3001-3003: the integration tests listen there
*) echo "unknown db '$db' (pg|mysql)" >&2; exit 1 ;;
esac

WORK="$ROOT_DIR/$db"
INI="$WORK/custom/conf/app.ini"
PIDFILE="$WORK/forgejo.pid"
URL="http://127.0.0.1:$PORT/"
export GITEA_WORK_DIR="$WORK"
[ "$(id -u)" = 0 ] && export GITEA_I_AM_BEING_UNSAFE_RUNNING_AS_ROOT=true

log() { printf '[dev-forgejo] %s\n' "$*" >&2; }

build() {
  mkdir -p "$ROOT_DIR"
  log "go build -> $BIN"
  (cd "$REPO" && go build -tags 'sqlite sqlite_unlock_notify' -o "$BIN" .)
}

running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

# admin_sql runs SQL (stdin) as the database's superuser, outside DB_NAME.
admin_sql() {
  if [ "$db" = pg ]; then
    PGPASSWORD=postgres psql -h 127.0.0.1 -p 5432 -U postgres -d postgres -X -q -A -t -v ON_ERROR_STOP=1
  else
    mysql --no-defaults -h 127.0.0.1 -P 3306 -uroot -N -B
  fi
}

# ensure_db creates DB_NAME if it is missing.
ensure_db() {
  if [ "$db" = pg ]; then
    if [ -z "$(echo "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME';" | admin_sql)" ]; then
      echo "CREATE DATABASE \"$DB_NAME\";" | admin_sql
    fi
  else
    echo "CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;" | admin_sql
  fi
}

# drop_db drops DB_NAME (only ever the conformance database).
drop_db() {
  if [ "$db" = pg ]; then
    echo "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE);" | admin_sql
  else
    echo "DROP DATABASE IF EXISTS \`$DB_NAME\`;" | admin_sql
  fi
}

write_ini() {
  mkdir -p "$(dirname "$INI")"
  local dbsec
  ensure_db
  if [ "$db" = pg ]; then
    dbsec="DB_TYPE = postgres"$'\n'"HOST = 127.0.0.1:5432"$'\n'"NAME = $DB_NAME"$'\n'"USER = postgres"$'\n'"PASSWD = postgres"$'\n'"SSL_MODE = disable"
  else
    dbsec="DB_TYPE = mysql"$'\n'"HOST = 127.0.0.1:3306"$'\n'"NAME = $DB_NAME"$'\n'"USER = root"$'\n'"PASSWD ="
  fi
  cat >"$INI" <<EOF
APP_NAME = Forgejo Next dev ($db)
RUN_MODE = dev

[database]
$dbsec

[server]
HTTP_ADDR = 127.0.0.1
HTTP_PORT = $PORT
ROOT_URL = $URL
APP_DATA_PATH = $WORK/data
STATIC_ROOT_PATH = $REPO
OFFLINE_MODE = true
DISABLE_SSH = true
; Each instance its own internal socket (git hooks call back through it). The default,
; /run/forgejo/internal.sock, is shared by every local instance: stopping one removed it
; and broke pushes, merges and contents API writes on the others.
INTERNAL_LISTENER_PATH = $WORK/internal.sock

[security]
INSTALL_LOCK = true

[service]
DISABLE_REGISTRATION = false
REQUIRE_SIGNIN_VIEW = false

[repository]
ROOT = $WORK/repos

[log]
MODE = file
LEVEL = Info
ROOT_PATH = $WORK/log

[mailer]
ENABLED = false

${NEXT_FORGEJO_EXTRA_INI:-}
EOF
  # The Forgejo Next toggle on classic pages (routers/livesync/classic.go): "Try Forgejo Next", and once opted
  # in "Back to Forgejo Next" / "Turn off". Operators install the same file (the admin page shows it).
  mkdir -p "$WORK/custom/templates/custom"
  cp "$REPO/routers/livesync/classic_header.tmpl" "$WORK/custom/templates/custom/header.tmpl"
}

start() {
  if running; then log "already running at $URL (pid $(cat "$PIDFILE"))"; return 0; fi
  "$REPO/next/tools/dev-db.sh" start "$( [ "$db" = pg ] && echo pg || echo mysql )" >/dev/null
  [ -x "$BIN" ] || build
  write_ini
  log "starting $URL (logs: $WORK/log, stdout: $WORK/web.out)"
  # `cd && nohup … &` would background a subshell: $! would be that subshell
  # (wrong pid) and it would keep the caller's stdout open (a pipe never closes).
  (cd "$WORK" || exit 1; nohup "$BIN" web -c "$INI" </dev/null >"$WORK/web.out" 2>&1 & echo $! >"$PIDFILE")
  local i
  for i in $(seq 1 240); do
    curl -sf "${URL}api/v1/version" >/dev/null 2>&1 && break
    running || { tail -20 "$WORK/web.out" "$WORK"/log/*.log >&2 2>/dev/null; log "forgejo exited"; exit 1; }
    sleep 0.5
  done
  curl -sf "${URL}api/v1/version" >/dev/null || { log "forgejo did not become ready"; exit 1; }
  if ! curl -sf -u dev:devdevdev1 "${URL}api/v1/user" >/dev/null; then
    "$BIN" -c "$INI" admin user create --admin --username dev --password devdevdev1 \
      --email dev@example.com --must-change-password=false >/dev/null
  fi
  status
}

# kill_server simulates a crash: SIGKILL, no graceful shutdown hooks run.
kill_server() {
  if running; then
    log "killing pid $(cat "$PIDFILE") (SIGKILL)"
    kill -9 "$(cat "$PIDFILE")" 2>/dev/null || true
    local i
    for i in $(seq 1 40); do running || break; sleep 0.25; done
  else
    log "not running"
  fi
  rm -f "$PIDFILE"
}

# conformance_ini is the configuration the suite expects (its
# CONFORMANCE_MAX_REPLAY must equal MAX_REPLAY): a small replay limit
# (bootstrap_required{replay_too_long}), a fast trigger watch (a dropped
# capture trigger is repaired while the server runs: trigger_repaired), and
# a sync-id wait long enough to crash the server between a write's commit and
# its idempotency record.
conformance_ini() {
  printf '%s\n' '[livesync]' 'ENABLED = true' 'INSTALL_MODE = auto' 'MAX_REPLAY = 100' \
    'TRIGGER_CHECK_INTERVAL = 2s' 'IDEMPOTENCY_SYNC_WAIT = 30s' '' '[actions]' 'ENABLED = true'
}

# sql_argv prints, as a JSON array, a command that runs the SQL on its stdin
# against this instance's database (the suite spawns it; PGPASSWORD is set).
sql_argv() {
  if [ "$db" = pg ]; then
    printf '["psql","-h","127.0.0.1","-p","5432","-U","postgres","-d","%s","-X","-q","-A","-t","-v","ON_ERROR_STOP=1"]' "$DB_NAME"
  else
    printf '["mysql","--no-defaults","-h","127.0.0.1","-P","3306","-uroot","-N","-B","-n","%s"]' "$DB_NAME"
  fi
}

# conformance_instance prints the environment that selects the conformance
# instance of database $1 (its own work dir, binary, port and database).
conformance_instance() {
  local port
  if [ "$1" = pg ]; then port="${NEXT_CONFORMANCE_PG_PORT:-3020}"; else port="${NEXT_CONFORMANCE_MYSQL_PORT:-3030}"; fi
  printf 'NEXT_DEV_ROOT=%s NEXT_FORGEJO_PORT=%s NEXT_FORGEJO_DB_NAME=%s' "$CONF_ROOT" "$port" "$CONF_DB_NAME"
}

# conformance_one runs the suite against this invocation's instance, which
# `conformance` selected (conformance_instance); it refuses the dev servers.
conformance_one() {
  if [ "$ROOT_DIR" = "$DEV_ROOT" ] || [ "$DB_NAME" = forgejo ]; then
    log "conformance-one runs only on a conformance instance (use: $0 conformance $db)"; return 1
  fi
  local self="$REPO/next/tools/dev-forgejo.sh" inst rc=0
  inst="$(conformance_instance "$db")"
  NEXT_FORGEJO_EXTRA_INI="$(conformance_ini)
${NEXT_FORGEJO_EXTRA_INI:-}"
  export NEXT_FORGEJO_EXTRA_INI # the suite's restarts (CONFORMANCE_START_CMD) write the same app.ini
  stop
  # A fresh instance every run: nothing of an earlier run is left over.
  "$REPO/next/tools/dev-db.sh" start "$db" >/dev/null
  drop_db
  rm -rf "$WORK"
  start
  log "conformance suite against $URL ($db, database $DB_NAME, work dir $WORK)"
  (
    cd "$REPO/next"
    FORGEJO_URL="${URL%/}" FORGEJO_ADMIN_USER=dev FORGEJO_ADMIN_PASSWORD=devdevdev1 \
      CONFORMANCE_DB="$db" CONFORMANCE_SQL="$(sql_argv)" PGPASSWORD=postgres \
      CONFORMANCE_KILL_CMD="env $inst '$self' kill $db" CONFORMANCE_STOP_CMD="env $inst '$self' stop $db" \
      CONFORMANCE_START_CMD="env $inst '$self' start $db" \
      CONFORMANCE_MAX_REPLAY=100 \
      npm run test:conformance -- "$@"
  ) || rc=$?
  if [ "${NEXT_CONFORMANCE_KEEP:-}" = 1 ]; then
    log "kept running: $URL (data: $WORK, database $DB_NAME)"
  else
    stop
    if [ "$rc" = 0 ]; then
      # Keep only the logs (small; the next run starts from scratch anyway).
      drop_db
      find "$WORK" -mindepth 1 -maxdepth 1 ! -name log ! -name web.out -exec rm -rf {} +
      log "server log: $WORK/log ($(cat "$WORK"/log/*.log 2>/dev/null | grep -c ' \[[EF]\] ' || true) [E]/[F] lines)"
    else
      log "failed: logs in $WORK/log and $WORK/web.out (database $DB_NAME kept)"
    fi
  fi
  return "$rc"
}

conformance() {
  local d failed=""
  [ "${NEXT_CONFORMANCE_NO_BUILD:-}" = 1 ] && [ -x "$CONF_ROOT/forgejo" ] || NEXT_DEV_ROOT="$CONF_ROOT" "$REPO/next/tools/dev-forgejo.sh" build
  [ -d "$REPO/next/node_modules" ] || (cd "$REPO/next" && npm ci --no-audit --no-fund)
  for d in $conf_dbs; do
    # shellcheck disable=SC2046 # word splitting of the NAME=value list is intended
    env $(conformance_instance "$d") "$REPO/next/tools/dev-forgejo.sh" conformance-one "$d" "$@" || failed="$failed $d"
  done
  if [ -n "$failed" ]; then
    log "conformance FAILED on:$failed"
    return 1
  fi
  log "conformance passed on: $conf_dbs"
}

# e2e_instance prints the environment that selects the e2e instance of
# database $1 (like conformance_instance).
e2e_instance() {
  local port
  if [ "$1" = pg ]; then port="${NEXT_E2E_PG_PORT:-3040}"; else port="${NEXT_E2E_MYSQL_PORT:-3050}"; fi
  printf 'NEXT_DEV_ROOT=%s NEXT_FORGEJO_PORT=%s NEXT_FORGEJO_DB_NAME=%s' "$E2E_ROOT" "$port" "$E2E_DB_NAME"
}

# e2e_one runs the forgejo Playwright project against this invocation's
# instance, which `e2e` selected; it refuses the dev servers.
e2e_one() {
  if [ "$ROOT_DIR" = "$DEV_ROOT" ] || [ "$DB_NAME" = forgejo ]; then
    log "e2e-one runs only on an e2e instance (use: $0 e2e $db)"; return 1
  fi
  local rc=0
  NEXT_FORGEJO_EXTRA_INI="$(printf '%s\n' '[livesync]' 'ENABLED = true' "ASSETS_DIR = $REPO/next/dist" '' '[actions]' 'ENABLED = true' '' '[metrics]' 'ENABLED = true')
${NEXT_FORGEJO_EXTRA_INI:-}"
  export NEXT_FORGEJO_EXTRA_INI
  stop
  "$REPO/next/tools/dev-db.sh" start "$db" >/dev/null
  drop_db
  rm -rf "$WORK"
  start
  log "e2e suite against $URL ($db, database $DB_NAME, work dir $WORK)"
  (
    cd "$REPO/next"
    NEXT_E2E_NO_SERVERS=1 NEXT_FORGEJO_URL="${URL%/}" NEXT_E2E_DB="$db" \
      npx playwright test --project forgejo --no-deps "$@"
  ) || rc=$?
  if [ "${NEXT_E2E_KEEP:-}" = 1 ]; then
    log "kept running: $URL (data: $WORK, database $DB_NAME)"
  else
    stop
    if [ "$rc" = 0 ]; then
      drop_db
      find "$WORK" -mindepth 1 -maxdepth 1 ! -name log ! -name web.out -exec rm -rf {} +
      log "server log: $WORK/log ($(cat "$WORK"/log/*.log 2>/dev/null | grep -c ' \[[EF]\] ' || true) [E]/[F] lines)"
    else
      log "failed: logs in $WORK/log and $WORK/web.out (database $DB_NAME kept)"
    fi
  fi
  return "$rc"
}

e2e() {
  local d failed=""
  [ "${NEXT_E2E_NO_BUILD:-}" = 1 ] && [ -x "$E2E_ROOT/forgejo" ] || NEXT_DEV_ROOT="$E2E_ROOT" "$REPO/next/tools/dev-forgejo.sh" build
  [ -d "$REPO/next/node_modules" ] || (cd "$REPO/next" && npm ci --no-audit --no-fund)
  [ "${NEXT_E2E_NO_BUILD:-}" = 1 ] && [ -f "$REPO/next/dist/index.html" ] || (cd "$REPO/next" && npx vite build >/dev/null)
  # The sandbox has no Playwright-managed Chromium of this version; use the preinstalled one when present.
  if [ -z "${PLAYWRIGHT_CHROMIUM:-}" ] && [ -x /opt/pw-browsers/chromium ]; then export PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium; fi
  for d in $conf_dbs; do
    # The update path and kill switch tests rewrite dist/ in place and restore it; a run killed in between
    # leaves it changed: put it back before each database.
    if [ -f "$REPO/next/dist/sw.js.off" ]; then mv -f "$REPO/next/dist/sw.js.off" "$REPO/next/dist/sw.js"; fi
    if grep -q 'e2e001' "$REPO/next/dist/index.html" "$REPO/next/dist/sw.js" 2>/dev/null; then (cd "$REPO/next" && npx vite build >/dev/null); fi
    # shellcheck disable=SC2046 # word splitting of the NAME=value list is intended
    env $(e2e_instance "$d") "$REPO/next/tools/dev-forgejo.sh" e2e-one "$d" "$@" || failed="$failed $d"
  done
  if [ -n "$failed" ]; then
    log "e2e FAILED on:$failed"
    return 1
  fi
  log "e2e passed on: $conf_dbs"
}

stop() {
  if running; then
    log "stopping pid $(cat "$PIDFILE")"
    kill "$(cat "$PIDFILE")"
    local i
    for i in $(seq 1 40); do running || break; sleep 0.25; done
    running && kill -9 "$(cat "$PIDFILE")" 2>/dev/null || true
  else
    log "not running"
  fi
  rm -f "$PIDFILE"
}

status() {
  if running; then
    echo "forgejo($db): UP   $URL  admin=dev/devdevdev1  ini=$INI"
  else
    echo "forgejo($db): DOWN"
  fi
}

case "$cmd" in
build) build ;;
start) start ;;
stop) stop ;;
kill) kill_server ;;
restart) stop; build; start ;;
status) status ;;
logs) tail -n 50 "$WORK"/log/*.log ;;
conformance) conformance "$@" ;;
conformance-one) conformance_one "$@" ;;
e2e) e2e "$@" ;;
e2e-one) e2e_one "$@" ;;
*) echo "usage: $0 {start|stop|kill|restart|status|build|logs} [pg|mysql] | conformance|e2e [pg|mysql|all] [args…]" >&2; exit 1 ;;
esac
