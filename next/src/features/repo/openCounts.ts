// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The repository tabs observe a frame-batched revision instead of every issue's fields, so an edit in a
// large repository recounts once per frame and re-renders the tabs only when a total changes.

import {computed, createAtom, type IAtom, type IComputedValue, runInAction, untracked} from 'mobx';
import type {Applied, Pool} from '../../data/pool.ts';
import type {Overlay} from '../../intents/overlay.ts';
import type {Issue} from '../../protocol/types.gen.ts';

export interface OpenCounts {
  issues: number;
  pulls: number;
}

class OpenCountsModel {
  private readonly rev: IAtom;
  private off: (() => void) | undefined;
  private scheduled = false;
  readonly value: IComputedValue<OpenCounts>;
  private readonly pool: Pool;
  private readonly overlay: Overlay;
  private readonly repoId: number;

  constructor(pool: Pool, overlay: Overlay, repoId: number) {
    this.pool = pool;
    this.overlay = overlay;
    this.repoId = repoId;
    this.rev = createAtom('open-counts', () => { this.off = pool.onApplied((changes) => { this.changed(changes); }); }, () => {
      this.off?.();
      this.off = undefined;
    });
    this.value = computed(() => this.count(), {equals: (a, b) => a.issues === b.issues && a.pulls === b.pulls});
  }

  private changed(changes: readonly Applied[]) {
    if (this.scheduled || !changes.some((c) => c.model === 'Issue' && (!c.entity || (c.entity.data as Issue).repo_id === this.repoId))) return;
    this.scheduled = true;
    const bump = () => {
      this.scheduled = false;
      if (this.off) runInAction(() => { this.rev.reportChanged(); });
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(bump);
    else setTimeout(bump, 16);
  }

  private count(): OpenCounts {
    this.rev.reportObserved();
    const [, created] = [this.overlay.revision, this.overlay.created('Issue')] as const;
    return untracked(() => {
      const out = {issues: 0, pulls: 0};
      const add = (i: Issue, state: string) => {
        if (state === 'open') out[i.is_pull ? 'pulls' : 'issues']++;
      };
      for (const e of this.pool.model('Issue').by('repo_id', this.repoId)) {
        const i = e.data;
        add(i, this.overlay.touches(i.id) ? (this.overlay.field('Issue', i.id, 'state')?.value as string | undefined) ?? i.state : i.state);
      }
      for (const e of created) {
        const i = e.data as Issue;
        if (i.repo_id === this.repoId) add(i, i.state);
      }
      return out;
    });
  }
}

const models = new WeakMap<Pool, Map<number, OpenCountsModel>>();

/** Open issue and pull request totals of a repository, local edits included; observe `.get()`. */
export function openCounts(pool: Pool, overlay: Overlay, repoId: number): IComputedValue<OpenCounts> {
  let byRepo = models.get(pool);
  if (!byRepo) models.set(pool, byRepo = new Map<number, OpenCountsModel>());
  let m = byRepo.get(repoId);
  if (!m) byRepo.set(repoId, m = new OpenCountsModel(pool, overlay, repoId));
  return m.value;
}
