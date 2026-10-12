// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {expect, test, vi} from 'vitest';
import {FileOperations} from './FileOperations.tsx';

const mocks = vi.hoisted(() => ({
  write: vi.fn(), navigate: vi.fn(), tree: vi.fn(),
  session: {data: {status: {connection: 'online'}, whenSynced: vi.fn()}},
  drafts: new Map(), keepText: vi.fn(), discardDraft: vi.fn(),
}));
vi.mock('../../app/store.ts', () => ({useApp: () => ({}), useSession: () => mocks.session}));
vi.mock('../../app/access.ts', () => ({canWrite: () => true}));
vi.mock('../../app/online.ts', () => ({reach: () => mocks.session.data.status.connection}));
vi.mock('../../app/api.ts', async (original) => ({...await original<object>(), onlineWrite: mocks.write}));
vi.mock('@tanstack/react-router', async (original) => ({...await original<object>(), useNavigate: () => mocks.navigate}));
vi.mock('../../intents/session.ts', () => ({editing: () => ({intents: {drafts: mocks.drafts, keepText: mocks.keepText, discardDraft: mocks.discardDraft}})}));
vi.mock('../issues/cells.tsx', () => ({usePool: () => ({model: () => ({get: () => ({data: {empty: false}})})})}));
vi.mock('./hooks.ts', () => ({useSource: () => ({tree: mocks.tree}), refTable: () => ({branches: new Map(), tags: new Map()})}));
vi.mock('./refOps.ts', () => ({branchProtected: () => Promise.resolve(false)}));

const props = {owner: 'alice', repo: 'repo', repoId: 20, at: {kind: 'branch' as const, ref: 'main', sha: 'head', path: 'docs'}};

test('a folder deletion sends every nested blob in one commit', async () => {
  mocks.tree.mockImplementation((_id: number, _sha: string, path: string) => Promise.resolve({entries: path === 'docs' ? [
    {name: 'a.txt', type: 'blob', sha: 'a'}, {name: 'nested', type: 'tree', sha: 'folder'},
  ] : [{name: 'b.txt', type: 'blob', sha: 'b'}]}));
  mocks.write.mockResolvedValue({value: {commit: {sha: 'new-head'}}});
  render(<FileOperations {...props} target={{folder: true, sha: 'folder'}}>{(controls, _drop, remove) => <>{controls}<button type="button" disabled={remove?.disabled} onClick={remove?.onSelect}>Delete directory</button></>}</FileOperations>);
  fireEvent.click(screen.getByRole('button', {name: 'Add file'}));
  expect(await screen.findAllByRole('menuitem')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', {name: 'Delete directory'}));
  const dialog = await screen.findByRole('dialog', {name: 'Commit changes'});
  await waitFor(() => {expect((within(dialog).getByRole('button', {name: 'Commit changes'}) as HTMLButtonElement).disabled).toBe(false);});
  fireEvent.click(within(dialog).getByRole('button', {name: 'Commit changes'}));
  await waitFor(() => {expect(mocks.write).toHaveBeenCalledOnce();});
  expect(mocks.write.mock.calls[0]?.[1]).toMatchObject({api: 'v1', method: 'POST', path: '/repos/alice/repo/contents', body: {
    branch: 'main', message: 'Delete docs', files: [
      {operation: 'delete', path: 'docs/a.txt', sha: 'a'}, {operation: 'delete', path: 'docs/nested/b.txt', sha: 'b'},
    ],
  }});
});

test('uploads preserve relative paths, can be removed, and commit base64 in one batch', async () => {
  mocks.write.mockClear();
  mocks.write.mockResolvedValue({value: {commit: {sha: 'uploaded'}}});
  render(<FileOperations {...props}/>);
  fireEvent.click(screen.getByRole('button', {name: 'Add file'}));
  const upload = await screen.findByRole('menuitem', {name: 'Upload files'});
  expect(upload.querySelector('.octicon-upload')).not.toBeNull();
  expect(screen.getByRole('menuitem', {name: 'Create new file'}).querySelector('.octicon-plus')).not.toBeNull();
  fireEvent.click(upload);
  const file = new File(['hello'], 'a.txt', {type: 'text/plain'});
  Object.defineProperty(file, 'webkitRelativePath', {value: 'folder/a.txt'});
  fireEvent.change(screen.getByLabelText('Choose files'), {target: {files: [file, new File(['remove me'], 'b.txt')]}});
  fireEvent.click(screen.getAllByRole('button', {name: 'Remove'})[1] as HTMLElement);
  fireEvent.click(screen.getByRole('button', {name: 'Commit changes…'}));
  const dialog = await screen.findByRole('dialog', {name: 'Commit changes'});
  await waitFor(() => {expect((within(dialog).getByRole('button', {name: 'Commit changes'}) as HTMLButtonElement).disabled).toBe(false);});
  fireEvent.click(within(dialog).getByRole('button', {name: 'Commit changes'}));
  await waitFor(() => {expect(mocks.write).toHaveBeenCalledOnce();});
  expect(mocks.write.mock.calls[0]?.[1]).toMatchObject({method: 'POST', body: {files: [{operation: 'create', path: 'docs/folder/a.txt', content: 'aGVsbG8='}]}});
});

test('toolbar actions retain the directory drop target', async () => {
  render(<FileOperations {...props}>{(controls, dropProps) => <><header>{controls}</header><main {...dropProps}>Directory files</main></>}</FileOperations>);
  expect(screen.getByRole('banner').contains(screen.getByRole('button', {name: 'Add file'}))).toBe(true);
  fireEvent.drop(screen.getByRole('main'), {dataTransfer: {types: ['Files'], files: [new File(['hello'], 'dropped.txt')]}});
  const dialog = await screen.findByRole('dialog', {name: 'Upload files'});
  expect(within(dialog).getByText('dropped.txt · 5 B')).toBeTruthy();
});

test('offline file changes are disabled with a reason', () => {
  mocks.session.data.status.connection = 'offline';
  render(<FileOperations {...props}/>);
  expect((screen.getByRole('button', {name: 'Add file'}) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Offline: file changes need a connection/)).toBeTruthy();
  mocks.session.data.status.connection = 'online';
});
