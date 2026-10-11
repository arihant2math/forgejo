// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The inbox (/notifications, PLAN §7.3: Linear's triage). Notifications come
// from the viewer's user group (always on this device); read, unread and pin
// are offline-capable intents (`notification.status`), shown at once and
// synced across tabs and devices by the server's echo.
//
// Keyboard: J/K move, X selects, Enter opens (and marks read), E marks read,
// U unread, Shift+P pins or unpins, Shift+E marks everything read. By default
// the inbox is the working view (classic Forgejo's Unread tab): unread and
// pinned notifications, so what is read (handled) leaves it; "Unread" and
// "All" (?filter=unread|all) are a click away. Like the
// issue lists: one virtualized listbox with aria-activedescendant, rows that
// observe their own fields, and a row set recomputed at most once a frame.
// Without keys (#206): the hovered row offers read/unread, pin and a menu;
// "Select" makes a tap select rows (a phone), and a selection gets a bar of
// its actions. Each of them names its key in its tooltip.

import {focusList, rememberedRow, rememberRow} from '../../app/listReturn.ts';
import {getRouteApi, useNavigate} from '@tanstack/react-router';
import {useVirtualizer} from '@tanstack/react-virtual';
import {
  BellOff, CheckCheck, ExternalLink, FolderGit2, GitCommitHorizontal, Inbox as InboxIcon, ListChecks, Mail, MailOpen, MoreHorizontal, Pin, PinOff, Rows3,
  Square, SquareCheck, X,
} from 'lucide-react';
import {autorun, computed, createAtom, type IComputedValue, observable, runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type KeyboardEvent, type MouseEvent, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {rememberListRows} from '../../app/boot.ts';
import {sitePath} from '../../app/config.ts';
import {notify} from '../../app/notices.ts';
import {afterPaint} from '../../app/paint.ts';
import type {InboxSearch} from '../../app/search.ts';
import {PageBody, pageListRect, viewChange} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {formatKeys, shortcutHint, useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {type App, useApp, useSession} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import type {Pool} from '../../data/pool.ts';
import type {Overlay} from '../../intents/overlay.ts';
import {editing} from '../../intents/session.ts';
import {notificationStatus} from '../../intents/view.ts';
import {
  Button, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger, cx, EmptyState, Icon, IconButton, ListGroupHeader, ListRow,
  Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuSeparator, MenuTrigger, StatusDot,
} from '../../ui/index.ts';
import {AgoCell, RefCell, StateGlyph, StateIcon, stateLook, TitleCell, useOverlay, usePool, useUser} from '../issues/cells.tsx';
import {issuePath} from '../issues/edits.ts';
import {KeyedFlags} from '../issues/flags.ts';
import {readAll as markAllRead, setStatus, type StatusTo, triage, unsubscribe, unsubscribeReason} from './actions.ts';
import {InboxCursor} from './cursor.ts';
import {reasonOf} from './reason.ts';
import {askServerReasons, serverReasons} from './serverReasons.ts';
import {InboxFilters} from './InboxFilters.tsx';
import {knownSubject, type Subject, subjectOf, subjectPath, subjectsKnown} from './subject.ts';
import {activityOf, type InboxResult, inboxRows, noteHash, togglePin} from './inbox.ts';

const ROW = 32; // ListRow's h-row
const route = getRouteApi('/shell/notifications');

/** The inbox's rows, recomputed when notifications change (at most once a frame) or a status is overridden. */
class InboxModel {
  readonly cursor = new InboxCursor();
  /** Select mode: a click or tap on a row selects it instead of opening it (no Shift, no X on a phone). */
  readonly selecting = observable.box(false);
  /** The row the mouse is over (its buttons show), and the row whose "More" menu is open (they stay meanwhile). */
  readonly hover = new KeyedFlags();
  menuFor: number | undefined;
  readonly result: IComputedValue<InboxResult>;
  private readonly rev = createAtom('inbox');
  private scheduled = false;
  private readonly off: () => void;
  private disposed = false;

  private readonly pool: Pool;
  private readonly overlay: Overlay;
  private readonly view: () => InboxSearch;
  private readonly app: App;

  constructor(app: App, pool: Pool, overlay: Overlay, view: () => InboxSearch) {
    this.app = app;
    this.pool = pool;
    this.overlay = overlay;
    this.view = view;
    this.off = pool.onApplied((changes) => {
      // New notifications may be mentions or review requests the server knows of (at most every FRESH ms).
      if (changes.some((c) => c.model === 'Notification')) askServerReasons(app, () => oldestNote(pool));
      if (this.scheduled || !changes.some((c) => c.model === 'Notification' || c.model === 'Repository' || c.model === 'Issue' || c.model === 'PullRequest' || c.model === 'Review' || c.model === 'Comment' || c.model === 'IssueAssignee' || c.model === 'User')) return;
      this.scheduled = true;
      requestAnimationFrame(() => {
        this.scheduled = false;
        if (!this.disposed) runInAction(() => {
          this.rev.reportChanged();
        });
      });
    });
    this.result = computed(() => this.compute(), {equals: (a, b) => a.rows.length === b.rows.length && a.rows.every((r, i) => {
      const o = b.rows[i];
      return r.type === 'note' ? o?.type === 'note' && o.id === r.id : o?.type === 'group' && o.key === r.key && o.count === r.count && o.label === r.label;
    })});
  }

  /** Every notification, newest first: sorted again only when notifications change (not on triage). */
  private readonly sorted = computed(() => {
    this.rev.reportObserved();
    const all = [...this.pool.model('Notification').all()];
    return untracked(() => all.map((e) => e.data).sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : b.id - a.id)));
  });

  /** How many notifications there are, in any view (observes them). */
  total(): number {
    return this.sorted.get().length;
  }

  private compute(): InboxResult {
    const v = this.view();
    const statuses = this.overlay.fieldOverrides('Notification', 'status');
    const all = this.sorted.get();
    // A notification whose issue is not on this device is ordered by its subject's activity once known.
    subjectsKnown();
    const server = serverReasons(this.app);
    return untracked(() => {
      const t0 = performance.now();
      // Already in order: inboxRows' own sort of a sorted list is linear.
      const issues = this.pool.model('Issue');
      const out = inboxRows(all, {...v, unread: v.filter === 'unread', working: v.filter === undefined, byRepo: v.group === 'repo'}, {
        reason: (n) => {
          const me = this.app.session?.userId ?? 0;
          const why = reasonOf(this.pool, n, me, this.pool.model('User').get(me)?.data.login, server)?.why;
          const issue = issues.get(n.issue_id)?.data;
          if (v.reason === 'participating') {
            return me && (issue?.poster_id === me || [...this.pool.model('Comment').by('issue_id', n.issue_id)].some((c) => c.data.poster_id === me) || [...this.pool.model('Review').by('issue_id', n.issue_id)].some((r) => r.data.reviewer_id === me && r.data.state !== 'REQUEST_REVIEW')) ? 'participating' : undefined;
          }
          if (why === 'Review requested') return 'review-requested';
          if (why === 'Mentioned') return 'mentioned';
          if (why === 'Assigned') return 'assigned';
          return undefined;
        },
        subject: (n) => {
          const issue = issues.get(n.issue_id)?.data;
          if (issue) {
            const merged = [...this.pool.model('PullRequest').by('issue_id', issue.id)].some((p) => p.data.merged);
            return {type: issue.is_pull ? 'pr' : 'issue', state: merged ? 'merged' : issue.state};
          }
          const subject = knownSubject(this.app, n.id);
          return subject ? {type: subject.pull ? 'pr' : 'issue', state: subject.state} : undefined;
        },
        status: (n) => (statuses.get(n.id) as string | undefined) ?? n.status,
        repoName: (id) => this.pool.model('Repository').get(id)?.data.full_name ?? '',
        activity: (n) => activityOf(n, issues.get(n.issue_id)?.data.updated_at ?? knownSubject(this.app, n.id)?.updated),
      });
      try {
        performance.measure('inbox:query', {start: t0, end: performance.now(), detail: {rows: out.rows.length}});
      } catch {
        // No User Timing.
      }
      return out;
    });
  }

  dispose(): void {
    this.disposed = true;
    this.off();
  }
}

