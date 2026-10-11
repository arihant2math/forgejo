// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The in-browser file editor: find and replace in the file (#175), and where a commit lands — the file on the branch
// it went to, said in a notice (#181).

import {EditorView} from '@codemirror/view';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, expect, test, vi} from 'vitest';
import FileEditor from './FileEditor.tsx';

const mocks = vi.hoisted(() => ({
  write: vi.fn(), navigate: vi.fn(), notify: vi.fn(),
  session: {data: {status: {connection: 'live'}, whenSynced: vi.fn(() => Promise.resolve())}},
  branches: new Map<string, string>([['main', 'a'.repeat(40)]]),
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

afterEach(() => {
  vi.clearAllMocks();
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
  // (CodeMirror selects the field, which focuses it in a browser; jsdom's select() does not.)
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
    // The push's sync: the new branch is in the pool once it arrived.
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
  expect(mocks.navigate).toHaveBeenCalledWith({to: '/-/next/code/$owner/$repo/$', params: {owner: 'acme', repo: 'design', _splat: 'src/branch/verify-nopr/docs/spacing.md/-'}});
  const notice = mocks.notify.mock.calls[0]?.[1] as {tone: string; title: string; action?: {label: string; run: () => void}};
  expect(notice).toMatchObject({tone: 'success', title: 'Committed to verify-nopr'});
  // The way on to a pull request, from the notice.
  expect(notice.action?.label).toBe('Open a pull request');
  notice.action?.run();
  expect(mocks.navigate).toHaveBeenLastCalledWith(expect.objectContaining({params: {owner: 'acme', repo: 'design', _splat: 'compare/main...verify-nopr/-'}, search: {expand: '1'}}));
  mocks.branches.delete('verify-nopr');
});

test('a direct commit lands on its branch; before the sync has it, on the commit (never a bare SHA without a word)', async () => {
  const head = 'd'.repeat(40);
  mocks.write.mockResolvedValue({value: {commit: {sha: head}}, syncId: undefined});
  await commit(() => undefined);
  // The pool still has main at its old head: the file at the new commit, and the notice names the branch.
  expect(mocks.navigate).toHaveBeenCalledWith({to: '/-/next/code/$owner/$repo/$', params: {owner: 'acme', repo: 'design', _splat: `src/commit/${head}/docs/spacing.md/-`}});
  const notice = mocks.notify.mock.calls[0]?.[1] as {action?: unknown} | undefined;
  expect(notice).toMatchObject({tone: 'success', title: 'Committed to main'});
  expect(notice?.action).toBeUndefined();
});
