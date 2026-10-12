// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A virtualized issue list (TanStack Virtual) over an IssueListModel.
//
// Rendering: fixed-height feature rows (group headers too), so
// nothing is measured; only the rows in view (plus overscan) exist, each a
// memoized observer that takes ids and stable references, and whose cells
// observe their own fields (cells.tsx). Scrolling renders the rows that come
// into view and nothing else; a delta re-renders one cell; the list itself
// re-renders only when the rows' order or membership changes.
//
// Keyboard (PLAN §5.6): J/K (and ↑/↓ while the list has focus) move the
// cursor, X selects, Enter opens, Esc clears the selection; S/L/A/M/P open
// the pickers for the selection, or the cursor's issue. The pointer selects
// with a row's check box (shown on hover, and on every row once something is
// selected; Shift-click selects a range), and the list bar's selection
// actions do the same as the keys for it. The listbox keeps
// focus and points at the cursor with aria-activedescendant (rows come and
// go as they scroll). Right click / Shift+F10 opens the same actions as the
// palette.

import {useNavigate, useRouterState} from '@tanstack/react-router';
import {focusList, rememberedRow, rememberRow} from '../../app/listReturn.ts';
import {useVirtualizer} from '@tanstack/react-virtual';
import {autorun, runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type KeyboardEvent, type MouseEvent, type ReactNode, createElement, useCallback, useDeferredValue, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {rememberListRows} from '../../app/boot.ts';
import {sitePath} from '../../app/config.ts';
import {pageListRect} from '../../app/shell/Frame.tsx';
import {shortcutHint, useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {type PickerKind, useApp} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import {editing} from '../../intents/session.ts';
import {ActionMenu, ActionList, Checkbox, CounterLabel, Text} from '@primer/react';
import {IssueRowFrame} from './IssueRowFrame.tsx';
import {LabelGlyph} from './cells.tsx';
import {type IssueAction, issueActions, openPicker} from './actions.ts';
import {
  AssigneesCell, AuthorCell, DueCell, LabelsCell, PendingCell, PinCell, priorityIcon, PriorityCell, PullStateCell, statusIcon, StatusCell, TitleCell, UpdatedCell, UserAvatar,
  usePool,
} from './cells.tsx';
import {issuePath, issuesOf} from './edits.ts';
import type {ListCursor} from './flags.ts';
import type {IssueListModel} from './list.ts';
import type {Row} from './query.ts';
import {IssueDraftIcon, RepoIcon, PersonIcon} from '@primer/octicons-react';

const ROW = 40; // Fixed-height feature rows (h-10), including group headers.

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
  // MobX publishes synchronously; defer the row snapshot so filtering (especially clearing a search)
  // can mount the newly visible rows in interruptible React work instead of the input's task.
  const {rows, ids} = useDeferredValue(model.result.get());
  const cursor = model.cursor;
  const listRef = useRef<HTMLDivElement>(null);
  const [menuIds, setMenuIds] = useState<number[]>([]);
  const menuAnchorRef = useRef<HTMLElement>(null);

  const hasRows = rows.length > 0;
  // Stable while the rows are (the virtualizer re-measures when it changes).
  const getItemKey = useCallback((i: number) => {
    const r = rows[i];
    return r ? (r.type === 'issue' ? (r.copy === undefined ? r.id : `${String(r.id)}@${r.copy}`) : `g:${r.key}`) : i;
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
  // Selecting (something is selected): every row shows its check box (CSS: in-data-selecting).
  useEffect(() => autorun(() => {
    const on = cursor.selected.size > 0;
    listRef.current?.toggleAttribute('data-selecting', on);
  }), [cursor, hasRows]);
  useEffect(() => autorun(() => {
    const [id] = cursor.active.values();
    const el = listRef.current;
    if (!el) return;
    if (id === undefined) el.removeAttribute('aria-activedescendant');
    else el.setAttribute('aria-activedescendant', rowId(id));
  }), [cursor, hasRows]);

  const all = virtualizer.getVirtualItems();
  // A list's first render is its most expensive one (every row in view mounts: 70 ms at 1× for My issues, QA
  // verify3): the first commit shows the top rows, and the rest of the screen follows in a deferred render
  // React does in slices, so that no navigation holds the main thread for a long task.
  const complete = useDeferredValue(true, false);
  const items = complete ? all : all.slice(0, FIRST_ROWS);
  const last = items.at(-1)?.index ?? 0;
  useEffect(() => {
    onNearEnd?.(rows.length > 0 && last >= rows.length - 15);
  }, [last, rows.length, onNearEnd]);

  const here = useRouterState({select: (st) => st.location.pathname});
  const open = (id: number, newTab = false) => {
    const issue = untracked(() => app.session?.data.pool.model('Issue').get(id) ?? (id < 0 ? editing(app).overlay.createdEntity('Issue', id) as Entity<'Issue'> | undefined : undefined));
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
    // Each issue once (one with several assignees is listed under each; the cursor goes to where it is first).
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
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const id = cursor.activeId;
      if (id === undefined) return;
      menuAnchorRef.current = document.getElementById(rowId(id)) ?? listRef.current;
      const selected = untracked(() => cursor.selected.values());
      setMenuIds(selected.includes(id) ? selected : [id]);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
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
    check: (id, e) => {
      if (e.shiftKey) cursor.selectRange(id, ids);
      else {
        cursor.selected.toggle(id);
        cursor.setActive(id);
      }
      // The list keeps the focus (X, Esc and the pickers' keys go on from here).
      listRef.current?.focus({preventScroll: true});
    },
  };
  const [stable] = useState<RowHandlers>(() => ({
    click: (id, e) => {
      handlers.current.click(id, e);
    },
    aux: (id, e) => {
      handlers.current.aux(id, e);
    },
    check: (id, e) => {
      handlers.current.check(id, e);
    },
  }));

  if (!rows.length) return <>{empty}</>;

  const actions: IssueAction[] = menuIds.length ? issueActions(app, issuesOf(app, menuIds), {navigate: (path) => void navigate({to: path})}) : [];
  return (
    <>
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
            e.preventDefault();
            menuAnchorRef.current = el as HTMLElement | null ?? listRef.current;
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
              <div key={it.key} className="group absolute inset-x-0 top-0" style={{transform: `translateY(${String(it.start)}px)`}}>
                {r.type === 'issue' ?
                  <IssueRow id={r.id} copy={r.copy} cursor={cursor} handlers={stable} showRepo={showRepo}/> :
                  <GroupRow row={r}/>}
              </div>
            );
          })}
        </div>
      <ActionMenu open={menuIds.length > 0} anchorRef={menuAnchorRef} onOpenChange={(open) => {
        if (open) return;
        setMenuIds([]);
        requestAnimationFrame(() => {focusList(listRef.current);});
      }}>
      <ActionMenu.Overlay><ActionList>
        {actions.map((a, i) => (
          <MenuAction key={a.id} action={a} separator={i > 0 && (a.id === 'copy-link' || a.id === 'state')}/>
        ))}
      </ActionList></ActionMenu.Overlay></ActionMenu>
    </>
  );
});

