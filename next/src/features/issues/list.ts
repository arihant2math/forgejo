// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Observe frame-coalesced pool revisions, synchronous overlay revisions, and the view.
// Read issue facts untracked to avoid per-issue subscriptions; preserve row identity when order is unchanged.

import {computed, createAtom, type IComputedValue, observable, runInAction, untracked} from 'mobx';
import {sitePath} from '../../app/config.ts';
import {netSignal} from '../../sync/net.ts';
import {type ListSearch, type MyListType, parseLabels} from '../../app/search.ts';
import type {App} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import type {ModelName} from '../../data/models.ts';
import type {Applied, Pool} from '../../data/pool.ts';
import type {Overlay} from '../../intents/overlay.ts';
import {issueAssigneeIds, issueLabelIds} from '../../intents/view.ts';
import type {Issue} from '../../protocol/types.gen.ts';
import {ListCursor} from './flags.ts';
import {type Group, type Query, type QueryContext, type QueryResult, type Row, runQuery, type Sort} from './query.ts';

/** milestone restricts membership independently of removable view filters. */
export type ListSource =
  | {kind: 'repo'; repoId: number; pulls: boolean | 'any'; milestone?: number}
  | {kind: 'my'; pulls: boolean; type: MyListType | undefined};

const RELEVANT = new Set<ModelName>(['Issue', 'IssueLabel', 'IssueAssignee', 'Label', 'Milestone', 'Repository', 'User', 'Review']);

export function queryOf(s: ListSearch, defaults: {group?: Group; sort?: Sort} = {}): Query {
  return {
    filter: {
      state: s.state ?? 'open',
      labels: parseLabels(s.labels),
      assignee: s.assignee,
      poster: s.poster,
      milestone: s.milestone,
      q: s.q,
      status: s.status,
      priority: s.priority,
      label: s.label,
      repo: s.repo,
    },
    sort: s.sort ?? defaults.sort ?? 'newest',
    group: s.group ?? defaults.group ?? 'none',
  };
}

export function poolContext(pool: Pool, overlay: Overlay): QueryContext {
  const labels = pool.model('Label');
  const users = pool.model('User');
  // Read server data directly for issues untouched by pending edits.
  const issueLabels = pool.model('IssueLabel');
  const issueAssignees = pool.model('IssueAssignee');
  const edited = (i: Issue) => overlay.touches(i.id);
  return {
    state: (i) => (edited(i) ? (overlay.field('Issue', i.id, 'state')?.value as string | undefined) ?? i.state : i.state),
    milestone: (i) => (edited(i) ? (overlay.field('Issue', i.id, 'milestone_id')?.value as number | undefined) ?? i.milestone_id : i.milestone_id),
    labels: (i) => {
      if (edited(i)) return issueLabelIds(pool, overlay, i.id);
      const out: number[] = [];
      for (const e of issueLabels.by('issue_id', i.id)) out.push(e.data.label_id);
      return out;
    },
    assignees: (i) => {
      if (edited(i)) return issueAssigneeIds(pool, overlay, i.id);
      const out: number[] = [];
      for (const e of issueAssignees.by('issue_id', i.id)) out.push(e.data.assignee_id);
      return out;
    },
    label: (id) => labels.get(id)?.data,
    milestoneOf: (id) => pool.model('Milestone').get(id)?.data,
    userName: (id) => {
      const u = users.get(id)?.data;
      return u ? u.full_name || u.login : undefined;
    },
    repo: (id) => pool.model('Repository').get(id)?.data,
  };
}

/** 0 means unpinned; pending pins follow Forgejo's existing pinned order. */
function pinOrder(overlay: Overlay, i: Issue): number {
  if (!overlay.touches(i.id)) return i.pin_order > 0 ? i.pin_order : 0;
  const o = overlay.field('Issue', i.id, 'pin_order');
  const v = o ? o.value as number : i.pin_order;
  return v > 0 ? v : 0;
}

function sameRow(x: Row | undefined, y: Row | undefined): boolean {
  if (x?.type === 'issue') return y?.type === 'issue' && x.id === y.id && x.copy === y.copy;
  if (x?.type === 'group') return y?.type === 'group' && x.key === y.key && x.count === y.count && x.label === y.label;
  return false;
}

const sameRows = (a: QueryResult, b: QueryResult): boolean => {
  if (a.rows.length !== b.rows.length) return false;
  for (let i = 0; i < a.rows.length; i++) {
    if (!sameRow(a.rows[i], b.rows[i])) return false;
  }
  return true;
};

