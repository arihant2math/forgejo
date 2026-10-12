// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Notifications come from the viewer's group; triage uses offline-capable intents.
// Rows observe their fields; the row set recomputes at most once per frame.

import {focusList, rememberedRow, rememberRow} from '../../app/listReturn.ts';
import {getRouteApi, useNavigate} from '@tanstack/react-router';
import {useVirtualizer} from '@tanstack/react-virtual';
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
import {clsx} from 'clsx';
import {DENSE_ROW_HEIGHT, DenseRow} from '../home/DenseRow.tsx';
import {IssueReference as RefCell} from '../home/IssueReference.tsx';
import {AgoCell, StateGlyph, StateIcon, stateLook, TitleCell, useOverlay, usePool, useUser} from '../issues/cells.tsx';
import {issuePath} from '../issues/edits.ts';
import {KeyedFlags} from '../issues/flags.ts';
import {readAll as markAllRead, setStatus, type StatusTo, triage, unsubscribe, unsubscribeReason} from './actions.ts';
import {InboxCursor} from './cursor.ts';
import {participates, reasonOf} from './reason.ts';
import {askServerReasons, serverReasons} from './serverReasons.ts';
import {InboxFilters} from './InboxFilters.tsx';
import {knownSubject, type Subject, subjectOf, subjectPath, subjectsKnown} from './subject.ts';
import {activityOf, type InboxResult, inboxRows, noteHash, togglePin} from './inbox.ts';
import {BellSlashIcon, ChecklistIcon, LinkExternalIcon, FileSubmoduleIcon, GitCommitIcon, InboxIcon, TasklistIcon, MailIcon, ReadIcon, KebabHorizontalIcon, PinIcon, PinSlashIcon, RowsIcon, SquareIcon, CheckboxIcon, XIcon} from '@primer/octicons-react';
import {ActionList, ActionMenu, Button, CounterLabel, IconButton, SegmentedControl, Tooltip} from '@primer/react';
import {Blankslate, KeybindingHint} from '@primer/react/experimental';

const ROW = DENSE_ROW_HEIGHT;
const route = getRouteApi('/shell/notifications');

class InboxModel {
  readonly cursor = new InboxCursor();
  readonly selecting = observable.box(false);
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

  /** Sort only on notification changes, not pending triage. */
  private readonly sorted = computed(() => {
    this.rev.reportObserved();
    const all = [...this.pool.model('Notification').all()];
    return untracked(() => all.map((e) => e.data).sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : b.id - a.id)));
  });

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
      const issues = this.pool.model('Issue');
      const out = inboxRows(all, {...v, unread: v.filter === 'unread', working: v.filter === undefined, byRepo: v.group === 'repo'}, {
        reason: (n) => {
          const me = this.app.session?.userId ?? 0;
          const myLogin = this.pool.model('User').get(me)?.data.login;
          if (v.reason === 'participating') return participates(this.pool, n, me, myLogin, server) ? 'participating' : undefined;
          const why = reasonOf(this.pool, n, me, myLogin, server)?.why;
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
        // User Timing may be unavailable.
      }
      return out;
    });
  }

  dispose(): void {
    this.disposed = true;
    this.off();
  }
}

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
        <SegmentedControl aria-label="Notification status" size="small" onChange={(index) => {
          set({filter: index === 1 ? 'unread' : index === 2 ? 'all' : undefined});
        }}>
          <SegmentedControl.Button selected={shown.filter === undefined}>Unread and pinned</SegmentedControl.Button>
          <SegmentedControl.Button selected={shown.filter === 'unread'} count={app.ui.unread ?? data.pool.model('Notification').by('status', 'unread').size}>Unread</SegmentedControl.Button>
          <SegmentedControl.Button selected={shown.filter === 'all'}>All</SegmentedControl.Button>
        </SegmentedControl>
        <ActionMenu>
          <ActionMenu.Button variant="invisible" size="small" leadingVisual={RowsIcon}>Display</ActionMenu.Button>
          <ActionMenu.Overlay><ActionList>
            <ActionList.Group selectionVariant="multiple">
              <ActionList.Item selected={shown.group === 'repo'} onSelect={() => {
                set({group: shown.group === 'repo' ? undefined : 'repo'});
              }}>Group by repository</ActionList.Item>
            </ActionList.Group>
          </ActionList></ActionMenu.Overlay>
        </ActionMenu>
        <Tooltip text={'Mark everything listed read'} keybindingHint={shortcutHint('inbox.readAll')}><Button variant="invisible" size="small" leadingVisual={ChecklistIcon} type="button" onClick={readAll}>Mark all read</Button></Tooltip>
      </PageHeader>
      <InboxBody model={model} filter={shown.filter} byRepo={shown.group === 'repo'} filtered={[shown.reason, shown.repo, shown.type, shown.state].some((value) => value !== undefined)}/>
    </>
  );
});

