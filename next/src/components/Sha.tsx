// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {shortSha} from '../code/refs.ts';

/** An abbreviated commit SHA in fixed-width digits, the full SHA on hover. */
export function Sha({sha}: {sha: string}) {
  return <span className="font-mono tabular-nums" title={sha}>{shortSha(sha)}</span>;
}

/** A commit message's first line. */
export function summary(message: string): string {
  const nl = message.indexOf('\n');
  return nl < 0 ? message : message.slice(0, nl);
}
