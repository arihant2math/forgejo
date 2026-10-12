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

/** A worker whose highlights wait for `release` and fail while `failing` is set. */
function gatedSpawn(calls: string[], state: {failing: boolean; release?: () => void}) {
  return (): HighlightWorker => {
    const api = {
      prepare: () => Promise.resolve(),
      highlight: (text: string) => {
        calls.push(text);
        return new Promise((resolve, reject) => {
          state.release = () => {
            if (state.failing) reject(new Error('the grammar did not load'));
            else resolve({spans: Uint32Array.of(text.length, 1), starts: Uint32Array.of(0, 1)});
          };
        });
      },
      highlightDiffFile: () => Promise.resolve(null),
    } as unknown as WorkerApi;
    return {api, failed: new Promise<never>(() => undefined), stop: () => undefined, onProgress: () => undefined};
  };
}

test('a snippet that failed is asked again next time, not kept plain for the session', async () => {
  const db = await openDatabase(1, {factory: new IDBFactory()});
  const calls: string[] = [];
  const state: {failing: boolean; release?: () => void} = {failing: true};
  const src = source(db, gatedSpawn(calls, state));
  const first = src.snippet('go', 'x').catch((err: unknown) => err);
  await vi.waitFor(() => {
    expect(calls).toHaveLength(1);
  });
  state.release?.();
  expect(await first).toBeInstanceOf(Error);
  state.failing = false;
  const second = src.snippet('go', 'x');
  await vi.waitFor(() => {
    expect(calls).toHaveLength(2);
  });
  state.release?.();
  expect(await second).not.toBeNull();
  expect(src.peekSnippet('go', 'x')).toBe(await second);
  src.close();
});

test('a shared snippet leaves the queue only once every asker has gone', async () => {
  const db = await openDatabase(1, {factory: new IDBFactory()});
  const calls: string[] = [];
  const state: {failing: boolean; release?: () => void} = {failing: false};
  const src = source(db, gatedSpawn(calls, state));
  void src.snippet('go', 'busy');
  await vi.waitFor(() => {
    expect(calls).toEqual(['busy']);
  });
  const a = new AbortController();
  const b = new AbortController();
  const first = src.snippet('go', 'shared', a.signal).catch((err: unknown) => err);
  const second = src.snippet('go', 'shared', b.signal);
  a.abort();
  expect(await first).toHaveProperty('name', 'AbortError');
  state.release?.();
  await vi.waitFor(() => {
    expect(calls).toEqual(['busy', 'shared']);
  });
  state.release?.();
  expect(await second).not.toBeNull();
  void src.snippet('go', 'busy again');
  await vi.waitFor(() => {
    expect(calls).toEqual(['busy', 'shared', 'busy again']);
  });
  const gone = new AbortController();
  const dropped = src.snippet('go', 'dropped', gone.signal).catch((err: unknown) => err);
  void src.snippet('go', 'next');
  gone.abort();
  expect(await dropped).toHaveProperty('name', 'AbortError');
  state.release?.();
  await vi.waitFor(() => {
    expect(calls).toEqual(['busy', 'shared', 'busy again', 'next']);
  });
  src.close();
});

test('text being edited is highlighted without being kept', async () => {
  const db = await openDatabase(1, {factory: new IDBFactory()});
  const calls: string[] = [];
  const state: {failing: boolean; release?: () => void} = {failing: false};
  const src = source(db, gatedSpawn(calls, state));
  const p = src.highlightText('go', 'v1');
  await vi.waitFor(() => {
    expect(calls).toEqual(['v1']);
  });
  state.release?.();
  expect(await p).not.toBeNull();
  expect(src.peekSnippet('go', 'v1')).toBeUndefined();
  src.close();
});

test('a settled snippet stops listening to its asker\'s signal', async () => {
  const db = await openDatabase(1, {factory: new IDBFactory()});
  const calls: string[] = [];
  const state: {failing: boolean; release?: () => void} = {failing: false};
  const src = source(db, gatedSpawn(calls, state));
  const ctl = new AbortController();
  const add = vi.spyOn(ctl.signal, 'addEventListener');
  const remove = vi.spyOn(ctl.signal, 'removeEventListener');
  const p = src.snippet('go', 'kept', ctl.signal);
  await vi.waitFor(() => {
    expect(calls).toEqual(['kept']);
  });
  state.release?.();
  expect(await p).not.toBeNull();
  expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1]);
  src.close();
});