/** The oldest notification's creation time: an issue that mentioned the viewer since was updated since. */
function oldestNote(pool: Pool): string | undefined {
  let min: string | undefined;
  for (const e of pool.model('Notification').all()) {
    const at = e.data.created_at;
    if (at && (min === undefined || at < min)) min = at;
  }
  return min;
}

export default observer(function Inbox() {
  const app = useApp();
  const {data} = useSession();
  const search = route.useSearch();
  const navigate = useNavigate();
  // The view (URL search params) as an observable, applied before paint. A view the page set itself is shown at
  // once and written to the URL a frame later (`pushed`, until the router has it): the router's navigation
  // re-renders the page and every sidebar link, a task of its own instead of half of the click's (QA round 2).
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
  // Which notifications mention the viewer or wait for their review: the server says (serverReasons.ts).
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
    // One request for all of them; Undo (Linear): the notifications this marked read become unread again.
    const marked = markAllRead(app, untracked(() => model.result.get().ids));
    if (!marked.length) return;
    notify(app, {tone: 'neutral', series: 'inbox', title: `Marked ${String(marked.length)} read`, action: {label: 'Undo', run: () => {
      setStatus(app, marked, (st) => (st === 'read' ? 'unread' : undefined));
    }}});
  };
  useShortcutScope('inbox');
  useShortcut('inbox.readAll', readAll);
  return (
    <>
      <PageHeader icon={InboxIcon} title="Inbox">
        <SelectionBar model={model}/>
        <InboxFilters search={shown} set={set}/>
        <SelectToggle model={model}/>
        <Button size="sm" pressed={shown.filter === 'unread'} tooltip="Show unread notifications only (not the pinned ones)" onClick={() => {
          set({filter: shown.filter === 'unread' ? undefined : 'unread'});
        }}>Unread<UnreadCount/></Button>
        <Button size="sm" pressed={shown.filter === 'all'} tooltip={shown.filter === 'all' ? 'Back to unread and pinned notifications' : 'Show read notifications too'} onClick={() => {
          set({filter: shown.filter === 'all' ? undefined : 'all'});
        }}>All</Button>
        <Menu>
          <MenuTrigger asChild><Button size="sm" variant="ghost" icon={Rows3}>Display</Button></MenuTrigger>
          <MenuContent>
            <MenuCheckboxItem checked={shown.group === 'repo'} onCheckedChange={(on) => {
              set({group: on ? 'repo' : undefined});
            }}>Group by repository</MenuCheckboxItem>
          </MenuContent>
        </Menu>
        <Button size="sm" variant="ghost" icon={CheckCheck} shortcut={shortcutHint('inbox.readAll')} tooltip="Mark everything listed read" onClick={readAll}>Mark all read</Button>
      </PageHeader>
      <InboxBody model={model} filter={shown.filter} byRepo={shown.group === 'repo'} filtered={[shown.reason, shown.repo, shown.type, shown.state].some((value) => value !== undefined)}/>
    </>
  );
});

