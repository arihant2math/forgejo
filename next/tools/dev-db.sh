#!/usr/bin/env bash
# Copyright 2026 The Forgejo Authors. All rights reserved.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# dev-db.sh — bring up throwaway PostgreSQL and MySQL servers for livesync
# development and Forgejo's integration tests. Idempotent: running `start`
# twice is a no-op, `stop` on a stopped server is a no-op.
#
# Usage: next/tools/dev-db.sh {start|stop|status|env|reset} [pg|mysql|mariadb|all]
#        (`all` = pg + mysql; `mariadb` is opt-in and runs in docker on :3307)
#
#   start   install missing binaries (apt, MySQL only), init data dir, start
#   stop    stop the server(s) cleanly
#   status  print whether each server is up, plus connection settings
#   env     print `export ...` lines for Forgejo's Makefile test variables
#           (eval "$(next/tools/dev-db.sh env)")
#   reset   stop and DELETE the data dir(s), then start fresh
#
# Defaults (override with env vars):
#   NEXT_DB_ROOT=/var/tmp/forgejo-next-db   data + logs + sockets
#   NEXT_PG_PORT=5432   NEXT_MYSQL_PORT=3306
#   NEXT_MYSQL_BINLOG=on|off   (default on, matching MySQL 8 defaults; trigger
#                               creation by non-SUPER users then needs
#                               log_bin_trust_function_creators=1)
#
# Accounts created:
#   PostgreSQL 16:  postgres/postgres (superuser), forgejo/forgejo (non-superuser,
#                   CREATEDB) — both over TCP 127.0.0.1 with scram-sha-256.
#   MySQL 8.0:      root/<empty> (root@localhost and root@'%'),
#                   forgejo/forgejo (ALL on `forgejo%`/`testgitea%` DBs, no SUPER).
set -euo pipefail

ROOT_DIR="${NEXT_DB_ROOT:-/var/tmp/forgejo-next-db}"
PG_PORT="${NEXT_PG_PORT:-5432}"
MYSQL_PORT="${NEXT_MYSQL_PORT:-3306}"
MYSQL_BINLOG="${NEXT_MYSQL_BINLOG:-on}"

PG_DIR="$ROOT_DIR/pg"
PG_DATA="$PG_DIR/data"
PG_LOG="$PG_DIR/postgres.log"
PG_SOCK_DIR="$PG_DIR/run"

MY_DIR="$ROOT_DIR/mysql"
MY_DATA="$MY_DIR/data"
MY_LOG="$MY_DIR/mysqld.err"
MY_SOCK="$MY_DIR/mysqld.sock"
MY_PID="$MY_DIR/mysqld.pid"
MY_CNF="$MY_DIR/my.cnf"

