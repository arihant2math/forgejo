// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The one table of keyboard shortcuts (PLAN §5.6). Features bind handlers to
// these ids (useShortcut); menus, tooltips, the palette and the shortcuts
// help read their hints from here (shortcutHint), so a key is defined once.
//
// Keys: chords separated by spaces ("g i" is G then I); a chord is
// modifiers + key joined by "+", where "mod" is ⌘ on Apple platforms and
// Ctrl elsewhere. Letters match without Shift; symbols match whatever
// produces them ("?" is Shift+/ on most layouts).
//
// Scopes: `global` bindings work everywhere; the others only while a view
// that pushed that scope is mounted (useShortcutScope), innermost first.

/** `editor`: keys a markdown field handles itself while it has the focus (not through the registry). */
export type Scope = 'global' | 'list' | 'issue' | 'inbox' | 'board' | 'editor' | 'diff' | 'palette';

export interface KeyDef {
  keys: string;
  /** What it does (shortcuts help, palette). */
  label: string;
  scope: Scope;
  /**
   * Also while typing in a text field or inside an open menu or dialog
   * (otherwise those keep their keys).
   */
  anywhere?: boolean;
  /** Handled by the focused view itself, not through the registry (listed in the help only). */
  local?: boolean;
}

export const KEYMAP = {
  'palette.open': {keys: 'mod+k', label: 'Open the command menu', scope: 'global', anywhere: true},
  'help.shortcuts': {keys: '?', label: 'Keyboard shortcuts', scope: 'global'},
  'create': {keys: 'c', label: 'Create an issue', scope: 'global'},
  'go.home': {keys: 'g h', label: 'Go to Home', scope: 'global'},
  'go.issues': {keys: 'g i', label: 'Go to my issues', scope: 'global'},
  'go.pulls': {keys: 'g p', label: 'Go to my pull requests', scope: 'global'},
  'go.inbox': {keys: 'g n', label: 'Go to the inbox', scope: 'global'},
  'go.board': {keys: 'g b', label: 'Go to the board', scope: 'global'},
  'go.code': {keys: 'g c', label: 'Go to the code of this repository', scope: 'global'},
  'sidebar.toggle': {keys: 'mod+\\', label: 'Show or hide the sidebar', scope: 'global', anywhere: true},
  'submit': {keys: 'mod+enter', label: 'Submit', scope: 'global', anywhere: true},
  'list.next': {keys: 'j', label: 'Next item', scope: 'list'},
  'list.prev': {keys: 'k', label: 'Previous item', scope: 'list'},
  'list.select': {keys: 'x', label: 'Select', scope: 'list'},
  'view.save': {keys: 'shift+v', label: 'Save the view', scope: 'list'},
  'inbox.read': {keys: 'e', label: 'Mark read', scope: 'inbox'},
  'inbox.unread': {keys: 'u', label: 'Mark unread', scope: 'inbox'},
  'inbox.pin': {keys: 'shift+p', label: 'Pin or unpin', scope: 'inbox'},
  'inbox.readAll': {keys: 'shift+e', label: 'Mark all read', scope: 'inbox'},
  'board.left': {keys: 'h', label: 'Previous column', scope: 'board'},
  'board.right': {keys: 'l', label: 'Next column', scope: 'board'},
  'board.moveLeft': {keys: 'shift+h', label: 'Move the card to the previous column', scope: 'board'},
  'board.moveRight': {keys: 'shift+l', label: 'Move the card to the next column', scope: 'board'},
  'board.moveUp': {keys: 'shift+k', label: 'Move the card up', scope: 'board'},
  'board.moveDown': {keys: 'shift+j', label: 'Move the card down', scope: 'board'},
  'issue.state': {keys: 's', label: 'Change the state', scope: 'issue'},
  'issue.labels': {keys: 'l', label: 'Labels', scope: 'issue'},
  'issue.assignee': {keys: 'a', label: 'Assignees', scope: 'issue'},
  'issue.milestone': {keys: 'm', label: 'Milestone', scope: 'issue'},
  'issue.priority': {keys: 'p', label: 'Priority', scope: 'issue'},
  'issue.edit': {keys: 'e', label: 'Edit', scope: 'issue'},
  'issue.subscribe': {keys: 'shift+s', label: 'Subscribe or unsubscribe', scope: 'issue'},
  'issue.comment': {keys: 'r', label: 'Comment', scope: 'issue'},
  'issue.back': {keys: 'escape', label: 'Back to the list', scope: 'issue'},
  'editor.preview': {keys: 'mod+shift+p', label: 'Toggle the preview', scope: 'editor', anywhere: true},
  'diff.prevFile': {keys: '[', label: 'Previous file', scope: 'diff'},
  'diff.nextFile': {keys: ']', label: 'Next file', scope: 'diff'},
  'review.start': {keys: 'r', label: 'Start a review', scope: 'diff'},
  'diff.viewed': {keys: 'v', label: 'Mark the file viewed', scope: 'diff'},
  'diff.lineDown': {keys: 'arrowdown', label: 'Next line', scope: 'diff', local: true},
  'diff.lineUp': {keys: 'arrowup', label: 'Previous line', scope: 'diff', local: true},
  'diff.lineComment': {keys: 'enter', label: 'Comment on the line', scope: 'diff', local: true},
  'editor.submit': {keys: 'mod+enter', label: 'Save or send', scope: 'editor', local: true},
} as const satisfies Record<string, KeyDef>;

export type ShortcutId = keyof typeof KEYMAP;

export const SCOPE_LABELS: Record<Scope, string> = {
  global: 'General',
  list: 'Lists',
  issue: 'Issues and pull requests',
  inbox: 'Inbox',
  board: 'Boards',
  editor: 'Markdown editor',
  diff: 'Diffs',
  palette: 'Command menu',
};

/** Whether this platform calls the command modifier ⌘ (Meta) rather than Ctrl. */
export function isApple(): boolean {
  const nav = globalThis.navigator as (Navigator & {userAgentData?: {platform?: string}}) | undefined;
  const p = nav?.userAgentData?.platform ?? nav?.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(p);
}

const NAMES: Record<string, string> = {enter: '↵', escape: 'Esc', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', backspace: '⌫'};

/** The hint for keys, as Shortcut renders it: key caps separated by spaces ("⌘K", "Ctrl K", "G I"). */
export function formatKeys(keys: string, apple = isApple()): string {
  return keys.split(' ').map((chord) => {
    const parts = chord.split('+');
    const key = parts.pop() ?? '';
    const name = NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key);
    const mods = parts.map((m) => {
      if (m === 'mod') return apple ? '⌘' : 'Ctrl';
      if (m === 'shift') return apple ? '⇧' : 'Shift';
      if (m === 'alt') return apple ? '⌥' : 'Alt';
      return m;
    });
    // Apple glyphs join into one cap ("⌘K"); words get their own ("Ctrl K").
    return apple ? [...mods, name].join('') : [...mods, name].join(' ');
  }).join(' ');
}

/** The hint of a shortcut id ("⌘K", "G I"). */
export function shortcutHint(id: ShortcutId): string {
  return formatKeys(KEYMAP[id].keys);
}
