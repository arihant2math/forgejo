#!/usr/bin/env bash
# Copyright 2026 The Forgejo Authors. All rights reserved.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# dev-forgejo.sh — build this tree and run a throwaway Forgejo against the
# dev databases from dev-db.sh. Idempotent.
#
# Usage: next/tools/dev-forgejo.sh {start|stop|status|build|logs} [pg|mysql]
#
#   pg    -> http://127.0.0.1:3000/  database `forgejo` on 127.0.0.1:5432
#   mysql -> http://127.0.0.1:3010/  database `forgejo` on 127.0.0.1:3306
#
# A site admin `dev` / `devdevdev1` is created on first start.
# Extra app.ini lines can be appended via NEXT_FORGEJO_EXTRA_INI (e.g. a
# "[livesync]" section). Binary is built without bindata, so STATIC_ROOT_PATH
# points at this checkout (templates/options/public are read from disk).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT_DIR="${NEXT_DEV_ROOT:-/var/tmp/forgejo-next-dev}"
BIN="$ROOT_DIR/forgejo"
cmd="${1:-status}"
db="${2:-pg}"

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
restart) stop; build; start ;;
status) status ;;
logs) tail -n 50 "$WORK"/log/*.log ;;
*) echo "usage: $0 {start|stop|restart|status|build|logs} [pg|mysql]" >&2; exit 1 ;;
esac
