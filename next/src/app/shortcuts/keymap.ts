// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Shared key definitions keep handlers and UI hints consistent.
// Spaces separate sequence chords; "+" joins modifiers, with "mod" meaning Meta on Apple and Ctrl elsewhere.
// Letters ignore Shift; symbols match what produces them. Active scopes resolve innermost first.

/** `editor`: keys a markdown field handles itself while it has the focus (not through the registry). */
export type Scope = 'global' | 'list' | 'issue' | 'inbox' | 'board' | 'code' | 'editor' | 'diff' | 'palette';

export interface KeyDef {
  keys: string;
  label: string;
  scope: Scope;
  /** Also active in text fields, menus and dialogs. */
  anywhere?: boolean;
  /** Handled by the focused view itself, not through the registry (listed in the help only). */
  local?: boolean;
  /** Active only on body or shortcut-enabled lists; focused controls retain their own Enter. */
  page?: boolean;
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
  'undo': {keys: 'mod+z', label: 'Undo the last change', scope: 'global'},
  'list.next': {keys: 'j', label: 'Next item', scope: 'list'},
  'list.prev': {keys: 'k', label: 'Previous item', scope: 'list'},
  'list.select': {keys: 'x', label: 'Select', scope: 'list'},
  'list.search': {keys: '/', label: 'Search the list', scope: 'list'},
  'list.open': {keys: 'enter', label: 'Open', scope: 'list', page: true},
  'list.clear': {keys: 'escape', label: 'Clear the selection', scope: 'list', page: true},
  'actions.rerunAll': {keys: '', label: 'Re-run all jobs', scope: 'global'},
  'actions.rerunFailed': {keys: '', label: 'Re-run failed jobs', scope: 'global'},
  'actions.rerunJob': {keys: '', label: 'Re-run selected job', scope: 'global'},
  'actions.cancel': {keys: '', label: 'Cancel workflow', scope: 'global'},
  'code.back': {keys: 'escape', label: 'Back to Commits', scope: 'code', page: true},
  'code.up': {keys: 'backspace', label: 'Up a directory', scope: 'code', page: true},
  'code.upAlt': {keys: 'alt+arrowup', label: 'Up a directory', scope: 'code', page: true},
  'code.editFile': {keys: 'e', label: 'Edit this file', scope: 'code'},
  'code.newFile': {keys: '', label: 'Create new file', scope: 'code'},
  'code.uploadFiles': {keys: '', label: 'Upload files', scope: 'code'},
  'code.deletePath': {keys: '', label: 'Delete file or folder', scope: 'code'},
  'code.permalink': {keys: 'y', label: 'Turn URL into a permalink', scope: 'code'},
  'code.findFile': {keys: 't', label: 'Go to a file', scope: 'code'},
  'view.save': {keys: 'shift+v', label: 'Save the view', scope: 'list'},
  'inbox.read': {keys: 'e', label: 'Mark read', scope: 'inbox'},
  'inbox.unread': {keys: 'u', label: 'Mark unread', scope: 'inbox'},
  'inbox.pin': {keys: 'shift+p', label: 'Pin or unpin', scope: 'inbox'},
  'inbox.unsubscribe': {keys: 'shift+u', label: 'Unsubscribe from thread', scope: 'inbox'},
  'inbox.readAll': {keys: 'shift+e', label: 'Mark all read', scope: 'inbox'},
  'board.open': {keys: 'enter', label: 'Open the card', scope: 'board', local: true},
  'board.arrows': {keys: 'arrowup arrowdown arrowleft arrowright', label: 'Move the cursor', scope: 'board', local: true},
  'board.shiftArrows': {keys: 'shift+arrowup shift+arrowdown shift+arrowleft shift+arrowright', label: 'Move the card', scope: 'board', local: true},
  'board.left': {keys: 'h', label: 'Previous column', scope: 'board'},
  'board.right': {keys: 'l', label: 'Next column', scope: 'board'},
  'board.moveLeft': {keys: 'shift+h', label: 'Move the card to the previous column', scope: 'board'},
  'board.moveRight': {keys: 'shift+l', label: 'Move the card to the next column', scope: 'board'},
  'board.moveUp': {keys: 'shift+k', label: 'Move the card up', scope: 'board'},
  'board.moveDown': {keys: 'shift+j', label: 'Move the card down', scope: 'board'},
  'repo.star': {keys: '', label: 'Star repository', scope: 'global'},
  'repo.watch': {keys: '', label: 'Watch repository', scope: 'global'},
  'board.addColumn': {keys: '', label: 'Add a column', scope: 'board'},
  'board.renameColumn': {keys: '', label: 'Rename the column', scope: 'board'},
  'board.removeCard': {keys: 'backspace', label: 'Remove card from board', scope: 'board'},
  'board.deleteColumn': {keys: '', label: 'Delete the column', scope: 'board'},
  'issue.state': {keys: 's', label: 'Change status', scope: 'issue'},
  'issue.labels': {keys: 'l', label: 'Labels', scope: 'issue'},
  'issue.assignee': {keys: 'a', label: 'Assignees', scope: 'issue'},
  'issue.milestone': {keys: 'm', label: 'Milestone', scope: 'issue'},
  'issue.priority': {keys: 'p', label: 'Priority', scope: 'issue'},
  'pull.ready': {keys: '', label: 'Ready for review', scope: 'issue'},
  'pull.draft': {keys: '', label: 'Convert to draft', scope: 'issue'},
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
  code: 'Code',
  editor: 'Markdown editor',
  diff: 'Diffs',
  palette: 'Command menu',
};

export function isApple(): boolean {
  const nav = globalThis.navigator as (Navigator & {userAgentData?: {platform?: string}}) | undefined;
  const p = nav?.userAgentData?.platform ?? nav?.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(p);
}

const NAMES: Record<string, string> = {enter: '↵', escape: 'Esc', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', backspace: '⌫'};

/** Formats raw keymap notation into platform keycaps separated by spaces. */
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
    return apple ? [...mods, name].join('') : [...mods, name].join(' ');
  }).join(' ');
}

export function shortcutHint(id: ShortcutId): string {
  return formatKeys(KEYMAP[id].keys);
}
