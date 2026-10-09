// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A list's live query: candidates from the pool (a repository's issues, or
// the viewer's across the workspace), the view (filter/sort/group: the URL's
// search params) and the overlay — one MobX computation (query.ts) that
// yields the rows.
//
// What it observes, on purpose coarse-grained: a revision bumped when the
// pool applies changes that concern the list (coalesced to one per
// animation frame, so a bootstrap streaming in thousands of lines recomputes
// a few times, not per line), the overlay's revision (bumped synchronously:
// a local change shows in the same frame), and the view. Everything else is
// read untracked, so a list of 10 000 issues creates no per-issue
// subscriptions. The rows' cells observe their own fields (cells.tsx).
//
// The result keeps its identity when a recomputation yields the same rows
// (a title change, a delta of a hidden issue): the virtualized list does not
// re-render then, and the changed cell updates on its own.

import {computed, createAtom, type IComputedValue, observable, runInAction, untracked} from 'mobx';
import {sitePath} from '../../app/config.ts';
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

export type ListSource =
  | {kind: 'repo'; repoId: number; pulls: boolean}
  | {kind: 'my'; pulls: boolean; type: MyListType | undefined};

/** Models whose changes can change a list's rows. */
const RELEVANT = new Set<ModelName>(['Issue', 'IssueLabel', 'IssueAssignee', 'Label', 'Milestone', 'Repository', 'User', 'Review']);

/** The query a view's search params describe. */
export function queryOf(s: ListSearch, defaults: {group?: Group; sort?: Sort} = {}): Query {
  return {
    filter: {
      state: s.state ?? 'open',
      labels: parseLabels(s.labels),
      assignee: s.assignee,
      poster: s.poster,
      milestone: s.milestone,
      q: s.q,
    },
    sort: s.sort ?? defaults.sort ?? 'newest',
    group: s.group ?? defaults.group ?? 'none',
  };
}

