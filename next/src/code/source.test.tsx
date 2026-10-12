// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import 'fake-indexeddb/auto';
import {render} from '@testing-library/react';
import {IDBFactory} from 'fake-indexeddb';
import {afterEach, expect, test, vi} from 'vitest';
import type {App, Session} from '../app/store.ts';
import {openDatabase} from '../data/idb.ts';
import {CodeLine, CodeTokens, LineNo} from './parts.tsx';
import {highlight as realHighlight} from '../workers/highlight.ts';
import type {HighlightWorker, WorkerApi} from './highlighter.ts';
import {CodeSource} from './source.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const SHA = 'a'.repeat(40);

/** Advances the fake clock, letting IndexedDB (real macrotasks) answer in between. */
async function advance(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 100) {
    await vi.advanceTimersByTimeAsync(100);
    await new Promise((r) => setImmediate(r));
  }
}
const TEXT = `${Array.from({length: 600}, (_, i) => `export const value${String(i)}: number = ${String(i)} * 2; // line ${String(i)}`).join('\n')}\n`;

/** A worker taking `ms` (virtual) per highlight, reporting progress every second, then highlighting (for real, or canned). */
function fakeSpawn(calls: string[], ms: number, real = true) {
  return (): HighlightWorker => {
    let progress: (() => void) | undefined;
    const api = {
      prepare: () => Promise.resolve(),
      highlight: async (text: string, lang: Parameters<typeof realHighlight>[1]) => {
        calls.push(lang ?? '');
        for (let t = 0; t < ms; t += 1000) {
          await new Promise((r) => setTimeout(r, 1000));
          progress?.();
        }
        return real ? realHighlight(text, lang) : {spans: Uint32Array.of(text.length, 1), starts: Uint32Array.of(0, 1)};
      },
      highlightDiffFile: () => Promise.resolve(null),
    } as unknown as WorkerApi;
    return {api, failed: new Promise<never>(() => undefined), stop: () => undefined, onProgress: (fn) => {
      progress = fn;
    }};
  };
}

function source(db: IDBDatabase, spawn: () => HighlightWorker): CodeSource {
  const s = {data: {db, on: () => () => undefined}} as unknown as Session;
  return new CodeSource({config: {base: '/-/next/'}} as unknown as App, s, {spawn});
}

test('a file is highlighted by blob SHA even when the worker takes long (progressing), and renders syntax classes', async () => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
  const db = await openDatabase(1, {factory: new IDBFactory()});
  const calls: string[] = [];
  const src = source(db, fakeSpawn(calls, 30_000));
  const p = src.highlight(7, SHA, 'src/value.ts', TEXT);
  await advance(31_000);
  const hl = await p;
  expect(hl).not.toBeNull();
  expect(calls).toEqual(['typescript']);
  expect(src.peekHighlight(7, SHA, 'src/value.ts')).toBe(hl);
  const {container} = render(<CodeLine gutter={<LineNo n={1}/>}><CodeTokens text={TEXT.split('\n')[0] ?? ''} hl={hl} line={0}/></CodeLine>);
  expect(container.querySelector('.text-syntax-keyword')?.textContent).toBe('export');
  expect(container.textContent).toContain('export const value0: number = 0 * 2; // line 0');
  src.close();
});

test('a file highlighted on an earlier visit is read back with the file (first frame) and not asked of the worker', async () => {
  const db = await openDatabase(1, {factory: new IDBFactory()});
  const calls: string[] = [];
  const a = source(db, fakeSpawn(calls, 0));
  const hl = await a.highlight(7, SHA, 'src/value.ts', TEXT);
  await new Promise((r) => setTimeout(r, 50));
  a.close();
  const b = source(db, fakeSpawn(calls, 0));
  expect(b.peekHighlight(7, SHA, 'src/value.ts')).toBeUndefined();
  await b.loadHighlight(7, SHA, 'src/value.ts');
  const back = b.peekHighlight(7, SHA, 'src/value.ts');
  if (!back) throw new Error('not read back');
  expect([...back.spans]).toEqual([...(hl?.spans ?? [])]);
  expect(await b.highlight(7, SHA, 'src/value.ts', TEXT)).toBe(back);
  expect(calls).toEqual(['typescript']);
  expect(b.peekHighlight(7, SHA, 'notes.txt')).toBeNull();
  b.close();
});

test('a hovered file (idle) opened before its turn is highlighted once, ahead of other intents', async () => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
  const db = await openDatabase(1, {factory: new IDBFactory()});
  const calls: string[] = [];
  const src = source(db, fakeSpawn(calls, 1000, false));
  const shown = src.highlight(7, 'f'.repeat(40), 'shown.ts', 'x');
  const hovered = ['a.go', 'b.rs', 'c.py'].map((p, i) => src.highlight(7, String(i).repeat(40), p, 'x', 'idle').catch(() => null));
  // Cache lookup can delay enqueueing the hovered highlight.
  await advance(100);
  const opened = src.highlight(7, '0'.repeat(40), 'a.go', 'x');
  await advance(5000);
  await Promise.all([shown, ...hovered, opened]);
  expect(calls).toEqual(['typescript', 'go', 'python', 'rust']);
  src.close();
});

function ownSource(db: IDBDatabase): CodeSource {
  const s = {data: {db, on: () => () => undefined}} as unknown as Session;
  return new CodeSource({config: {base: '/-/next/'}} as unknown as App, s);
}

test('preheating without workers (jsdom, an engine without them) starts nothing and throws nothing', async () => {
  vi.stubGlobal('Worker', undefined);
  const db = await openDatabase(1, {factory: new IDBFactory()});
  const src = ownSource(db);
  expect(() => {
    src.preheat();
  }).not.toThrow();
  src.close();
});

test('preheating with workers starts the code worker once', async () => {
  const started: string[] = [];
  vi.stubGlobal('Worker', class extends EventTarget {
    constructor(url: string | URL, opts?: WorkerOptions) {
      super();
      started.push(opts?.name ?? String(url));
    }
    postMessage = () => undefined;
    terminate = () => undefined;
  });
  const db = await openDatabase(1, {factory: new IDBFactory()});
  const src = ownSource(db);
  src.preheat();
  src.preheat();
  expect(started).toEqual(['code-highlight']);
  src.close();
});
