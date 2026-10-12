// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useLocation, useNavigate, useSearch} from '@tanstack/react-router';
import {useVirtualizer} from '@tanstack/react-virtual';
import {computed} from 'mobx';
import {observer} from 'mobx-react-lite';
import {useCallback, useEffect, useMemo, useState} from 'react';
import {sitePath} from '../../app/config.ts';
import {useSiteLink} from '../../app/links.ts';
import {connectivity} from '../../app/online.ts';
import {useApp} from '../../app/store.ts';
import {PageBody, pageListRect} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {ListRow, NORMAL_ROW_HEIGHT} from '../../components/ListRow.tsx';
import {StateGlyph, stateLook} from '../issues/cells.tsx';
import {ActionList, ActionMenu, SegmentedControl} from '@primer/react';
import {discover, discoverySearch, localCount, localDiscovery, type DiscoverySearch, type Kind, type ResultPage, type ResultRow} from './discovery.ts';
import {availableKinds, ResultPager, SearchTypeNav, searchHref, useDraft} from './controls.tsx';

import CodeSearch from './CodeSearch.tsx';
import {SearchIcon, FilterIcon, OrganizationIcon, PersonIcon, RepoIcon} from '@primer/octicons-react';
import {Button, TextInput} from '@primer/react';
import {Blankslate} from '@primer/react/experimental';

const sorts = [{value: 'updated', label: 'Recently updated'}, {value: 'created', label: 'Newest'}, {value: 'alpha', label: 'Name'}, {value: 'stars', label: 'Most stars'}] as const;

export default function Discovery() {
  const raw = useSearch({strict: false}) as Record<string, unknown>;
  return raw.type === 'code' ? <CodeSearch/> : <DiscoveryResults/>;
}

function pathOf(explore: boolean, type: Kind): string {
  return !explore ? '/search' : type === 'users' ? '/explore/users' : type === 'organizations' ? '/explore/organizations' : '/explore/repos';
}

