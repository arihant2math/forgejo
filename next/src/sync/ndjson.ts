// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Yields complete lines per network chunk (one await per chunk), including a final unterminated line. */
export async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let rest = '';
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      const text = rest + decoder.decode(value, {stream: true});
      const lines = text.split('\n');
      rest = lines.pop() ?? '';
      const out = lines.filter((l) => l !== '');
      if (out.length) yield out;
    }
    rest += decoder.decode();
    if (rest !== '') yield [rest];
  } finally {
    reader.releaseLock();
  }
}