function sameView(a: InboxSearch, b: InboxSearch): boolean {
  return a.filter === b.filter && a.group === b.group && a.reason === b.reason && a.repo === b.repo && a.type === b.type && a.state === b.state;
}

const SelectToggle = observer(function SelectToggle({model}: {model: InboxModel}) {
  const on = model.selecting.get();
  return (
    <Tooltip text={on ? 'Tap rows to select them; Esc or Select again to stop' : 'Select notifications to act on several at once (also Shift-click, or X on a row)'} keybindingHint={shortcutHint('list.select')}><Button aria-pressed={on} variant="default" size="small" leadingVisual={TasklistIcon} type="button" onClick={() => {
        runInAction(() => {
          model.selecting.set(!on);
        });
        if (on) model.cursor.clearSelection();
      }}>Select</Button></Tooltip>
  );
});

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
    <div role="toolbar" aria-label="Selected notifications" className="flex flex-wrap items-center gap-2">
      <span className="px-1 text-sm whitespace-nowrap text-muted tabular-nums">{ids.length} selected</span>
      <Tooltip text={statuses.includes('unread') ? 'Mark the selected notifications read' : 'No selected notifications are unread'} keybindingHint={shortcutHint('inbox.read')}><Button variant="invisible" size="small" leadingVisual={ReadIcon} type="button" inactive={!statuses.includes('unread')} onClick={run((st) => (st === 'unread' ? 'read' : undefined), 'read')}>Mark read</Button></Tooltip>
      <Tooltip text={statuses.every((st) => st === 'unread') ? 'All selected notifications are already unread' : 'Mark the selected notifications unread'} keybindingHint={shortcutHint('inbox.unread')}><Button variant="invisible" size="small" leadingVisual={MailIcon} type="button" inactive={statuses.every((st) => st === 'unread')} onClick={run(() => 'unread', 'unread')}>Mark unread</Button></Tooltip>
      <Tooltip text={allPinned ? 'Unpin the selected notifications' : 'Pin the selected notifications: they stay at the top, for later'} keybindingHint={shortcutHint('inbox.pin')}><Button variant="invisible" size="small" leadingVisual={allPinned ? PinSlashIcon : PinIcon} type="button" onClick={run((st) => (allPinned ? (st === 'pinned' ? 'read' : undefined) : st === 'pinned' ? undefined : 'pinned'), 'pin')}>{allPinned ? 'Unpin' : 'Pin'}</Button></Tooltip>
      <Tooltip text={cannotUnsubscribe ?? 'Unsubscribe from the selected threads'} keybindingHint={shortcutHint('inbox.unsubscribe')}><Button variant="invisible" size="small" leadingVisual={BellSlashIcon} type="button" inactive={!!cannotUnsubscribe} onClick={() => {
          unsubscribe(app, untracked(() => model.cursor.selected.values()));
        }}>Unsubscribe</Button></Tooltip>
      <Tooltip text={'Clear the selection'} keybindingHint={formatKeys('escape')}><Button variant="invisible" size="small" leadingVisual={XIcon} type="button" onClick={() => {
        model.cursor.clearSelection();
      }}>Clear</Button></Tooltip>
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
        <Blankslate spacious><Blankslate.Visual><BellSlashIcon size={24}/></Blankslate.Visual><Blankslate.Heading>{filtered ? 'No matching notifications' : caughtUp ? 'All caught up' : 'No notifications'}</Blankslate.Heading><Blankslate.Description>{filtered ? 'Try changing the filters to see more notifications.' : caughtUp ?? 'Mentions, reviews, and issue and pull request activity on what you watch show here. New releases are announced by email only; choose what you watch in a repository’s Watch menu.'}</Blankslate.Description></Blankslate>}
    </PageBody>
  );
});