function ResultIcon({type, row}: {type: Kind; row: ResultRow}) {
  if (type === 'issues' || type === 'pulls') return row.state ? <StateGlyph look={stateLook(row.state, type === 'pulls', row.merged === true)}/> : null;
  const Icon = type === 'users' ? PersonIcon : type === 'organizations' ? OrganizationIcon : RepoIcon;
  return <Icon size={16}/>;
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
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [cursor, setCursor] = useState(0);
  const link = useSiteLink();
  const available = useMemo(() => availableKinds(app, explore), [explore, app]);
  const allowed = available.includes(search.type);
  /** Text fields replace the history entry; discrete choices push one. */
  const patch = useCallback((change: Partial<DiscoverySearch>, replace = false) => {
    const next = discoverySearch({...search, page: 1, ...change});
    void navigate({to: pathOf(explore, next.type), search: next, replace});
  }, [search, explore, navigate]);
  const commitQuery = useCallback((q: string) => { patch({q}, true); }, [patch]);
  const commitLanguage = useCallback((language: string) => { patch({language}, true); }, [patch]);
  const [query, setQuery] = useDraft(search.q, commitQuery);
  const [language, setLanguage] = useDraft(search.language, commitLanguage);
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
  // Offline results scan the pool: cached until the search or the pool changes, not redone per cursor move.
  const local = useMemo(() => computed(() => (connected ? undefined : {
    page: localDiscovery(app, search),
    counts: Object.fromEntries(available.filter((kind) => kind !== 'code').map((kind) => [kind, localCount(app, discoverySearch({...search, type: kind, page: 1}))])) as Partial<Record<Kind, number>>,
  })), [app, search, available, connected]).get();
  const page = !allowed ? undefined : local ? local.page : answer?.key === key ? answer.page : undefined;
  const rows = page?.rows ?? [];
  const virtual = useVirtualizer({count: rows.length, getScrollElement: () => scroller, estimateSize: () => NORMAL_ROW_HEIGHT, overscan: 10, ...pageListRect()});
  const loading = connected && !page && !error && allowed;
  const sort = sorts.find((s) => s.value === search.sort);
  return <>
    <PageHeader title={explore ? 'Explore' : 'Search'} icon={SearchIcon}>
      <TextInput size="small" className="w-64" aria-label="Search across Forgejo" placeholder="Search across Forgejo…" value={query} onChange={(event) => { setQuery(event.target.value); }}/>
      <ActionMenu>
        <ActionMenu.Button size="small"><span className="text-muted">Sort by: </span>{sort?.label}</ActionMenu.Button>
        <ActionMenu.Overlay><ActionList selectionVariant="single" aria-label="Sort results">
          {sorts.filter((s) => (s.value !== 'stars' || search.type === 'repositories') && (s.value !== 'alpha' || search.type !== 'issues' && search.type !== 'pulls')).map((s) =>
            <ActionList.Item key={s.value} selected={search.sort === s.value} onSelect={() => { patch({sort: s.value}); }}>{s.label}</ActionList.Item>)}
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
        <TextInput size="small" className="w-56" aria-label="Primary language" placeholder="Primary language (e.g. Go)" value={language} onChange={(event) => { setLanguage(event.target.value); }}/>
      </>}
      {(search.type === 'issues' || search.type === 'pulls') && <SegmentedControl size="small" aria-label="State" onChange={(index) => {
        const state = index === undefined ? undefined : (['all', 'open', 'closed'] as const)[index];
        if (state) patch({state});
      }}>{(['all', 'open', 'closed'] as const).map((state) =>
        <SegmentedControl.Button key={state} selected={search.state === state}>{state.slice(0, 1).toUpperCase() + state.slice(1)}</SegmentedControl.Button>)}</SegmentedControl>}
    </PageHeader>
    <div className="shrink-0 px-4">
      <SearchTypeNav label={explore ? 'Explore type' : 'Search type'} available={available} current={search.type} counts={local ? local.counts : counts}
        href={(kind) => kind === 'code' ? searchHref(app, '/search', {q: search.q, type: 'code'}) : searchHref(app, pathOf(explore, kind), discoverySearch({...search, type: kind, page: 1}))}/>
    </div>
    {!connected && <p role="note" className="px-4 py-2 text-sm text-muted">Offline — showing results on this device only. Language filtering and people sort by activity are unavailable offline.</p>}
    <PageBody ref={setScroller}>
      {!allowed && <p role="status" className="p-4 text-muted">This discovery page is disabled by the instance administrator.</p>}
      {loading && <p role="status" className="p-4 text-muted">Searching Forgejo…</p>}
      {error && <div role="alert" className="p-4"><p>{error}</p><Button size="small" type="button" onClick={() => { setRetry((n) => n + 1); }}>Retry</Button></div>}
      {allowed && page && !rows.length && <div role="status"><Blankslate spacious><Blankslate.Heading>No results found.</Blankslate.Heading><Blankslate.Description>Try a different query or change the filters.</Blankslate.Description></Blankslate></div>}
      <div role="listbox" aria-label="Search results" aria-activedescendant={rows[cursor] ? `discovery-${String(rows[cursor]?.id)}` : undefined} tabIndex={0} onKeyDown={(event) => {
        if (!rows.length || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === 'Enter') {
          const row = rows[cursor];
          if (row) { event.preventDefault(); void navigate({href: sitePath(app.config, row.path)}); }
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
            const to = link(sitePath(app.config, row.path));
            return <div key={row.id} className="absolute inset-x-0 top-0" style={{transform: `translateY(${String(item.start)}px)`}}>
              <ListRow id={`discovery-${String(row.id)}`} role="option" {...to} active={cursor === item.index} selected={cursor === item.index} tabIndex={-1} leading={<ResultIcon type={search.type} row={row}/>} trailing={<span className="max-w-64 truncate">{row.detail}</span>} onClick={(event) => { setCursor(item.index); to.onClick(event); }}>{row.title}</ListRow>
            </div>;
          })}
        </div>
      </div>
      {page && <ResultPager page={search.page} pageCount={Math.ceil(page.total / 50)} href={(n) => searchHref(app, pathOf(explore, search.type), {...search, page: n})}/>}
    </PageBody>
  </>;
});
