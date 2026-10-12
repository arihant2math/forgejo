// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Observe a frame-batched pool revision and the overlay, not individual issues,
// to avoid per-issue subscriptions in large repositories.

import {computed, createAtom, type IComputedValue, runInAction, untracked} from 'mobx';
import {useEffect, useState} from 'react';
import {useApp} from '../../app/store.ts';
import type {Applied, Pool} from '../../data/pool.ts';
import {editing} from '../../intents/editing.ts';
import type {Overlay} from '../../intents/overlay.ts';
import type {Issue} from '../../protocol/types.gen.ts';
import {poolContext} from '../issues/list.ts';
import {countIssues, type IssueFacts, type RepoCounts} from './counts.ts';

class RepoCountsModel {
  private readonly rev = createAtom('repo-counts');
  private scheduled = false;
  readonly counts: IComputedValue<RepoCounts>;
  private readonly pool: Pool;
  private readonly overlay: Overlay;
  private readonly repoId: number;

  constructor(pool: Pool, overlay: Overlay, repoId: number) {
    this.pool = pool;
    this.overlay = overlay;
    this.repoId = repoId;
    this.counts = computed(() => this.compute());
  }

  /** Follows the pool's changes (one recomputation per frame at most) until the returned function is called. */
  start(): () => void {
    let live = true;
    const bump = () => {
      this.scheduled = false;
      if (live) runInAction(() => {
        this.rev.reportChanged();
      });
    };
    const off = this.pool.onApplied((changes) => {
      if (this.scheduled || !changes.some((c) => this.concerns(c))) return;
      this.scheduled = true;
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(bump);
      else setTimeout(bump, 16);
    });
    return () => {
      live = false;
      off();
    };
  }

  private concerns(c: Applied): boolean {
    if (c.model !== 'Issue' && c.model !== 'IssueLabel') return false;
    if (!c.entity) return true;
    const d = c.entity.data as {repo_id?: number; issue_id?: number};
    if (c.model === 'Issue') return d.repo_id === this.repoId;
    const issue = this.pool.model('Issue').get(d.issue_id ?? 0);
    return !issue || issue.data.repo_id === this.repoId;
  }

  private compute(): RepoCounts {
    this.rev.reportObserved();
    const [, created] = [this.overlay.revision, this.overlay.created('Issue')] as const;
    return untracked(() => {
      const ctx = poolContext(this.pool, this.overlay);
      const facts: IssueFacts[] = [];
      const add = (i: Issue) => {
        facts.push({state: ctx.state(i), isPull: i.is_pull, milestone: ctx.milestone(i), labels: ctx.labels(i)});
      };
      for (const e of this.pool.model('Issue').by('repo_id', this.repoId)) add(e.data);
      for (const e of created) {
        const i = e.data as Issue;
        if (i.repo_id === this.repoId) add(i);
      }
      return countIssues(facts);
    });
  }
}

/** Observe .get() in an observer; subscription lasts while mounted. */
export function useRepoCounts(repoId: number): IComputedValue<RepoCounts> {
  const app = useApp();
  const [model] = useState(() => {
    const s = app.session;
    if (!s) throw new Error('counts need a session');
    return new RepoCountsModel(s.data.pool, editing(app).overlay, repoId);
  });
  // Subscribe in the effect so StrictMode remounts resubscribe.
  useEffect(() => model.start(), [model]);
  return model.counts;
}
