// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {EditorView} from '@codemirror/view';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, expect, test, vi} from 'vitest';
import FileEditor from './FileEditor.tsx';

const mocks = vi.hoisted(() => ({
  write: vi.fn(), navigate: vi.fn(), notify: vi.fn(),
  session: {data: {status: {connection: 'live'}, whenSynced: vi.fn(() => Promise.resolve())}},
  branches: new Map<string, string>([['main', 'a'.repeat(40)]]),
  upstream: undefined as {owner: string; name: string; defaultBranch: string} | undefined,
}));
vi.mock('../../app/store.ts', () => ({useApp: () => ({}), useSession: () => mocks.session}));
vi.mock('../../app/online.ts', () => ({reach: () => 'online'}));
vi.mock('../../app/notices.ts', () => ({notify: mocks.notify}));
vi.mock('../../app/api.ts', async (original) => ({...await original<object>(), onlineWrite: mocks.write}));
vi.mock('@tanstack/react-router', async (original) => ({...await original<object>(), useNavigate: () => mocks.navigate}));
vi.mock('../../intents/session.ts', () => ({editing: () => ({intents: {drafts: new Map(), keepText: vi.fn(), discardDraft: vi.fn()}})}));
vi.mock('../issues/cells.tsx', () => ({usePool: () => ({model: () => ({get: () => ({data: {archived: false, mirror: false}})})})}));
vi.mock('./hooks.ts', () => ({useSource: () => ({snippet: () => Promise.resolve(null)}), refTable: () => ({branches: mocks.branches, tags: new Map(), defaultBranch: 'main'})}));
vi.mock('./refOps.ts', () => ({branchProtected: () => Promise.resolve(false)}));
vi.mock('../editor/Composer.tsx', () => ({MarkdownPreview: () => null}));
vi.mock('./upstream.ts', async (original) => ({...await original<object>(), useUpstream: () => mocks.upstream}));

afterEach(() => {
  vi.clearAllMocks();
  mocks.upstream = undefined;
});

const at = {kind: 'branch' as const, ref: 'main', sha: 'a'.repeat(40), path: 'docs/spacing.md'};
const TEXT = 'Use 4px spacing.\nThe teh grid is 4px.\nteh end\n';

function editor() {
  render(<FileEditor owner="acme" repo="design" repoId={20} at={at} sha={'b'.repeat(40)} original={TEXT} onCancel={() => undefined}/>);
  const content = screen.getByRole('textbox', {name: 'File contents'});
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error('no editor');
  return {content, view};
}

test('Ctrl F opens find and replace in the editor; Replace all fixes every match (#175)', async () => {
  const {content, view} = editor();
  expect(document.querySelector('.cm-search')).toBeNull();
  act(() => {
    fireEvent.keyDown(content, {key: 'f', code: 'KeyF', ctrlKey: true});
  });
  const panel = await waitFor(() => {
    const p = document.querySelector<HTMLElement>('.cm-search');
    if (!p) throw new Error('no search panel');
    return p;
  });
  // jsdom's select() does not focus the field like CodeMirror expects in a browser.
  const find = within(panel).getByRole('textbox', {name: 'Find'});
  fireEvent.change(find, {target: {value: 'teh'}});
  fireEvent.keyUp(find, {key: 'h'});
  fireEvent.change(within(panel).getByRole('textbox', {name: 'Replace'}), {target: {value: 'the'}});
  fireEvent.keyUp(within(panel).getByRole('textbox', {name: 'Replace'}), {key: 'e'});
  act(() => {
    fireEvent.click(within(panel).getByRole('button', {name: 'replace all'}));
  });
  expect(view.state.doc.toString()).toBe('Use 4px spacing.\nThe the grid is 4px.\nthe end\n');
});

test('Ctrl H opens the panel with the focus in its replace field (#175)', async () => {
  const {content} = editor();
  act(() => {
    fireEvent.keyDown(content, {key: 'h', code: 'KeyH', ctrlKey: true});
  });
  await waitFor(() => {
    expect(document.activeElement?.getAttribute('name')).toBe('replace');
  });
  expect(document.querySelector('.cm-search')).toBeTruthy();
});

