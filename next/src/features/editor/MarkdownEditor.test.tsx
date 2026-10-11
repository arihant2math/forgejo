// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {EditorView} from '@codemirror/view';
import {afterEach, expect, test, vi} from 'vitest';
import {shortcuts} from '../../app/shortcuts/index.ts';
import {createRef} from 'react';
import MarkdownEditor, {type MarkdownEditorHandle} from './MarkdownEditor.tsx';
import {uploadPlaceholder} from './attachments.ts';

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

test('inserts uploads at the caret, replaces them after typing, and leaves a deleted marker deleted', () => {
  const ref = createRef<MarkdownEditorHandle>();
  render(<MarkdownEditor ref={ref} value="before after" onChange={vi.fn()} label="Comment"/>);
  const field = screen.getByRole('textbox', {name: 'Comment'});
  const view = EditorView.findFromDOM(field);
  if (!view) throw new Error('Editor did not mount');
  const placeholder = uploadPlaceholder('test', 'image.png');
  act(() => {
    view.dispatch({selection: {anchor: 7}});
    ref.current?.insert(placeholder);
    ref.current?.insert(' typed');
  });
  expect(screen.getByText('Uploading image.png…')).not.toBeNull();
  act(() => { ref.current?.replace(placeholder, '![image.png](/attachments/id)'); });
  expect(view.state.doc.toString()).toBe('before ![image.png](/attachments/id) typedafter');
  act(() => { ref.current?.replace(placeholder, 'unexpected'); });
  expect(view.state.doc.toString()).not.toContain('unexpected');
});

test('pasted and dropped files are intercepted, while ordinary text keeps native behavior', () => {
  const files = vi.fn();
  render(<MarkdownEditor value="" onChange={vi.fn()} label="Comment" onFiles={files}/>);
  const field = screen.getByRole('textbox', {name: 'Comment'});
  const image = new File(['image'], 'image.png', {type: 'image/png'});
  fireEvent.paste(field, {clipboardData: {files: [image]}});
  expect(files).toHaveBeenCalledWith([image]);
  fireEvent.drop(field, {dataTransfer: {files: [image]}, clientX: 0, clientY: 0});
  expect(files).toHaveBeenCalledTimes(2);
  fireEvent.paste(field, {clipboardData: {files: [], getData: () => ''}});
  expect(files).toHaveBeenCalledTimes(2);
});
