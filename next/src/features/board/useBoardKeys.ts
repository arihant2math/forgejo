// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useNavigate, useSearch} from '@tanstack/react-router';
import {autorun, runInAction, untracked} from 'mobx';
import {type KeyboardEvent, type RefObject, useCallback, useEffect, useRef, useState} from 'react';
import {openCreate} from '../../app/create.ts';
import {notify} from '../../app/notices.ts';
import {connectivity} from '../../app/online.ts';
import {useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import type {PickerKind, useApp} from '../../app/store.ts';
import {openPicker} from '../issues/actions.ts';
import {issuePath} from '../issues/edits.ts';
import {findCard} from './board.ts';
import type {ColumnDialogState} from './ColumnControls.tsx';
import {newIssueIn} from './create.ts';
import type {BoardModel} from './model.ts';

/** Preserve the active card across navigation, per tab. */
const lastCard = new Map<number, number>();

export interface ColumnHandle {
  focus(): void;
  scrollTo(index: number): void;
}

export function useBoardKeys({app, model, projectId, editable, readOnlyReason, boardRef}: {
  app: ReturnType<typeof useApp>; model: BoardModel; projectId: number; editable: boolean; readOnlyReason: string;
  boardRef: RefObject<HTMLDivElement | null>;
}) {
  const navigate = useNavigate();
  const handles = useRef(new Map<number, ColumnHandle>());
  const activeColumn = useRef<number | undefined>(undefined);
  const register = useCallback((id: number, h: ColumnHandle | undefined) => {
    if (h) handles.current.set(id, h);
    else handles.current.delete(id);
  }, []);
  const [menuCard, setMenuCard] = useState<number | undefined>();
  const menuAnchor = useRef<HTMLSpanElement>(null);
  const menuReturnFocus = useRef<HTMLElement>(null);
  const [menuPoint, setMenuPoint] = useState({x: 0, y: 0});
  const openCardMenu = (id: number, target: HTMLElement, x = 0, y = 0) => {
    const list = target.closest('[data-column]')?.querySelector<HTMLElement>('[role="listbox"]');
    menuReturnFocus.current = list ?? target;
    const rect = target.closest('[data-card]')?.getBoundingClientRect() ?? target.getBoundingClientRect();
    setMenuPoint(x || y ? {x, y} : {x: rect.left, y: rect.top});
    model.cursor.setActive(id);
    setMenuCard(id);
  };

  useEffect(() => autorun(() => {
    const target = model.cursor.active.values();
    if (target[0] !== undefined) lastCard.set(projectId, target[0]);
    runInAction(() => {
      app.ui.issueTarget = target;
    });
  }), [app, model, projectId]);
  // Wait for on-demand cards before restoring the requested or remembered cursor.
  const asked = useSearch({strict: false, select: (s: {card?: number}) => s.card});
  const placed = useRef(false);
  useEffect(() => autorun(() => {
    if (placed.current) return;
    const layout = model.layout.get();
    const id = asked ?? lastCard.get(projectId) ?? layout.columns.map((c) => layout.cards.get(c.id)?.[0]).find((card) => card !== undefined);
    if (id === undefined) {
      if (layout.columns[0]) {
        placed.current = true;
        focusColumn(layout.columns[0].id);
      }
      return;
    }
    if (model.cursor.activeId !== undefined) return;
    if (findCard(model.layout.get(), id)) {
      placed.current = true;
      untracked(() => {
        show(id);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the card is there
  }), [asked]);
  useEffect(() => () => {
    runInAction(() => {
      app.ui.issueTarget = [];
    });
  }, [app]);

  const open = (issueId: number, newTab = false) => {
    const issue = untracked(() => app.session?.data.pool.model('Issue').get(issueId));
    const path = issue && issuePath(app, issue);
    if (!path) return;
    if (newTab) window.open(`${app.config.app_sub_url}${path}`, '_blank', 'noopener');
    else void navigate({to: path});
  };
  const show = (issueId: number) => {
    activeColumn.current = findCard(untracked(() => model.layout.get()), issueId)?.column;
    model.cursor.setActive(issueId);
    // Wait for the moved card's column to render before focusing it.
    requestAnimationFrame(() => {
      const at = findCard(untracked(() => model.layout.get()), issueId);
      if (!at) return;
      const h = handles.current.get(at.column);
      h?.scrollTo(at.index);
      h?.focus();
      boardRef.current?.querySelector(`[data-column="${String(at.column)}"]`)?.scrollIntoView({block: 'nearest', inline: 'nearest'});
    });
  };
  const here = () => {
    const id = model.cursor.activeId;
    const layout = untracked(() => model.layout.get());
    return id === undefined ? undefined : {id, at: findCard(layout, id), layout};
  };
  const step = (dCol: number, dRow: number) => {
    const layout = untracked(() => model.layout.get());
    const cur = here();
    if (!cur?.at && activeColumn.current === undefined) {
      const first = layout.columns.map((c) => layout.cards.get(c.id)?.[0]).find((x) => x !== undefined);
      if (first !== undefined) show(first);
      return;
    }
    const column = cur?.at?.column ?? activeColumn.current;
    const ci = layout.columns.findIndex((c) => c.id === column);
    if (dCol) {
      const target = layout.columns[ci + dCol];
      if (!target) return;
      const list = layout.cards.get(target.id) ?? [];
      const next = list[Math.min(cur?.at?.index ?? 0, list.length - 1)];
      if (next !== undefined) show(next);
      else {
        model.cursor.setActive(undefined);
        focusColumn(target.id);
      }
      return;
    }
    const list = layout.cards.get(column ?? 0) ?? [];
    const next = list[Math.max(0, Math.min(list.length - 1, (cur?.at?.index ?? -1) + dRow))];
    if (next !== undefined) show(next);
  };
  const shift = (dCol: number, dRow: number) => {
    if (!editable) {
      notify(app, {tone: 'neutral', title: 'You can view this board, not change it', description: readOnlyReason, series: 'board.readonly'});
      return;
    }
    const cur = here();
    if (!cur?.at) return;
    const {layout, at} = cur;
    if (dCol) {
      const ci = layout.columns.findIndex((c) => c.id === at.column);
      const col = layout.columns[ci + dCol];
      if (!col) return;
      model.move(cur.id, col.id, model.rankIn(cur.id, col.id));
    } else {
      // Gaps: one below the card is index + 2, one above is index - 1.
      model.move(cur.id, at.column, dRow > 0 ? at.index + 2 : at.index - 1);
    }
    show(cur.id);
  };
  const pick = (kind: PickerKind) => () => {
    const id = model.cursor.activeId;
    if (id !== undefined) openPicker(app, kind, [id]);
  };
  // Register the board innermost so H/L override issue-label shortcuts.
  useShortcutScope('list');
  useShortcutScope('issue');
  useShortcutScope('board');
  useShortcut('list.next', () => {
    step(0, 1);
  });
  useShortcut('list.prev', () => {
    step(0, -1);
  });
  useShortcut('board.left', () => {
    step(-1, 0);
  });
  useShortcut('board.right', () => {
    step(1, 0);
  });
  const canShift = (dCol: number, dRow: number) => () => {
    const cur = untracked(here);
    if (!cur?.at) return false;
    if (!editable) return true; // the key says why it moves nothing
    const {layout, at} = cur;
    if (dCol) {
      const ci = layout.columns.findIndex((c) => c.id === at.column);
      return layout.columns[ci + dCol] !== undefined;
    }
    const n = layout.cards.get(at.column)?.length ?? 0;
    return dRow > 0 ? at.index < n - 1 : at.index > 0;
  };
  useShortcut('board.moveDown', () => {
    shift(0, 1);
  }, true, canShift(0, 1));
  useShortcut('board.moveUp', () => {
    shift(0, -1);
  }, true, canShift(0, -1));
  useShortcut('board.moveLeft', () => {
    shift(-1, 0);
  }, true, canShift(-1, 0));
  useShortcut('board.moveRight', () => {
    shift(1, 0);
  }, true, canShift(1, 0));
  useShortcut('issue.state', pick('status'));
  useShortcut('issue.labels', pick('labels'));
  useShortcut('issue.assignee', pick('assignees'));
  useShortcut('issue.milestone', pick('milestone'));
  useShortcut('issue.priority', pick('priority'));
  const [columnDialog, setColumnDialog] = useState<ColumnDialogState | undefined>();
  const [adding, setAdding] = useState(false);
  const [addTo, setAddTo] = useState<number>();
  useShortcut('board.removeCard', () => {
    const id = model.cursor.activeId;
    if (id !== undefined) model.setProject(id, 0, 0);
  }, editable, () => untracked(here)?.at !== undefined);
  const cursorColumn = () => untracked(here)?.at?.column ?? activeColumn.current;
  const columnOf = (id: number | undefined) => (id === undefined ? undefined : untracked(() => model.columns.find((c) => c.id === id)));
  useShortcut('board.addColumn', () => {
    setAdding(true);
  }, editable, () => connectivity.online);
  useShortcut('board.renameColumn', () => {
    const c = cursorColumn();
    if (c !== undefined) setColumnDialog({kind: 'rename', columnId: c});
  }, editable, () => connectivity.online && cursorColumn() !== undefined);
  useShortcut('board.deleteColumn', () => {
    const c = cursorColumn();
    if (c !== undefined) setColumnDialog({kind: 'delete', columnId: c});
  }, editable, () => connectivity.online && columnOf(cursorColumn())?.default === false);
  const focusColumn = (id: number | undefined) => {
    requestAnimationFrame(() => {
      const target = id ?? untracked(() => model.columns.find((c) => c.default)?.id ?? model.columns[0]?.id);
      if (target !== undefined) {
        activeColumn.current = target;
        handles.current.get(target)?.focus();
        boardRef.current?.querySelector(`[data-column="${String(target)}"]`)?.scrollIntoView({block: 'nearest', inline: 'nearest'});
      }
    });
  };
  useShortcut('create', () => {
    const layout = untracked(() => model.layout.get());
    const column = cursorColumn() ?? layout.columns.find((c) => c.default)?.id ?? layout.columns[0]?.id;
    if (column === undefined || !editable) openCreate(app);
    else newIssueIn(app, projectId, column);
  });

  const onKeyDown = (e: KeyboardEvent) => {
    // Only a column's own keys (not Enter in the new column's name field, or in a menu).
    if ((e.target as Element).getAttribute('role') !== 'listbox') return;
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      if (model.cursor.activeId !== undefined) {
        e.preventDefault();
        openCardMenu(model.cursor.activeId, e.target as HTMLElement);
      }
      return;
    }
    const arrows: Record<string, [number, number]> = {ArrowDown: [0, 1], ArrowUp: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0]};
    const dir = arrows[e.key];
    if (dir && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) shift(dir[0], dir[1]);
      else step(dir[0], dir[1]);
    } else if (e.key === 'Enter' && model.cursor.activeId !== undefined) {
      e.preventDefault();
      open(model.cursor.activeId, e.metaKey || e.ctrlKey);
    }
  };
  return {register, activeColumn, open, onKeyDown, focusColumn, menuCard, setMenuCard, menuAnchor, menuReturnFocus, menuPoint,
    openCardMenu, columnDialog, setColumnDialog, adding, setAdding, addTo, setAddTo};
}
