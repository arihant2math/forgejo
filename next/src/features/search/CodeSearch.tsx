// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {observer} from 'mobx-react-lite';
import {useCallback, useEffect, useMemo, useState} from 'react';
import {useNavigate, useSearch} from '@tanstack/react-router';
import {useVirtualizer} from '@tanstack/react-virtual';
import {online} from '../../app/api.ts';
import {connectivity} from '../../app/online.ts';
import {useApp} from '../../app/store.ts';
import {hrefOf, useLinkClick} from '../../app/links.ts';
import {codePath} from '../../app/paths.ts';
import {PageBody, pageListRect} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {Input, ListRow, EmptyState, CodeLine, SegmentedControl} from '../../ui/index.ts';
import {discoverySearch, kinds} from './params.ts';
import {type Hit, matchRows, type ShownLine} from './codeHits.ts';
import {Button} from '@primer/react';

interface Answer {enabled: boolean; total: number; results: Hit[]; repositories: Record<string, string>}

/** A line of a hit: its number, its text with the words that matched marked; a context line dimmed. */
function HitCode({line, context = false}: {line: ShownLine; context?: boolean}) {
  return (
    <CodeLine gutter={<span className="w-12 shrink-0 pr-2 text-right text-fg-subtle tabular-nums select-none">{line.num}</span>}>
      <span className={context ? 'text-fg-subtle' : undefined}>{line.runs.map((r, i) => (r.marked ? <mark key={i}>{r.text}</mark> : <span key={i}>{r.text}</span>))}</span>
    </CodeLine>
  );
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
  // The matching lines only (the hits: rows, the cursor's stops), each with its context (#248).
  const rows = useMemo(() => matchRows(answer?.results ?? []), [answer]);
  const virtual = useVirtualizer({
    count: rows.length, getScrollElement: () => scroller, overscan: 5, ...pageListRect(),
    estimateSize: (i) => 40 + 20 * (1 + (rows[i]?.before.length ?? 0) + (rows[i]?.after.length ?? 0)),
  });
  const resultHref = (index: number) => {
    const row = rows[index];
    const name = row && answer?.repositories[String(row.hit.RepoID)];
    const [owner, repo] = name?.split('/') ?? [];
    // The app's code view of the file at the searched commit, at the line (a classic address would be rewritten to it).
    return row && owner && repo ? hrefOf(app, `${codePath(owner, repo, `src/commit/${row.hit.CommitID}/${row.hit.Filename}`)}#L${String(row.line.num)}`) : undefined;
  };
  const open = () => { const href = resultHref(cursor); if (href) void navigate({href}); };
  return <><PageHeader title={repoId ? `Search code in ${repoName ?? 'this repository'}` : 'Search code'}><Input aria-label="Search code" autoFocus={!q} value={query} placeholder="Word or symbol…" onKeyDown={(e) => { if (e.key === 'Enter' && query === q) { e.preventDefault(); open(); } }} onChange={(e) => { setQuery(e.target.value); }}/><Button type="button" onClick={() => { void navigate({to: '/search', search: discoverySearch({q, type: 'repositories'})}); }}>All search types</Button></PageHeader>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2"><SegmentedControl label="Search type" value="code" onChange={(type) => { void navigate({to: '/search', search: discoverySearch({q, type})}); }} options={kinds.map((kind) => ({value: kind, label: kind === 'code' ? 'Code' : kind === 'pulls' ? 'Pull requests' : kind.slice(0, 1).toUpperCase() + kind.slice(1)}))}/>{repoId && <Button type="button" onClick={() => { void navigate({to: '/search', search: discoverySearch({q, type: 'code'})}); }}>Search all repositories</Button>}</div>
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
        return (
          <div key={`${String(row.hit.RepoID)}:${row.hit.Filename}:${String(row.line.num)}`} data-index={item.index} ref={virtual.measureElement} className="absolute inset-x-0 top-0 pb-2" style={{transform: `translateY(${String(item.start)}px)`}}>
            <ListRow role="option" active={cursor === item.index} selected={cursor === item.index} href={href} onClick={(e) => { click(e, href); }}>{name} / {row.hit.Filename}:{row.line.num}</ListRow>
            {/* The same link as the row (a click on the code opens the line too); the context lines are dimmed. */}
            <a href={href} tabIndex={-1} aria-hidden onClick={(e) => { click(e, href); }} className="block overflow-x-auto">
              {row.before.map((l) => <HitCode key={l.num} line={l} context/>)}
              <HitCode line={row.line}/>
              {row.after.map((l) => <HitCode key={l.num} line={l} context/>)}
            </a>
          </div>
        );
      })}</div>
      {answer && answer.total > 50 && <div className="flex gap-2 p-4"><Button type="button" disabled={page <= 1} onClick={() => { patch({page: page - 1}); }}>Previous</Button><span>Page {page}</span><Button type="button" disabled={page * 50 >= answer.total || page >= 100} onClick={() => { patch({page: page + 1}); }}>Next</Button></div>}
    </PageBody></>;
});
