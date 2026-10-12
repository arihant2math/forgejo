// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {BellSlashIcon, ChecklistIcon, InboxIcon, MailIcon, PinIcon, PinSlashIcon, ReadIcon} from '@primer/octicons-react';
import {ActionList, ActionMenu, Button, Checkbox, SegmentedControl, Tooltip} from '@primer/react';
import {getRouteApi, useNavigate} from '@tanstack/react-router';
import {observable, runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {notify} from '../../app/notices.ts';
import {afterPaint} from '../../app/paint.ts';
import type {InboxSearch} from '../../app/search.ts';
import {PageBody, viewChange} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {shortcutHint, useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {useApp, useSession} from '../../app/store.ts';
import {EmptyState} from '../../components/EmptyState.tsx';
import {editing} from '../../intents/session.ts';
import {notificationStatus} from '../../intents/view.ts';
import {useOverlay, usePool} from '../issues/cells.tsx';
import {readAll as markAllRead, setStatus, type StatusTo, triage, unsubscribe, unsubscribeReason} from './actions.ts';
import {InboxFilters} from './InboxFilters.tsx';
import {InboxList} from './InboxList.tsx';
import {InboxModel, oldestNote} from './InboxModel.ts';
import {askServerReasons} from './serverReasons.ts';

const route = getRouteApi('/shell/notifications');

export default observer(function Inbox() {
  const app = useApp();
  const {data} = useSession();
  const search = route.useSearch();
  const navigate = useNavigate();
  // Apply view changes immediately; defer router work to a separate frame to keep clicks responsive.
  const [view] = useState(() => observable.box<InboxSearch>(search, {deep: false}));
  const pushed = useRef<InboxSearch | null>(null);
  useLayoutEffect(() => {
    const mine = pushed.current;
    if (mine) {
      if (sameView(mine, search)) pushed.current = null;
      return;
    }
    runInAction(() => {
      view.set(search);
    });
  }, [search, view]);
  const [model] = useState(() => new InboxModel(app, data.pool, editing(app).overlay, () => view.get()));
  useEffect(() => () => {
    model.dispose();
  }, [model]);
  useEffect(() => {
    askServerReasons(app, () => untracked(() => oldestNote(data.pool)), true);
  }, [app, data.pool]);
  const shown = view.get();
  const set = (patch: {[K in keyof InboxSearch]?: InboxSearch[K] | undefined}) => {
    const next = Object.fromEntries(Object.entries({...view.get(), ...patch}).filter(([, v]) => v !== undefined)) as InboxSearch;
    const keep = viewChange();
    pushed.current = next;
    runInAction(() => {
      view.set(next);
    });
    afterPaint(() => {
      void navigate({to: '.', ...keep, search: next});
    });
  };
  const readAll = () => {
    const marked = markAllRead(app, untracked(() => model.result.get().ids));
    if (!marked.length) return;
    notify(app, {tone: 'neutral', series: 'inbox', title: `Marked ${String(marked.length)} as read`, action: {label: 'Undo', run: () => {
      setStatus(app, marked, (st) => (st === 'read' ? 'unread' : undefined));
    }}});
  };
  useShortcutScope('inbox');
  useShortcut('inbox.readAll', readAll);
  return (
    <>
      <PageHeader icon={InboxIcon} title="Inbox">
        <InboxFilters search={shown} set={set}/>
        <SegmentedControl aria-label="Notification status" size="small" onChange={(index) => {
          set({filter: index === 1 ? 'unread' : index === 2 ? 'all' : undefined});
        }}>
          <SegmentedControl.Button selected={shown.filter === undefined}>Unread and pinned</SegmentedControl.Button>
          <SegmentedControl.Button selected={shown.filter === 'unread'} count={app.ui.unread ?? data.pool.model('Notification').by('status', 'unread').size}>Unread</SegmentedControl.Button>
          <SegmentedControl.Button selected={shown.filter === 'all'}>All</SegmentedControl.Button>
        </SegmentedControl>
        <ActionMenu>
          <ActionMenu.Button size="small">Group by: {shown.group === 'repo' ? 'Repository' : 'Date'}</ActionMenu.Button>
          <ActionMenu.Overlay><ActionList selectionVariant="single" aria-label="Group by">
            <ActionList.Item selected={shown.group !== 'repo'} onSelect={() => { set({group: undefined}); }}>Date</ActionList.Item>
            <ActionList.Item selected={shown.group === 'repo'} onSelect={() => { set({group: 'repo'}); }}>Repository</ActionList.Item>
          </ActionList></ActionMenu.Overlay>
        </ActionMenu>
        <Tooltip text={'Mark everything listed as read'} keybindingHint={shortcutHint('inbox.readAll')}><Button variant="invisible" size="small" leadingVisual={ChecklistIcon} type="button" onClick={readAll}>Mark all as read</Button></Tooltip>
      </PageHeader>
      <ListHeader model={model}/>
      <InboxBody model={model} filter={shown.filter} byRepo={shown.group === 'repo'} filtered={[shown.reason, shown.repo, shown.type, shown.state].some((value) => value !== undefined)}/>
    </>
  );
});

function sameView(a: InboxSearch, b: InboxSearch): boolean {
  return a.filter === b.filter && a.group === b.group && a.reason === b.reason && a.repo === b.repo && a.type === b.type && a.state === b.state;
}

/** GitHub's list header: select all, replaced by the bulk actions while anything is selected. */
const ListHeader = observer(function ListHeader({model}: {model: InboxModel}) {
  const app = useApp();
  const overlay = useOverlay();
  const pool = usePool();
  const {ids: listed} = model.result.get();
  const ids = model.cursor.selected.values();
  if (!listed.length) return null;
  const all = ids.length > 0 && listed.every((id) => model.cursor.selected.has(id));
  const statuses = ids.map((id) => {
    const n = pool.model('Notification').get(id);
    return n ? notificationStatus(overlay, n) : undefined;
  });
  const allPinned = statuses.every((st) => st === 'pinned');
  const cannotUnsubscribe = unsubscribeReason(app, ids);
  const run = (to: StatusTo, said: 'read' | 'unread' | 'pin') => () => {
    triage(app, untracked(() => model.cursor.selected.values()), to, said);
  };
  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-default bg-muted px-4 py-1">
      <Checkbox aria-label={ids.length ? 'Clear the selection' : 'Select all notifications'} checked={all} indeterminate={ids.length > 0 && !all} onChange={() => {
        if (ids.length) model.cursor.clearSelection();
        else model.cursor.selected.replace(listed);
      }}/>
      {ids.length ? <div role="toolbar" aria-label="Selected notifications" className="flex flex-wrap items-center gap-2">
        <span className="px-1 text-sm whitespace-nowrap text-muted tabular-nums">{ids.length} selected</span>
        <Tooltip text={statuses.includes('unread') ? 'Mark the selected notifications as read' : 'No selected notifications are unread'} keybindingHint={shortcutHint('inbox.read')}><Button size="small" leadingVisual={ReadIcon} type="button" inactive={!statuses.includes('unread')} onClick={run((st) => (st === 'unread' ? 'read' : undefined), 'read')}>Mark as read</Button></Tooltip>
        <Tooltip text={statuses.every((st) => st === 'unread') ? 'All selected notifications are already unread' : 'Mark the selected notifications as unread'} keybindingHint={shortcutHint('inbox.unread')}><Button size="small" leadingVisual={MailIcon} type="button" inactive={statuses.every((st) => st === 'unread')} onClick={run(() => 'unread', 'unread')}>Mark as unread</Button></Tooltip>
        <Tooltip text={allPinned ? 'Unpin the selected notifications' : 'Pin the selected notifications: they stay at the top, for later'} keybindingHint={shortcutHint('inbox.pin')}><Button size="small" leadingVisual={allPinned ? PinSlashIcon : PinIcon} type="button" onClick={run((st) => (allPinned ? (st === 'pinned' ? 'read' : undefined) : st === 'pinned' ? undefined : 'pinned'), 'pin')}>{allPinned ? 'Unpin' : 'Pin'}</Button></Tooltip>
        <Tooltip text={cannotUnsubscribe ?? 'Unsubscribe from the selected threads'} keybindingHint={shortcutHint('inbox.unsubscribe')}><Button size="small" leadingVisual={BellSlashIcon} type="button" inactive={!!cannotUnsubscribe} onClick={() => {
          unsubscribe(app, untracked(() => model.cursor.selected.values()));
        }}>Unsubscribe</Button></Tooltip>
      </div> : <span className="text-sm text-muted">Select all</span>}
    </div>
  );
});

const InboxBody = observer(function InboxBody({model, filter, byRepo, filtered}: {model: InboxModel; filter: InboxSearch['filter']; byRepo: boolean; filtered: boolean}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const {rows} = model.result.get();
  const caughtUp = filter === 'all' || !model.total() ? undefined : filter === 'unread' ?
    'Nothing unread. Pinned notifications are in the inbox’s default view, read ones under “All”.' :
    'Nothing unread or pinned. Read notifications are under “All”.';
  return (
    <PageBody ref={setScroller}>
      {rows.length ?
        <InboxList model={model} scroller={scroller} byRepo={byRepo}/> :
        <EmptyState icon={BellSlashIcon} title={filtered ? 'No matching notifications' : caughtUp ? 'All caught up' : 'No notifications'} description={filtered ? 'Try changing the filters to see more notifications.' : caughtUp ?? 'Mentions, reviews, and issue and pull request activity on what you watch show here. New releases are announced by email only; choose what you watch in a repository’s Watch menu.'}/>}
    </PageBody>
  );
});
