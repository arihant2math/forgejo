// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The inbox (/notifications, PLAN §7.3: Linear's triage). Notifications come
// from the viewer's user group (always on this device); read, unread and pin
// are offline-capable intents (`notification.status`), shown at once and
// synced across tabs and devices by the server's echo.
//
// Keyboard: J/K move, X selects, Enter opens (and marks read), E marks read,
// U unread, Shift+P pins or unpins, Shift+E marks everything read. Like the
// issue lists: one virtualized listbox with aria-activedescendant, rows that
// observe their own fields, and a row set recomputed at most once a frame.

import {getRouteApi, useNavigate} from '@tanstack/react-router';
import {useVirtualizer} from '@tanstack/react-virtual';
import {BellOff, CheckCheck, ExternalLink, FolderGit2, GitCommitHorizontal, Inbox as InboxIcon, Mail, MailOpen, Pin, Rows3} from 'lucide-react';
import {autorun, computed, createAtom, type IComputedValue, observable, runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {rememberListRows} from '../../app/boot.ts';
import type {InboxSearch} from '../../app/search.ts';
import {PageBody} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {formatKeys, shortcutHint, useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {useApp, useSession} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import type {Pool} from '../../data/pool.ts';
import type {Overlay} from '../../intents/overlay.ts';
import {editing} from '../../intents/session.ts';
import {notificationStatus} from '../../intents/view.ts';
import {
  Button, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger, EmptyState, Icon, ListGroupHeader, ListRow, Menu,
  MenuCheckboxItem, MenuContent, MenuTrigger, StatusDot,
} from '../../ui/index.ts';
import {AgoCell, StateIcon, TitleCell, useOverlay, usePool} from '../issues/cells.tsx';
import {issuePath} from '../issues/edits.ts';
import {ListCursor} from '../issues/flags.ts';
import {setStatus} from './actions.ts';
import {type InboxResult, inboxRows, togglePin} from './inbox.ts';

const ROW = 32; // ListRow's h-row
const route = getRouteApi('/shell/notifications');

/** The inbox's rows, recomputed when notifications change (at most once a frame) or a status is overridden. */
class InboxModel {
  readonly cursor = new ListCursor();
  readonly result: IComputedValue<InboxResult>;
  private readonly rev = createAtom('inbox');
  private scheduled = false;
  private readonly off: () => void;
  private disposed = false;

  private readonly pool: Pool;
  private readonly overlay: Overlay;
  private readonly view: () => InboxSearch;

  constructor(pool: Pool, overlay: Overlay, view: () => InboxSearch) {
    this.pool = pool;
    this.overlay = overlay;
    this.view = view;
    this.off = pool.onApplied((changes) => {
      if (this.scheduled || !changes.some((c) => c.model === 'Notification' || c.model === 'Repository')) return;
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

  private compute(): InboxResult {
    const v = this.view();
    const statuses = this.overlay.fieldOverrides('Notification', 'status');
    const all = this.sorted.get();
    return untracked(() => {
      const t0 = performance.now();
      // Already in order: inboxRows' own sort of a sorted list is linear.
      const out = inboxRows(all, {unread: v.filter === 'unread', byRepo: v.group === 'repo'}, {
        status: (n) => (statuses.get(n.id) as string | undefined) ?? n.status,
        repoName: (id) => this.pool.model('Repository').get(id)?.data.full_name ?? '',
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

export default function Inbox() {
  const app = useApp();
  const {data} = useSession();
  const search = route.useSearch();
  const navigate = useNavigate();
  // The view (URL search params) as an observable, applied before paint.
  const [view] = useState(() => observable.box<InboxSearch>(search, {deep: false}));
  useLayoutEffect(() => {
    runInAction(() => {
      view.set(search);
    });
  }, [search, view]);
  const [model] = useState(() => new InboxModel(data.pool, editing(app).overlay, () => view.get()));
  useEffect(() => () => {
    model.dispose();
  }, [model]);
  const set = (patch: {filter?: InboxSearch['filter'] | undefined; group?: InboxSearch['group'] | undefined}) => {
    const next = {...search, ...patch};
    void navigate({to: '.', replace: true, search: Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) as InboxSearch});
  };
  const readAll = () => {
    setStatus(app, untracked(() => model.result.get().ids), (st) => (st === 'unread' ? 'read' : undefined));
  };
  useShortcutScope('inbox');
  useShortcut('inbox.readAll', readAll);
  return (
    <>
      <PageHeader icon={InboxIcon} title="Inbox">
        <Button size="sm" pressed={search.filter === 'unread'} tooltip="Show unread notifications only" onClick={() => {
          set({filter: search.filter === 'unread' ? undefined : 'unread'});
        }}>Unread<UnreadCount/></Button>
        <Menu>
          <MenuTrigger asChild><Button size="sm" variant="ghost" icon={Rows3}>Display</Button></MenuTrigger>
          <MenuContent>
            <MenuCheckboxItem checked={search.group === 'repo'} onCheckedChange={(on) => {
              set({group: on ? 'repo' : undefined});
            }}>Group by repository</MenuCheckboxItem>
          </MenuContent>
        </Menu>
        <Button size="sm" variant="ghost" icon={CheckCheck} shortcut={shortcutHint('inbox.readAll')} tooltip="Mark everything listed read" onClick={readAll}>Mark all read</Button>
      </PageHeader>
      <InboxBody model={model} unreadOnly={search.filter === 'unread'}/>
    </>
  );
}

const UnreadCount = observer(function UnreadCount() {
  const {ui} = useApp();
  const {data} = useSession();
  const n = ui.unread ?? data.pool.model('Notification').by('status', 'unread').size;
  return n ? <span className="text-fg-subtle tabular-nums">{n}</span> : null;
});

const InboxBody = observer(function InboxBody({model, unreadOnly}: {model: InboxModel; unreadOnly: boolean}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const {rows} = model.result.get();
  return (
    <PageBody ref={setScroller}>
      {rows.length ?
        <InboxList model={model} scroller={scroller}/> :
        <EmptyState icon={BellOff} title={unreadOnly ? 'All caught up' : 'No notifications'}
          description={unreadOnly ? 'Nothing unread. Pinned and read notifications are under “Unread” off.' : 'Mentions, reviews and activity on what you watch show here.'}/>}
    </PageBody>
  );
});

const rowId = (id: number) => `inbox-row-${String(id)}`;

const InboxList = observer(function InboxList({model, scroller}: {model: InboxModel; scroller: HTMLDivElement | null}) {
  const app = useApp();
  const navigate = useNavigate();
  const {rows, ids} = model.result.get();
  const {cursor} = model;
  const listRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller,
    estimateSize: () => ROW,
    overscan: 8,
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
    const el = listRef.current;
    if (!el) return;
    if (id === undefined) el.removeAttribute('aria-activedescendant');
    else el.setAttribute('aria-activedescendant', rowId(id));
  }), [cursor]);

  const open = (id: number, newTab = false) => {
    const s = app.session;
    const n = s && untracked(() => s.data.pool.model('Notification').get(id));
    if (!n) return;
    const issue = untracked(() => s.data.pool.model('Issue').get(n.data.issue_id));
    const path = issue && issuePath(app, issue);
    // Opening it is reading it (Linear); a pinned one stays pinned.
    setStatus(app, [id], (st) => (st === 'unread' ? 'read' : undefined));
    if (!path) return;
    if (newTab) window.open(`${app.config.app_sub_url}${path}`, '_blank', 'noopener');
    else void navigate({to: path});
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
  /** Triage keeps the cursor moving: after E/U/pin on the cursor's row, J goes on from there. */
  const triage = (to: (st: string) => 'read' | 'unread' | 'pinned' | undefined) => () => {
    // Without a cursor (from the palette, before J): the first row, which then has the cursor.
    let targets = cursor.targets();
    if (!targets.length && ids[0] !== undefined) {
      cursor.setActive(ids[0]);
      targets = [ids[0]];
    }
    setStatus(app, targets, to);
  };
  useShortcutScope('list');
  useShortcut('list.next', () => {
    move(1);
  });
  useShortcut('list.prev', () => {
    move(-1);
  });
  useShortcut('list.select', () => {
    if (cursor.activeId !== undefined) cursor.selected.toggle(cursor.activeId);
  });
  useShortcut('inbox.read', triage((st) => (st === 'unread' ? 'read' : undefined)));
  useShortcut('inbox.unread', triage(() => 'unread'));
  useShortcut('inbox.pin', triage(togglePin));

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' && cursor.activeId !== undefined) {
      e.preventDefault();
      open(cursor.activeId, e.metaKey || e.ctrlKey);
    } else if (e.key === 'Escape' && untracked(() => cursor.selected.size)) {
      e.preventDefault();
      cursor.selected.clear();
    }
  };
  const handlers = useRef({open, cursor});
  handlers.current = {open, cursor};
  const [click] = useState(() => (id: number, e: {shiftKey: boolean; metaKey: boolean; ctrlKey: boolean}) => {
    const h = handlers.current;
    if (e.shiftKey) {
      h.cursor.selected.toggle(id);
      h.cursor.setActive(id);
      return;
    }
    h.cursor.setActive(id);
    h.open(id, e.metaKey || e.ctrlKey);
  });

  const items = virtualizer.getVirtualItems();
  const status = (id: number) => {
    const n = untracked(() => app.session?.data.pool.model('Notification').get(id));
    return n ? untracked(() => notificationStatus(editing(app).overlay, n)) : undefined;
  };
  const [menuId, setMenuId] = useState<number | undefined>();
  const menuStatus = menuId === undefined ? undefined : status(menuId);
  return (
    <ContextMenu onOpenChange={(o) => {
      if (!o) setMenuId(undefined);
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
          onContextMenuCapture={(e) => {
            const el = (e.target as Element).closest('[data-note]');
            const id = el ? Number(el.getAttribute('data-note')) : cursor.activeId;
            if (id === undefined) {
              e.preventDefault();
              return;
            }
            setMenuId(id);
            cursor.setActive(id);
          }}
          className="relative w-full outline-none"
          style={{height: virtualizer.getTotalSize()}}
        >
          {items.map((it) => {
            const r = rows[it.index];
            if (!r) return null;
            return (
              <div key={it.key} className="absolute inset-x-0 top-0" style={{transform: `translateY(${String(it.start)}px)`}}>
                {r.type === 'note' ?
                  <NoteRow id={r.id} cursor={cursor} onClick={click}/> :
                  <ListGroupHeader leading={r.key === 'pinned' ? <Icon icon={Pin}/> : r.key.startsWith('repo:') ? <Icon icon={FolderGit2}/> : null} label={r.label} count={r.count}/>}
              </div>
            );
          })}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {menuId !== undefined && (
          <>
            <ContextMenuItem icon={ExternalLink} shortcut={formatKeys('enter')} onSelect={() => {
              open(menuId);
            }}>Open</ContextMenuItem>
            <ContextMenuSeparator/>
            <ContextMenuItem icon={MailOpen} shortcut={shortcutHint('inbox.read')} disabled={menuStatus !== 'unread'} onSelect={() => {
              setStatus(app, [menuId], (st) => (st === 'unread' ? 'read' : undefined));
            }}>Mark read</ContextMenuItem>
            <ContextMenuItem icon={Mail} shortcut={shortcutHint('inbox.unread')} disabled={menuStatus === 'unread'} onSelect={() => {
              setStatus(app, [menuId], () => 'unread');
            }}>Mark unread</ContextMenuItem>
            <ContextMenuItem icon={Pin} shortcut={shortcutHint('inbox.pin')} onSelect={() => {
              setStatus(app, [menuId], togglePin);
            }}>{menuStatus === 'pinned' ? 'Unpin' : 'Pin'}</ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});

const NoteRow = observer(function NoteRow({id, cursor, onClick}: {id: number; cursor: ListCursor; onClick: (id: number, e: {shiftKey: boolean; metaKey: boolean; ctrlKey: boolean}) => void}) {
  const pool = usePool();
  const n = pool.model('Notification').get(id);
  if (!n) return <ListRow role="presentation"> </ListRow>;
  return <NoteRowBody n={n} cursor={cursor} onClick={onClick}/>;
});

const NoteRowBody = observer(function NoteRowBody({n, cursor, onClick}: {n: Entity<'Notification'>; cursor: ListCursor; onClick: (id: number, e: {shiftKey: boolean; metaKey: boolean; ctrlKey: boolean}) => void}) {
  const pool = usePool();
  const status = notificationStatus(useOverlay(), n);
  const issue = pool.model('Issue').get(n.get('issue_id'));
  const repo = pool.model('Repository').get(n.get('repo_id'));
  const unread = status === 'unread';
  const at = n.get('updated_at');
  return (
    <ListRow
      role="option"
      id={rowId(n.id)}
      data-note={n.id}
      active={cursor.active.has(n.id)}
      selected={cursor.selected.has(n.id)}
      onClick={(e) => {
        onClick(n.id, e);
      }}
      leading={<>
        <StatusDot tone="accent" off={!unread}/>
        {issue ? <StateIcon issue={issue}/> : <Icon icon={n.get('subject') === 'commit' ? GitCommitHorizontal : InboxIcon}/>}
      </>}
      trailing={<>
        {status === 'pinned' && <Icon icon={Pin} size="sm"/>}
        <span className="truncate">{repo?.get('full_name') ?? ''}{issue ? `#${String(issue.get('number'))}` : ''}</span>
        <AgoCell at={at}/>
      </>}
    >
      {(unread || status === 'pinned') && <span className="sr-only">{unread ? 'Unread: ' : 'Pinned: '}</span>}
      <span className={unread ? 'font-medium text-fg' : 'text-fg-muted'}>
        {issue ? <TitleCell issue={issue}/> : subjectWords(n.get('subject'))}
      </span>
    </ListRow>
  );
});

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
