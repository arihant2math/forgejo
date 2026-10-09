// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A virtualized issue list (TanStack Virtual) over an IssueListModel.
//
// Rendering: fixed-height rows (ListRow's h-row; group headers too), so
// nothing is measured; only the rows in view (plus overscan) exist, each a
// memoized observer that takes ids and stable references, and whose cells
// observe their own fields (cells.tsx). Scrolling renders the rows that come
// into view and nothing else; a delta re-renders one cell; the list itself
// re-renders only when the rows' order or membership changes.
//
// Keyboard (PLAN §5.6): J/K (and ↑/↓ while the list has focus) move the
// cursor, X selects, Enter opens, Esc clears the selection; S/L/A/M/P open
// the pickers for the selection, or the cursor's issue. The listbox keeps
// focus and points at the cursor with aria-activedescendant (rows come and
// go as they scroll). Right click / Shift+F10 opens the same actions as the
// palette.

import {useNavigate, useRouterState} from '@tanstack/react-router';
import {focusList, rememberedRow, rememberRow} from '../../app/listReturn.ts';
import {useVirtualizer} from '@tanstack/react-virtual';
import {CircleDashed, FolderGit2, User as UserIcon} from 'lucide-react';
import {autorun, runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type KeyboardEvent, type MouseEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {rememberListRows} from '../../app/boot.ts';
import {sitePath} from '../../app/config.ts';
import {pageListRect} from '../../app/shell/Frame.tsx';
import {shortcutHint, useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {type PickerKind, useApp} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import {editing} from '../../intents/session.ts';
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger, Icon, LabelIcon, ListGroupHeader, ListRow,
} from '../../ui/index.ts';
import {type IssueAction, issueActions, openPicker} from './actions.ts';
import {
  AssigneesCell, DueCell, LabelsCell, PendingCell, PinCell, priorityIcon, PriorityCell, PullStateCell, statusIcon, StatusCell, TitleCell, UpdatedCell, UserAvatar,
  usePool,
} from './cells.tsx';
import {issuePath, issuesOf} from './edits.ts';
import type {ListCursor} from './flags.ts';
import type {IssueListModel} from './list.ts';
import type {Row} from './query.ts';

const ROW = 32; // ListRow's h-row (tokens.css --spacing-row)

export interface IssueListProps {
  model: IssueListModel;
  /** The page's scroll container (PageBody); null until it is mounted. */
  scroller: HTMLDivElement | null;
  /** Shown when no row matches. */
  empty: ReactNode;
  /** Name the repository in each row (lists across repositories). */
  showRepo?: boolean | undefined;
  /** Told whether the rows in view are near the end of the list (load more). */
  onNearEnd?: ((near: boolean) => void) | undefined;
  /** Accessible name of the list. */
  label: string;
}

export const IssueList = observer(function IssueList({model, scroller, empty, showRepo = false, onNearEnd, label}: IssueListProps) {
  const app = useApp();
  const navigate = useNavigate();
  const {rows} = model.result.get();
  const cursor = model.cursor;
  const listRef = useRef<HTMLDivElement>(null);
  const [menuIds, setMenuIds] = useState<number[]>([]);

  const hasRows = rows.length > 0;
  // Stable while the rows are (the virtualizer re-measures when it changes).
  const getItemKey = useCallback((i: number) => {
    const r = rows[i];
    return r ? (r.type === 'issue' ? r.id : `g:${r.key}`) : i;
  }, [rows]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller,
    ...pageListRect(),
    estimateSize: () => ROW,
    // As the inbox: rendered with the next frame, not synchronously in each scroll event.
    useFlushSync: false,
    overscan: 4,
    getItemKey,
  });

  // The splash's skeleton rows for the next boot on this page.
  const visible = Math.min(rows.length, 40);
  useEffect(() => {
    rememberListRows(visible);
  }, [visible]);

  // The cursor and the selection stay on listed issues (closing or filtering one out drops it), so actions
  // never reach rows the user cannot see; the keyboard's targets go to the palette.
  const {ids} = model.result.get();
  useLayoutEffect(() => {
    cursor.keep(new Set(ids));
  }, [ids, cursor]);
  useEffect(() => autorun(() => {
    const sel = cursor.selected.values();
    const active = cursor.active.values();
    const target = sel.length ? sel : active;
    runInAction(() => {
      app.ui.issueTarget = target;
    });
  }), [app, cursor]);
  useEffect(() => () => {
    runInAction(() => {
      app.ui.issueTarget = [];
    });
  }, [app]);
  // The listbox points at the cursor's row (set here: the list itself does not re-render when the cursor moves).
  useEffect(() => autorun(() => {
    const [id] = cursor.active.values();
    const el = listRef.current;
    if (!el) return;
    if (id === undefined) el.removeAttribute('aria-activedescendant');
    else el.setAttribute('aria-activedescendant', rowId(id));
  }), [cursor, hasRows]);

  const items = virtualizer.getVirtualItems();
  const last = items.at(-1)?.index ?? 0;
  useEffect(() => {
    onNearEnd?.(rows.length > 0 && last >= rows.length - 15);
  }, [last, rows.length, onNearEnd]);

  const here = useRouterState({select: (st) => st.location.pathname});
  const open = (id: number, newTab = false) => {
    const issue = untracked(() => app.session?.data.pool.model('Issue').get(id));
    const path = issue && issuePath(app, issue);
    if (!path) return;
    if (newTab) window.open(sitePath(app.config, path), '_blank', 'noopener');
    else {
      rememberRow(here, id);
      void navigate({to: path});
    }
  };
  // Back on this list (Esc, Back, a breadcrumb): the cursor on the issue the user came from, and the focus.
  useLayoutEffect(() => {
    const back = rememberedRow(here);
    if (typeof back !== 'number' || cursor.activeId !== undefined) return;
    const at = untracked(() => model.result.get().rows.findIndex((r) => r.type === 'issue' && r.id === back));
    if (at < 0) return;
    cursor.setActive(back);
    virtualizer.scrollToIndex(at, {align: 'auto'});
    focusList(listRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the rows are there
  }, [hasRows]);
  const move = (delta: number) => {
    const ids = rows.filter((r): r is Extract<Row, {type: 'issue'}> => r.type === 'issue').map((r) => r.id);
    if (!ids.length) return;
    const at = cursor.activeId === undefined ? -1 : ids.indexOf(cursor.activeId);
    const next = ids[at < 0 ? (delta > 0 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, at + delta))];
    if (next === undefined) return;
    cursor.setActive(next);
    const index = rows.findIndex((r) => r.type === 'issue' && r.id === next);
    virtualizer.scrollToIndex(index, {align: 'auto'});
    listRef.current?.focus({preventScroll: true});
  };
  const picker = (kind: PickerKind) => () => {
    openPicker(app, kind, cursor.targets());
  };

  useShortcutScope('list');
  useShortcutScope('issue');
  useShortcut('list.next', () => {
    move(1);
  });
  useShortcut('list.prev', () => {
    move(-1);
  });
  useShortcut('list.select', () => {
    if (cursor.activeId !== undefined) cursor.selected.toggle(cursor.activeId);
  });
  // Enter and Esc also while nothing has the focus (back from an issue, a click on a notice).
  useShortcut('list.open', () => {
    if (cursor.activeId === undefined) return;
    open(cursor.activeId);
  }, true, () => cursor.activeId !== undefined);
  useShortcut('list.clear', () => {
    cursor.selected.clear();
  }, true, () => untracked(() => cursor.selected.size) > 0);
  useShortcut('issue.state', picker('status'));
  useShortcut('issue.labels', picker('labels'));
  useShortcut('issue.assignee', picker('assignees'));
  useShortcut('issue.milestone', picker('milestone'));
  useShortcut('issue.priority', picker('priority'));

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

  // Rows call back through refs: their props stay the same objects across renders.
  const handlers = useRef<RowHandlers>(undefined as unknown as RowHandlers);
  handlers.current = {
    click: (id, e) => {
      if (e.shiftKey) {
        cursor.selectRange(id, ids);
        return;
      }
      if (e.metaKey || e.ctrlKey) {
        open(id, true);
        return;
      }
      cursor.setActive(id);
      open(id);
    },
    aux: (id, e) => {
      if (e.button === 1) {
        e.preventDefault();
        open(id, true);
      }
    },
  };
  const [stable] = useState<RowHandlers>(() => ({
    click: (id, e) => {
      handlers.current.click(id, e);
    },
    aux: (id, e) => {
      handlers.current.aux(id, e);
    },
  }));

  if (!rows.length) return <>{empty}</>;

  const actions: IssueAction[] = menuIds.length ? issueActions(app, issuesOf(app, menuIds), {navigate: (path) => void navigate({to: path})}) : [];
  return (
    <ContextMenu onOpenChange={(o) => {
      if (!o) setMenuIds([]);
    }}>
      <ContextMenuTrigger asChild>
        <div
          ref={listRef}
          role="listbox"
          aria-label={label}
          aria-multiselectable
          data-shortcuts
          tabIndex={0}
          onKeyDown={onKeyDown}
          onFocus={(e) => {
            // Focus arriving by keyboard (Tab) puts the cursor on the first row in view: focus always shows.
            if (e.target !== e.currentTarget || cursor.activeId !== undefined) return;
            const first = items.map((it) => rows[it.index]).find((r) => r?.type === 'issue');
            if (first?.type === 'issue') cursor.setActive(first.id);
          }}
          onContextMenuCapture={(e) => {
            const el = (e.target as Element).closest('[data-issue]');
            const id = el ? Number(el.getAttribute('data-issue')) : cursor.activeId;
            if (id === undefined) return;
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
              <div key={it.key} className="absolute inset-x-0 top-0" style={{transform: `translateY(${String(it.start)}px)`}}>
                {r.type === 'issue' ?
                  <IssueRow id={r.id} cursor={cursor} handlers={stable} showRepo={showRepo}/> :
                  <GroupRow row={r}/>}
              </div>
            );
          })}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {actions.map((a, i) => (
          <MenuAction key={a.id} action={a} separator={i > 0 && (a.id === 'copy-link' || a.id === 'state')}/>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
});

function MenuAction({action, separator}: {action: IssueAction; separator: boolean}) {
  return (
    <>
      {separator && <ContextMenuSeparator/>}
      <ContextMenuItem icon={action.icon} shortcut={action.shortcut && shortcutHint(action.shortcut)} onSelect={() => {
        action.run();
      }}>{action.label}</ContextMenuItem>
    </>
  );
}

interface RowHandlers {
  click(id: number, e: MouseEvent): void;
  aux(id: number, e: MouseEvent): void;
}

const rowId = (id: number) => `issue-row-${String(id)}`;

const IssueRow = observer(function IssueRow({id, cursor, handlers, showRepo}: {id: number; cursor: ListCursor; handlers: RowHandlers; showRepo: boolean}) {
  const app = useApp();
  const pool = usePool();
  // An issue created on this device and not synced yet is in the overlay (temporary, negative id).
  const issue = pool.model('Issue').get(id) ?? (id < 0 ? editing(app).overlay.createdEntity('Issue', id) as Entity<'Issue'> | undefined : undefined);
  // A real link: middle-click, ⌘-click and "open in a new tab" are the browser's own; a plain click opens it here.
  const path = issue && issuePath(app, issue);
  const active = cursor.active.has(id);
  const selected = cursor.selected.has(id);
  if (!issue) return <ListRow role="presentation"> </ListRow>;
  return (
    <ListRow
      role="option"
      id={rowId(id)}
      data-issue={id}
      active={active}
      selected={selected}
      href={path ? sitePath(app.config, path) : undefined}
      tabIndex={-1}
      onClick={(e) => {
        if (path && (e.metaKey || e.ctrlKey) && !e.shiftKey) return;
        e.preventDefault();
        handlers.click(id, e);
      }}
      onAuxClick={(e) => {
        if (!path) handlers.aux(id, e);
      }}
      leading={<><PriorityCell issue={issue}/><StatusCell issue={issue}/></>}
      // Labels give way first on a narrow list (the title keeps its room).
      trailing={<>
        <PinCell issue={issue}/>
        <PullStateCell issue={issue}/>
        <span className="flex items-center gap-2 @max-lg:hidden"><LabelsCell issue={issue}/></span>
        <DueCell issue={issue}/><AssigneesCell issue={issue}/><UpdatedCell issue={issue}/>
      </>}
    >
      <span className={showRepo ? 'mr-2 text-fg-subtle tabular-nums' : 'mr-2 inline-block min-w-12 text-fg-subtle tabular-nums'}>
        {id < 0 ? 'New' : showRepo ? <RepoRef repoId={issue.get('repo_id')} number={issue.get('number')}/> : `#${String(issue.get('number'))}`}
      </span>
      <TitleCell issue={issue}/> <PendingCell issueId={issue.id}/>
    </ListRow>
  );
});

const RepoRef = observer(function RepoRef({repoId, number}: {repoId: number; number: number}) {
  const name = usePool().model('Repository').get(repoId)?.get('name');
  return <>{name ?? ''}#{number}</>;
});

const GroupRow = observer(function GroupRow({row}: {row: Extract<Row, {type: 'group'}>}) {
  const pool = usePool();
  let leading: ReactNode = null;
  if ((row.kind === 'status' || row.kind === 'priority') && row.value) {
    const l = pool.model('Label').get(row.value);
    if (l) leading = <LabelIcon icon={row.kind === 'status' ? statusIcon(l.get('name')) : priorityIcon(l.get('name'))} color={l.get('color')}/>;
  } else if (row.kind === 'status') {
    leading = <Icon icon={CircleDashed}/>;
  } else if (row.kind === 'assignee') {
    leading = row.value ? <UserAvatar id={row.value}/> : <Icon icon={UserIcon}/>;
  } else if (row.kind === 'repo') {
    leading = <Icon icon={FolderGit2}/>;
  }
  return <ListGroupHeader leading={leading} label={row.label} count={row.count}/>;
});
