// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {observer} from 'mobx-react-lite';
import {textOfMarkup} from '../../app/trusted.ts';
import {useCallback, useEffect, useState} from 'react';
import {useNavigate, useSearch} from '@tanstack/react-router';
import {useVirtualizer} from '@tanstack/react-virtual';
import {online} from '../../app/api.ts';
import {connectivity} from '../../app/online.ts';
import {useApp} from '../../app/store.ts';
import {hrefOf, useLinkClick} from '../../app/links.ts';
import {codePath} from '../../app/paths.ts';
import {PageBody, pageListRect} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {Button, Input, ListRow, EmptyState, CodeLine, SegmentedControl} from '../../ui/index.ts';
import {discoverySearch, kinds} from './params.ts';

interface Hit {RepoID: number; Filename: string; CommitID: string; Lines: {Num: number; FormattedContent: string}[]}
interface Answer {enabled: boolean; total: number; results: Hit[]; repositories: Record<string, string>}
const plain = textOfMarkup;
function snippet(text: string, query: string) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  return at < 0 || !query ? text : <>{text.slice(0, at)}<mark>{text.slice(at, at + query.length)}</mark>{text.slice(at + query.length)}</>;
}
export default observer(function CodeSearch() {
  const app = useApp();
  const navigate = useNavigate();
  const raw = useSearch({strict: false}) as Record<string, unknown>;
  const q = typeof raw.q === 'string' ? raw.q : '';
  const repoId = Number(raw.repoId) || undefined;
  const page = Math.min(100, Math.max(1, Number(raw.page) || 1));
  const connected = connectivity.online;
  const repoName = repoId === undefined ? undefined : app.session?.data.pool.model('Repository').get(repoId)?.data.full_name;
  const [query, setQuery] = useState(q);
  const [answer, setAnswer] = useState<Answer>();
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState(0);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const click = useLinkClick();
  const patch = useCallback((changes: Record<string, unknown>) => { void navigate({to: '/search', search: discoverySearch({...raw, ...changes, type: 'code', repoId})}); }, [navigate, raw, repoId]);
  useEffect(() => { setQuery(q); }, [q]);
  useEffect(() => {
    if (query === q) return;
    const timer = setTimeout(() => { patch({q: query, page: 1}); }, 250);
    return () => { clearTimeout(timer); };
  }, [query, q, patch]);
  useEffect(() => {
    setAnswer(undefined); setError(''); setCursor(0);
    if (!connected) { setError('Code search requires an internet connection.'); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void online<Answer>(app, {api: 'sync', path: `${repoId ? `/repos/${repoId}/search` : '/search/code'}?${new URLSearchParams({q, page: String(page)})}`, signal: controller.signal}).then((value) => { if (!controller.signal.aborted) setAnswer(value); }).catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Search failed'); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [app, q, page, repoId, connected]);
  const rows = (answer?.results ?? []).flatMap((hit) => hit.Lines.map((line) => ({hit, line})));
  const virtual = useVirtualizer({count: rows.length, getScrollElement: () => scroller, estimateSize: () => 64, overscan: 5, ...pageListRect()});
  const resultHref = (index: number) => {
    const row = rows[index];
    const name = row && answer?.repositories[String(row.hit.RepoID)];
    const [owner, repo] = name?.split('/') ?? [];
    // The app's code view of the file at the searched commit, at the line (a classic address would be rewritten to it).
    return row && owner && repo ? hrefOf(app, `${codePath(owner, repo, `src/commit/${row.hit.CommitID}/${row.hit.Filename}`)}#L${String(row.line.Num)}`) : undefined;
  };
  const open = () => { const href = resultHref(cursor); if (href) void navigate({href}); };
  return <><PageHeader title={repoId ? `Search code in ${repoName ?? 'this repository'}` : 'Search code'}><Input aria-label="Search code" autoFocus={!q} value={query} placeholder="Word or symbol…" onKeyDown={(e) => { if (e.key === 'Enter' && query === q) { e.preventDefault(); open(); } }} onChange={(e) => { setQuery(e.target.value); }}/><Button onClick={() => { void navigate({to: '/search', search: discoverySearch({q, type: 'repositories'})}); }}>All search types</Button></PageHeader>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2"><SegmentedControl label="Search type" value="code" onChange={(type) => { void navigate({to: '/search', search: discoverySearch({q, type})}); }} options={kinds.map((kind) => ({value: kind, label: kind === 'code' ? 'Code' : kind === 'pulls' ? 'Pull requests' : kind.slice(0, 1).toUpperCase() + kind.slice(1)}))}/>{repoId && <Button onClick={() => { void navigate({to: '/search', search: discoverySearch({q, type: 'code'})}); }}>Search all repositories</Button>}</div>
    <PageBody ref={setScroller}>
      {error && <p role="alert" className="p-4">{error}</p>}
      {answer && !answer.enabled && !repoId && <EmptyState title="Global code search is unavailable" description="The repository code indexer is disabled on this instance."/>}
      {answer && (answer.enabled || repoId) && !rows.length && <EmptyState title={q ? 'No matching code' : 'Search file contents'} description="Enter a word or symbol to find matching files and lines."/>}
      {!answer && !error && <p role="status" className="p-4">Searching code…</p>}
      <div role="listbox" aria-label="Code search results" tabIndex={0} onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); open(); }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const next = Math.max(0, Math.min(rows.length - 1, cursor + (e.key === 'ArrowDown' ? 1 : -1))); setCursor(next); virtual.scrollToIndex(next); }
      }} className="relative" style={{height: virtual.getTotalSize()}}>{virtual.getVirtualItems().map((item) => {
        const row = rows[item.index]; if (!row) return null;
        const name = answer?.repositories[String(row.hit.RepoID)]; if (!name) return null;
        const href = resultHref(item.index);
        if (!href) return null;
        return <div key={`${row.hit.RepoID}:${row.hit.Filename}:${row.line.Num}`} className="absolute inset-x-0 top-0" style={{transform: `translateY(${item.start}px)`}}><ListRow role="option" active={cursor === item.index} selected={cursor === item.index} href={href} onClick={(e) => { click(e, href); }}>{name} / {row.hit.Filename}:{row.line.Num}</ListRow><a href={href} onClick={(e) => { click(e, href); }}><CodeLine gutter={null}>{snippet(plain(row.line.FormattedContent), q)}</CodeLine></a></div>;
      })}</div>
      {answer && answer.total > 50 && <div className="flex gap-2 p-4"><Button disabled={page <= 1} onClick={() => { patch({page: page - 1}); }}>Previous</Button><span>Page {page}</span><Button disabled={page * 50 >= answer.total || page >= 100} onClick={() => { patch({page: page + 1}); }}>Next</Button></div>}
    </PageBody></>;
});