async function commit(fields: (dialog: HTMLElement) => void) {
  editor();
  await waitFor(() => {
    expect(screen.getByRole('button', {name: 'Commit changes…'})).toBeTruthy();
  });
  fireEvent.click(screen.getByRole('button', {name: 'Commit changes…'}));
  const dialog = await screen.findByRole('dialog', {name: 'Commit changes'});
  fields(dialog);
  const button = within(dialog).getByRole('button', {name: 'Commit changes'});
  await waitFor(() => {
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
  fireEvent.click(button);
  await waitFor(() => {
    expect(mocks.notify).toHaveBeenCalled();
  });
}

test('a commit to a new branch without a pull request opens the file on that branch and says where it went (#181)', async () => {
  const head = 'c'.repeat(40);
  mocks.write.mockImplementation(() => {
    mocks.branches.set('verify-nopr', head);
    return Promise.resolve({value: {commit: {sha: head}}, syncId: 41});
  });
  await commit((dialog) => {
    fireEvent.click(within(dialog).getByRole('radio', {name: /Create a new branch/}));
    fireEvent.change(within(dialog).getByRole('textbox', {name: 'New branch name'}), {target: {value: 'verify-nopr'}});
    fireEvent.click(within(dialog).getByRole('checkbox', {name: /Open a pull request/}));
  });
  expect(mocks.write.mock.calls[0]?.[1]).toMatchObject({method: 'PUT', body: {branch: 'main', new_branch: 'verify-nopr'}});
  expect(mocks.session.data.whenSynced).toHaveBeenCalledWith('repo:20', 41, expect.anything());
  expect(mocks.navigate).toHaveBeenCalledWith({to: '/$owner/$repo/$view/$', params: {owner: 'acme', repo: 'design', view: 'src', _splat: 'branch/verify-nopr/docs/spacing.md'}});
  const notice = mocks.notify.mock.calls[0]?.[1] as {tone: string; title: string; action?: {label: string; run: () => void}};
  expect(notice).toMatchObject({tone: 'success', title: 'Committed to verify-nopr'});
  expect(notice.action?.label).toBe('Open a pull request');
  notice.action?.run();
  expect(mocks.navigate).toHaveBeenLastCalledWith(expect.objectContaining({params: {owner: 'acme', repo: 'design', view: 'compare', _splat: 'main...verify-nopr'}, search: {expand: '1'}}));
  mocks.branches.delete('verify-nopr');
});

test('a direct commit lands on its branch; before the sync has it, on the commit (never a bare SHA without a word)', async () => {
  const head = 'd'.repeat(40);
  mocks.write.mockResolvedValue({value: {commit: {sha: head}}, syncId: undefined});
  await commit(() => undefined);
  // Without a synced branch head, navigation must use the commit SHA.
  expect(mocks.navigate).toHaveBeenCalledWith({to: '/$owner/$repo/$view/$', params: {owner: 'acme', repo: 'design', view: 'src', _splat: `commit/${head}/docs/spacing.md`}});
  const notice = mocks.notify.mock.calls[0]?.[1] as {action?: unknown} | undefined;
  expect(notice).toMatchObject({tone: 'success', title: 'Committed to main'});
  expect(notice?.action).toBeUndefined();
});

test('in a fork, the new branch\'s pull request is proposed to the upstream, as the dialog says (#173)', async () => {
  mocks.upstream = {owner: 'acme', name: 'design-upstream', defaultBranch: 'trunk'};
  const head = 'e'.repeat(40);
  mocks.write.mockImplementation(() => {
    mocks.branches.set('fix-typo', head);
    return Promise.resolve({value: {commit: {sha: head}}, syncId: 42});
  });
  editor();
  await waitFor(() => {
    expect(screen.getByRole('button', {name: 'Commit changes…'})).toBeTruthy();
  });
  fireEvent.click(screen.getByRole('button', {name: 'Commit changes…'}));
  const dialog = await screen.findByRole('dialog', {name: 'Commit changes'});
  fireEvent.click(within(dialog).getByRole('radio', {name: /Create a new branch/}));
  fireEvent.change(within(dialog).getByRole('textbox', {name: 'New branch name'}), {target: {value: 'fix-typo'}});
  const pull = within(dialog).getByRole('checkbox', {name: 'Open a pull request into acme/design-upstream:trunk'});
  expect((pull as HTMLInputElement).checked).toBe(true);
  const button = within(dialog).getByRole('button', {name: 'Commit changes'});
  await waitFor(() => {
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
  fireEvent.click(button);
  await waitFor(() => {
    expect(mocks.navigate).toHaveBeenCalled();
  });
  expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({
    params: {owner: 'acme', repo: 'design-upstream', view: 'compare', _splat: 'trunk...acme/design:fix-typo'}, search: {expand: '1'},
  }));
  expect(mocks.notify).not.toHaveBeenCalled();
  mocks.branches.delete('fix-typo');
});

test('in a fork, the notice\'s pull request action goes to the upstream (#173)', async () => {
  mocks.upstream = {owner: 'upstream-org', name: 'design', defaultBranch: 'main'};
  const head = 'f'.repeat(40);
  mocks.write.mockImplementation(() => {
    mocks.branches.set('later', head);
    return Promise.resolve({value: {commit: {sha: head}}, syncId: 43});
  });
  await commit((dialog) => {
    fireEvent.click(within(dialog).getByRole('radio', {name: /Create a new branch/}));
    fireEvent.change(within(dialog).getByRole('textbox', {name: 'New branch name'}), {target: {value: 'later'}});
    fireEvent.click(within(dialog).getByRole('checkbox', {name: /Open a pull request into upstream-org\/design:main/}));
  });
  const notice = mocks.notify.mock.calls[0]?.[1] as {title: string; action?: {label: string; run: () => void}};
  expect(notice.title).toBe('Committed to later');
  expect(notice.action?.label).toBe('Open a pull request into upstream-org/design:main');
  notice.action?.run();
  expect(mocks.navigate).toHaveBeenLastCalledWith(expect.objectContaining({
    params: {owner: 'upstream-org', repo: 'design', view: 'compare', _splat: 'main...acme:later'}, search: {expand: '1'},
  }));
  mocks.branches.delete('later');
});