function MenuAction({action, separator}: {action: IssueAction; separator: boolean}) {
  return (
    <>
      {separator && <ActionList.Divider/>}
      <ActionList.Item onSelect={action.run}>
        <ActionList.LeadingVisual>{createElement(action.icon)}</ActionList.LeadingVisual>{action.label}
        {action.shortcut && <ActionList.TrailingVisual>{shortcutHint(action.shortcut)}</ActionList.TrailingVisual>}
      </ActionList.Item>
    </>
  );
}

interface RowHandlers {
  click(id: number, e: MouseEvent): void;
  aux(id: number, e: MouseEvent): void;
  /** The row's check box: toggles the row in the selection (Shift: the range from the cursor). */
  check(id: number, e: MouseEvent): void;
}

/** Rows in a list's first commit (about half a screen; the rest renders right after). */
const FIRST_ROWS = 12;

const rowId = (id: number) => `issue-row-${String(id)}`;

const IssueRow = observer(function IssueRow({id, copy, cursor, handlers, showRepo}: {
  id: number; copy?: string | undefined; cursor: ListCursor; handlers: RowHandlers; showRepo: boolean;
}) {
  const app = useApp();
  const pool = usePool();
  // An issue created on this device and not synced yet is in the overlay (temporary, negative id).
  const issue = pool.model('Issue').get(id) ?? (id < 0 ? editing(app).overlay.createdEntity('Issue', id) as Entity<'Issue'> | undefined : undefined);
  // A real link: middle-click, ⌘-click and "open in a new tab" are the browser's own; a plain click opens it here.
  const path = issue && issuePath(app, issue);
  const active = cursor.active.has(id);
  const selected = cursor.selected.has(id);
  if (!issue) return <IssueRowFrame role="presentation" leading={null} trailing={null}> </IssueRowFrame>;
  return (
    <IssueRowFrame
      role="option"
      // The cursor points at an issue's first row (aria-activedescendant); its other rows have their own ids.
      id={copy === undefined ? rowId(id) : `${rowId(id)}-${copy}`}
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
      leading={<><SelectBox id={id} cursor={cursor} handlers={handlers}/><PriorityCell issue={issue}/><StatusCell issue={issue}/></>}
      // The trailing metadata reads right to left in fixed columns (age, author, then a pull request's checks slot
      // and its Draft/review badge), so they line up down the list; what varies in width (assignees, due date, pin)
      // sits left of them. On a phone the pin, due date, assignees and author give way: the row keeps its state and age.
      trailing={<>
        <span className="contents @max-md:hidden"><PinCell issue={issue}/><DueCell issue={issue}/><AssigneesCell issue={issue}/></span>
        <PullStateCell issue={issue} row/>
        <span className="contents @max-md:hidden"><AuthorCell issue={issue}/></span>
        <UpdatedCell issue={issue}/>
      </>}
    >
      <span className={showRepo ? 'shrink-0 text-sm text-muted tabular-nums' : 'inline-block min-w-12 shrink-0 text-sm text-muted tabular-nums @max-md:min-w-10'}>
        {id < 0 ? 'New' : showRepo ? <RepoRef repoId={issue.get('repo_id')} number={issue.get('number')}/> : `#${String(issue.get('number'))}`}
      </span>
      <TitleCell issue={issue} className="min-w-0 truncate font-semibold group-hover:text-accent group-hover:underline"/><PendingCell issueId={issue.id}/>
      {/* The labels follow the title they describe (GitHub's lists do), and give way first on a narrow list. */}
      <span data-row-labels className="flex shrink-0 items-center @max-lg:hidden"><LabelsCell issue={issue}/></span>
    </IssueRowFrame>
  );
});

