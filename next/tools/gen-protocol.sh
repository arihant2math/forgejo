#!/usr/bin/env bash
# Copyright 2026 The Forgejo Authors. All rights reserved.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# gen-protocol.sh — generate next/src/protocol/types.gen.ts from the Go wire
# types in services/livesync/protocol with tygo (config: next/tools/tygo.yaml).
#
# Usage: next/tools/gen-protocol.sh            regenerate the file
#        next/tools/gen-protocol.sh --check    fail (exit 1) if the file is not
#                                              up to date; changes nothing
set -euo pipefail

TYGO_VERSION=v0.2.21
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
out=next/src/protocol/types.gen.ts

check=false
case "${1:-}" in
"") ;;
--check) check=true ;;
*)
  echo "usage: $0 [--check]" >&2
  exit 2
  ;;
esac

cd "$root"
# `go run pkg@version` does not follow the toolchain switch of go.mod; tygo
# loads this module's packages, so it needs a Go at least as new as go.mod's.
toolchain=$(sed -n 's/^toolchain //p' go.mod)
export GOTOOLCHAIN=${GOTOOLCHAIN:-${toolchain:-auto}}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
sed "s#output_path: \"$out\"#output_path: \"$tmp/types.gen.ts\"#" next/tools/tygo.yaml >"$tmp/tygo.yaml"
go run "github.com/gzuidhof/tygo@$TYGO_VERSION" generate --config "$tmp/tygo.yaml"

if $check; then
  if ! diff -u "$out" "$tmp/types.gen.ts"; then
    echo "$out is out of date: run next/tools/gen-protocol.sh" >&2
    exit 1
  fi
  echo "$out is up to date"
else
  cp "$tmp/types.gen.ts" "$out"
  echo "wrote $out"
fi
