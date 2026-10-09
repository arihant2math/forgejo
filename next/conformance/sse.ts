// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * EventSource over fetch: Node has none (and the server's stream is plain
 * `data:` lines). Implements what openSSE uses.
 */
export class FetchEventSource {
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly ctrl = new AbortController();

  constructor(url: string) {
    void this.run(url);
  }

  close(): void {
    this.ctrl.abort();
  }

  private async run(url: string): Promise<void> {
    try {
      const res = await fetch(url, {signal: this.ctrl.signal, headers: {Accept: 'text/event-stream'}});
      if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(l.startsWith('data: ') ? 6 : 5)).join('\n');
          if (data) this.onmessage?.({data} as MessageEvent<string>);
        }
      }
      this.onerror?.();
    } catch {
      if (!this.ctrl.signal.aborted) this.onerror?.();
    }
  }
}