/** The pool-backed facts query.ts asks for (as the user sees them: overlay included). Read untracked. */
export function poolContext(pool: Pool, overlay: Overlay): QueryContext {
  const labels = pool.model('Label');
  const users = pool.model('User');
  // Untracked reads (the list observes overlay.revision): the server's values
  // are read directly for every issue no pending edit touches.
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

function sameRow(x: Row | undefined, y: Row | undefined): boolean {
  if (x?.type === 'issue') return y?.type === 'issue' && x.id === y.id;
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
  /** The view: the URL's search params, applied here first (in the frame of the click) and then to the URL. */
  private readonly view = observable.box<ListSearch>({}, {deep: false});
  private readonly defaultGroup: Group;
  /** Issues the server says belong to the list (mentioned, review requested); undefined: not asked. */
  private readonly serverIds = observable.box<ReadonlySet<number> | undefined>(undefined, {deep: false});
  private serverAsked = '';
  readonly result: IComputedValue<QueryResult>;
  /** The keyboard cursor (J/K) and the selection (X). */
  readonly cursor = new ListCursor();
  /** The issues of the last computation (moves away from a repository are relevant to its list). */
  private listed: ReadonlySet<number> = new Set();
  /** The last computation's duration (ms), for the perf checks. */
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

  /**
   * Whether a change can change the rows: a model the list shows, and for a
   * repository's list something of that repository (another repository's
   * stream of deltas recomputes nothing). Deletions and sets whose issue is
   * not held are taken as relevant (cheap to recompute, rare).
   */
  private concerns(c: Applied): boolean {
    if (!RELEVANT.has(c.model)) return false;
    // A user's name orders and labels only the assignee groups.
    if (c.model === 'User') return untracked(() => queryOf(this.view.get(), {group: this.defaultGroup}).group) === 'assignee';
    const src = this.source;
    if (src.kind !== 'repo' || !c.entity) return true;
    // Plain reads (not in a reaction): nothing is observed.
    const d = c.entity.data as {repo_id?: number; issue_id?: number};
    switch (c.model) {
      case 'Issue':
        // Also an issue that moved away (its new repo_id is another's): it is still among the rows.
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

  /** The view's search params (observable). */
  get search(): ListSearch {
    return this.view.get();
  }

  /** The query the view describes (the "assigned" list also filters on the viewer as assignee, through the overlay). */
  get query(): Query {
    const q = queryOf(this.view.get(), {group: this.defaultGroup});
    if (this.source.kind === 'my' && this.source.type === 'assigned') q.filter = {...q.filter, assignee: this.app.session?.userId};
    return q;
  }

  /** The search params this model last wrote to the URL (ListControls), see `fromUrl`. */
  pushed: ListSearch | undefined;

  /**
   * The URL's search params changed: shows them — unless they are what this model wrote itself and
   * the view has moved on since (typing continued while the URL caught up).
   */
  fromUrl(s: ListSearch): void {
    const own = this.pushed && JSON.stringify(s) === JSON.stringify(this.pushed);
    this.pushed = undefined;
    if (own) return;
    this.setSearch(s);
  }

  /** Shows another view (recomputed on the next read: in the same frame). */
  setSearch(s: ListSearch): void {
    if (JSON.stringify(s) === JSON.stringify(this.view.get())) return;
    runInAction(() => {
      this.view.set(s);
    });
    this.askServer();
  }

  dispose(): void {
    this.disposed = true;
    this.off();
  }

  /** Whether the list needs the server's answer (mentioned, review requested). */
  get serverAssisted(): boolean {
    return this.source.kind === 'my' && (this.source.type === 'mentioned' || this.source.type === 'review_requested');
  }

  private compute(): QueryResult {
    this.rev.reportObserved();
    const query = this.query;
    const overlayRev = this.overlay.revision;
    const server = this.serverIds.get();
    // Issues created on this device and not synced yet (observes creations only): listed, marked as pending.
    const created = this.overlay.created('Issue');
    return untracked(() => {
      const t0 = performance.now();
      const out = runQuery([...this.candidates(server), ...this.localCandidates(created)], query, poolContext(this.pool, this.overlay));
      this.lastMs = performance.now() - t0;
      this.listed = new Set(out.ids);
      try {
        performance.measure('list:query', {start: t0, end: t0 + this.lastMs, detail: {rows: out.rows.length, overlay: overlayRev}});
      } catch {
        // No User Timing.
      }
      return out;
    });
  }

  private candidates(server: ReadonlySet<number> | undefined): Iterable<Issue> {
    const src = this.source;
    if (src.kind === 'repo') {
      // The common case, in a plain loop (no generator per issue).
      const out: Issue[] = [];
      for (const e of this.pool.model('Issue').by('repo_id', src.repoId)) {
        const d = e.data;
        if (d.is_pull === src.pulls) out.push(d);
      }
      return out;
    }
    return this.myCandidates(src, server);
  }

  /** The locally created issues this list shows (its repository, or the viewer's own "created" and "all" lists). */
  private localCandidates(created: readonly Entity[]): Issue[] {
    const src = this.source;
    const out: Issue[] = [];
    for (const e of created) {
      const d = e.data as Issue;
      if (src.kind === 'repo' ? d.repo_id === src.repoId && d.is_pull === src.pulls : !src.pulls && (src.type === undefined || src.type === 'created_by')) out.push(d);
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
        // The pool's assignments and the overlay's (an optimistic self-assignment shows at once; the query's
        // assignee filter, set below, drops an optimistic unassignment).
        const ids = [...this.pool.model('IssueAssignee').by('assignee_id', me)].map((e) => e.data.issue_id);
        yield* yieldIds([...ids, ...this.overlay.ownersWith('IssueAssignee', me)], src.pulls);
        return;
      }
      case 'created_by':
        for (const e of issues.by('poster_id', me)) if (e.data.is_pull === src.pulls) yield e.data;
        return;
      case 'review_requested': {
        // The server's answer, and review requests of pull requests whose timeline is on this device.
        const local = [...this.pool.model('Review').by('reviewer_id', me)].filter((e) => e.data.state === 'REQUEST_REVIEW').map((e) => e.data.issue_id);
        yield* yieldIds([...server ?? [], ...local], src.pulls);
        return;
      }
      case 'mentioned':
        yield* yieldIds(server ?? [], src.pulls);
        return;
      default:
        // All issues of the repositories on this device (the classic "your repositories").
        for (const e of issues.all()) if (e.data.is_pull === src.pulls) yield e.data;
    }
  }

  /**
   * Mentions and review requests are not synced (they live in tables the
   * sync engine does not track): the server's issue search names them, and
   * the rows come from the pool.
   */
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
    void (async () => {
      const ids = new Set<number>();
      try {
        const token = await s.auth.token();
        for (let page = 1; page <= 10; page++) {
          params.set('page', String(page));
          const res = await fetch(sitePath(this.app.config, `/api/v1/repos/issues/search?${params.toString()}`), {
            headers: {Authorization: `Bearer ${token}`, Accept: 'application/json'}, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) break;
          const list = await res.json() as {id?: unknown}[];
          for (const i of list) if (typeof i.id === 'number') ids.add(i.id);
          if (list.length < 50) break;
        }
      } catch {
        // Offline: the local part only (review requests of loaded timelines).
      }
      if (this.disposed || this.serverAsked !== key) return;
      runInAction(() => {
        this.serverIds.set(ids);
      });
    })();
  }
}