export class IssueListModel {
  readonly source: ListSource;
  private readonly app: App;
  private readonly pool: Pool;
  private readonly overlay: Overlay;
  private readonly rev = createAtom('list');
  private scheduled = false;
  private readonly off: () => void;
  private readonly view = observable.box<ListSearch>({}, {deep: false});
  private readonly defaultGroup: Group;
  /** undefined means the server has not been asked. */
  private readonly serverIds = observable.box<ReadonlySet<number> | undefined>(undefined, {deep: false});
  private readonly serverFailed = observable.box(false);
  /** Keep ids listed while requesting another state, but track which state they answer. */
  private readonly serverAnsweredState = observable.box<string | undefined>(undefined);
  private serverAsked = '';
  readonly result: IComputedValue<QueryResult>;
  readonly cursor = new ListCursor();
  /** Retain membership to detect issues moved out of the repository. */
  private listed: ReadonlySet<number> = new Set();
  /** Last query duration in milliseconds. */
  lastMs = 0;
  disposed = false;

  constructor(app: App, overlay: Overlay, source: ListSource, defaultGroup: Group = 'none') {
    const s = app.session;
    if (!s) throw new Error('a list needs a session');
    this.app = app;
    this.pool = s.data.pool;
    this.overlay = overlay;
    this.source = source;
    this.defaultGroup = defaultGroup;
    this.off = this.pool.onApplied((changes) => {
      if (this.scheduled) return;
      if (!changes.some((c) => this.concerns(c))) return;
      this.scheduled = true;
      const run = () => {
        this.scheduled = false;
        if (!this.disposed) runInAction(() => {
          this.rev.reportChanged();
        });
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
      else setTimeout(run, 16);
    });
    this.result = computed(() => this.compute(), {equals: sameRows});
  }

  /** Treat deletions and changes to unheld issues as relevant; their prior membership may be unknown. */
  private concerns(c: Applied): boolean {
    if (!RELEVANT.has(c.model)) return false;
    if (c.model === 'User') return untracked(() => queryOf(this.view.get(), {group: this.defaultGroup}).group) === 'assignee';
    const src = this.source;
    if (src.kind !== 'repo' || !c.entity) return true;
    const d = c.entity.data as {repo_id?: number; issue_id?: number};
    switch (c.model) {
      case 'Issue':
        // Include issues moved away: their new repo_id does not identify the list they leave.
        return d.repo_id === src.repoId || this.listed.has(c.id);
      case 'Milestone':
        return d.repo_id === src.repoId;
      case 'Label':
        return d.repo_id === src.repoId || d.repo_id === 0;
      case 'IssueLabel':
      case 'IssueAssignee': {
        const issue = this.pool.model('Issue').get(d.issue_id ?? 0);
        return !issue || issue.data.repo_id === src.repoId;
      }
      case 'Repository':
        return c.id === src.repoId;
      case 'Review':
        return false; // only the viewer's "review requested" list reads reviews
      default:
        return true;
    }
  }

  get search(): ListSearch {
    return this.view.get();
  }

  get query(): Query {
    const q = queryOf(this.view.get(), {group: this.defaultGroup});
    if (this.source.kind === 'my' && this.source.type === 'assigned') q.filter = {...q.filter, assignee: this.app.session?.userId};
    if (this.source.kind === 'repo' && this.source.milestone !== undefined) q.filter = {...q.filter, milestone: this.source.milestone};
    return q;
  }

  pushed: ListSearch | undefined;

  /** Ignore delayed URL echoes if the live view has already moved on. */
  fromUrl(s: ListSearch): void {
    const own = this.pushed && JSON.stringify(s) === JSON.stringify(this.pushed);
    this.pushed = undefined;
    if (own) return;
    this.setSearch(s);
  }

  setSearch(s: ListSearch): void {
    if (JSON.stringify(s) !== JSON.stringify(this.view.get())) {
      runInAction(() => {
        this.view.set(s);
      });
    }
    this.askServer();
  }

  dispose(): void {
    this.disposed = true;
    this.off();
  }

  get serverAnswered(): boolean {
    return this.serverIds.get() !== undefined;
  }

  /** unanswered is not empty: retry on reconnect; asking is in flight and answered is authoritative. */
  get serverStatus(): 'answered' | 'asking' | 'unanswered' {
    if (this.serverFailed.get()) return 'unanswered';
    // An answer for a previous state cannot establish that this state is empty.
    return this.serverIds.get() !== undefined && this.serverAnsweredState.get() === this.query.filter.state ? 'answered' : 'asking';
  }

  get serverAssisted(): boolean {
    return this.source.kind === 'my' && (this.source.type === 'mentioned' || this.source.type === 'review_requested');
  }

  private compute(): QueryResult {
    this.rev.reportObserved();
    const query = this.query;
    const overlayRev = this.overlay.revision;
    const server = this.serverIds.get();
    const created = this.overlay.created('Issue');
    return untracked(() => {
      const t0 = performance.now();
      const ctx = poolContext(this.pool, this.overlay);
      if (this.source.kind === 'repo') ctx.pin = (i) => pinOrder(this.overlay, i);
      const out = runQuery([...this.candidates(server), ...this.localCandidates(created)], query, ctx);
      this.lastMs = performance.now() - t0;
      this.listed = new Set(out.ids);
      try {
        performance.measure('list:query', {start: t0, end: t0 + this.lastMs, detail: {rows: out.rows.length, overlay: overlayRev}});
      } catch {
        // User Timing is optional.
      }
      return out;
    });
  }

  private candidates(server: ReadonlySet<number> | undefined): Iterable<Issue> {
    const src = this.source;
    if (src.kind === 'repo') {
      // Avoid allocating a generator per issue in the common case.
      const out: Issue[] = [];
      for (const e of this.pool.model('Issue').by('repo_id', src.repoId)) {
        const d = e.data;
        if (src.pulls === 'any' || d.is_pull === src.pulls) out.push(d);
      }
      return out;
    }
    return this.myCandidates(src, server);
  }

  private localCandidates(created: readonly Entity[]): Issue[] {
    const src = this.source;
    const out: Issue[] = [];
    for (const e of created) {
      const d = e.data as Issue;
      if (src.kind === 'repo' ? d.repo_id === src.repoId && (src.pulls === 'any' || d.is_pull === src.pulls) : !src.pulls && (src.type === undefined || src.type === 'created_by')) out.push(d);
    }
    return out;
  }

  private *myCandidates(src: Extract<ListSource, {kind: 'my'}>, server: ReadonlySet<number> | undefined): Generator<Issue> {
    const issues = this.pool.model('Issue');
    const me = this.app.session?.userId ?? 0;
    const yieldIds = function* (ids: Iterable<number>, pulls: boolean): Generator<Issue> {
      const seen = new Set<number>();
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const d = issues.get(id)?.data;
        if (d?.is_pull === pulls) yield d;
      }
    };
    switch (src.type) {
      case 'assigned': {
        const ids = [...this.pool.model('IssueAssignee').by('assignee_id', me)].map((e) => e.data.issue_id);
        yield* yieldIds([...ids, ...this.overlay.ownersWith('IssueAssignee', me)], src.pulls);
        return;
      }
      case 'created_by':
        for (const e of issues.by('poster_id', me)) if (e.data.is_pull === src.pulls) yield e.data;
        return;
      case 'review_requested': {
        const local = [...this.pool.model('Review').by('reviewer_id', me)].filter((e) => e.data.state === 'REQUEST_REVIEW').map((e) => e.data.issue_id);
        yield* yieldIds([...server ?? [], ...local], src.pulls);
        return;
      }
      case 'mentioned':
        yield* yieldIds(server ?? [], src.pulls);
        return;
      default:
        for (const e of issues.all()) if (e.data.is_pull === src.pulls) yield e.data;
    }
  }