/**
 * A row's check box, for the pointer (GitHub's, Linear's): hidden until the row is hovered, shown on every row
 * while something is selected (and always on a touch screen). Hidden from assistive technology: the row's
 * aria-selected says the same, and X toggles it.
 */
const SelectBox = observer(function SelectBox({id, cursor, handlers}: {id: number; cursor: ListCursor; handlers: RowHandlers}) {
  const on = cursor.selected.has(id);
  return (
    <span className={on ? 'inline-flex shrink-0' : 'invisible inline-flex shrink-0 group-hover:visible in-data-selecting:visible pointer-coarse:visible'}>
    <Checkbox aria-hidden tabIndex={-1} checked={on} data-select-row title={on ? 'Deselect (X)' : 'Select (X; Shift-click: a range)'}
      // The row does not take it as a click (open), and the list keeps the focus.
      onMouseDown={(e) => {
        e.preventDefault();
      }}
      onClick={(e) => {
        e.stopPropagation();
        handlers.check(id, e);
      }}
      readOnly/></span>
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
    if (l) leading = <LabelGlyph icon={row.kind === 'status' ? statusIcon(l.get('name')) : priorityIcon(l.get('name'))} color={l.get('color')}/>;
  } else if (row.kind === 'status') {
    leading = <IssueDraftIcon size={16} className="shrink-0"/>;
  } else if (row.kind === 'assignee') {
    leading = row.value ? <UserAvatar id={row.value}/> : <PersonIcon size={16} className="shrink-0"/>;
  } else if (row.kind === 'repo') {
    leading = <RepoIcon size={16} className="shrink-0"/>;
  }
  return <div className="flex h-10 items-center gap-2 border-b border-default bg-muted px-4">
    {leading}<Text as="h3" size="medium" weight="semibold" className="min-w-0 truncate">{row.label}</Text><CounterLabel>{row.count}</CounterLabel>
  </div>;
});
