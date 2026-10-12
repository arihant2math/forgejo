// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {repoGroup} from '../../data/models.ts';
import {autorun, observable, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useCallback, useEffect, useLayoutEffect, useState} from 'react';
import {PageBody, viewChange} from '../../app/shell/Frame.tsx';
import type {ListSearch} from '../../app/search.ts';
import {useApp, useSession} from '../../app/store.ts';
import {editing} from '../../intents/session.ts';
import {IssueRowFrame} from './IssueRowFrame.tsx';
import {useNavigate} from '@tanstack/react-router';
import {closedPager} from './closed.ts';
import {IssueList} from './IssueList.tsx';
import {IssueListModel, type ListSource} from './list.ts';
import {type Group, narrowed} from './query.ts';
import {SearchIcon} from '@primer/octicons-react';
import {Button} from '@primer/react';
import {Blankslate, SkeletonBox} from '@primer/react/experimental';

const SHORT = 60;

/** Controls update the live query before the URL; external URL changes apply before paint. */
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
  empty: ReactNode;
  /** If empty-state text covers every state, a non-open state does not count as a filter. */
  emptyForEveryState?: boolean | undefined;
  showRepo?: boolean | undefined;
}

export const ListBody = observer(function ListBody({model, label, empty, emptyForEveryState, showRepo}: ListBodyProps) {
  // Use state: parent refs attach after children's layout effects, too late for initial virtualization.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const {data} = useSession();
  const app = useApp();
  const navigate = useNavigate();
  const src = model.source;
  const q = model.query;
  // Older closed issues are outside the summary; page them in when needed.
  const pager = src.kind === 'repo' ? closedPager(data, repoGroup(src.repoId)) : undefined;
  const wantsClosed = q.filter.state !== 'open' || Boolean(q.filter.q?.trim());
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
  const filtered = (q.filter.state !== 'open' && !emptyForEveryState) || narrowed(model.search);
  const loading = data.status.loading > 0 && model.result.get().rows.length === 0;
  const typed = q.filter.q?.trim();
  const gone = data.status.loading > 0 ? [] : q.filter.labels.filter((id) => !data.pool.model('Label').get(Math.abs(id)));
  const goneRequired = gone.some((id) => id > 0);
  const dropGone = () => {
    const labels = q.filter.labels.filter((id) => !gone.includes(id)).join(',') || undefined;
    const next = Object.fromEntries(Object.entries({...model.search, labels}).filter(([, v]) => v !== undefined)) as ListSearch;
    const keep = viewChange();
    model.setSearch(next);
    void navigate({to: '.', replace: true, ...keep, search: ((prev: Record<string, unknown>) => ({...Object.fromEntries(Object.entries(prev).filter(([k]) => k !== 'labels')), ...(labels ? {labels} : {})})) as never});
  };
  const none = loading ? <ListSkeleton/> : filtered ?
    <Blankslate spacious><Blankslate.Visual><SearchIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Nothing matches</Blankslate.Heading><Blankslate.Description>{goneRequired ?
        `The filter names a label that no longer exists (it was deleted), so no item can match. ${gone.length > 1 ? 'Drop those labels' : 'Drop it'} to see the list.` :
        'No item on this device matches these filters.'}</Blankslate.Description>{<span className="flex flex-wrap justify-center gap-2">
        {goneRequired && <Button variant="primary" type="button" onClick={dropGone}>{gone.length > 1 ? 'Drop the deleted labels' : 'Drop the deleted label'}</Button>}
        {typed && <Button variant="primary" type="button" onClick={() => {
          runInAction(() => {
            app.ui.paletteQuery = typed;
            app.ui.paletteOpen = true;
          });
        }}>Search everywhere</Button>}
        <Button type="button" onClick={() => {
        const {group, sort} = model.search;
        const next = {...(group ? {group} : {}), ...(sort ? {sort} : {})};
        const keep = viewChange();
        model.setSearch(next);
        void navigate({to: '.', replace: true, ...keep, search: ((prev: Record<string, unknown>) => ({...(typeof prev.type === 'string' ? {type: prev.type} : {}), ...next})) as never});
      }}>Clear the search and filters</Button>
      </span>}</Blankslate> :
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
  return <p role="status" className="px-4 py-2 text-sm text-muted">{text}</p>;
});

const widths = ['w-64', 'w-48', 'w-72', 'w-56', 'w-40', 'w-60'];

function ListSkeleton() {
  return (
    <div role="presentation">
      {widths.map((w) => (
        <IssueRowFrame key={w} role="presentation" leading={<><SkeletonBox className="size-4"/><SkeletonBox className="size-4"/></>} trailing={<SkeletonBox className="h-3 w-12"/>}>
          <SkeletonBox className={`h-3 ${w}`}/>
        </IssueRowFrame>
      ))}
    </div>
  );
}