function sameView(a: InboxSearch, b: InboxSearch): boolean {
  return a.filter === b.filter && a.group === b.group && a.reason === b.reason && a.repo === b.repo && a.type === b.type && a.state === b.state;
}

/** Select mode (a phone has no Shift-click and no X): a tap selects; turning it off clears the selection. */
const SelectToggle = observer(function SelectToggle({model}: {model: InboxModel}) {
  const on = model.selecting.get();
  return (
    <Button size="sm" pressed={on} icon={ListChecks} shortcut={shortcutHint('list.select')}
      tooltip={on ? 'Tap rows to select them; Esc or Select again to stop' : 'Select notifications to act on several at once (also Shift-click, or X on a row)'} onClick={() => {
        runInAction(() => {
          model.selecting.set(!on);
        });
        if (on) model.cursor.clearSelection();
      }}>Select</Button>
  );
});

/** What the selection can do (#206), with the count; the keys that do the same are in the tooltips. */
const SelectionBar = observer(function SelectionBar({model}: {model: InboxModel}) {
  const app = useApp();
  const overlay = useOverlay();
  const pool = usePool();
  const ids = model.cursor.selected.values();
  if (!ids.length) return null;
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
    <div role="toolbar" aria-label="Selected notifications" className="flex flex-wrap items-center gap-1">
      <span className="px-1 text-sm whitespace-nowrap text-fg-muted tabular-nums">{ids.length} selected</span>
      <Button size="sm" variant="ghost" icon={MailOpen} shortcut={shortcutHint('inbox.read')} tooltip="Mark the selected notifications read"
        disabled={!statuses.includes('unread')} onClick={run((st) => (st === 'unread' ? 'read' : undefined), 'read')}>Mark read</Button>
      <Button size="sm" variant="ghost" icon={Mail} shortcut={shortcutHint('inbox.unread')} tooltip="Mark the selected notifications unread"
        disabled={statuses.every((st) => st === 'unread')} onClick={run(() => 'unread', 'unread')}>Mark unread</Button>
      <Button size="sm" variant="ghost" icon={allPinned ? PinOff : Pin} shortcut={shortcutHint('inbox.pin')}
        tooltip={allPinned ? 'Unpin the selected notifications' : 'Pin the selected notifications: they stay at the top, for later'}
        onClick={run((st) => (allPinned ? (st === 'pinned' ? 'read' : undefined) : st === 'pinned' ? undefined : 'pinned'), 'pin')}>{allPinned ? 'Unpin' : 'Pin'}</Button>
      <Button size="sm" variant="ghost" icon={BellOff} shortcut={shortcutHint('inbox.unsubscribe')} tooltip={cannotUnsubscribe ?? 'Unsubscribe from the selected threads'}
        disabled={!!cannotUnsubscribe} onClick={() => {
          unsubscribe(app, untracked(() => model.cursor.selected.values()));
        }}>Unsubscribe</Button>
      <Button size="sm" variant="ghost" icon={X} shortcut={formatKeys('escape')} tooltip="Clear the selection" onClick={() => {
        model.cursor.clearSelection();
      }}>Clear</Button>
    </div>
  );
});

