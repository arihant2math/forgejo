#!/usr/bin/env bash
# Copyright 2026 The Forgejo Authors. All rights reserved.
# SPDX-License-Identifier: GPL-3.0-or-later
# Usage: next/tools/ci.sh [install check protocol browser conformance e2e crawl]
# Run all requested steps even after failures; exit 1 if any fail.
# NEXT_CI_OUT stores logs and perf data; NEXT_CI_DBS selects pg|mysql|all.
set -uo pipefail

NEXT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${NEXT_CI_OUT:-/var/tmp/forgejo-next-ci/$(date -u +%Y%m%dT%H%M%SZ)}"
DBS="${NEXT_CI_DBS:-all}"
STEPS=("$@")
[ ${#STEPS[@]} -eq 0 ] && STEPS=(install check protocol browser conformance e2e crawl)
mkdir -p "$OUT"
export NEXT_E2E_PERF_OUT="$OUT/perf.jsonl"
: >"$NEXT_E2E_PERF_OUT"
# CI rejects focused tests in Playwright and Vitest.
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
  install) [ "${NEXT_CI_NO_INSTALL:-}" = 1 ] || run install pnpm install --frozen-lockfile ;;
  check) run check pnpm run check ;;
  protocol) run protocol "$NEXT/tools/gen-protocol.sh" --check ;;
  browser) run browser pnpm exec playwright test --project build --project dev ;;
  conformance) run conformance "$NEXT/tools/dev-forgejo.sh" conformance "$DBS" ;;
  e2e) run e2e "$NEXT/tools/dev-forgejo.sh" e2e "$DBS" --grep-invert @crawl ;;
  crawl) run crawl "$NEXT/tools/dev-forgejo.sh" e2e "$DBS" --grep @crawl ;;
  *) echo "[ci] unknown step $step (install check protocol browser conformance e2e crawl)" >&2; exit 2 ;;
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