const rowId = (id: number) => `inbox-row-${String(id)}`;

/** Share one return cursor across inbox filters. */
const INBOX = '/notifications';

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
    estimateSize: (index) => rows[index]?.type === 'note' ? ROW : 40,
    // Avoid synchronous virtualizer work on every scroll event.
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
  // Preserve the next row as cursor when triage removes the active row.
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
    setStatus(app, [id], (st) => (st === 'unread' ? 'read' : undefined));
    if (!path) return;
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
  const triageKey = (to: StatusTo, said?: 'read' | 'unread' | 'pin') => () => {
    let targets = cursor.targets();
    if (!targets.length && ids[0] !== undefined) {
      cursor.setActive(ids[0]);
      targets = [ids[0]];
    }
    triage(app, targets, to, said);
  };
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
  const [menuIds, setMenuIds] = useState<number[]>([]);
  const contextAnchor = useRef<HTMLElement>(null);
  const showContextMenu = (id: number, anchor: HTMLElement | null) => {
    const selected = untracked(() => cursor.selected.values());
    contextAnchor.current = anchor ?? listRef.current;
    setMenuIds(selected.includes(id) ? selected : [id]);
    if (!selected.includes(id)) cursor.setActive(id);
  };
  return (
    <>
        <div
          ref={listRef}
          role="listbox"
          aria-label="Notifications"
          aria-multiselectable
          data-shortcuts
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
              event.preventDefault();
              const id = cursor.activeId ?? ids[0];
              if (id !== undefined) showContextMenu(id, document.getElementById(rowId(id)));
            } else onKeyDown(event);
          }}
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
            e.preventDefault();
            showContextMenu(id, el instanceof HTMLElement ? el : document.getElementById(rowId(id)));
          }}
          className="relative w-full outline-none"
          style={{height: virtualizer.getTotalSize()}}
        >
          {items.map((it) => {
            const r = rows[it.index];
            if (!r) return null;
            return (
              <div key={it.key} className="absolute inset-x-0 top-0 hover:bg-control-transparent-hover" style={{transform: `translateY(${String(it.start)}px)`}} onPointerEnter={r.type === 'note' ? (e) => {
                if (e.pointerType === 'mouse' && model.menuFor === undefined) model.hover.replace([r.id]);
              } : undefined}>
                {r.type === 'note' ?
                  <>
                    <NoteRow id={r.id} model={model} onClick={click} byRepo={byRepo}/>
                    <RowActions id={r.id} model={model} open={open} refocus={refocus}/>
                  </> :
                  <div role="presentation" className="flex min-h-10 items-center gap-2 border-b border-default bg-muted px-4 py-2">
                    {r.key === 'pinned' ? <PinIcon size={16}/> : r.key.startsWith('repo:') ? <FileSubmoduleIcon size={16}/> : null}
                    <span className="min-w-0 truncate font-semibold">{r.label}</span><CounterLabel>{r.count}</CounterLabel>
                  </div>}
              </div>
            );
          })}
        </div>
      <ActionMenu anchorRef={contextAnchor} open={menuIds.length > 0} onOpenChange={(isOpen) => {
        if (!isOpen) { setMenuIds([]); afterPaint(refocus); }
      }}>
        <ActionMenu.Overlay><ActionList>
          <NoteMenu ids={menuIds} open={open}/>
        </ActionList></ActionMenu.Overlay>
      </ActionMenu>
    </>
  );
});

