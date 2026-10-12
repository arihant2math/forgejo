// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Pool changes recompute layout at most once per frame; pending moves apply immediately.
// Structurally equal per-column lists prevent unrelated columns from re-rendering.

import {computed, createAtom, type IComputedValue, runInAction, untracked} from 'mobx';
import type {App} from '../../app/store.ts';
import {notify} from '../../app/notices.ts';
import type {Applied, Pool} from '../../data/pool.ts';
import type {Overlay} from '../../intents/overlay.ts';
import {boardField, PROJECT_FIELD} from '../../intents/intents.ts';
import {editing} from '../../intents/editing.ts';
import {issueProject} from '../../intents/view.ts';
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

  /** Issue field edits notify card observers; only arrivals/departures invalidate layout. */
  private concerns(c: Applied): boolean {
    const d = c.entity?.data as {project_id?: number} | undefined;
    switch (c.model) {
      case 'ProjectColumn':
        return d ? d.project_id === this.projectId : this.columnIds.has(c.id);
      case 'ProjectIssue':
        return d ? d.project_id === this.projectId : this.cardIds.has(c.id);
      case 'Issue':
        if (!c.entity) return this.shown.has(c.id);
        return !this.shown.has(c.id) && untracked(() => [...this.pool.model('ProjectIssue').by('issue_id', c.id)].some((p) => p.data.project_id === this.projectId));
      default:
        return false;
    }
  }

  private compute(): BoardLayout {
    this.rev.reportObserved();
    const moves = this.overlay.fieldLayers('Issue', boardField(this.projectId)) as [number, Move][];
    // Only the last pending project assignment per issue counts.
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
        // User Timing may be unavailable.
      }
      return out;
    });
  }

  get hiddenCount(): number {
    return this.hiddenValue.get();
  }

  /** The columns in order; observing it reacts to the columns changing, not to card moves. */
  get columns(): ProjectColumn[] {
    return this.columnList.get();
  }

  setProject(issueId: number, projectId: number, columnId: number): void {
    const issue = this.pool.model('Issue').get(issueId);
    if (!issue) return;
    const {intents, overlay} = editing(this.app);
    const before = issueProject(this.pool, overlay, issueId);
    intents.submit({kind: 'issue.project', issueId, repoId: issue.get('repo_id'), projectId, columnId, base: before.project});
    notify(this.app, {tone: 'neutral', title: projectId ? 'Issue added to board' : 'Card removed from board', action: {label: 'Undo', run: () => {
      intents.submit({kind: 'issue.project', issueId, repoId: issue.get('repo_id'), projectId: before.project, columnId: before.column, base: projectId});
    }}});
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

  /** Submit an offline-capable move to a gap counted with the card included. Returns whether submitted. */
  move(issueId: number, column: number, gap: number, say = true): boolean {
    const layout = untracked(() => this.layout.get());
    const m = moveTo(layout, issueId, column, gap);
    const from = findCard(layout, issueId);
    const issue = untracked(() => this.pool.model('Issue').get(issueId)?.data);
    if (!m || !from || !issue) return false;
    editing(this.app).intents.submit({
      kind: 'board.move', issueId, repoId: issue.repo_id, projectId: this.projectId, columnId: m.column, position: m.position, baseColumn: from.column,
    });
    if (say && m.column !== from.column) {
      const title = layout.columns.find((c) => c.id === m.column)?.title ?? 'another column';
      notify(this.app, {tone: 'neutral', title: `#${String(issue.number)} moved to “${title}”`, series: 'board.move', action: {label: 'Undo', run: () => {
        this.move(issueId, from.column, from.index, false);
      }}});
    }
    return true;
  }

  /** Keep server sorting rank across columns so moving there and back preserves placement. */
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