const UnreadCount = observer(function UnreadCount() {
  const {ui} = useApp();
  const {data} = useSession();
  const n = ui.unread ?? data.pool.model('Notification').by('status', 'unread').size;
  return n ? <span className="text-fg-subtle tabular-nums">{n}</span> : null;
});

const InboxBody = observer(function InboxBody({model, filter, byRepo, filtered}: {model: InboxModel; filter: InboxSearch['filter']; byRepo: boolean; filtered: boolean}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const {rows} = model.result.get();
  // Some notifications, none in this view: they are handled (read).
  const caughtUp = filter === 'all' || !model.total() ? undefined : filter === 'unread' ?
    'Nothing unread. Pinned notifications are in the inbox’s default view, read ones under “All”.' :
    'Nothing unread or pinned. Read notifications are under “All”.';
  return (
    <PageBody ref={setScroller}>
      {rows.length ?
        <InboxList model={model} scroller={scroller} byRepo={byRepo}/> :
        <EmptyState icon={BellOff} title={filtered ? 'No matching notifications' : caughtUp ? 'All caught up' : 'No notifications'}
          description={filtered ? 'Try changing the filters to see more notifications.' : caughtUp ?? 'Mentions, reviews, and issue and pull request activity on what you watch show here. New releases are announced by email only; choose what you watch in a repository’s Watch menu.'}/>}
    </PageBody>
  );
});

const rowId = (id: number) => `inbox-row-${String(id)}`;

/** The inbox's place in listReturn (one inbox: its filters do not change the row the user left from). */
const INBOX = '/notifications';

