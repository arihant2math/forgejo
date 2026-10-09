// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The global shortcut registry (PLAN §5.6): one keydown listener on the
// window, the key table in keymap.ts, handlers bound by the views that can
// run them, and scopes pushed by the views that are on screen.
//
//   const off = shortcuts.bind('go.inbox', () => navigate(...));
//   const pop = shortcuts.pushScope('list');   // J/K now apply
//
// A binding runs when its keys were typed, its scope is active (global
// always is) and, unless it is `anywhere`, focus is neither in a text field
// nor inside an open menu, listbox or dialog (those keep their keys). When
// several match, the innermost scope wins, then the latest binding.

import {isApple, KEYMAP, type KeyDef, type Scope, type ShortcutId} from './keymap.ts';

/** How long the next key of a sequence ("g i") is waited for (ms). */
export const SEQUENCE_TIMEOUT = 1500;

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Meta', 'Alt', 'AltGraph', 'CapsLock', 'Fn', 'OS', 'Hyper', 'Super']);
const NAMED = new Set(['enter', 'escape', 'tab', 'backspace', 'delete', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'home', 'end', 'pageup', 'pagedown', ' ']);

/** The chord an event types, in keymap notation ("mod+k", "g", "?", "shift+enter"); undefined for a bare modifier. */
export function chordOf(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & {code?: string}, apple: boolean): string | undefined {
  if (MODIFIER_KEYS.has(e.key) || e.key === 'Dead' || e.key === 'Unidentified' || !e.key) return undefined;
  // A letter key of a non-Latin layout (Cyrillic, Greek, …): its position, as on a US layout.
  const physical = /^Key([A-Z])$/.exec(e.code ?? '')?.[1];
  const lower = e.key.length === 1 && !/^[\x20-\x7e]$/.test(e.key) && physical ? physical.toLowerCase() : e.key.toLowerCase();
  const letter = /^[a-z0-9]$/.test(lower);
  const named = NAMED.has(lower);
  const key = lower === ' ' ? 'space' : letter || named ? lower : e.key;
  const mods: string[] = [];
  if (apple ? e.metaKey : e.ctrlKey) mods.push('mod');
  if (apple && e.ctrlKey) mods.push('ctrl');
  if (!apple && e.metaKey) mods.push('meta');
  if (e.altKey) mods.push('alt');
  // Shift is part of a symbol ("?"), but a modifier of letters and named keys.
  if (e.shiftKey && (letter || named)) mods.push('shift');
  return [...mods, key].join('+');
}

function isTextField(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'reset', 'submit'].includes(el.type);
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * Inside an open menu, listbox or dialog (they keep their keys) — unless that
 * element opts in to the app's shortcuts with `data-shortcuts` (an issue
 * list's listbox: J/K/X/S/L/… are its keys).
 */
function inOverlay(el: Element | null): boolean {
  const overlay = el?.closest('[role="menu"],[role="menubar"],[role="listbox"],[role="dialog"],[role="alertdialog"]');
  // A menu or dialog fading out (Radix: data-state="closed") has let go of the keys already.
  return Boolean(overlay) && !overlay?.hasAttribute('data-shortcuts') && overlay?.getAttribute('data-state') !== 'closed';
}

interface Binding {
  id: ShortcutId;
  run: () => void;
  /** Whether it applies now (Open with a row under the cursor, a card move with a card): not, it is neither run nor offered. */
  when: (() => boolean) | undefined;
  seq: number;
}

