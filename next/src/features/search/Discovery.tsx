// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useLocation, useNavigate, useSearch} from '@tanstack/react-router';
import {useVirtualizer} from '@tanstack/react-virtual';
import {observer} from 'mobx-react-lite';
import {useCallback, useEffect, useMemo, useState} from 'react';
import {hrefOf, useLinkClick} from '../../app/links.ts';
import {connectivity} from '../../app/online.ts';
import {useApp} from '../../app/store.ts';
import {PageBody, pageListRect} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {DenseRow} from '../home/DenseRow.tsx';
import {ActionList, ActionMenu, SegmentedControl} from '@primer/react';
import {discover, discoverySearch, kinds, localDiscovery, type DiscoverySearch, type Kind, type ResultPage} from './discovery.ts';

import CodeSearch from './CodeSearch.tsx';
import {SearchIcon, FilterIcon} from '@primer/octicons-react';
import {Button, TextInput} from '@primer/react';

const labels: Record<Kind, string> = {code: 'Code', repositories: 'Repositories', issues: 'Issues', pulls: 'Pull requests', users: 'Users', organizations: 'Organizations'};
const sorts = [{value: 'updated', label: 'Recently updated'}, {value: 'created', label: 'Newest'}, {value: 'alpha', label: 'Name'}, {value: 'stars', label: 'Most stars'}] as const;

