// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A project board's live state: the layout (board.ts) over the pool and the
// overlay, recomputed at most once a frame when something of the board
// changes (its columns, its cards, its cards' issues) and at once when a
// pending move changes. Each column reads its own card list through a
// computed with structural equality, so a move re-renders the two columns
// concerned, not the board.

import {computed, createAtom, type IComputedValue, runInAction, untracked} from 'mobx';
import type {App} from '../../app/store.ts';
import type {Pool} from '../../data/pool.ts';
import type {Overlay} from '../../intents/overlay.ts';
import {editing} from '../../intents/session.ts';
import type {ProjectColumn} from '../../protocol/types.gen.ts';
import {ListCursor} from '../issues/flags.ts';
import {type BoardLayout, boardLayout, findCard, type Move, moveTo} from './board.ts';

const sameIds = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export class BoardModel {
  readonly projectId: number;
  readonly layout: IComputedValue<BoardLayout>;
  /** The keyboard cursor (a card's issue id). */
  readonly cursor = new ListCursor();
  private readonly app: App;
  private readonly pool: Pool;
  private readonly overlay: Overlay;
  private readonly rev = createAtom('board');
  private readonly columnCards = new Map<number, IComputedValue<readonly number[]>>();
  private scheduled = false;
  private disposed = false;
  private readonly off: () => void;
  /** The board's cards whose issue is not on this device (counted in the last layout). */
  hidden = 0;
  /** The last computation's duration (ms). */
  lastMs = 0;

  constructor(app: App, projectId: number) {
    const s = app.session;
    if (!s) throw new Error('a board needs a session');
    this.app = app;
    this.projectId = projectId;
    this.pool = s.data.pool;
    this.overlay = editing(app).overlay;
    this.off = this.pool.onApplied((changes) => {
      if (this.scheduled) return;
      const relevant = changes.some((c) => {
        if (c.model === 'ProjectColumn' || c.model === 'ProjectIssue') return true;
        // An issue of the board arriving or leaving (shown or not); its fields re-render its card alone.
        return c.model === 'Issue' && (!c.entity || untracked(() => [...this.pool.model('ProjectIssue').by('issue_id', c.id)].some((p) => p.data.project_id === projectId)));
      });
      if (!relevant) return;
      this.scheduled = true;
      requestAnimationFrame(() => {
        this.scheduled = false;
        if (!this.disposed) runInAction(() => {
          this.rev.reportChanged();
        });
      });
    });
    this.layout = computed(() => this.compute());
  }

  private compute(): BoardLayout {
    this.rev.reportObserved();
    const field = `~board:${String(this.projectId)}`;
    const moves = this.overlay.fieldOverrides('Issue', field) as Map<number, Move>;
    return untracked(() => {
      const t0 = performance.now();
      const issues = this.pool.model('Issue');
      const cards = [...this.pool.model('ProjectIssue').by('project_id', this.projectId)].map((p) => ({
        issueId: p.data.issue_id, column: p.data.column_id, sorting: p.data.sorting, id: p.id,
      }));
      let hidden = 0;
      for (const c of cards) if (!issues.get(c.issueId)) hidden++;
      const out = boardLayout([...this.pool.model('ProjectColumn').by('project_id', this.projectId)].map((e) => e.data), cards, moves, (id) => Boolean(issues.get(id)));
      this.hidden = hidden;
      this.lastMs = performance.now() - t0;
      try {
        performance.measure('board:layout', {start: t0, end: t0 + this.lastMs, detail: {cards: cards.length}});
      } catch {
        // No User Timing.
      }
      return out;
    });
  }

  /** The columns in order (observes the layout). */
  get columns(): ProjectColumn[] {
    return this.layout.get().columns;
  }

  /** One column's cards; observing it re-renders only when that column's order changes. */
  cards(columnId: number): readonly number[] {
    let c = this.columnCards.get(columnId);
    if (!c) {
      c = computed(() => this.layout.get().cards.get(columnId) ?? [], {equals: sameIds});
      this.columnCards.set(columnId, c);
    }
    return c.get();
  }

  /**
   * Moves a card to gap `gap` of `column` (gaps counted in the column as it
   * shows, the card included): an offline-capable intent (B9 card move).
   * Returns whether something was submitted.
   */
  move(issueId: number, column: number, gap: number): boolean {
    const layout = untracked(() => this.layout.get());
    const m = moveTo(layout, issueId, column, gap);
    const from = findCard(layout, issueId);
    const issue = untracked(() => this.pool.model('Issue').get(issueId)?.data);
    if (!m || !from || !issue) return false;
    editing(this.app).intents.submit({
      kind: 'board.move', issueId, repoId: issue.repo_id, projectId: this.projectId, columnId: m.column, position: m.position, baseColumn: from.column,
    });
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.off();
  }
}
