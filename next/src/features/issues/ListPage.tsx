// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The body of every issue list page (a repository's issues or pull
// requests, the viewer's across the workspace): the live query, the
// virtualized list in the page's scroll container, the closed tier's pages
// (repository lists) and the empty states. Pages put a PageHeader with
// ListControls above it.

import {SearchX} from 'lucide-react';
import {autorun, observable, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useCallback, useEffect, useLayoutEffect, useState} from 'react';
import {PageBody, viewChange} from '../../app/shell/Frame.tsx';
import type {ListSearch} from '../../app/search.ts';
import {useApp, useSession} from '../../app/store.ts';
import {editing} from '../../intents/session.ts';
import {Button, EmptyState, ListRow, Skeleton} from '../../ui/index.ts';
import {useNavigate} from '@tanstack/react-router';
import {closedPager} from './closed.ts';
import {IssueList} from './IssueList.tsx';
import {IssueListModel, type ListSource} from './list.ts';
import type {Group} from './query.ts';

/** Below this many rows a list that shows closed issues keeps loading older pages. */
const SHORT = 60;

/**
 * A list's live query. The controls change it directly (the list updates in
 * the frame of the click or keystroke) and then the URL; the URL changing
 * otherwise (back, a link) changes it before paint.
 */
export function useListModel(source: ListSource, search: ListSearch, defaultGroup: Group): IssueListModel {
  const app = useApp();
  const [model] = useState(() => {
    const m = new IssueListModel(app, editing(app).overlay, source, defaultGroup);
    m.setSearch(search);
    return m;
  });
  useLayoutEffect(() => {
    model.fromUrl(search);
  }, [model, search]);
  useEffect(() => () => {
    model.dispose();
  }, [model]);
  return model;
}

export interface ListBodyProps {
  model: IssueListModel;
  label: string;
  /** Shown when nothing at all is listed (no filter in effect). */
  empty: ReactNode;
  showRepo?: boolean | undefined;
}

export const ListBody = observer(function ListBody({model, label, empty, showRepo}: ListBodyProps) {
  // State, not a ref: the list's virtualizer needs the element when it first lays out, and a parent's
  // ref is attached after its children's layout effects ran.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const {data} = useSession();
  const app = useApp();
  const navigate = useNavigate();
  const src = model.source;
  const q = model.query;
  // Older closed issues are not in the summary (B6): load them when the list can show them.
  const pager = src.kind === 'repo' ? closedPager(data, `repo:${String(src.repoId)}`) : undefined;
  const wantsClosed = q.filter.state !== 'open' || Boolean(q.filter.q?.trim());
  // Keep paging while the list is short (a search that matches nothing yet) or the cursor/scroll is near its end.
  const [nearEnd] = useState(() => observable.box(false));
  useEffect(() => {
    if (!pager || !wantsClosed) return undefined;
    return autorun(() => {
      if (pager.done || pager.loading) return;
      if (nearEnd.get() || model.result.get().ids.length < SHORT) pager.more();
    });
  }, [pager, wantsClosed, model, nearEnd]);
  const onNearEnd = useCallback((near: boolean) => {
    if (near !== nearEnd.get()) runInAction(() => {
      nearEnd.set(near);
    });
  }, [nearEnd]);
  const filtered = q.filter.state !== 'open' || q.filter.labels.length > 0 || q.filter.q !== undefined || q.filter.assignee !== undefined ||
    q.filter.poster !== undefined || q.filter.milestone !== undefined || q.filter.status !== undefined || q.filter.priority !== undefined ||
    q.filter.label !== undefined || q.filter.repo !== undefined;
  const loading = data.status.loading > 0 && model.result.get().rows.length === 0;
  const typed = q.filter.q?.trim();
  const none = loading ? <ListSkeleton/> : filtered ?
    <EmptyState icon={SearchX} title="Nothing matches" description="No item on this device matches these filters."
      action={<span className="flex flex-wrap justify-center gap-2">
        {typed && <Button variant="primary" onClick={() => {
          // The command menu searches the rest: other repositories, the index, and Forgejo itself.
          runInAction(() => {
            app.ui.paletteQuery = typed;
            app.ui.paletteOpen = true;
          });
        }}>Search everywhere</Button>}
        <Button onClick={() => {
        // Back to the list's default view (open items, no search, no filter; the grouping and order stay).
        const {group, sort} = model.search;
        const next = {...(group ? {group} : {}), ...(sort ? {sort} : {})};
        const keep = viewChange();
        model.setSearch(next);
        void navigate({to: '.', replace: true, ...keep, search: ((prev: Record<string, unknown>) => ({...(typeof prev.type === 'string' ? {type: prev.type} : {}), ...next})) as never});
      }}>Clear the search and filters</Button>
      </span>}/> :
    empty;
  return (
    <PageBody ref={setScroller}>
      <IssueList model={model} scroller={scroller} empty={none} showRepo={Boolean(showRepo) && q.group !== 'repo'} label={label}
        onNearEnd={onNearEnd}/>
      {pager && wantsClosed && <ClosedFooter pager={pager}/>}
    </PageBody>
  );
});

const ClosedFooter = observer(function ClosedFooter({pager}: {pager: ReturnType<typeof closedPager>}) {
  if (pager.done && !pager.count) return null;
  const text = pager.loading ?
    'Loading older closed items…' :
    pager.done ? `All older closed items are here (${String(pager.count)} loaded).` : `${String(pager.count)} older closed items loaded; more load as you scroll.`;
  return <p role="status" className="px-3 py-2 text-sm text-fg-subtle">{text}</p>;
});

const widths = ['w-64', 'w-48', 'w-72', 'w-56', 'w-40', 'w-60'];

/** Rows of placeholders while a repository's issues load for the first time (static, no spinner). */
function ListSkeleton() {
  return (
    <div role="presentation">
      {widths.map((w) => (
        <ListRow key={w} role="presentation" leading={<><Skeleton className="size-4"/><Skeleton className="size-4"/></>} trailing={<Skeleton className="h-3 w-12"/>}>
          <Skeleton className={`h-3 ${w}`}/>
        </ListRow>
      ))}
    </div>
  );
}
