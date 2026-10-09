#!/usr/bin/env bash
# Copyright 2026 The Forgejo Authors. All rights reserved.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# ci.sh — the one command that checks everything of Forgejo Next (F8):
#
#   1. install   npm ci in next/ (NEXT_CI_NO_INSTALL=1 skips it)
#   2. check     npm run check: ESLint + Stylelint, typecheck, unit tests, build, budget
#   3. protocol  the generated protocol types are up to date (tools/gen-protocol.sh --check)
#   4. browser   Playwright without a server: the boot shell against the build, the
#                primitive gallery and the hydration benchmark (projects build, dev)
#   5. conformance  the headless protocol suite (B10) on PostgreSQL and MySQL
#   6. e2e       the Playwright suite against a real Forgejo (next/e2e/forgejo) on
#                PostgreSQL and MySQL, perf assertions included
#
# Every step runs (a failure does not stop the others); the summary lists each
# step's result and time, and the perf numbers the e2e suite measured. Exit 1
# when any step failed. Logs and the perf report go to $NEXT_CI_OUT
# (default /var/tmp/forgejo-next-ci/<time>/).
#
#   next/tools/ci.sh                 # everything
#   next/tools/ci.sh check e2e       # only these steps
#   NEXT_CI_DBS=pg next/tools/ci.sh  # conformance and e2e on one database
#
# Needs: Go, Node ≥ 22.18, the dev databases (tools/dev-db.sh, started here), a
# Chromium for Playwright (PLAYWRIGHT_CHROMIUM, defaults to the sandbox's
# /opt/pw-browsers/chromium when present). Takes ≈ 25 min here, most of it
# the e2e suite's seeding and its two databases.
set -uo pipefail

NEXT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${NEXT_CI_OUT:-/var/tmp/forgejo-next-ci/$(date -u +%Y%m%dT%H%M%SZ)}"
DBS="${NEXT_CI_DBS:-all}"
STEPS=("$@")
[ ${#STEPS[@]} -eq 0 ] && STEPS=(install check protocol browser conformance e2e)
mkdir -p "$OUT"
export NEXT_E2E_PERF_OUT="$OUT/perf.jsonl"
: >"$NEXT_E2E_PERF_OUT"
# CI: Playwright refuses a stray test.only (forbidOnly) and Vitest a .only (allowOnly).
export CI=1
if [ -z "${PLAYWRIGHT_CHROMIUM:-}" ] && [ -x /opt/pw-browsers/chromium ]; then export PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium; fi

results=()
failed=0

run() {
  local name="$1"
  shift
  local t0 rc
  t0=$(date +%s)
  printf '[ci] %s …\n' "$name"
  (cd "$NEXT" && "$@") >"$OUT/$name.log" 2>&1
  rc=$?
  local dt=$(( $(date +%s) - t0 ))
  if [ "$rc" = 0 ]; then
    results+=("$(printf '%-12s PASS  %4ss' "$name" "$dt")")
  else
    results+=("$(printf '%-12s FAIL  %4ss  (log: %s)' "$name" "$dt" "$OUT/$name.log")")
    failed=1
    tail -n 30 "$OUT/$name.log" | sed "s/^/[ci $name] /"
  fi
}

"$NEXT/tools/dev-db.sh" start >/dev/null || { echo '[ci] dev-db.sh start failed' >&2; exit 1; }

for step in "${STEPS[@]}"; do
  case "$step" in
  install) [ "${NEXT_CI_NO_INSTALL:-}" = 1 ] || run install npm ci --no-audit --no-fund ;;
  check) run check npm run check ;;
  protocol) run protocol "$NEXT/tools/gen-protocol.sh" --check ;;
  browser) run browser npx playwright test --project build --project dev ;;
  conformance) run conformance "$NEXT/tools/dev-forgejo.sh" conformance "$DBS" ;;
  e2e) run e2e "$NEXT/tools/dev-forgejo.sh" e2e "$DBS" ;;
  *) echo "[ci] unknown step $step (install check protocol browser conformance e2e)" >&2; exit 2 ;;
  esac
done

echo
echo "[ci] summary ($OUT)"
printf '  %s\n' "${results[@]}"
if [ -s "$NEXT_E2E_PERF_OUT" ]; then
  echo "[ci] perf (median p50 / p95 / max per metric and database)"
  node -e '
    const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map((l) => JSON.parse(l));
    for (const l of lines) console.log(`  ${l.db.padEnd(6)} ${l.metric.padEnd(64)} p50 ${l.p50.toFixed(1).padStart(7)}  p95 ${l.p95.toFixed(1).padStart(7)}  max ${l.max.toFixed(1).padStart(7)}  (n=${l.n})`);
  ' "$NEXT_E2E_PERF_OUT"
fi
exit "$failed"
