// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {computed, createAtom, type IComputedValue, runInAction, untracked} from 'mobx';
import type {InboxSearch} from '../../app/search.ts';
import type {App} from '../../app/store.ts';
import type {Applied, Pool} from '../../data/pool.ts';
import type {Overlay} from '../../intents/overlay.ts';
import {KeyedFlags, ListCursor} from '../issues/flags.ts';
import {activityOf, type InboxResult, inboxRows} from './inbox.ts';
import {participates, reasonOf} from './reason.ts';
import {askServerReasons, serverReasons} from './serverReasons.ts';
import {knownSubject, subjectsKnown} from './subject.ts';

export class InboxModel {
  readonly cursor = new ListCursor();
  readonly hover = new KeyedFlags();
  menuFor: number | undefined;
  readonly result: IComputedValue<InboxResult>;
  /** Notification changes re-sort; changes to what rows show only recompute the rows. */
  private readonly notes = createAtom('inbox:notes');
  private readonly related = createAtom('inbox:related');
  private dirty = {notes: false, related: false};
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
      const notes = changes.some((c) => c.model === 'Notification');
      if (notes) askServerReasons(app, () => oldestNote(pool));
      const related = !notes && !this.dirty.related && untracked(() => changes.some((c) => this.concerns(c)));
      if (!notes && !related) return;
      this.dirty = {notes: this.dirty.notes || notes, related: this.dirty.related || related};
      if (this.scheduled) return;
      this.scheduled = true;
      requestAnimationFrame(() => {
        this.scheduled = false;
        const dirty = this.dirty;
        this.dirty = {notes: false, related: false};
        if (!this.disposed) runInAction(() => {
          if (dirty.notes) this.notes.reportChanged();
          if (dirty.related) this.related.reportChanged();
        });
      });
    });
    this.result = computed(() => this.compute(), {equals: (a, b) => a.rows.length === b.rows.length && a.rows.every((r, i) => {
      const o = b.rows[i];
      return r.type === 'note' ? o?.type === 'note' && o.id === r.id : o?.type === 'group' && o.key === r.key && o.count === r.count && o.label === r.label;
    })});
  }

  /** Whether a change can alter a listed notification's row: its issue, pull, reviews, comments, assignees, repository or the viewer. */
  private concerns(c: Applied): boolean {
    const notes = this.pool.model('Notification');
    switch (c.model) {
      case 'Issue':
        return notes.by('issue_id', c.id).size > 0;
      case 'PullRequest':
      case 'IssueAssignee':
      case 'Review':
      case 'Comment': {
        const issueId = (c.entity?.data as {issue_id?: number} | undefined)?.issue_id;
        return issueId === undefined || notes.by('issue_id', issueId).size > 0;
      }
      case 'Repository':
        return notes.by('repo_id', c.id).size > 0;
      case 'User':
        return c.id === this.app.session?.userId;
      default:
        return false;
    }
  }

  /** Sort only on notification changes, not pending triage. */
  private readonly sorted = computed(() => {
    this.notes.reportObserved();
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
    this.related.reportObserved();
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

export function oldestNote(pool: Pool): string | undefined {
  let min: string | undefined;
  for (const e of pool.model('Notification').all()) {
    const at = e.data.created_at;
    if (at && (min === undefined || at < min)) min = at;
  }
  return min;
}