/** byRepo: grouped by repository (the group header names it; the rows give the number only). */
const InboxList = observer(function InboxList({model, scroller, byRepo}: {model: InboxModel; scroller: HTMLDivElement | null; byRepo: boolean}) {
  const app = useApp();
  const navigate = useNavigate();
  const {rows, ids} = model.result.get();
  const {cursor} = model;
  const listRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller,
    ...pageListRect(),
    estimateSize: () => ROW,
    // Rendered with the next frame, not synchronously in every scroll event (QA round 2: 60-100 ms long tasks per
    // wheel step on a 4x slowed CPU); a few rows past each edge are enough for J/K and the wheel.
    useFlushSync: false,
    overscan: 4,
    getItemKey: (i) => {
      const r = rows[i];
      return r ? (r.type === 'note' ? r.id : `g:${r.key}`) : i;
    },
  });
  const visible = Math.min(rows.length, 40);
  useEffect(() => {
    rememberListRows(visible);
  }, [visible]);
  // A row that leaves the list (read in the Unread view) hands the cursor to the row that followed it, so J/E
  // triage goes on from there.
  const prevIds = useRef<readonly number[]>(ids);
  useLayoutEffect(() => {
    const listed = new Set(ids);
    const active = cursor.activeId;
    if (active !== undefined && !listed.has(active)) {
      const old = prevIds.current;
      const at = old.indexOf(active);
      const next = [...old.slice(at + 1), ...old.slice(0, Math.max(0, at)).reverse()].find((id) => listed.has(id));
      cursor.setActive(next);
    }
    cursor.keep(listed);
    prevIds.current = ids;
  }, [ids, cursor]);
  useEffect(() => autorun(() => {
    const [id] = cursor.active.values();
    if (id !== undefined) rememberRow(INBOX, id);
    const el = listRef.current;
    if (!el) return;
    if (id === undefined) el.removeAttribute('aria-activedescendant');
    else el.setAttribute('aria-activedescendant', rowId(id));
  }), [cursor]);
  // Back in the inbox: the cursor is where it was, and the list has the focus (Enter, E, Esc work at once).
  useLayoutEffect(() => {
    const back = rememberedRow(INBOX);
    if (typeof back !== 'number' || cursor.activeId !== undefined) return;
    const at = untracked(() => model.result.get().rows.findIndex((r) => r.type === 'note' && r.id === back));
    if (at < 0) return;
    cursor.setActive(back);
    virtualizer.scrollToIndex(at, {align: 'auto'});
    focusList(listRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the list mounts
  }, []);

  const open = (id: number, newTab = false) => {
    const s = app.session;
    const n = s && untracked(() => s.data.pool.model('Notification').get(id));
    if (!n) return;
    const issue = untracked(() => s.data.pool.model('Issue').get(n.data.issue_id));
    const subject = issue ? undefined : untracked(() => knownSubject(app, id));
    const path = issue ? issuePath(app, issue) : subject && subjectPath(subject);
    // Opening it is reading it (Linear); a pinned one stays pinned.
    setStatus(app, [id], (st) => (st === 'unread' ? 'read' : undefined));
    if (!path) return;
    // At the comment it is about (#211), not the top of the thread.
    const hash = noteHash(n.data);
    if (newTab) window.open(`${app.config.app_sub_url}${path}${hash ? `#${hash}` : ''}`, '_blank', 'noopener');
    else void navigate({to: path, ...(hash ? {hash} : {})});
  };
  const move = (delta: number) => {
    if (!ids.length) return;
    const at = cursor.activeId === undefined ? -1 : ids.indexOf(cursor.activeId);
    const next = ids[at < 0 ? (delta > 0 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, at + delta))];
    if (next === undefined) return;
    cursor.setActive(next);
    virtualizer.scrollToIndex(rows.findIndex((r) => r.type === 'note' && r.id === next), {align: 'auto'});
    listRef.current?.focus({preventScroll: true});
  };
  /**
   * Triage keeps the cursor moving: after E/U/pin on the cursor's row, J goes on from there. Read and unread say
   * what they did, with Undo (a row that leaves the Unread view is easy to lose).
   */
  const triageKey = (to: StatusTo, said?: 'read' | 'unread' | 'pin') => () => {
    // Without a cursor (from the palette, before J): the first row, which then has the cursor.
    let targets = cursor.targets();
    if (!targets.length && ids[0] !== undefined) {
      cursor.setActive(ids[0]);
      targets = [ids[0]];
    }
    triage(app, targets, to, said);
  };
  /** Esc: clears the selection, else leaves select mode. */
  const clear = () => {
    if (untracked(() => cursor.selected.size)) cursor.clearSelection();
    else runInAction(() => {
      model.selecting.set(false);
    });
  };
  const clearable = () => untracked(() => cursor.selected.size > 0 || model.selecting.get());
  useShortcutScope('list');
  useShortcut('list.next', () => {
    move(1);
  });
  useShortcut('list.prev', () => {
    move(-1);
  });
  useShortcut('list.select', () => {
    // Before J (no cursor yet): the first row, which then has the cursor (#206).
    if (cursor.activeId === undefined && ids[0] !== undefined) cursor.setActive(ids[0]);
    if (cursor.activeId !== undefined) cursor.toggle(cursor.activeId);
  });
  useShortcut('list.open', () => {
    if (cursor.activeId !== undefined) open(cursor.activeId);
  }, true, () => cursor.activeId !== undefined);
  useShortcut('list.clear', clear, true, clearable);
  useShortcut('inbox.read', triageKey((st) => (st === 'unread' ? 'read' : undefined), 'read'));
  useShortcut('inbox.unread', triageKey(() => 'unread', 'unread'));
  useShortcut('inbox.pin', triageKey(togglePin, 'pin'));
  useShortcut('inbox.unsubscribe', () => {
    const targets = cursor.targets();
    unsubscribe(app, targets.length ? targets : ids.slice(0, 1));
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' && cursor.activeId !== undefined) {
      e.preventDefault();
      open(cursor.activeId, e.metaKey || e.ctrlKey);
    } else if (e.key === 'Escape' && clearable()) {
      e.preventDefault();
      clear();
    }
  };
  const handlers = useRef({open, cursor, ids, model});
  handlers.current = {open, cursor, ids, model};
  const [click] = useState(() => (id: number, e: {shiftKey: boolean; metaKey: boolean; ctrlKey: boolean}) => {
    const h = handlers.current;
    if (e.shiftKey) {
      h.cursor.selectRange(id, h.ids);
      return;
    }
    h.cursor.setActive(id);
    if (untracked(() => h.model.selecting.get()) && !(e.metaKey || e.ctrlKey)) h.cursor.toggle(id);
    else h.open(id, e.metaKey || e.ctrlKey);
  });

  const items = virtualizer.getVirtualItems();
  const refocus = () => {
    focusList(listRef.current);
  };
  // The row menu acts on the selection when the row is in it (and says how many), else on the row.
  const [menuIds, setMenuIds] = useState<number[]>([]);
  return (
    <ContextMenu onOpenChange={(o) => {
      if (!o) setMenuIds([]);
    }}>
      <ContextMenuTrigger asChild>
        <div
          ref={listRef}
          role="listbox"
          aria-label="Notifications"
          aria-multiselectable
          data-shortcuts
          tabIndex={0}
          onKeyDown={onKeyDown}
          onFocus={(e) => {
            if (e.target !== e.currentTarget || cursor.activeId !== undefined) return;
            const first = items.map((it) => rows[it.index]).find((r) => r?.type === 'note');
            if (first?.type === 'note') cursor.setActive(first.id);
          }}
          onPointerLeave={() => {
            if (model.menuFor === undefined) model.hover.clear();
          }}
          onContextMenuCapture={(e) => {
            const el = (e.target as Element).closest('[data-note]');
            const id = el ? Number(el.getAttribute('data-note')) : cursor.activeId;
            if (id === undefined) {
              e.preventDefault();
              return;
            }
            const sel = untracked(() => cursor.selected.values());
            setMenuIds(sel.includes(id) ? sel : [id]);
            if (!sel.includes(id)) cursor.setActive(id);
          }}
          className="relative w-full outline-none"
          style={{height: virtualizer.getTotalSize()}}
        >
          {items.map((it) => {
            const r = rows[it.index];
            if (!r) return null;
            return (
              <div key={it.key} className="absolute inset-x-0 top-0 hover:bg-hover" style={{transform: `translateY(${String(it.start)}px)`}} onPointerEnter={r.type === 'note' ? (e) => {
                // A mouse: a tap that opens the row has no use for its buttons.
                if (e.pointerType === 'mouse' && model.menuFor === undefined) model.hover.replace([r.id]);
              } : undefined}>
                {r.type === 'note' ?
                  <>
                    <NoteRow id={r.id} model={model} onClick={click} byRepo={byRepo}/>
                    <RowActions id={r.id} model={model} open={open} refocus={refocus}/>
                  </> :
                  <ListGroupHeader leading={r.key === 'pinned' ? <Icon icon={Pin}/> : r.key.startsWith('repo:') ? <Icon icon={FolderGit2}/> : null} label={r.label} count={r.count}/>}
              </div>
            );
          })}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {menuIds.length > 0 && <NoteMenu ids={menuIds} open={open} Item={ContextMenuItem} Separator={ContextMenuSeparator}/>}
      </ContextMenuContent>
    </ContextMenu>
  );
});

