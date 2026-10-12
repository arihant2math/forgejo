// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {EditorView} from '@codemirror/view';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {runInAction} from 'mobx';
import {useState} from 'react';
import {afterEach, expect, test, vi} from 'vitest';
import {fallbackConfig} from '../../app/config.ts';
import {connectivity} from '../../app/online.ts';
import {AppContext, createApp, type App, type Session} from '../../app/store.ts';
import {MarkdownField} from './Composer.tsx';
import {BaseStyles, ThemeProvider} from '@primer/react';

vi.mock('../issues/people.ts', () => ({loadPeople: vi.fn(), repoPeople: () => []}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  runInAction(() => { connectivity.online = true; });
});

function app(): App {
  const session = {userId: 1, auth: {token: () => Promise.resolve('token')}, data: {
    status: {connection: 'live'}, pool: {model: (model: string) => ({
      get: () => model === 'Repository' ? {data: {id: 7, archived: false, owner_id: 1}} : undefined,
      by: () => [],
    })},
  }} as unknown as Session;
  return createApp({...fallbackConfig(), attachments: {enabled: true, allowed_types: '.png,.zip', max_size: 1048576, max_files: 5}}, session);
}

function Field({app}: {app: App}) {
  const [value, setValue] = useState('before ');
  return <AppContext value={app}><ThemeProvider><BaseStyles><MarkdownField repoId={7} label="Comment" value={value} onChange={setValue}/></BaseStyles></ThemeProvider><output data-testid="text">{value}</output></AppContext>;
}

test('uploads a pasted screenshot, preserving later typing; failed uploads say the server reason and remove their placeholder', async () => {
  const root = app();
  let finish: ((res: Response) => void) | undefined;
  const fetcher = vi.fn((_url: string, req: RequestInit) => req.method === 'POST' ? new Promise<Response>((resolve) => { finish = resolve; }) : Promise.resolve(new Response('{"allowed":true}')));
  vi.stubGlobal('fetch', fetcher);
  render(<Field app={root}/>);
  await waitFor(() => { expect(screen.queryByRole('button', {name: 'Paste, drop, or click to add files'})).not.toBeNull(); });
  const file = new File(['image'], 'image.png', {type: 'image/png'});
  fireEvent.paste(screen.getByRole('textbox', {name: 'Comment'}), {clipboardData: {files: [file]}});
  await waitFor(() => { expect(screen.getByTestId('text').textContent).toContain('uploading-attachment:'); });
  await waitFor(() => { expect(fetcher.mock.calls.filter(([, req]) => req.method === 'POST')).toHaveLength(1); });
  const field = screen.getByRole('textbox', {name: 'Comment'});
  const view = EditorView.findFromDOM(field);
  if (view) act(() => { view.dispatch({changes: {from: view.state.doc.length, insert: 'typed'}}); });
  else fireEvent.change(field, {target: {value: `${screen.getByTestId('text').textContent}typed`}});
  const post = fetcher.mock.calls.find(([, req]) => req.method === 'POST')?.[1];
  expect(post?.body).toBeInstanceOf(FormData);
  expect(post?.headers).not.toHaveProperty('Idempotency-Key');
  await act(async () => { finish?.(new Response('{"uuid":"id","url":"/attachments/id"}', {status: 201})); await Promise.resolve(); });
  await waitFor(() => { expect(screen.getByTestId('text').textContent).toContain('![image.png](/attachments/id)'); });
  expect(screen.getByTestId('text').textContent).not.toContain('uploading-attachment:');
  expect(screen.getByTestId('text').textContent).toContain('typed');

  fireEvent.paste(screen.getByRole('textbox', {name: 'Comment'}), {clipboardData: {files: [file]}});
  await waitFor(() => { expect(screen.getByTestId('text').textContent).toContain('uploading-attachment:'); });
  await waitFor(() => { expect(fetcher.mock.calls.filter(([, req]) => req.method === 'POST')).toHaveLength(2); });
  await act(async () => { finish?.(new Response('{"message":"attachment storage quota exceeded"}', {status: 413})); await Promise.resolve(); });
  await waitFor(() => { expect(screen.getByTestId('text').textContent).not.toContain('uploading-attachment:'); });
  expect(root.ui.notices.at(-1)?.description).toBe('attachment storage quota exceeded');
});

test('offline uploads are disabled and pasted files produce a notice rather than disappearing silently', () => {
  runInAction(() => { connectivity.online = false; });
  const root = app();
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(<Field app={root}/>);
  expect(screen.getByRole('button', {name: 'Paste, drop, or click to add files'}).getAttribute('aria-disabled')).toBe('true');
  fireEvent.paste(screen.getByRole('textbox', {name: 'Comment'}), {clipboardData: {files: [new File(['x'], 'image.png')]}});
  expect(root.ui.notices.at(-1)?.title).toContain('needs a connection');
  expect(screen.getByTestId('text').textContent).toBe('before ');
  expect(fetcher).not.toHaveBeenCalled();
});

test('the server can forbid Attach even for a visible repository', async () => {
  const root = app();
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{"message":"you may not change this"}', {status: 403}))));
  render(<Field app={root}/>);
  await waitFor(() => { expect(fetch).toHaveBeenCalled(); });
  expect(screen.queryByRole('button', {name: 'Paste, drop, or click to add files'})).toBeNull();
});
