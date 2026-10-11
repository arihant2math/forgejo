// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {EditorState} from '@codemirror/state';
import {syntaxTree} from '@codemirror/language';
import {expect, test} from 'vitest';
import {continueList, markdown} from './markdown.ts';

test.each([
  ['- one', '- one\n- '],
  ['  * one', '  * one\n  * '],
  ['1. one', '1. one\n2. '],
  ['- [x] one', '- [x] one\n- [ ] '],
  ['- ', ''],
  ['- [ ] ', ''],
  ['```\n- one', '```\n- one'],
])('Enter continues or ends lists: %s', (doc, expected) => {
  let state = EditorState.create({doc, selection: {anchor: doc.length}, extensions: [markdown]});
  continueList({state, dispatch: (tr) => { state = tr.state; }});
  expect(state.doc.toString()).toBe(expected);
});

test('conflict separators are markers, not setext headings', () => {
  const state = EditorState.create({doc: 'Line one.\n<<<<<<< yours\nMine.\n=======\nTheirs.\n>>>>>>> theirs', extensions: [markdown]});
  const names: string[] = [];
  syntaxTree(state).iterate({enter: (node) => { names.push(node.name); }});
  expect(names).not.toContain('SetextHeading1');
  expect(names.filter((name) => name === 'ConflictMarker')).toHaveLength(3);
  const heading = EditorState.create({doc: 'Heading\n=======', extensions: [markdown]});
  expect(syntaxTree(heading).topNode.firstChild?.name).toBe('SetextHeading1');
});