const NoteMenu = observer(function NoteMenu({ids, open}: {ids: readonly number[]; open: (id: number) => void}) {
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
        <ActionList.Item onSelect={() => {
          open(one);
        }}><ActionList.LeadingVisual><LinkExternalIcon size={16}/></ActionList.LeadingVisual>Open<ActionList.TrailingVisual><KeybindingHint keys={formatKeys('enter')}/></ActionList.TrailingVisual></ActionList.Item>
        <ActionList.Divider/>
      </>}
      <ActionList.Item disabled={status !== undefined && status !== 'unread'} onSelect={() => {
        triage(app, ids, (st) => (st === 'unread' ? 'read' : undefined), 'read');
      }}><ActionList.LeadingVisual><ReadIcon size={16}/></ActionList.LeadingVisual>{`Mark read${many}`}<ActionList.TrailingVisual><KeybindingHint keys={shortcutHint('inbox.read')}/></ActionList.TrailingVisual></ActionList.Item>
      <ActionList.Item disabled={status === 'unread'} onSelect={() => {
        triage(app, ids, () => 'unread', 'unread');
      }}><ActionList.LeadingVisual><MailIcon size={16}/></ActionList.LeadingVisual>{`Mark unread${many}`}<ActionList.TrailingVisual><KeybindingHint keys={shortcutHint('inbox.unread')}/></ActionList.TrailingVisual></ActionList.Item>
      <ActionList.Item onSelect={() => {
        triage(app, ids, togglePin, 'pin');
      }}><ActionList.LeadingVisual>{status === 'pinned' ? <PinSlashIcon size={16}/> : <PinIcon size={16}/>} </ActionList.LeadingVisual>{status === 'pinned' ? 'Unpin' : `Pin${many}`}<ActionList.TrailingVisual><KeybindingHint keys={shortcutHint('inbox.pin')}/></ActionList.TrailingVisual></ActionList.Item>
      <ActionList.Divider/>
      <ActionList.Item disabled={!!cannotUnsubscribe} onSelect={() => {
        unsubscribe(app, ids);
      }}><ActionList.LeadingVisual><BellSlashIcon size={16}/></ActionList.LeadingVisual>{`Unsubscribe${many}`}<ActionList.TrailingVisual><KeybindingHint keys={shortcutHint('inbox.unsubscribe')}/></ActionList.TrailingVisual></ActionList.Item>
      <ActionList.Item disabled={!!cannotUnsubscribe} onSelect={() => {
        unsubscribe(app, ids, true);
      }}><ActionList.LeadingVisual><BellSlashIcon size={16}/></ActionList.LeadingVisual>{`Unsubscribe and mark read${many}`}</ActionList.Item>
      {cannotUnsubscribe && <div className="px-2 py-1 text-xs text-muted">{cannotUnsubscribe}</div>}
    </>
  );
});

/** Mouse-only actions are hidden from assistive tech and tab order; keys and the row menu provide equivalents. */
const RowActions = observer(function RowActions({id, model, open, refocus}: {id: number; model: InboxModel; open: (id: number) => void; refocus: () => void}) {
  const app = useApp();
  const pool = usePool();
  const overlay = useOverlay();
  const shown = model.hover.has(id);
  const n = pool.model('Notification').get(id);
  if (!shown || !n) return null;
  const status = notificationStatus(overlay, n);
  const unread = status === 'unread';
  const keepFocus = (e: MouseEvent) => {
    e.preventDefault();
  };
  return (
    <div data-note={id} aria-hidden className="absolute inset-y-0 right-0 flex items-center pe-2">
      <div className="flex items-center gap-1 rounded-md border border-default bg-overlay">
        <IconButton icon={unread ? ReadIcon : MailIcon} variant="invisible" size="small" aria-label={unread ? 'Mark read' : 'Mark unread'} keybindingHint={shortcutHint(unread ? 'inbox.read' : 'inbox.unread')} type="button" tabIndex={-1} onMouseDown={keepFocus} onClick={() => {
          triage(app, [id], unread ? (st) => (st === 'unread' ? 'read' : undefined) : () => 'unread', unread ? 'read' : 'unread');
        }}/>
        <IconButton icon={status === 'pinned' ? PinSlashIcon : PinIcon} variant="invisible" size="small" aria-label={status === 'pinned' ? 'Unpin' : 'Pin, to keep it for later'} keybindingHint={shortcutHint('inbox.pin')} type="button" tabIndex={-1} onMouseDown={keepFocus} onClick={() => {
          triage(app, [id], togglePin, 'pin');
        }}/>
        <ActionMenu onOpenChange={(isOpen) => {
          model.menuFor = isOpen ? id : undefined;
          if (!isOpen) { model.hover.clear(); afterPaint(refocus); }
        }}>
          <ActionMenu.Anchor><IconButton icon={KebabHorizontalIcon} variant="invisible" size="small" aria-label="More actions" type="button" tabIndex={-1}/></ActionMenu.Anchor>
          <ActionMenu.Overlay align="end"><ActionList>
            <NoteMenu ids={[id]} open={open}/>
          </ActionList></ActionMenu.Overlay>
        </ActionMenu>
      </div>
    </div>
  );
});

