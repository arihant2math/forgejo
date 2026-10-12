// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {untracked} from 'mobx';
import {type MouseEvent, type RefObject, useEffect, useRef, useState} from 'react';
import {KeyedFlags} from '../issues/flags.ts';
import {BoardDnd} from './dnd.ts';
import type {BoardModel} from './model.ts';

export function useBoardDrag(model: BoardModel, boardRef: RefObject<HTMLDivElement | null>, editable: boolean, open: (issueId: number, newTab?: boolean) => void) {
  const [dragging] = useState(() => new KeyedFlags());
  const indicatorRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react/refs -- the initializer stores callbacks; pointer events read the refs
  const [dnd] = useState(() => new BoardDnd({
    board: () => boardRef.current,
    indicator: () => indicatorRef.current,
    count: (column) => untracked(() => model.cards(column).length),
    dragging: (id) => {
      dragging.replace(id === undefined ? [] : [id]);
    },
    drop: (issueId, target) => {
      model.move(issueId, target.column, target.gap);
    },
  }));
  useEffect(() => () => {
    dnd.dispose();
    model.dispose();
  }, [dnd, model]);
  // Cards call back through a ref: their props stay the same objects across renders.
  const actions = useRef({open, dnd, editable});
  // eslint-disable-next-line react/refs -- stable handlers read the latest actions only during pointer events
  actions.current = {open, dnd, editable};
  const [cardHandlers] = useState(() => ({
    click: (id: number, e: MouseEvent<HTMLElement>) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && actions.current.dnd.click()) return;
      e.preventDefault();
      if (!actions.current.dnd.click()) return;
      model.cursor.setActive(id);
      actions.current.open(id);
    },
    down: (id: number, e: PointerEvent) => {
      if (actions.current.editable) actions.current.dnd.down(e, id);
    },
  }));
  return {dragging, indicatorRef, cardHandlers};
}
