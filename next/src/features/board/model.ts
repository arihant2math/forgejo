// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A project board's live state: the layout (board.ts) over the pool and the
// overlay, recomputed at most once a frame when something of the board
// changes (its columns, its cards, its cards' issues arriving or leaving) and at once when a
// pending move changes. Each column reads its own card list through a
// computed with structural equality, so a move re-renders the two columns
// concerned, not the board.

import {computed, createAtom, type IComputedValue, runInAction, untracked} from 'mobx';
import type {App} from '../../app/store.ts';
import {notify} from '../../app/notices.ts';
import type {Applied, Pool} from '../../data/pool.ts';
import type {Overlay} from '../../intents/overlay.ts';
import {PROJECT_FIELD} from '../../intents/intents.ts';
import {editing} from '../../intents/session.ts';
import type {ProjectColumn} from '../../protocol/types.gen.ts';
import {ListCursor} from '../issues/flags.ts';
import {type BoardLayout, boardLayout, findCard, type Move, moveTo} from './board.ts';

const sameColumns = (a: readonly ProjectColumn[], b: readonly ProjectColumn[]) => a.length === b.length && a.every((x, i) => x === b[i]);
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
  /** What the last layout held: this board's column and card (ProjectIssue) ids, the issues it showed. */
  private columnIds = new Set<number>();
  private cardIds = new Set<number>();
  private shown = new Set<number>();
  private readonly columnList: IComputedValue<ProjectColumn[]>;
  private readonly hiddenValue: IComputedValue<number>;
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
      if (this.scheduled || !changes.some((c) => this.concerns(c))) return;
      this.scheduled = true;
      requestAnimationFrame(() => {
        this.scheduled = false;
        if (!this.disposed) runInAction(() => {
          this.rev.reportChanged();
        });
      });
    });
    this.layout = computed(() => this.compute());
    this.columnList = computed(() => this.layout.get().columns, {equals: sameColumns});
    this.hiddenValue = computed(() => {
      this.layout.get();
      return this.hidden;
    });
  }

  /**
   * Whether an applied change can change the layout: this board's columns and
   * cards, and its cards' issues arriving or leaving. A field of a card's
   * issue (its title, labels) re-renders that card alone (its observers);
   * another board's changes nothing.
   */
  private concerns(c: Applied): boolean {
    const d = c.entity?.data as {project_id?: number} | undefined;
    switch (c.model) {
      case 'ProjectColumn':
        return d ? d.project_id === this.projectId : this.columnIds.has(c.id);
      case 'ProjectIssue':
        return d ? d.project_id === this.projectId : this.cardIds.has(c.id);
      case 'Issue':
        // Left (or arrived on the board: its ProjectIssue says so, and it was not shown).
        if (!c.entity) return this.shown.has(c.id);
        return !this.shown.has(c.id) && untracked(() => [...this.pool.model('ProjectIssue').by('issue_id', c.id)].some((p) => p.data.project_id === this.projectId));
      default:
        return false;
    }
  }

  private compute(): BoardLayout {
    this.rev.reportObserved();
    const field = `~board:${String(this.projectId)}`;
    const moves = this.overlay.fieldLayers('Issue', field) as [number, Move][];
    // Issues put on a board or taken off it and not synced yet (issue.project): the last one per issue counts.
    const placed = new Map(this.overlay.fieldLayers('Issue', PROJECT_FIELD) as [number, {project: number; column: number}][]);
    return untracked(() => {
      const t0 = performance.now();
      const issues = this.pool.model('Issue');
      const cards = [...this.pool.model('ProjectIssue').by('project_id', this.projectId)]
        .filter((p) => (placed.get(p.data.issue_id)?.project ?? this.projectId) === this.projectId).map((p) => ({
          issueId: p.data.issue_id, column: p.data.column_id, sorting: p.data.sorting, id: p.id,
        }));
      const on = new Set(cards.map((c) => c.issueId));
      // A pending addition goes to the end of its column (as Forgejo puts it), after every synced card.
      for (const [issueId, p] of placed) {
        if (p.project === this.projectId && !on.has(issueId)) cards.push({issueId, column: p.column, sorting: Number.MAX_SAFE_INTEGER, id: Number.MAX_SAFE_INTEGER});
      }
      let hidden = 0;
      for (const c of cards) if (!issues.get(c.issueId)) hidden++;
      const columns = [...this.pool.model('ProjectColumn').by('project_id', this.projectId)].map((e) => e.data);
      const out = boardLayout(columns, cards, moves, (id) => Boolean(issues.get(id)));
      this.columnIds = new Set(columns.map((c) => c.id));
      this.cardIds = new Set(cards.map((c) => c.id));
      this.shown = new Set([...out.cards.values()].flat());
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

  /** The board's cards not on this device (observing it reacts to the count changing). */
  get hiddenCount(): number {
    return this.hiddenValue.get();
  }

  /** The columns in order; observing it reacts to the columns changing, not to card moves. */
  get columns(): ProjectColumn[] {
    return this.columnList.get();
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
  move(issueId: number, column: number, gap: number, say = true): boolean {
    const layout = untracked(() => this.layout.get());
    const m = moveTo(layout, issueId, column, gap);
    const from = findCard(layout, issueId);
    const issue = untracked(() => this.pool.model('Issue').get(issueId)?.data);
    if (!m || !from || !issue) return false;
    editing(this.app).intents.submit({
      kind: 'board.move', issueId, repoId: issue.repo_id, projectId: this.projectId, columnId: m.column, position: m.position, baseColumn: from.column,
    });
    // To another column (by key, menu or drag): said, with Undo (and ⌘Z) back to where it was.
    if (say && m.column !== from.column) {
      const title = layout.columns.find((c) => c.id === m.column)?.title ?? 'another column';
      notify(this.app, {tone: 'neutral', title: `#${String(issue.number)} moved to “${title}”`, series: 'board.move', action: {label: 'Undo', run: () => {
        this.move(issueId, from.column, from.index, false);
      }}});
    }
    return true;
  }

  /**
   * Where a card goes in another column so that it keeps its rank (Linear's): after the cards that came before
   * it on the server (sorting). Moving it there and back puts it where it was.
   */
  rankIn(issueId: number, column: number): number {
    const layout = untracked(() => this.layout.get());
    const list = layout.cards.get(column) ?? [];
    const sortOf = (id: number) => untracked(() => [...this.pool.model('ProjectIssue').by('issue_id', id)].find((p) => p.data.project_id === this.projectId)?.data.sorting);
    const mine = sortOf(issueId);
    if (mine === undefined) return list.length;
    const at = list.findIndex((id) => (sortOf(id) ?? Number.MAX_SAFE_INTEGER) > mine);
    return at < 0 ? list.length : at;
  }

  dispose(): void {
    this.disposed = true;
    this.off();
  }
}