// The item parts of the context menu and the dropdown have the same props (ui/Menu.tsx makeItems).
type ItemComponent = typeof MenuItem;

/**
 * A row's actions as menu items (its context menu and its "More" menu: the same rows). On the selection when the
 * row is in it (the labels say how many), else on the row.
 */
const NoteMenu = observer(function NoteMenu({ids, open, Item, Separator}: {ids: readonly number[]; open: (id: number) => void; Item: ItemComponent; Separator: typeof MenuSeparator}) {
  const app = useApp();
  const pool = usePool();
  const overlay = useOverlay();
  const one = ids.length === 1 ? ids[0] : undefined;
  const n = one === undefined ? undefined : pool.model('Notification').get(one);
  const status = n ? notificationStatus(overlay, n) : undefined;
  const cannotUnsubscribe = unsubscribeReason(app, ids);
  const many = ids.length > 1 ? ` (${String(ids.length)})` : '';
  return (
    <>
      {one !== undefined && <>
        <Item icon={ExternalLink} shortcut={formatKeys('enter')} onSelect={() => {
          open(one);
        }}>Open</Item>
        <Separator/>
      </>}
      <Item icon={MailOpen} shortcut={shortcutHint('inbox.read')} disabled={status !== undefined && status !== 'unread'} onSelect={() => {
        triage(app, ids, (st) => (st === 'unread' ? 'read' : undefined), 'read');
      }}>{`Mark read${many}`}</Item>
      <Item icon={Mail} shortcut={shortcutHint('inbox.unread')} disabled={status === 'unread'} onSelect={() => {
        triage(app, ids, () => 'unread', 'unread');
      }}>{`Mark unread${many}`}</Item>
      <Item icon={status === 'pinned' ? PinOff : Pin} shortcut={shortcutHint('inbox.pin')} onSelect={() => {
        triage(app, ids, togglePin, 'pin');
      }}>{status === 'pinned' ? 'Unpin' : `Pin${many}`}</Item>
      <Separator/>
      <Item icon={BellOff} shortcut={shortcutHint('inbox.unsubscribe')} disabled={!!cannotUnsubscribe} onSelect={() => {
        unsubscribe(app, ids);
      }}>{`Unsubscribe${many}`}</Item>
      <Item icon={BellOff} disabled={!!cannotUnsubscribe} onSelect={() => {
        unsubscribe(app, ids, true);
      }}>{`Unsubscribe and mark read${many}`}</Item>
      {cannotUnsubscribe && <div className="px-2 py-1 text-xs text-fg-subtle">{cannotUnsubscribe}</div>}
    </>
  );
});

