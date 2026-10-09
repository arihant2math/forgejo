// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Every request the app sends carries a deadline and the current network epoch's signal. A stalled network
// (a captive portal, a dead VPN, a server that accepts and never answers) otherwise leaves requests open for
// minutes: HTTP/1.1 gives a host six connections, and once hung requests hold them, nothing the app asks
// after the network is back gets a connection (QA verify3: "Catching up" for 40–120 s after a stall). When
// the sync client finds the connection dead, it ends the epoch: everything in flight is aborted and retried
// on fresh connections.

let epoch = new AbortController();

/** The current epoch's signal, with a deadline when `ms` is given (and the caller's own signal, if any). */
export function netSignal(ms?: number, signal?: AbortSignal): AbortSignal {
  const all = [epoch.signal];
  if (ms !== undefined) all.push(AbortSignal.timeout(ms));
  if (signal) all.push(signal);
  return all.length === 1 ? epoch.signal : AbortSignal.any(all);
}

/** Aborts every request of the current epoch (the connection was found dead) and starts a new one. */
export function dropRequests(): void {
  const old = epoch;
  epoch = new AbortController();
  old.abort(new DOMException('the network connection was lost', 'AbortError'));
}

/** Whether an error is an abort of the epoch or a deadline (a retry on a fresh connection may succeed). */
export function isNetAbort(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError');
}