  /** Mentions and review requests are outside sync scope; server search supplies ids for pool-backed rows. */
  private askServer(): void {
    if (!this.serverAssisted || this.source.kind !== 'my') return;
    const s = this.app.session;
    if (!s) return;
    const state = this.query.filter.state;
    const key = `${String(this.source.type)}:${state}`;
    if (key === this.serverAsked) return;
    this.serverAsked = key;
    const params = new URLSearchParams({type: this.source.pulls ? 'pulls' : 'issues', state, limit: '50'});
    params.set(this.source.type === 'mentioned' ? 'mentioned' : 'review_requested', 'true');
    if (this.serverFailed.get()) runInAction(() => {
      this.serverFailed.set(false);
    });
    void (async () => {
      const ids = new Set<number>();
      let answered = false;
      try {
        const token = await s.auth.token();
        for (let page = 1; page <= 10; page++) {
          params.set('page', String(page));
          const res = await fetch(sitePath(this.app.config, `/api/v1/repos/issues/search?${params.toString()}`), {
            headers: {Authorization: `Bearer ${token}`, Accept: 'application/json'}, credentials: 'omit', redirect: 'error', signal: netSignal(15_000),
          });
          if (!res.ok) break;
          answered = true;
          const list = await res.json() as {id?: unknown}[];
          for (const i of list) if (typeof i.id === 'number') ids.add(i.id);
          if (list.length < 50) break;
        }
      } catch {
        // Connection failures leave the query unanswered for retry below.
      }
      if (this.disposed || this.serverAsked !== key) return;
      if (!answered) {
        // Failure is not an empty answer; retain the unanswered state and retry on reconnect.
        this.serverAsked = '';
        runInAction(() => {
          this.serverFailed.set(true);
        });
        if (typeof window !== 'undefined') window.addEventListener('online', () => { this.askServer(); }, {once: true});
        return;
      }
      runInAction(() => {
        this.serverIds.set(ids);
        this.serverAnsweredState.set(state);
      });
    })();
  }
}