log() { printf '[dev-db] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

is_root() { [ "$(id -u)" = 0 ]; }

# ---------------------------------------------------------------- PostgreSQL

pg_bindir() {
  local d
  for d in /usr/lib/postgresql/*/bin; do
    [ -x "$d/pg_ctl" ] && { echo "$d"; return 0; }
  done
  command -v pg_ctl >/dev/null 2>&1 && { dirname "$(command -v pg_ctl)"; return 0; }
  return 1
}

# Run a command as the postgres OS user (initdb/postgres refuse to run as root).
as_pg() {
  if is_root; then
    (cd / && runuser -u postgres -- "$@")
  else
    "$@"
  fi
}

pg_ensure_binaries() {
  if ! pg_bindir >/dev/null; then
    is_root || die "PostgreSQL binaries missing and not root; install postgresql-16"
    log "installing postgresql via apt"
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends postgresql >/dev/null
  fi
  if is_root && ! id postgres >/dev/null 2>&1; then
    useradd --system --home-dir "$PG_DIR" --shell /usr/sbin/nologin postgres
  fi
}

pg_running() {
  local bin; bin="$(pg_bindir)" || return 1
  [ -f "$PG_DATA/PG_VERSION" ] || return 1
  as_pg "$bin/pg_ctl" -D "$PG_DATA" status >/dev/null 2>&1
}

pg_start() {
  pg_ensure_binaries
  local bin; bin="$(pg_bindir)"
  mkdir -p "$PG_DIR" "$PG_SOCK_DIR"
  is_root && chown -R postgres:postgres "$PG_DIR"
  if [ ! -f "$PG_DATA/PG_VERSION" ]; then
    log "initdb $PG_DATA"
    local pw="$PG_DIR/.pw"
    echo postgres >"$pw"
    is_root && chown postgres "$pw"
    as_pg "$bin/initdb" -D "$PG_DATA" -U postgres --pwfile="$pw" \
      --auth-local=trust --auth-host=scram-sha-256 -E UTF8 --locale=C.UTF-8 >/dev/null
    rm -f "$pw"
    cat >>"$PG_DATA/postgresql.conf" <<EOF
# --- forgejo next dev-db ---
listen_addresses = '127.0.0.1'
port = $PG_PORT
unix_socket_directories = '$PG_SOCK_DIR'
max_connections = 200
fsync = off
synchronous_commit = off
full_page_writes = off
EOF
  fi
  if pg_running; then
    log "postgres already running"
  else
    log "starting postgres on 127.0.0.1:$PG_PORT"
    as_pg "$bin/pg_ctl" -D "$PG_DATA" -l "$PG_LOG" -w -t 60 start >/dev/null \
      || { tail -20 "$PG_LOG" >&2; die "postgres failed to start"; }
  fi
  # Idempotent role setup (via the local socket, trust auth).
  as_pg "$bin/psql" -h "$PG_SOCK_DIR" -p "$PG_PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'forgejo') THEN
    CREATE ROLE forgejo LOGIN PASSWORD 'forgejo' CREATEDB;
  END IF;
END $$;
SQL
  # Forgejo's tests/test_utils.go connects *to* TEST_PGSQL_DBNAME to check
  # that it exists (CI's postgres image pre-creates it), so pre-create it.
  local dbname
  for dbname in testgitea forgejo; do
    if [ -z "$(as_pg "$bin/psql" -h "$PG_SOCK_DIR" -p "$PG_PORT" -U postgres -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='$dbname'")" ]; then
      as_pg "$bin/createdb" -h "$PG_SOCK_DIR" -p "$PG_PORT" -U postgres "$dbname"
    fi
  done
}

pg_stop() {
  local bin; bin="$(pg_bindir)" || { log "postgres not installed"; return 0; }
  if pg_running; then
    log "stopping postgres"
    as_pg "$bin/pg_ctl" -D "$PG_DATA" -m fast -w stop >/dev/null
  else
    log "postgres not running"
  fi
}

pg_status() {
  if pg_running; then
    echo "postgres: UP   host=127.0.0.1 port=$PG_PORT superuser=postgres/postgres app=forgejo/forgejo socket=$PG_SOCK_DIR data=$PG_DATA"
    echo "          psql: PGPASSWORD=postgres psql -h 127.0.0.1 -p $PG_PORT -U postgres"
  else
    echo "postgres: DOWN (data=$PG_DATA)"
  fi
}

# --------------------------------------------------------------------- MySQL

my_ensure_binaries() {
  if ! command -v mysqld >/dev/null 2>&1 && [ ! -x /usr/sbin/mysqld ]; then
    is_root || die "mysqld missing and not root; install mysql-server-core-8.0"
    log "installing mysql-server-core-8.0 + mysql-client-core-8.0 via apt"
    if ! DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      mysql-server-core-8.0 mysql-client-core-8.0 >/dev/null 2>&1; then
      apt-get update >/dev/null
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        mysql-server-core-8.0 mysql-client-core-8.0 >/dev/null
    fi
  fi
}

mysqld_bin() { command -v mysqld 2>/dev/null || echo /usr/sbin/mysqld; }

my_cli() { mysql --no-defaults -uroot -S "$MY_SOCK" "$@"; }

my_running() {
  [ -S "$MY_SOCK" ] || return 1
  mysqladmin --no-defaults -uroot -S "$MY_SOCK" ping >/dev/null 2>&1
}

my_write_cnf() {
  local binlog_line="log_bin_trust_function_creators = 0"
  [ "$MYSQL_BINLOG" = off ] && binlog_line="skip-log-bin"
  cat >"$MY_CNF" <<EOF
[mysqld]
user = $(id -un)
datadir = $MY_DATA
socket = $MY_SOCK
pid-file = $MY_PID
log-error = $MY_LOG
bind-address = 127.0.0.1
port = $MYSQL_PORT
mysqlx = OFF
character-set-server = utf8mb4
collation-server = utf8mb4_0900_ai_ci
innodb_flush_log_at_trx_commit = 2
sync_binlog = 0
innodb_buffer_pool_size = 256M
max_connections = 300
secure-file-priv = ""
$binlog_line
EOF
}

my_start() {
  my_ensure_binaries
  mkdir -p "$MY_DIR"
  my_write_cnf
  if [ ! -d "$MY_DATA/mysql" ]; then
    log "mysqld --initialize-insecure $MY_DATA"
    rm -rf "$MY_DATA"
    "$(mysqld_bin)" --defaults-file="$MY_CNF" --initialize-insecure >/dev/null 2>&1 \
      || { tail -20 "$MY_LOG" >&2; die "mysqld --initialize failed"; }
  fi
  if my_running; then
    log "mysql already running"
  else
    log "starting mysqld on 127.0.0.1:$MYSQL_PORT (binlog=$MYSQL_BINLOG)"
    rm -f "$MY_SOCK" "$MY_SOCK.lock"
    nohup "$(mysqld_bin)" --defaults-file="$MY_CNF" >/dev/null 2>&1 &
    local i
    for i in $(seq 1 120); do
      my_running && break
      sleep 0.5
    done
    my_running || { tail -30 "$MY_LOG" >&2; die "mysqld failed to start"; }
  fi
  my_cli <<'SQL'
CREATE USER IF NOT EXISTS 'root'@'%' IDENTIFIED BY '';
GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' WITH GRANT OPTION;
CREATE USER IF NOT EXISTS 'forgejo'@'%' IDENTIFIED BY 'forgejo';
CREATE USER IF NOT EXISTS 'forgejo'@'localhost' IDENTIFIED BY 'forgejo';
GRANT ALL PRIVILEGES ON `forgejo%`.* TO 'forgejo'@'%';
GRANT ALL PRIVILEGES ON `forgejo%`.* TO 'forgejo'@'localhost';
GRANT ALL PRIVILEGES ON `testgitea%`.* TO 'forgejo'@'%';
GRANT ALL PRIVILEGES ON `testgitea%`.* TO 'forgejo'@'localhost';
FLUSH PRIVILEGES;
SQL
}

my_stop() {
  if my_running; then
    log "stopping mysqld"
    mysqladmin --no-defaults -uroot -S "$MY_SOCK" shutdown >/dev/null 2>&1 || true
    local i
    for i in $(seq 1 60); do
      [ -f "$MY_PID" ] || break
      sleep 0.5
    done
  else
    log "mysql not running"
  fi
}

my_status() {
  if my_running; then
    local v; v="$(my_cli -N -e 'SELECT CONCAT(VERSION(), " log_bin=", @@log_bin, " log_bin_trust_function_creators=", @@log_bin_trust_function_creators)')"
    echo "mysql:    UP   host=127.0.0.1 port=$MYSQL_PORT root/<empty> app=forgejo/forgejo socket=$MY_SOCK ($v)"
    echo "          cli: mysql -h 127.0.0.1 -P $MYSQL_PORT -uroot"
  else
    echo "mysql:    DOWN (data=$MY_DATA)"
  fi
}

# ---------------------------------------------- MariaDB (optional, via docker)
# Not part of `all`. Used only to answer PLAN §11 Q1 (MariaDB in the matrix?).

MARIA_PORT="${NEXT_MARIADB_PORT:-3307}"
MARIA_IMAGE="${NEXT_MARIADB_IMAGE:-mariadb:11}"
MARIA_NAME=forgejo-next-mariadb

docker_ensure() {
  docker info >/dev/null 2>&1 && return 0
  is_root || die "docker daemon not running and not root"
  log "starting dockerd (log: $ROOT_DIR/dockerd.log)"
  mkdir -p "$ROOT_DIR"
  nohup dockerd >"$ROOT_DIR/dockerd.log" 2>&1 &
  local i
  for i in $(seq 1 60); do docker info >/dev/null 2>&1 && return 0; sleep 0.5; done
  die "dockerd failed to start"
}

maria_running() {
  docker info >/dev/null 2>&1 || return 1
  [ "$(docker inspect -f '{{.State.Running}}' "$MARIA_NAME" 2>/dev/null)" = true ] || return 1
  mysql --no-defaults -h 127.0.0.1 -P "$MARIA_PORT" -uroot -e 'SELECT 1' >/dev/null 2>&1
}

maria_start() {
  docker_ensure
  if maria_running; then log "mariadb already running"; return 0; fi
  if docker inspect "$MARIA_NAME" >/dev/null 2>&1; then
    docker start "$MARIA_NAME" >/dev/null
  else
    log "starting $MARIA_IMAGE on 127.0.0.1:$MARIA_PORT"
    docker run -d --name "$MARIA_NAME" -e MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1 \
      -p "127.0.0.1:$MARIA_PORT:3306" "$MARIA_IMAGE" \
      --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci --log-bin >/dev/null
  fi
  local i
  for i in $(seq 1 120); do maria_running && return 0; sleep 0.5; done
  docker logs --tail 20 "$MARIA_NAME" >&2 || true
  die "mariadb failed to start"
}

maria_stop() {
  if docker info >/dev/null 2>&1 && docker inspect "$MARIA_NAME" >/dev/null 2>&1; then
    log "removing mariadb container"
    docker rm -f "$MARIA_NAME" >/dev/null
  else
    log "mariadb not running"
  fi
}

maria_status() {
  if maria_running; then
    echo "mariadb:  UP   host=127.0.0.1 port=$MARIA_PORT root/<empty> (docker $MARIA_IMAGE)"
  else
    echo "mariadb:  DOWN"
  fi
}

# ---------------------------------------------------------------------- main

print_env() {
  cat <<EOF
export TEST_PGSQL_HOST=127.0.0.1:$PG_PORT
export TEST_PGSQL_DBNAME=testgitea
export TEST_PGSQL_USERNAME=postgres
export TEST_PGSQL_PASSWORD=postgres
export TEST_PGSQL_SCHEMA=gtestschema
export TEST_MYSQL_HOST=127.0.0.1:$MYSQL_PORT
export TEST_MYSQL_DBNAME='testgitea?multiStatements=true'
export TEST_MYSQL_USERNAME=root
export TEST_MYSQL_PASSWORD=
export TEST_STORAGE_TYPE=local
EOF
  # Forgejo refuses to start as root (modules/setting/setting.go) unless told otherwise.
  if is_root; then echo "export GITEA_I_AM_BEING_UNSAFE_RUNNING_AS_ROOT=true"; fi
}

cmd="${1:-status}"
which="${2:-all}"
case "$which" in
pg|postgres) which=pg ;;
mysql|my) which=mysql ;;
mariadb|maria) which=mariadb ;;
all) ;;
*) die "unknown target '$which' (pg|mysql|mariadb|all)" ;;
esac

do_for() {
  local action="$1"
  if [ "$which" = all ] || [ "$which" = pg ]; then "pg_$action"; fi
  if [ "$which" = all ] || [ "$which" = mysql ]; then "my_$action"; fi
  if [ "$which" = mariadb ]; then "maria_$action"; fi
}

case "$cmd" in
start) do_for start; do_for status ;;
stop) do_for stop ;;
status) do_for status ;;
env) print_env ;;
reset)
  do_for stop
  if [ "$which" = all ] || [ "$which" = pg ]; then rm -rf "$PG_DIR"; fi
  if [ "$which" = all ] || [ "$which" = mysql ]; then rm -rf "$MY_DIR"; fi
  do_for start
  do_for status
  ;;
*) die "usage: $0 {start|stop|status|env|reset} [pg|mysql|mariadb|all]" ;;
esac
