// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Splits a byte stream into NDJSON lines. Yields the complete lines of each
 * network chunk together (one await per chunk, not per line). The body is
 * decoded by the browser already (br/gzip). A final line without a newline
 * is yielded too.
 */
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