export default function Discovery() {
  const raw = useSearch({strict: false}) as Record<string, unknown>;
  return raw.type === 'code' ? <CodeSearch/> : <DiscoveryResults/>;
}
const DiscoveryResults = observer(function DiscoveryResults() {
  const app = useApp();
  const navigate = useNavigate();
  const path = useLocation({select: (l) => l.pathname});
  const raw = useSearch({strict: false}) as Record<string, unknown>;
  const explore = path.startsWith('/explore');
  const routeType: Kind = path.endsWith('/users') ? 'users' : path.endsWith('/organizations') ? 'organizations' : 'repositories';
  const search = useMemo(() => discoverySearch({...raw, ...(explore ? {type: routeType} : {})}), [raw, explore, routeType]);
  const key = JSON.stringify(search);
  const connected = connectivity.online;
  const [answer, setAnswer] = useState<{key: string; page: ResultPage} | undefined>();
  const [counts, setCounts] = useState<Partial<Record<Kind, number>>>({});
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState(search.q);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [cursor, setCursor] = useState(0);
  const click = useLinkClick();
  const available = useMemo(() => kinds.filter((kind) => (!explore || kind !== 'issues' && kind !== 'pulls' && kind !== 'code') && (kind !== 'users' || !app.config.explore?.disable_users) && (kind !== 'organizations' || !app.config.explore?.disable_organizations)), [explore, app]);
  const allowed = available.includes(search.type);
  const patch = useCallback((change: Partial<DiscoverySearch>) => {
    const next = discoverySearch({...search, page: 1, ...change});
    const to = explore ? next.type === 'users' ? '/explore/users' : next.type === 'organizations' ? '/explore/organizations' : '/explore/repos' : '/search';
    void navigate({to, search: next, replace: false});
  }, [search, explore, navigate]);
  useEffect(() => { setQuery(search.q); }, [search.q]);
  useEffect(() => {
    if (query === search.q) return undefined;
    const timer = setTimeout(() => { patch({q: query}); }, 250);
    return () => { clearTimeout(timer); };
  }, [query, search.q, patch]);
  useEffect(() => {
    setError('');
    setCursor(0);
    if (!connected || !allowed) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void discover(app, search, controller.signal).then((page) => {
        if (!controller.signal.aborted) { setAnswer({key, page}); setCounts((previous) => ({...previous, [search.type]: page.total})); }
      }).catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Search failed.');
      });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [app, key, search, connected, allowed, retry]);
  useEffect(() => {
    setCounts({});
    if (!connected) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      for (const kind of available.filter((kind) => kind !== search.type && kind !== 'code')) {
        void discover(app, discoverySearch({...search, type: kind, page: 1, sort: 'updated'}), controller.signal).then((page) => {
          if (!controller.signal.aborted) setCounts((previous) => ({...previous, [kind]: page.total}));
        }).catch(() => { /* The selected tab reports its own error. */ });
      }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [app, search, available, connected, retry]);
  const page = !allowed ? undefined : connected ? answer?.key === key ? answer.page : undefined : localDiscovery(app, search);
  const rows = page?.rows ?? [];
  const virtual = useVirtualizer({count: rows.length, getScrollElement: () => scroller, estimateSize: () => 32, overscan: 10, ...pageListRect()});
  const loading = connected && !page && !error && allowed;
  return <>
    <PageHeader title={explore ? 'Explore' : 'Search'} icon={SearchIcon}>
      <TextInput aria-label="Search across Forgejo" placeholder="Search across Forgejo…" value={query} onChange={(event) => { setQuery(event.target.value); }}/>
      <ActionMenu>
        <ActionMenu.Button size="small">{sorts.find((sort) => sort.value === search.sort)?.label}</ActionMenu.Button>
        <ActionMenu.Overlay><ActionList selectionVariant="single" aria-label="Sort results">
          {sorts.filter((sort) => (sort.value !== 'stars' || search.type === 'repositories') && (sort.value !== 'alpha' || search.type !== 'issues' && search.type !== 'pulls')).map((sort) =>
            <ActionList.Item key={sort.value} selected={search.sort === sort.value} onSelect={() => { patch({sort: sort.value}); }}>{sort.label}</ActionList.Item>)}
        </ActionList></ActionMenu.Overlay>
      </ActionMenu>
      {search.type === 'repositories' && <>
        <ActionMenu>
          <ActionMenu.Button size="small" leadingVisual={FilterIcon}>{search.archived === 'true' ? 'Archived' : search.archived === 'false' ? 'Not archived' : 'Archived: all'}</ActionMenu.Button>
          <ActionMenu.Overlay><ActionList selectionVariant="single" aria-label="Archived repositories">
            {([{value: '', label: 'All repositories'}, {value: 'false', label: 'Not archived'}, {value: 'true', label: 'Archived'}] as const).map((option) =>
              <ActionList.Item key={option.value} selected={search.archived === option.value} onSelect={() => { patch({archived: option.value}); }}>{option.label}</ActionList.Item>)}
          </ActionList></ActionMenu.Overlay>
        </ActionMenu>
        <TextInput aria-label="Primary language" placeholder="Primary language (e.g. Go)" value={search.language} onChange={(event) => { patch({language: event.target.value}); }}/>
      </>}
      {(search.type === 'issues' || search.type === 'pulls') && <SegmentedControl aria-label="State" onChange={(index) => {
        const state = index === undefined ? undefined : (['all', 'open', 'closed'] as const)[index];
        if (state) patch({state});
      }}>{(['all', 'open', 'closed'] as const).map((state) =>
        <SegmentedControl.Button key={state} selected={search.state === state}>{state.slice(0, 1).toUpperCase() + state.slice(1)}</SegmentedControl.Button>)}</SegmentedControl>}
    </PageHeader>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-default px-4 py-2">
      <SegmentedControl aria-label={explore ? 'Explore type' : 'Search type'} variant={{narrow: 'dropdown', regular: 'default'}} onChange={(index) => {
        const type = index === undefined ? undefined : available[index];
        if (type) patch({type});
      }}>{available.map((kind) => <SegmentedControl.Button key={kind} selected={search.type === kind}
          {...(kind === 'code' ? {} : {count: connected ? counts[kind] ?? '…' : localDiscovery(app, discoverySearch({...search, type: kind, page: 1})).total})}>
          {labels[kind]}
        </SegmentedControl.Button>)}</SegmentedControl>
    </div>
    {!connected && <p role="note" className="px-4 py-2 text-sm text-muted">Offline — showing results on this device only. Language filtering and people sort by activity are unavailable offline.</p>}
    <PageBody ref={setScroller}>
      {!allowed && <p role="status" className="p-4 text-muted">This discovery page is disabled by the instance administrator.</p>}
      {loading && <p role="status" className="p-4 text-muted">Searching Forgejo…</p>}
      {error && <div role="alert" className="p-4"><p>{error}</p><Button type="button" onClick={() => { setRetry((n) => n + 1); }}>Retry</Button></div>}
      {allowed && page && !rows.length && <p role="status" className="p-4 text-muted">No results found.</p>}
      <div role="listbox" aria-label="Search results" aria-activedescendant={rows[cursor] ? `discovery-${String(rows[cursor]?.id)}` : undefined} tabIndex={0} onKeyDown={(event) => {
        if (!rows.length || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === 'Enter') {
          const row = rows[cursor];
          if (row) { event.preventDefault(); void navigate({href: hrefOf(app, row.path)}); }
        } else if (['j', 'k', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
          event.preventDefault();
          const next = Math.max(0, Math.min(rows.length - 1, cursor + (event.key === 'j' || event.key === 'ArrowDown' ? 1 : -1)));
          setCursor(next); virtual.scrollToIndex(next, {align: 'auto'});
        }
      }}>
        <div className="relative" style={{height: virtual.getTotalSize()}}>
          {virtual.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            const href = hrefOf(app, row.path);
            return <div key={row.id} className="absolute inset-x-0 top-0" style={{transform: `translateY(${String(item.start)}px)`}}>
              <DenseRow id={`discovery-${String(row.id)}`} role="option" href={href} active={cursor === item.index} selected={cursor === item.index} tabIndex={-1} trailing={<span className="max-w-64 truncate">{row.detail}</span>} onClick={(event) => { setCursor(item.index); click(event, href); }}>{row.title}</DenseRow>
            </div>;
          })}
        </div>
      </div>
      {page && page.total > 50 && <div className="flex items-center gap-2 p-4">
        <Button type="button" disabled={search.page === 1} onClick={() => { patch({page: search.page - 1}); }}>Previous</Button>
        <span className="text-sm text-muted">Page {search.page} of {Math.ceil(page.total / 50)}</span>
        <Button type="button" disabled={search.page * 50 >= page.total} onClick={() => { patch({page: search.page + 1}); }}>Next</Button>
      </div>}
    </PageBody>
  </>;
});
