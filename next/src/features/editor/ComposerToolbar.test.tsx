// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {EditorView} from '@codemirror/view';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {useState} from 'react';
import {afterEach, expect, test, vi} from 'vitest';
import {fallbackConfig} from '../../app/config.ts';
import {AppContext, createApp, type App, type Session} from '../../app/store.ts';
import {BaseStyles, ThemeProvider} from '@primer/react';
import {type EditorTool, MarkdownField} from './Composer.tsx';
import MarkdownEditor from './MarkdownEditor.tsx';
import {QuoteIcon} from '@primer/octicons-react';

vi.mock('../issues/people.ts', () => ({loadPeople: vi.fn(), repoPeople: () => []}));
afterEach(cleanup);

function app(): App {
  const session = {userId: 1, auth: {token: () => Promise.resolve('token')}, data: {
    status: {connection: 'live'}, pool: {model: () => ({get: () => undefined, by: () => []})},
  }} as unknown as Session;
  return createApp(fallbackConfig(), session);
}

function Field({initial, tools}: {initial: string; tools?: EditorTool[]}) {
  const [value, setValue] = useState(initial);
  return <AppContext value={app()}><ThemeProvider><BaseStyles>
    <MarkdownField repoId={0} label="Description" value={value} onChange={setValue} tools={tools} autoFocus/>
  </BaseStyles></ThemeProvider><output data-testid="text">{value}</output></AppContext>;
}

async function editorView(): Promise<EditorView> {
  let view: EditorView | null = null;
  await waitFor(() => {
    view = EditorView.findFromDOM(screen.getByRole('textbox', {name: 'Description'}));
    expect(view).not.toBeNull();
  });
  return view as unknown as EditorView;
}

test('the toolbar has a Code button: a pasted log becomes a fenced block, a word inline code', async () => {
  const log = 'panic: tile out of range\ngoroutine 1 [running]';
  render(<Field initial={`It crashed:\n${log}`}/>);
  const view = await editorView();
  const code = screen.getByRole('button', {name: 'Code'});
  await waitFor(() => { expect(code.getAttribute('aria-disabled')).not.toBe('true'); });
  const from = view.state.doc.toString().indexOf('panic');
  act(() => { view.dispatch({selection: {anchor: from, head: from + log.length}}); });
  fireEvent.click(code);
  expect(screen.getByTestId('text').textContent).toBe(`It crashed:\n\`\`\`\n${log}\n\`\`\``);
  act(() => { view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: 'run make test'}, selection: {anchor: 4, head: 13}}); });
  fireEvent.click(code);
  expect(screen.getByTestId('text').textContent).toBe('run `make test`');
});

test('callers add their own toolbar tools, applied to the selection as one change', async () => {
  const tool: EditorTool = {id: 'shout', icon: QuoteIcon, label: 'Shout', edit: (doc, from, to) => {
    const insert = doc.slice(from, to).toUpperCase();
    return {from, to, insert, anchor: from, head: from + insert.length};
  }};
  render(<Field initial="say hello" tools={[tool]}/>);
  const view = await editorView();
  const button = screen.getByRole('button', {name: 'Shout'});
  await waitFor(() => { expect(button.getAttribute('aria-disabled')).not.toBe('true'); });
  act(() => { view.dispatch({selection: {anchor: 4, head: 9}}); });
  fireEvent.click(button);
  expect(screen.getByTestId('text').textContent).toBe('say HELLO');
});

test('the format buttons are one toolbar: a single tab stop, arrow keys move between its buttons', async () => {
  render(<Field initial="note"/>);
  await editorView();
  const toolbar = screen.getByRole('toolbar', {name: 'Formatting tools'});
  const buttons = within(toolbar).getAllByRole('button').filter((b) => !b.hasAttribute('data-more-button-inactive'));
  expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Heading', 'Bold', 'Italic', 'Quote', 'Code', 'Link', 'Numbered list', 'Unordered list', 'Task list']);
  expect(buttons.filter((b) => b.tabIndex === 0)).toEqual([buttons[0]]);
  act(() => { buttons[0]?.focus(); });
  fireEvent.keyDown(document.activeElement ?? document.body, {key: 'ArrowRight'});
  expect(document.activeElement).toBe(buttons[1]);
  fireEvent.keyDown(document.activeElement ?? document.body, {key: 'End'});
  expect(document.activeElement).toBe(buttons.at(-1));
});

test('Mod-E formats the selection as code in the editor', () => {
  const change = vi.fn();
  render(<MarkdownEditor value="use git log" onChange={change} label="Comment" autoFocus/>);
  const field = screen.getByRole('textbox', {name: 'Comment'});
  const view = EditorView.findFromDOM(field);
  if (!view) throw new Error('Editor did not mount');
  act(() => { view.dispatch({selection: {anchor: 4, head: 11}}); });
  fireEvent.keyDown(field, {key: 'e', ctrlKey: true});
  expect(view.state.doc.toString()).toBe('use `git log`');
});
