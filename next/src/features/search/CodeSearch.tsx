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
import {DenseRow} from '../home/DenseRow.tsx';
import {discoverySearch} from './params.ts';
import {availableKinds, SearchTypeNav, searchHref, useDraft} from './controls.tsx';
import {Pager} from '../../components/Pager.tsx';
import {type Hit, type MatchRow, matchRows} from './codeHits.ts';
import {useSnippetHighlight} from '../../code/DiffSnippet.tsx';
import {CodeTokens} from '../../code/parts.tsx';
import {langOf} from '../../code/shiki.ts';
import {Button, TextInput} from '@primer/react';
import {Blankslate} from '@primer/react/experimental';

interface Answer {enabled: boolean; total: number; results: Hit[]; repositories: Record<string, string>}

/** A hit with its context lines, highlighted together (the grammar starts mid-file, which is close enough here). */
function HitCode({row}: {row: MatchRow}) {
  const lines = [...row.before, row.line, ...row.after];
  const lang = langOf(row.hit.Filename);
  const text = lines.map((l) => l.text).join('\n');
  const hl = useSnippetHighlight(lang && `${lang}\n${text}`, (src, signal) => (lang ? src.snippet(lang, text, signal) : Promise.resolve(null)),
    (src) => (lang ? src.peekSnippet(lang, text) : null));
  return lines.map((l, i) => (
    <div key={l.num} className="flex min-h-5 font-mono text-sm whitespace-pre">
      <span className="w-12 shrink-0 pr-2 text-right text-muted tabular-nums select-none">{l.num}</span>
      <span><CodeTokens text={l.text} hl={hl} line={i} marks={l.marks}/></span>
    </div>
  ));
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
  const [answer, setAnswer] = useState<Answer>();
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState(0);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const click = useLinkClick();
  const commitQuery = useCallback((query: string) => { void navigate({to: '/search', search: discoverySearch({...raw, q: query, page: 1, type: 'code', repoId}), replace: true}); }, [navigate, raw, repoId]);
  const [query, setQuery] = useDraft(q, commitQuery);
  useEffect(() => {
    setAnswer(undefined); setError(''); setCursor(0);
    if (!connected) { setError('Code search requires an internet connection.'); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void online<Answer>(app, {api: 'sync', path: `${repoId ? `/repos/${repoId}/search` : '/search/code'}?${new URLSearchParams({q, page: String(page)})}`, signal: controller.signal}).then((value) => { if (!controller.signal.aborted) setAnswer(value); }).catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Search failed'); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [app, q, page, repoId, connected]);
  const rows = useMemo(() => matchRows(answer?.results ?? []), [answer]);
  const virtual = useVirtualizer({
    count: rows.length, getScrollElement: () => scroller, overscan: 5, ...pageListRect(),
    estimateSize: (i) => 40 + 20 * (1 + (rows[i]?.before.length ?? 0) + (rows[i]?.after.length ?? 0)),
  });
  const resultHref = (index: number) => {
    const row = rows[index];
    const name = row && answer?.repositories[String(row.hit.RepoID)];
    const [owner, repo] = name?.split('/') ?? [];
    return row && owner && repo ? hrefOf(app, `${codePath(owner, repo, `src/commit/${row.hit.CommitID}/${row.hit.Filename}`)}#L${String(row.line.num)}`) : undefined;
  };
  const open = () => { const href = resultHref(cursor); if (href) void navigate({href}); };
  const pageHref = (n: number) => searchHref(app, '/search', {q, type: 'code', repoId, page: n});
  return <><PageHeader title={repoId ? `Search code in ${repoName ?? 'this repository'}` : 'Search code'}>
      <TextInput size="small" aria-label="Search code" autoFocus={!q} value={query} placeholder="Word or symbol…" onKeyDown={(e) => { if (e.key === 'Enter' && query === q) { e.preventDefault(); open(); } }} onChange={(e) => { setQuery(e.target.value); }}/>
      {repoId && <Button size="small" type="button" onClick={() => { void navigate({to: '/search', search: discoverySearch({q, type: 'code'})}); }}>Search all repositories</Button>}
    </PageHeader>
    <div className="shrink-0 px-4">
      <SearchTypeNav label="Search type" available={availableKinds(app, false)} current="code" counts={{code: answer?.total}}
        href={(kind) => searchHref(app, '/search', kind === 'code' ? {q, type: 'code', repoId} : {q, type: kind})}/>
    </div>
    <PageBody ref={setScroller}>
      {error && <p role="alert" className="p-4">{error}</p>}
      {answer && !answer.enabled && !repoId && <Blankslate spacious><Blankslate.Heading>Global code search is unavailable</Blankslate.Heading><Blankslate.Description>The repository code indexer is disabled on this instance.</Blankslate.Description></Blankslate>}
      {answer && (answer.enabled || repoId) && !rows.length && <Blankslate spacious><Blankslate.Heading>{q ? 'No matching code' : 'Search file contents'}</Blankslate.Heading><Blankslate.Description>Enter a word or symbol to find matching files and lines.</Blankslate.Description></Blankslate>}
      {!answer && !error && <p role="status" className="p-4">Searching code…</p>}
      <div role="listbox" aria-label="Code search results" aria-activedescendant={rows[cursor] ? `code-hit-${String(cursor)}` : undefined} tabIndex={0} onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); open(); }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const next = Math.max(0, Math.min(rows.length - 1, cursor + (e.key === 'ArrowDown' ? 1 : -1))); setCursor(next); virtual.scrollToIndex(next); }
      }} className="relative" style={{height: virtual.getTotalSize()}}>{virtual.getVirtualItems().map((item) => {
        const row = rows[item.index]; if (!row) return null;
        const name = answer?.repositories[String(row.hit.RepoID)]; if (!name) return null;
        const href = resultHref(item.index);
        if (!href) return null;
        return (
          <div key={`${String(row.hit.RepoID)}:${row.hit.Filename}:${String(row.line.num)}`} data-index={item.index} ref={virtual.measureElement} className="absolute inset-x-0 top-0 pb-2" style={{transform: `translateY(${String(item.start)}px)`}}>
            <DenseRow id={`code-hit-${String(item.index)}`} role="option" tabIndex={-1} active={cursor === item.index} selected={cursor === item.index} href={href} onClick={(e) => { click(e, href); }}>{name} / {row.hit.Filename}:{row.line.num}</DenseRow>
            <a href={href} tabIndex={-1} aria-hidden onClick={(e) => { click(e, href); }} className="block overflow-x-auto">
              <HitCode row={row}/>
            </a>
          </div>
        );
      })}</div>
      {answer && <Pager page={page} pageCount={Math.min(100, Math.ceil(answer.total / 50))} href={pageHref} className="py-2"/>}
    </PageBody></>;
});
