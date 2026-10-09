// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {afterEach, expect, test, vi} from 'vitest';
import {formatKeys, KEYMAP} from './keymap.ts';
import {chordOf, SEQUENCE_TIMEOUT, ShortcutRegistry} from './registry.ts';

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

function press(r: ShortcutRegistry, key: string, init: KeyboardEventInit = {}, target: Element = document.body): boolean {
  const e = new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true, ...init});
  Object.defineProperty(e, 'target', {value: target});
  return r.handle(e);
}

test('chords: mod is ⌘ on Apple and Ctrl elsewhere; Shift belongs to symbols', () => {
  const k = (key: string, m: Partial<KeyboardEvent> = {}) => ({key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m});
  expect(chordOf(k('k', {metaKey: true}), true)).toBe('mod+k');
  expect(chordOf(k('k', {ctrlKey: true}), false)).toBe('mod+k');
  expect(chordOf(k('k', {ctrlKey: true}), true)).toBe('ctrl+k');
  expect(chordOf(k('K', {shiftKey: true}), false)).toBe('shift+k');
  expect(chordOf(k('?', {shiftKey: true}), false)).toBe('?');
  expect(chordOf(k('Enter', {metaKey: true}), true)).toBe('mod+enter');
  expect(chordOf(k('Shift', {shiftKey: true}), false)).toBeUndefined();
});

test('hints: one cap per Apple chord, words for other platforms', () => {
  expect(formatKeys('mod+k', true)).toBe('⌘K');
  expect(formatKeys('mod+k', false)).toBe('Ctrl K');
  expect(formatKeys('g i', false)).toBe('G I');
  expect(formatKeys('mod+enter', true)).toBe('⌘↵');
  expect(formatKeys('?', false)).toBe('?');
});

test('every keymap entry is well-formed and keys are unique per scope', () => {
  const seen = new Set<string>();
  for (const [id, def] of Object.entries(KEYMAP)) {
    expect(def.keys, id).toMatch(/^((mod|shift|alt)\+)*([a-z0-9]|enter|escape|arrowup|arrowdown|[?[\]\\])( ((mod|shift|alt)\+)*([a-z0-9]|enter|escape|[?[\]\\]))*$/);
    const k = `${def.scope}|${def.keys}`;
    expect(seen.has(k), id).toBe(false);
    seen.add(k);
  }
});

test('Shift and a letter runs the letter\'s shortcut unless Shift+letter is one itself', () => {
  const r = new ShortcutRegistry({apple: false});
  const ran: string[] = [];
  r.bind('review.start', () => ran.push('review'));
  r.bind('inbox.pin', () => ran.push('pin'));
  r.bind('issue.priority', () => ran.push('priority'));
  r.pushScope('diff');
  r.pushScope('inbox');
  r.pushScope('issue');
  const press = (key: string, shiftKey = false) => r.handle(new KeyboardEvent('keydown', {key, shiftKey, cancelable: true}));
  press('R', true);
  press('P', true);
  expect(ran).toEqual(['review', 'pin']);
});

test('single keys, sequences, and the sequence timeout', () => {
  vi.useFakeTimers();
  const r = new ShortcutRegistry({apple: false});
  const ran: string[] = [];
  r.bind('go.issues', () => ran.push('issues'));
  r.bind('create', () => ran.push('create'));
  r.bind('palette.open', () => ran.push('palette'));
  expect(press(r, 'g')).toBe(true);
  expect(press(r, 'i')).toBe(true);
  expect(ran).toEqual(['issues']);
  // An unrelated key ends the sequence and is tried alone.
  press(r, 'g');
  press(r, 'c');
  expect(ran).toEqual(['issues', 'create']);
  press(r, 'g');
  vi.advanceTimersByTime(SEQUENCE_TIMEOUT + 1);
  expect(press(r, 'i')).toBe(false);
  press(r, 'k', {ctrlKey: true});
  expect(ran).toEqual(['issues', 'create', 'palette']);
  // A modifier makes it another chord: Ctrl+C is not C.
  expect(press(r, 'c', {ctrlKey: true})).toBe(false);
});

test('text fields and open menus keep their keys, except `anywhere` bindings', () => {
  const r = new ShortcutRegistry({apple: true});
  const ran: string[] = [];
  r.bind('create', () => ran.push('create'));
  r.bind('palette.open', () => ran.push('palette'));
  const input = document.createElement('input');
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  const item = document.createElement('div');
  menu.append(item);
  const check = document.createElement('input');
  check.type = 'checkbox';
  document.body.append(input, menu, check);
  expect(press(r, 'c', {}, input)).toBe(false);
  expect(press(r, 'c', {}, item)).toBe(false);
  expect(press(r, 'c', {}, check)).toBe(true);
  expect(press(r, 'k', {metaKey: true}, input)).toBe(true);
  expect(ran).toEqual(['create', 'palette']);
});

test('scoped bindings apply only while their scope is pushed; the innermost and latest win', () => {
  const r = new ShortcutRegistry({apple: false});
  const ran: string[] = [];
  r.bind('list.next', () => ran.push('outer list'));
  expect(press(r, 'j')).toBe(false);
  const pop = r.pushScope('list');
  expect(press(r, 'j')).toBe(true);
  const unbind = r.bind('list.next', () => ran.push('inner list'));
  press(r, 'j');
  unbind();
  press(r, 'j');
  pop();
  expect(press(r, 'j')).toBe(false);
  expect(ran).toEqual(['outer list', 'inner list', 'outer list']);
  expect(r.bound()).toEqual(new Set(['list.next']));
});

