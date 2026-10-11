// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {EditorView} from '@codemirror/view';
import {afterEach, expect, test, vi} from 'vitest';
import {shortcuts} from '../../app/shortcuts/index.ts';
import MarkdownEditor from './MarkdownEditor.tsx';

afterEach(cleanup);

test('editing starts at the end and Escape blurs a composer', () => {
  render(<MarkdownEditor value="Existing text" onChange={vi.fn()} label="Comment" autoFocus/>);
  const field = screen.getByRole('textbox', {name: 'Comment'});
  const view = EditorView.findFromDOM(field);
  expect(view?.state.selection.main.head).toBe('Existing text'.length);
  expect(document.activeElement).toBe(field);
  fireEvent.keyDown(field, {key: 'Escape'});
  expect(document.activeElement).not.toBe(field);
});

test('Escape requests cancellation and Ctrl+K reaches the global command menu', () => {
  const cancel = vi.fn();
  const palette = vi.fn();
  const unbind = shortcuts.bind('palette.open', palette);
  const detach = shortcuts.attach(window);
  render(<MarkdownEditor value="Text" onChange={vi.fn()} label="Comment" onCancel={cancel} autoFocus/>);
  try {
    const field = screen.getByRole('textbox', {name: 'Comment'});
    fireEvent.keyDown(field, {key: 'Escape'});
    expect(cancel).toHaveBeenCalledOnce();
    fireEvent.keyDown(field, {key: 'k', ctrlKey: true});
    expect(palette).toHaveBeenCalledOnce();
    expect(EditorView.findFromDOM(field)?.state.doc.toString()).toBe('Text');
  } finally {
    detach();
    unbind();
  }
});
