// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What the client holds of each sync group, persisted in meta "group:<name>"
// (written by the persister together with the entities):
//
//   position  the protocol's position (messages.go "Positions"): the highest
//             v received in the group, raised to delta.to / caught_up / pong
//             / barrier_ok / resume_from_cursor while the group is caught up,
//             and to a bootstrap's watermark. A group is resumed from it.
//   units     the units the held entities were filtered by (the last
//             bootstrap's header): a grant with other units means
//             bootstrap_required{permission_changed} (the units rule).
//   needs     a pending (re-)bootstrap, of every model or of some models;
//             kept until a bootstrap covering it completed, so a reload
//             re-bootstraps even when the server will not say so again.
//   holders   why the group is held: "workspace", "ref:<group>" (a group
//             whose entities refer to it, BootstrapEnd.refs), "recent"
//             (opened on demand, kept for offline use, LRU), "pin".
//             Tabs add holds that are not persisted (see SyncClient.hold).

import type {MetaCache} from '../data/meta.ts';

export interface GroupNeeds {
  /** Every model (a full bootstrap); otherwise only `models`. */
  all: boolean;
  models: string[];
  reason: string;
}

export interface GroupState {
  group: string;
  position?: number;
  units?: string[];
  /** The watermark of the last complete full/summary bootstrap. */
  watermark?: number;
  tier?: string;
  /** The summary's (or user group's) closed_before. */
  closedBefore?: number;
  needs?: GroupNeeds;
  /** Groups the last bootstrap referred to (end.refs) and which this group holds. */
  refs?: string[];
  holders: string[];
  /** Last use (ms since epoch), for the "recent" LRU. */
  used?: number;
}

const PREFIX = 'group:';

export class GroupTable {
  private readonly meta: MetaCache;
  private readonly states = new Map<string, GroupState>();

  constructor(meta: MetaCache) {
    this.meta = meta;
    for (const k of meta.keys()) {
      if (!k.startsWith(PREFIX)) continue;
      const s = meta.get<GroupState>(k);
      if (s?.group) this.states.set(s.group, {...s, holders: [...s.holders]});
    }
  }

  get(group: string): GroupState | undefined {
    return this.states.get(group);
  }

  all(): IterableIterator<GroupState> {
    return this.states.values();
  }

  get size(): number {
    return this.states.size;
  }

  /** Changes a group's state (creating it) and persists it. */
  update(group: string, fn: (s: GroupState) => void): GroupState {
    const prev = this.states.get(group);
    const s: GroupState = prev ? {...prev, holders: [...prev.holders]} : {group, holders: []};
    fn(s);
    this.states.set(group, s);
    this.meta.set(PREFIX + group, s);
    return s;
  }

  remove(group: string): void {
    if (!this.states.delete(group)) return;
    this.meta.delete(PREFIX + group);
  }

  /** Raises a group's position (never lowers it). */
  raise(group: string, pos: number): void {
    const s = this.states.get(group);
    if (!s || (s.position ?? -1) >= pos) return;
    this.update(group, (x) => {
      x.position = pos;
    });
  }

  /** Adds a need for a (re-)bootstrap. */
  need(group: string, model: string | undefined, reason: string): void {
    this.update(group, (s) => {
      if (!model) {
        s.needs = {all: true, models: [], reason};
      } else if (!s.needs) {
        s.needs = {all: false, models: [model], reason};
      } else if (!s.needs.all && !s.needs.models.includes(model)) {
        s.needs = {...s.needs, models: [...s.needs.models, model]};
      }
    });
  }
}
