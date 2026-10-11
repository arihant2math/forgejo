import {createMemoryHistory} from '@tanstack/react-router';
import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import type * as APIModule from '../../app/api.ts';
import {online} from '../../app/api.ts';
import {fallbackConfig} from '../../app/config.ts';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import {fakeSession} from '../../test/fakeSession.ts';

vi.mock('../../app/api.ts', async (original) => ({...await original<typeof APIModule>(), online: vi.fn()}));
afterEach(() => { vi.clearAllMocks(); });
async function mount(path: string) {
  const app = createApp(fallbackConfig(), fakeSession());
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  return router;
}
test('repository results contain safe highlighted text and commit-pinned line links', async () => {
  vi.mocked(online).mockResolvedValue({enabled: false, total: 1, repositories: {'10': 'alice/project'}, results: [{RepoID: 10, Filename: 'src/main.ts', CommitID: 'abcdef', Lines: [{Num: 7, FormattedContent: '<span>const <mark>symbol</mark> = &lt;danger&gt;</span>'}]}]});
  const router = await mount('/search?type=code&repoId=10&q=symbol');
  const row = await screen.findByRole('option', {name: 'alice/project / src/main.ts:7'});
  expect(row.getAttribute('href')).toContain('/src/commit/abcdef/src/main.ts#L7');
  expect(screen.getByText('symbol').tagName).toBe('MARK');
  expect(screen.getByText(/<danger>/).textContent).toContain('<danger>');
  expect(vi.mocked(online).mock.calls[0]?.[1].path).toContain('/repos/10/search?');
  fireEvent.click(screen.getByRole('button', {name: 'Search all repositories'}));
  await waitFor(() => { expect(router.state.location.search.repoId).toBeUndefined(); });
});
test('global search explains a disabled code indexer', async () => {
  vi.mocked(online).mockResolvedValue({enabled: false, total: 0, results: []});
  await mount('/search?type=code&q=symbol');
  await screen.findByText('Global code search is unavailable');
});