/**
 * The hovered row's buttons (#206): read or unread, pin (keep it for later) and the row's menu, over its time. For
 * the mouse; the keys and the row menu (right click, long press, Shift+F10) do the same, so they are hidden from
 * assistive tech and out of the tab order. Only the hovered row has them (no tooltips mounted per row).
 */
const RowActions = observer(function RowActions({id, model, open, refocus}: {id: number; model: InboxModel; open: (id: number) => void; refocus: () => void}) {
  const app = useApp();
  const pool = usePool();
  const overlay = useOverlay();
  const shown = model.hover.has(id);
  const n = pool.model('Notification').get(id);
  if (!shown || !n) return null;
  const status = notificationStatus(overlay, n);
  const unread = status === 'unread';
  // A click keeps the focus where it is (the list: J/K and E go on).
  const keepFocus = (e: MouseEvent) => {
    e.preventDefault();
  };
  return (
    <div data-note={id} aria-hidden className="absolute inset-y-0 right-0 flex items-center pe-2">
      <div className="flex items-center gap-0.5 rounded-md border border-border bg-raised p-0.5">
        <IconButton size="sm" tabIndex={-1} icon={unread ? MailOpen : Mail} label={unread ? 'Mark read' : 'Mark unread'} shortcut={shortcutHint(unread ? 'inbox.read' : 'inbox.unread')}
          onMouseDown={keepFocus} onClick={() => {
          triage(app, [id], unread ? (st) => (st === 'unread' ? 'read' : undefined) : () => 'unread', unread ? 'read' : 'unread');
        }}/>
        <IconButton size="sm" tabIndex={-1} icon={status === 'pinned' ? PinOff : Pin} label={status === 'pinned' ? 'Unpin' : 'Pin, to keep it for later'} shortcut={shortcutHint('inbox.pin')}
          onMouseDown={keepFocus} onClick={() => {
          triage(app, [id], togglePin, 'pin');
        }}/>
        <Menu onOpenChange={(o) => {
          model.menuFor = o ? id : undefined;
          if (!o) model.hover.clear();
        }}>
          <MenuTrigger asChild><IconButton size="sm" tabIndex={-1} icon={MoreHorizontal} label="More actions"/></MenuTrigger>
          <MenuContent align="end" onCloseAutoFocus={(e) => {
            // Back to the list (its buttons are gone with the hover), not to the button.
            e.preventDefault();
            refocus();
          }}>
            <NoteMenu ids={[id]} open={open} Item={MenuItem} Separator={MenuSeparator}/>
          </MenuContent>
        </Menu>
      </div>
    </div>
  );
});

type RowClick = (id: number, e: {shiftKey: boolean; metaKey: boolean; ctrlKey: boolean}) => void;

