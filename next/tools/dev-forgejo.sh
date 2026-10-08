#!/usr/bin/env bash
# Copyright 2026 The Forgejo Authors. All rights reserved.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# dev-forgejo.sh — build this tree and run a throwaway Forgejo against the
# dev databases from dev-db.sh. Idempotent.
#
# Usage: next/tools/dev-forgejo.sh {start|stop|kill|restart|status|build|logs} [pg|mysql]
#        next/tools/dev-forgejo.sh conformance [pg|mysql|all] [vitest args…]
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
# `conformance` (B10) rebuilds the binary, then on each database restarts
# Forgejo with livesync enabled (conformance_ini below), runs the headless
# conformance suite (next/conformance) against it — with the hooks the suite
# uses to crash/restart the server and to reach the database — and stops the
# server again (NEXT_CONFORMANCE_KEEP=1 leaves it running).
# NEXT_CONFORMANCE_NO_BUILD=1 reuses the binary. Arguments after the
# database are passed to Vitest (e.g. a file name filter).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT_DIR="${NEXT_DEV_ROOT:-/var/tmp/forgejo-next-dev}"
BIN="$ROOT_DIR/forgejo"
cmd="${1:-status}"
db="${2:-pg}"
conf_dbs="$db"
if [ "$cmd" = conformance ] && [ "$db" = all ]; then conf_dbs="pg mysql"; db=pg; fi
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

write_ini() {
  mkdir -p "$(dirname "$INI")"
  local dbsec
  if [ "$db" = pg ]; then
    dbsec=$'DB_TYPE = postgres\nHOST = 127.0.0.1:5432\nNAME = forgejo\nUSER = postgres\nPASSWD = postgres\nSSL_MODE = disable'
  else
    mysql --no-defaults -h 127.0.0.1 -P 3306 -uroot -e 'CREATE DATABASE IF NOT EXISTS forgejo CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci'
    dbsec=$'DB_TYPE = mysql\nHOST = 127.0.0.1:3306\nNAME = forgejo\nUSER = root\nPASSWD ='
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
    printf '%s' '["psql","-h","127.0.0.1","-p","5432","-U","postgres","-d","forgejo","-X","-q","-A","-t","-v","ON_ERROR_STOP=1"]'
  else
    printf '%s' '["mysql","--no-defaults","-h","127.0.0.1","-P","3306","-uroot","-N","-B","-n","forgejo"]'
  fi
}

conformance_one() {
  local self="$REPO/next/tools/dev-forgejo.sh" rc=0
  NEXT_FORGEJO_EXTRA_INI="$(conformance_ini)
${NEXT_FORGEJO_EXTRA_INI:-}"
  export NEXT_FORGEJO_EXTRA_INI # the suite's restarts (CONFORMANCE_START_CMD) write the same app.ini
  stop
  start
  log "conformance suite against $URL ($db)"
  (
    cd "$REPO/next"
    FORGEJO_URL="${URL%/}" FORGEJO_ADMIN_USER=dev FORGEJO_ADMIN_PASSWORD=devdevdev1 \
      CONFORMANCE_DB="$db" CONFORMANCE_SQL="$(sql_argv)" PGPASSWORD=postgres \
      CONFORMANCE_KILL_CMD="'$self' kill $db" CONFORMANCE_STOP_CMD="'$self' stop $db" \
      CONFORMANCE_START_CMD="'$self' start $db" \
      CONFORMANCE_MAX_REPLAY=100 \
      npm run test:conformance -- "$@"
  ) || rc=$?
  [ "${NEXT_CONFORMANCE_KEEP:-}" = 1 ] || stop
  return "$rc"
}

conformance() {
  local d failed=""
  [ "${NEXT_CONFORMANCE_NO_BUILD:-}" = 1 ] || build
  [ -d "$REPO/next/node_modules" ] || (cd "$REPO/next" && npm ci --no-audit --no-fund)
  for d in $conf_dbs; do
    "$REPO/next/tools/dev-forgejo.sh" conformance-one "$d" "$@" || failed="$failed $d"
  done
  if [ -n "$failed" ]; then
    log "conformance FAILED on:$failed"
    return 1
  fi
  log "conformance passed on: $conf_dbs"
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
*) echo "usage: $0 {start|stop|kill|restart|status|build|logs} [pg|mysql] | conformance [pg|mysql|all] [vitest args…]" >&2; exit 1 ;;
esac
