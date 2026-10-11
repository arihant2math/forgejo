// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {defineLanguageFacet, Language, LanguageSupport, syntaxTree} from '@codemirror/language';
import type {StateCommand} from '@codemirror/state';
import {tags} from '@lezer/highlight';
import {GFM, parser} from '@lezer/markdown';

const marker = /^(?:<<<<<<<(?: .*)?|=======|>>>>>>>(?: .*)?)$/;

export const markdown = new LanguageSupport(new Language(defineLanguageFacet(), parser.configure([GFM, {
  defineNodes: [{name: 'Conflict', block: true}, {name: 'ConflictMarker', style: tags.processingInstruction}],
  parseBlock: [{
    name: 'ConflictMarker',
    before: 'SetextHeading',
    endLeaf: (_cx, line) => /^<<<<<<<(?: |$)/.test(line.text),
    parse(cx, line) {
      if (!/^<<<<<<<(?: |$)/.test(line.text)) return false;
      const from = cx.lineStart;
      const children = [];
      let to: number;
      do {
        to = cx.lineStart + line.text.length;
        if (marker.test(line.text)) children.push(cx.elt('ConflictMarker', cx.lineStart, to));
        if (/^>>>>>>>(?: |$)/.test(line.text)) {
          cx.nextLine();
          break;
        }
      } while (cx.nextLine());
      cx.addElement(cx.elt('Conflict', from, to, children));
      return true;
    },
  }],
}]), [], 'markdown'));

/** Continue a list, or remove an empty marker to leave it. */
export const continueList: StateCommand = ({state, dispatch}) => {
  const selection = state.selection.main;
  if (!selection.empty || state.selection.ranges.length !== 1) return false;
  const line = state.doc.lineAt(selection.head);
  let node = syntaxTree(state).resolveInner(selection.head, -1);
  for (; ; ) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return false;
    if (!node.parent) break;
    node = node.parent;
  }
  const match = /^(\s*)([-*+]|(\d+)([.)]))\s+(?:\[([ xX])\]\s+)?/.exec(line.text);
  if (!match || selection.head < line.from + match[0].length) return false;
  const empty = !line.text.slice(match[0].length).trim();
  const bullet = match[3] ? `${String(Number(match[3]) + 1)}${match[4] ?? '.'}` : match[2];
  const insert = empty ? '' : `\n${match[1] ?? ''}${bullet ?? '-'} ${match[5] !== undefined ? '[ ] ' : ''}`;
  const from = empty ? line.from : selection.head;
  const to = empty ? line.to : selection.head;
  dispatch(state.update({changes: {from, to, insert}, selection: {anchor: from + insert.length}, userEvent: 'input'}));
  return true;
};