test('a handled key is not typed (preventDefault); defaultPrevented and IME events are left alone', () => {
  const r = new ShortcutRegistry({apple: false});
  r.bind('create', () => undefined);
  const e = new KeyboardEvent('keydown', {key: 'c', cancelable: true});
  r.handle(e);
  expect(e.defaultPrevented).toBe(true);
  const composing = new KeyboardEvent('keydown', {key: 'c', isComposing: true});
  expect(r.handle(composing)).toBe(false);
});

test('held keys repeat movement only; non-Latin layouts use the key\'s position', () => {
  const r = new ShortcutRegistry({apple: false});
  const ran: string[] = [];
  r.bind('palette.open', () => ran.push('palette'));
  r.bind('list.next', () => ran.push('next'));
  r.pushScope('list');
  press(r, 'k', {ctrlKey: true, repeat: true});
  press(r, 'j', {repeat: true});
  expect(ran).toEqual(['next']);
  r.bind('go.issues', () => ran.push('issues'));
  press(r, 'п', {code: 'KeyG'});
  press(r, 'ш', {code: 'KeyI'});
  expect(ran).toEqual(['next', 'issues']);
});

test('a listbox keeps its keys unless it opts in to the app shortcuts (an issue list)', () => {
  const r = new ShortcutRegistry({apple: false});
  const runs: string[] = [];
  r.bind('list.next', () => runs.push('next'));
  r.pushScope('list');
  const plain = document.createElement('div');
  plain.setAttribute('role', 'listbox');
  const list = document.createElement('div');
  list.setAttribute('role', 'listbox');
  list.setAttribute('data-shortcuts', '');
  document.body.append(plain, list);
  const press = (target: Element) => {
    const e = new KeyboardEvent('keydown', {key: 'j', bubbles: true, cancelable: true});
    Object.defineProperty(e, 'target', {value: target});
    return r.handle(e);
  };
  expect(press(plain)).toBe(false);
  expect(press(list)).toBe(true);
  expect(runs).toEqual(['next']);
  plain.remove();
  list.remove();
});

test('scopes a view pushes together: the innermost decides a key they share (a board: L is the next column, not labels)', () => {
  const r = new ShortcutRegistry({apple: false});
  const ran: string[] = [];
  r.pushScope('list');
  r.pushScope('issue');
  r.pushScope('board');
  r.bind('issue.labels', () => ran.push('labels'));
  r.bind('board.right', () => ran.push('right'));
  press(r, 'l');
  expect(ran).toEqual(['right']);
});

test('views that push several scopes: every key two of them share is meant, and the innermost one wins', () => {
  // [scopes from outer to inner, keys the inner one takes over on purpose]
  const views: [string[], string[]][] = [[['list', 'issue'], []], [['list', 'inbox'], []], [['list', 'issue', 'board'], ['l']], [['list', 'diff'], []]];
  for (const [scopes, intended] of views) {
    const byKey = new Map<string, string[]>();
    for (const [id, def] of Object.entries(KEYMAP)) {
      if (!scopes.includes(def.scope)) continue;
      byKey.set(def.keys, [...byKey.get(def.keys) ?? [], id]);
    }
    const shared = [...byKey].filter(([, ids]) => ids.length > 1).map(([k]) => k);
    expect(shared, scopes.join('+')).toEqual(intended);
  }
});

test('available() lists the bound shortcuts of active scopes; run() runs the innermost binding', () => {
  const r = new ShortcutRegistry({apple: false});
  const ran: string[] = [];
  const off = r.bind('inbox.read', () => ran.push('read'));
  r.bind('create', () => ran.push('create'));
  expect(r.available()).toEqual([]);
  const pop = r.pushScope('inbox');
  expect(r.available()).toEqual(['inbox.read']);
  expect(r.run('inbox.read')).toBe(true);
  pop();
  expect(r.run('inbox.read')).toBe(false);
  off();
  expect(r.run('create')).toBe(true);
  expect(ran).toEqual(['read', 'create']);
});

test('shadowed(): a key an inner scope has taken does not advertise the outer binding (no "Labels L" on a board)', () => {
  const r = new ShortcutRegistry({apple: false});
  r.bind('issue.labels', () => undefined);
  r.pushScope('issue');
  expect(r.shadowed('issue.labels')).toBe(false);
  r.bind('board.right', () => undefined);
  const pop = r.pushScope('board');
  expect(r.shadowed('issue.labels')).toBe(true);
  expect(r.shadowed('board.right')).toBe(false);
  pop();
  expect(r.shadowed('issue.labels')).toBe(false);
});

test('a dialog fading out (data-state="closed") does not keep the keys: C right after Esc', () => {
  const r = new ShortcutRegistry({apple: false});
  let ran = 0;
  r.bind('create', () => ran++);
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  const inside = document.createElement('button');
  dialog.append(inside);
  document.body.append(dialog);
  press(r, 'c', {}, inside);
  expect(ran).toBe(0);
  dialog.setAttribute('data-state', 'closed');
  press(r, 'c', {}, inside);
  expect(ran).toBe(1);
});