type RowClick = (id: number, e: {shiftKey: boolean; metaKey: boolean; ctrlKey: boolean}) => void;

const NoteRow = observer(function NoteRow({id, model, onClick, byRepo}: {id: number; model: InboxModel; onClick: RowClick; byRepo: boolean}) {
  const pool = usePool();
  const n = pool.model('Notification').get(id);
  if (!n) return <DenseRow role="presentation"> </DenseRow>;
  return <NoteRowBody n={n} model={model} onClick={onClick} byRepo={byRepo}/>;
});

const NoteRowBody = observer(function NoteRowBody({n, model, onClick, byRepo}: {n: Entity<'Notification'>; model: InboxModel; onClick: RowClick; byRepo: boolean}) {
  const pool = usePool();
  const app = useApp();
  const {userId} = useSession();
  const {cursor} = model;
  const status = notificationStatus(useOverlay(), n);
  const issue = pool.model('Issue').get(n.get('issue_id'));
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
    <DenseRow
      role="option"
      id={rowId(n.id)}
      data-note={n.id}
      active={cursor.active.has(n.id)}
      selected={selected}
      href={path ? `${sitePath(app.config, path)}${hash ? `#${hash}` : ''}` : undefined}
      tabIndex={-1}
      onClick={(e) => {
        if (path && (e.metaKey || e.ctrlKey) && !e.shiftKey) return;
        e.preventDefault();
        onClick(n.id, e);
      }}
      leading={<>
        {selecting && (selected ? <CheckboxIcon size={16} className="shrink-0 text-accent"/> : <SquareIcon size={16} className="shrink-0"/>)}
        <span aria-hidden className={clsx("size-2 shrink-0 rounded-full", unread ? "bg-accent-emphasis" : "bg-transparent")}/>
        {issue ? <StateIcon issue={issue}/> : subject ? <SubjectIcon s={subject}/> : n.get('subject') === 'commit' ? <GitCommitIcon size={16}/> : <InboxIcon size={16}/>}
      </>}
      trailing={<>
        {status === 'pinned' && <PinIcon size={12} className="shrink-0"/>}
        <RefCell repo={byRepo ? '' : repo} number={number}/>
        <AgoCell at={at}/>
      </>}
    >
      {/* Bound secondary metadata and let it shrink first, preserving the title on phones. */}
      <span className="flex min-w-0 items-center">
        {(unread || status === 'pinned') && <span className="sr-only">{unread ? 'Unread: ' : 'Pinned: '}</span>}
        <span className={clsx('min-w-0 truncate', unread ? 'font-semibold text-default' : 'text-default')}>
          {issue ? <TitleCell issue={issue}/> : subject ? subject.title : subjectWords(n.get('subject'))}
        </span>
        {reason && <Why why={reason.why} actor={reason.actor}/>}
      </span>
    </DenseRow>
  );
});

function Why({why, actor}: {why: string; actor: number}) {
  const user = useUser(actor);
  const description = actor && user.name ? `· ${why} · ${user.name}` : `· ${why}`;
  return <span title={description} className="ms-2 min-w-8 max-w-2/5 shrink-4 truncate text-sm text-muted max-md:max-w-1/4">{description}</span>;
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