export class ShortcutRegistry {
  private readonly keymap: Readonly<Record<string, KeyDef>>;
  private readonly apple: boolean;
  private readonly bindings: Binding[] = [];
  private readonly scopes: {scope: Scope; token: number}[] = [];
  private bindSeq = 0;
  private scopeSeq = 0;
  private pending: string[] = [];
  /**
   * Whether an overlay is opening or open (set by the shell): its keys are its own even before it has the focus —
   * typing right after Ctrl+K must never run the page's shortcuts ("c" of a search creating an issue).
   */
  overlayOpen: () => boolean = () => false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: {apple?: boolean; keymap?: Readonly<Record<string, KeyDef>>} = {}) {
    this.apple = opts.apple ?? isApple();
    this.keymap = opts.keymap ?? KEYMAP;
  }

  /** Binds a handler to a shortcut (applying while `when` says so); returns the unbind function. */
  bind(id: ShortcutId, run: () => void, when?: () => boolean): () => void {
    const b: Binding = {id, run, when, seq: ++this.bindSeq};
    this.bindings.push(b);
    return () => {
      const i = this.bindings.indexOf(b);
      if (i >= 0) this.bindings.splice(i, 1);
    };
  }

  /** The shortcuts something is bound to right now. */
  bound(): Set<ShortcutId> {
    return new Set(this.bindings.map((b) => b.id));
  }

  /** The scopes active now, innermost first, global last (the shortcuts help lists them first). */
  activeScopes(): Scope[] {
    const out: Scope[] = [];
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const s = this.scopes[i]?.scope;
      if (s && !out.includes(s)) out.push(s);
    }
    return [...out, 'global'];
  }

  /**
   * The bound shortcuts whose scope is active now, outside global (what the
   * view on screen offers: the palette lists them as commands).
   */
  available(): ShortcutId[] {
    const seen = new Set<ShortcutId>();
    for (const b of this.bindings) {
      const def = this.keymap[b.id];
      if (def && def.scope !== 'global' && this.depth(def.scope) >= 0 && (b.when?.() ?? true)) seen.add(b.id);
    }
    return [...seen];
  }

  /**
   * Whether a shortcut's keys run something else now: another binding with
   * the same keys in a deeper active scope (on a board, L is the next
   * column, not labels). Its hint must not be shown then.
   */
  shadowed(id: ShortcutId): boolean {
    const def = this.keymap[id];
    if (!def?.keys) return false;
    const mine = this.depth(def.scope);
    return this.bindings.some((b) => {
      const other = this.keymap[b.id];
      return b.id !== id && other?.keys === def.keys && this.depth(other.scope) > mine;
    });
  }

  /** Runs what a shortcut is bound to now (as if its keys were typed); false when nothing is. */
  run(id: ShortcutId): boolean {
    let best: Binding | undefined;
    let depth = -1;
    for (const b of this.bindings) {
      if (b.id !== id || !(b.when?.() ?? true)) continue;
      const def = this.keymap[b.id];
      const d = def ? this.depth(def.scope) : -1;
      if (d > depth || (d === depth && best && b.seq > best.seq)) {
        best = b;
        depth = d;
      }
    }
    if (!best || depth < 0) return false;
    best.run();
    return true;
  }

  /** Activates a scope while a view is mounted; returns the function that pops it. */
  pushScope(scope: Scope): () => void {
    const entry = {scope, token: ++this.scopeSeq};
    this.scopes.push(entry);
    return () => {
      const i = this.scopes.indexOf(entry);
      if (i >= 0) this.scopes.splice(i, 1);
    };
  }

  /** How deep a scope is active (higher = inner); -1 when inactive. Global is the outermost. */
  private depth(scope: Scope): number {
    if (scope === 'global') return 0;
    for (let i = this.scopes.length - 1; i >= 0; i--) if (this.scopes[i]?.scope === scope) return i + 1;
    return -1;
  }

  private eligible(restricted: boolean, onPage: boolean): {binding: Binding; keys: string; depth: number}[] {
    const out: {binding: Binding; keys: string; depth: number}[] = [];
    for (const b of this.bindings) {
      const def = this.keymap[b.id];
      if (!def || (restricted && !def.anywhere) || (def.page && !onPage) || !(b.when?.() ?? true)) continue;
      const depth = this.depth(def.scope);
      if (depth >= 0) out.push({binding: b, keys: def.keys, depth});
    }
    return out;
  }

  private reset(): void {
    this.pending = [];
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Handles a keydown; returns whether a shortcut ran (or a sequence started). */
  handle(e: KeyboardEvent): boolean {
    // keyCode 229: a key the IME is handling (some browsers do not set isComposing).
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the only IME signal some browsers give
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return false;
    const chord = chordOf(e, this.apple);
    if (!chord) return false;
    const target = e.target instanceof Element ? e.target : null;
    const restricted = isTextField(target) || inOverlay(target) || this.overlayOpen();
    const onPage = !target || target === target.ownerDocument.body || target.closest('[data-shortcuts]') !== null;
    const candidates = this.eligible(restricted, onPage);
    const attempt = (typed: string[]): boolean => {
      const keys = typed.join(' ');
      let best: {binding: Binding; depth: number} | undefined;
      let prefix = false;
      for (const c of candidates) {
        // Holding a key repeats only movement (J/K in a list), never a toggle such as ⌘K.
        if (e.repeat && c.binding.id !== 'list.next' && c.binding.id !== 'list.prev') continue;
        if (c.keys === keys) {
          if (!best || c.depth > best.depth || (c.depth === best.depth && c.binding.seq > best.binding.seq)) best = c;
        } else if (c.keys.startsWith(`${keys} `)) {
          prefix = true;
        }
      }
      if (best) {
        this.reset();
        e.preventDefault();
        best.binding.run();
        return true;
      }
      if (prefix && !e.repeat) {
        this.pending = typed;
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.reset();
        }, SEQUENCE_TIMEOUT);
        return true;
      }
      return false;
    };
    if (this.pending.length && attempt([...this.pending, chord])) return true;
    this.reset();
    if (attempt([chord])) return true;
    // Shift and a letter that is no shortcut of its own: the letter's (the help shows "R"; Caps Lock). Not when
    // the keymap gives Shift+letter a meaning that this page does not bind (Shift+S on a board must not change
    // the status).
    const letter = /^shift\+([a-z])$/.exec(chord)?.[1];
    const meant = Object.values(this.keymap).some((d) => d.keys === chord || d.keys.startsWith(`${chord} `));
    return letter !== undefined && !meant && attempt([letter]);
  }

  /** Listens on a window (the app does this once); returns the function that stops. */
  attach(win: Window): () => void {
    const onKey = (e: KeyboardEvent) => {
      this.handle(e);
    };
    const onBlur = () => {
      this.reset();
    };
    win.addEventListener('keydown', onKey);
    win.addEventListener('blur', onBlur);
    return () => {
      win.removeEventListener('keydown', onKey);
      win.removeEventListener('blur', onBlur);
      this.reset();
    };
  }
}
