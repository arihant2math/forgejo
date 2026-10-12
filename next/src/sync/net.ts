// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Hung requests can exhaust per-host HTTP connections and starve recovery traffic.
// Deadlines and network-epoch aborts free them so reconnects can use fresh connections.

let epoch = new AbortController();

/** The current epoch's signal, with a deadline when `ms` is given (and the caller's own signal, if any). */
export function netSignal(ms?: number, signal?: AbortSignal): AbortSignal {
  const all = [epoch.signal];
  if (ms !== undefined) all.push(AbortSignal.timeout(ms));
  if (signal) all.push(signal);
  return all.length === 1 ? epoch.signal : AbortSignal.any(all);
}

/** Aborts the current epoch’s requests and starts a new epoch. */
export function dropRequests(): void {
  const old = epoch;
  epoch = new AbortController();
  old.abort(new DOMException('the network connection was lost', 'AbortError'));
}

/** Whether an error is an abort of the epoch or a deadline (a retry on a fresh connection may succeed). */
export function isNetAbort(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError');
}
