// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The two transports of the sync protocol (PLAN §4.6, B5): a WebSocket at
// {endpoint}/ws, and the fallback for networks that break WebSockets —
// server messages as Server-Sent Events of {endpoint}/sse (the first is
// `session{session}`), client messages POSTed one at a time to
// {endpoint}/send with the X-Livesync-Session header. Both deliver parsed
// ServerMessages and accept ClientMessages; neither reconnects by itself.

import type {ClientMessage, ServerMessage} from '../protocol/types.gen.ts';
import {netSignal} from './net.ts';

/** A message POSTed over SSE that is not accepted within this time ends the transport (ms). */
const SEND_MS = 15_000;

export interface TransportHandlers {
  /** The transport can send. */
  open(): void;
  message(msg: ServerMessage): void;
  /** The transport is gone (after open or instead of it); `opened` says whether it ever opened. */
  close(info: {opened: boolean; code?: number; reason?: string}): void;
}

export interface Transport {
  readonly kind: 'ws' | 'sse';
  send(msg: ClientMessage): void;
  close(): void;
}

export interface TransportEnv {
  WebSocket?: typeof WebSocket;
  EventSource?: typeof EventSource;
  fetch?: typeof fetch;
  /** Absolute base for relative endpoints (default: location.href). */
  base?: string;
}

export function wsURL(endpoint: string, base: string): string {
  const u = new URL(`${endpoint}/ws`, base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

export function openWebSocket(endpoint: string, h: TransportHandlers, env: TransportEnv = {}): Transport {
  const WS = env.WebSocket ?? WebSocket;
  const ws = new WS(wsURL(endpoint, env.base ?? location.href));
  let opened = false;
  let closed = false;
  const finish = (info: {code?: number; reason?: string}) => {
    if (closed) return;
    closed = true;
    h.close({opened, ...info});
  };
  ws.onopen = () => {
    opened = true;
    h.open();
  };
  ws.onmessage = (ev: MessageEvent) => {
    if (closed || typeof ev.data !== 'string') return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data) as ServerMessage;
    } catch {
      return;
    }
    h.message(msg);
  };
  ws.onclose = (ev: CloseEvent) => {
    finish({code: ev.code, reason: ev.reason});
  };
  ws.onerror = () => {
    // A close event follows.
  };
  return {
    kind: 'ws',
    send(msg) {
      if (!closed && ws.readyState === WS.OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      if (closed) return;
      try {
        ws.close(1000);
      } catch {
        // Already closing.
      }
      finish({code: 1000, reason: 'client'});
    },
  };
}

export function openSSE(endpoint: string, h: TransportHandlers, env: TransportEnv = {}): Transport {
  const ES = env.EventSource ?? EventSource;
  const f = env.fetch ?? fetch.bind(globalThis);
  const base = env.base ?? location.href;
  const es = new ES(new URL(`${endpoint}/sse`, base).toString());
  let session: string | undefined;
  let closed = false;
  let opened = false;
  let chain: Promise<void> = Promise.resolve();
  const finish = (info: {code?: number; reason?: string}) => {
    if (closed) return;
    closed = true;
    es.close();
    h.close({opened, ...info});
  };
  es.onmessage = (ev: MessageEvent<string>) => {
    if (closed) return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data) as ServerMessage;
    } catch {
      return;
    }
    if (msg.type === 'session' && session === undefined) {
      session = msg.session;
      opened = true;
      h.open();
      return;
    }
    h.message(msg);
  };
  // EventSource reconnects by itself; a new stream would be a new session
  // the client knows nothing about, so any error ends this transport.
  es.onerror = () => {
    finish({reason: 'sse error'});
  };
  return {
    kind: 'sse',
    send(msg) {
      if (closed || session === undefined) return;
      const id = session;
      const body = JSON.stringify(msg);
      // One POST at a time, in order (the hello must complete before the next message).
      chain = chain.then(async () => {
        if (closed) return;
        const res = await f(new URL(`${endpoint}/send`, base).toString(), {
          method: 'POST',
          headers: {'Content-Type': 'application/json', 'X-Livesync-Session': id},
          body,
          cache: 'no-store',
          signal: netSignal(SEND_MS),
        });
        if (!res.ok) finish({code: res.status, reason: 'send failed'});
      }).catch(() => {
        finish({reason: 'send failed'});
      });
    },
    close() {
      finish({code: 1000, reason: 'client'});
    },
  };
}