const NoteRow = observer(function NoteRow({id, model, onClick, byRepo}: {id: number; model: InboxModel; onClick: RowClick; byRepo: boolean}) {
  const pool = usePool();
  const n = pool.model('Notification').get(id);
  if (!n) return <ListRow role="presentation"> </ListRow>;
  return <NoteRowBody n={n} model={model} onClick={onClick} byRepo={byRepo}/>;
});

const NoteRowBody = observer(function NoteRowBody({n, model, onClick, byRepo}: {n: Entity<'Notification'>; model: InboxModel; onClick: RowClick; byRepo: boolean}) {
  const pool = usePool();
  const app = useApp();
  const {userId} = useSession();
  const {cursor} = model;
  const status = notificationStatus(useOverlay(), n);
  const issue = pool.model('Issue').get(n.get('issue_id'));
  // Not on this device (a repository outside the workspace): what the server says it is about.
  const subject = issue ? undefined : subjectOf(app, n.data);
  const repo = pool.model('Repository').get(n.get('repo_id'))?.get('full_name') ?? (subject ? `${subject.owner}/${subject.repo}` : '');
  const unread = status === 'unread';
  const at = activityOf(n.data, issue?.get('updated_at') ?? subject?.updated);
  const path = issue ? issuePath(app, issue) : subject && subjectPath(subject);
  const hash = noteHash(n.data);
  const reason = reasonOf(pool, n.data, userId, pool.model('User').get(userId)?.get('login'), serverReasons(app));
  const number = issue ? issue.get('number') : subject?.number;
  const selecting = model.selecting.get();
  const selected = cursor.selected.has(n.id);
  return (
    <ListRow
      role="option"
      id={rowId(n.id)}
      data-note={n.id}
      active={cursor.active.has(n.id)}
      selected={selected}
      // A link (middle-click, a new tab) to the comment it is about; a plain click opens it here and marks it read.
      href={path ? `${sitePath(app.config, path)}${hash ? `#${hash}` : ''}` : undefined}
      tabIndex={-1}
      onClick={(e) => {
        if (path && (e.metaKey || e.ctrlKey) && !e.shiftKey) return;
        e.preventDefault();
        onClick(n.id, e);
      }}
      leading={<>
        {selecting && (selected ? <Icon icon={SquareCheck} className="text-accent-fg"/> : <Icon icon={Square}/>)}
        <StatusDot tone="accent" off={!unread}/>
        {issue ? <StateIcon issue={issue}/> : subject ? <SubjectIcon s={subject}/> : <Icon icon={n.get('subject') === 'commit' ? GitCommitHorizontal : InboxIcon}/>}
      </>}
      trailing={<>
        {status === 'pinned' && <Icon icon={Pin} size="sm"/>}
        <RefCell repo={byRepo ? '' : repo} number={number}/>
        <AgoCell at={at}/>
      </>}
    >
      {/* The title gives way first, then the actor's name; why it is here stays (a phone, #229). */}
      <span className="flex min-w-0 items-baseline">
        {(unread || status === 'pinned') && <span className="sr-only">{unread ? 'Unread: ' : 'Pinned: '}</span>}
        <span className={cx('shrink-4 truncate', reason ? 'min-w-24' : 'min-w-0', unread ? 'font-medium text-fg' : 'text-fg-muted')}>
          {issue ? <TitleCell issue={issue}/> : subject ? subject.title : subjectWords(n.get('subject'))}
        </span>
        {reason && <Why why={reason.why} actor={reason.actor}/>}
      </span>
    </ListRow>
  );
});

/** Why the notification is here, and whose activity it is (muted, after the title). */
function Why({why, actor}: {why: string; actor: number}) {
  const user = useUser(actor);
  return <>
    <span className="ms-1 shrink-0 whitespace-nowrap text-fg-subtle">· {why}</span>
    {actor && user.name ? <span className="ms-1 min-w-0 truncate text-fg-subtle">· {user.name}</span> : null}
  </>;
}

function SubjectIcon({s}: {s: Subject}) {
  return <StateGlyph look={stateLook(s.state === 'open' ? 'open' : 'closed', s.pull, s.state === 'merged')}/>;
}

function subjectWords(subject: string): string {
  switch (subject) {
    case 'commit':
      return 'A commit (not on this device)';
    case 'repository':
      return 'Repository activity';
    case 'pull':
      return 'A pull request (not on this device)';
    default:
      return 'An issue (not on this device)';
  }
}
