// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Drag frames read geometry before writing transforms to avoid extra layout.
// Fixed card slots allow arithmetic hit tests without per-card measurements.
// Touch pointers scroll; use the menu or keyboard to move cards.

import {SLOT} from './geometry.ts';
/** The column body's top padding (pt-1). */
const PAD_TOP = 4;
/** The column body's side padding (px-2): the indicator spans the cards. */
const PAD_X = 8;
const START_DISTANCE = 4;
const EDGE = 48;
const SCROLL_STEP = 12;

export interface DropTarget {
  column: number;
  /** The gap (0 = above the first card) in the column as it shows, the dragged card included. */
  gap: number;
}

export interface DndHost {
  /** The board's horizontal scroller. */
  board(): HTMLElement | null;
  indicator(): HTMLElement | null;
  count(column: number): number;
  /** Marks the card being dragged (undefined: none). */
  dragging(issueId: number | undefined): void;
  drop(issueId: number, target: DropTarget): void;
}

interface Drag {
  issueId: number;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  /** The pointer's offset in the card. */
  offX: number;
  offY: number;
  card: HTMLElement;
  ghost: HTMLElement | undefined;
  target: DropTarget | undefined;
  frame: number;
}

export class BoardDnd {
  private drag: Drag | undefined;
  private suppressClick = false;
  private readonly host: DndHost;

  constructor(host: DndHost) {
    this.host = host;
  }

  get active(): boolean {
    return Boolean(this.drag?.ghost);
  }

  down(e: PointerEvent, issueId: number): void {
    if (e.button !== 0 || e.pointerType === 'touch' || e.ctrlKey || e.metaKey || e.shiftKey || this.drag) return;
    const card = e.currentTarget as HTMLElement;
    // A control inside the card is its own; the card itself is a link (an <a>) and drags.
    const control = (e.target as Element).closest('a,button,input');
    if (control && control !== card) return;
    const r = card.getBoundingClientRect();
    this.drag = {
      issueId, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY,
      offX: e.clientX - r.left, offY: e.clientY - r.top, card, ghost: undefined, target: undefined, frame: 0,
    };
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onCancel);
    window.addEventListener('keydown', this.onKey, true);
  }

  /** A card's click: false right after a drag (the drop is not an open). */
  click(): boolean {
    if (!this.suppressClick) return true;
    this.suppressClick = false;
    return false;
  }

  /** Stops a drag in progress (unmount). */
  dispose(): void {
    this.end(false);
  }

  private readonly onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (e.pointerId !== d?.pointerId) return;
    d.x = e.clientX;
    d.y = e.clientY;
    if (!d.ghost) {
      if (Math.hypot(d.x - d.startX, d.y - d.startY) < START_DISTANCE) return;
      this.start(d);
    }
    e.preventDefault();
    this.schedule();
  };

  private readonly onUp = (e: PointerEvent) => {
    if (e.pointerId !== this.drag?.pointerId) return;
    this.end(true);
  };

  private readonly onCancel = (e: PointerEvent) => {
    if (e.pointerId !== this.drag?.pointerId) return;
    this.end(false);
  };

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !this.drag) return;
    e.preventDefault();
    e.stopPropagation();
    this.end(false);
  };

  private start(d: Drag): void {
    const r = d.card.getBoundingClientRect();
    const ghost = d.card.cloneNode(true) as HTMLElement;
    ghost.removeAttribute('id');
    ghost.removeAttribute('data-dragging');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.classList.add('drag-layer', 'shadow-popover');
    ghost.style.width = `${String(r.width)}px`;
    document.body.append(ghost);
    d.ghost = ghost;
    document.getSelection()?.removeAllRanges();
    this.host.dragging(d.issueId);
  }

  private schedule(): void {
    const d = this.drag;
    if (!d || d.frame) return;
    d.frame = requestAnimationFrame(() => {
      d.frame = 0;
      this.frame(d);
    });
  }

  private frame(d: Drag): void {
    if (this.drag !== d || !d.ghost) return;
    // Reads first.
    const board = this.host.board();
    const columns = board ? [...board.querySelectorAll<HTMLElement>('[data-column]')] : [];
    let hit: {id: number; body: HTMLElement; rect: DOMRect} | undefined;
    let best = Number.POSITIVE_INFINITY;
    for (const col of columns) {
      const body = col.lastElementChild as HTMLElement | null;
      if (!body) continue;
      const rect = body.getBoundingClientRect();
      const dist = d.x < rect.left ? rect.left - d.x : d.x > rect.right ? d.x - rect.right : 0;
      if (dist < best) {
        best = dist;
        hit = {id: Number(col.dataset.column), body, rect};
      }
    }
    const boardRect = board?.getBoundingClientRect();
    if (!boardRect || d.x < boardRect.left || d.x > boardRect.right || d.y < boardRect.top || d.y > boardRect.bottom) hit = undefined;
    let scrollY = 0;
    let scrollX = 0;
    let target: DropTarget | undefined;
    let line: {x: number; y: number; width: number} | undefined;
    if (hit) {
      const {body, rect} = hit;
      const n = this.host.count(hit.id);
      const y = d.y - rect.top + body.scrollTop - PAD_TOP;
      const gap = Math.max(0, Math.min(n, Math.round(y / SLOT)));
      target = {column: hit.id, gap};
      line = {x: rect.left + PAD_X, y: rect.top + PAD_TOP + gap * SLOT - body.scrollTop - 5, width: rect.width - 2 * PAD_X};
      if (d.y < rect.top + EDGE && body.scrollTop > 0) scrollY = -SCROLL_STEP;
      else if (d.y > rect.bottom - EDGE && body.scrollTop + body.clientHeight < body.scrollHeight) scrollY = SCROLL_STEP;
      if (scrollY) body.scrollTop += scrollY;
    }
    if (board && boardRect) {
      if (d.x < boardRect.left + EDGE && board.scrollLeft > 0) scrollX = -SCROLL_STEP;
      else if (d.x > boardRect.right - EDGE && board.scrollLeft + board.clientWidth < board.scrollWidth) scrollX = SCROLL_STEP;
      if (scrollX) board.scrollLeft += scrollX;
    }
    d.target = target;
    d.ghost.style.transform = `translate3d(${String(d.x - d.offX)}px, ${String(d.y - d.offY)}px, 0)`;
    const ind = this.host.indicator();
    if (ind) {
      ind.hidden = !line;
      if (line) {
        ind.style.width = `${String(line.width)}px`;
        ind.style.transform = `translate3d(${String(line.x)}px, ${String(line.y)}px, 0)`;
      }
    }
    if (scrollX || scrollY) this.schedule();
  }

  private end(drop: boolean): void {
    const d = this.drag;
    if (!d) return;
    // The pointer's last position counts (a quick drop between frames).
    if (drop && d.ghost) this.frame(d);
    this.drag = undefined;
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onCancel);
    window.removeEventListener('keydown', this.onKey, true);
    if (d.frame) cancelAnimationFrame(d.frame);
    if (!d.ghost) return;
    d.ghost.remove();
    const ind = this.host.indicator();
    if (ind) ind.hidden = true;
    this.suppressClick = true;
    // A click that does not come (released outside the card) must not swallow the next one.
    setTimeout(() => {
      this.suppressClick = false;
    }, 0);
    this.host.dragging(undefined);
    if (drop && d.target) this.host.drop(d.issueId, d.target);
  }
}
