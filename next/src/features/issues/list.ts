// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Observe frame-coalesced pool revisions, synchronous overlay revisions, and the view.
// Read issue facts untracked to avoid per-issue subscriptions; preserve row identity when order is unchanged.

import {computed, createAtom, type IComputedValue, observable, runInAction, untracked} from 'mobx';
import {send} from '../../app/api.ts';
import {type ListSearch, type MyListType, parseLabels} from '../../app/search.ts';
import type {App, Session} from '../../app/store.ts';
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

/** Answers younger than this are reused by every list that shows them (ms). */
export const SERVER_FRESH = 60_000;
const SERVER_PAGE = 50;
const SERVER_PAGES = 10;

/**
 * The ids of one issues/search question (mentions, review requests: outside sync scope), shared per session by
 * every list asking it, so Home and My pull requests do not ask again on every visit.
 */
class ServerSearch {
  /** undefined until answered; a refresh keeps the previous answer. */
  readonly ids = observable.box<ReadonlySet<number> | undefined>(undefined, {deep: false});
  /** The last attempt got no answer (offline, an error status): not an empty list. */
  readonly failed = observable.box(false);
  /** Lists showing this search; a failed one is asked again on reconnect only while shown. */
  users = 0;
  private at = 0;
  private asking = false;
  private readonly app: App;
  private readonly params: URLSearchParams;

  constructor(app: App, params: URLSearchParams) {
    this.app = app;
    this.params = params;
  }

  ask(): void {
    if (this.asking || (this.ids.get() !== undefined && Date.now() - this.at < SERVER_FRESH)) return;
    this.asking = true;
    if (this.failed.get()) runInAction(() => {
      this.failed.set(false);
    });
    void this.pages().then((ids) => {
      this.asking = false;
      if (ids) this.at = Date.now();
      runInAction(() => {
        if (ids) this.ids.set(ids);
        // A failed refresh keeps showing the previous answer.
        this.failed.set(!ids && this.ids.get() === undefined);
      });
    });
  }

  /** Page 1, then the other pages at once when Forgejo says how many there are. Undefined when page 1 failed. */
  private async pages(): Promise<Set<number> | undefined> {
    const get = (page: number) => {
      const q = new URLSearchParams(this.params);
      q.set('page', String(page));
      return send<{id?: unknown}[]>(this.app, {api: 'v1', path: `/repos/issues/search?${q.toString()}`});
    };
    const ids = new Set<number>();
    const add = (list: {id?: unknown}[] | undefined) => {
      for (const i of list ?? []) if (typeof i.id === 'number') ids.add(i.id);
      return (list?.length ?? 0) >= SERVER_PAGE;
    };
    let first;
    try {
      first = await get(1);
    } catch {
      return undefined;
    }
    if (!add(first.value)) return ids;
    const total = first.totalCount;
    try {
      if (total !== undefined) {
        const rest = Array.from({length: Math.min(SERVER_PAGES, Math.ceil(total / SERVER_PAGE)) - 1}, (_, i) => get(i + 2));
        for (const r of await Promise.allSettled(rest)) if (r.status === 'fulfilled') add(r.value.value);
      } else {
        for (let page = 2; page <= SERVER_PAGES && add((await get(page)).value); page++);
      }
    } catch {
      // Later pages that fail leave the answer shorter.
    }
    return ids;
  }
}

const serverSearches = new WeakMap<Session, Map<string, ServerSearch>>();

function serverSearch(app: App, s: Session, pulls: boolean, type: 'mentioned' | 'review_requested', state: string): ServerSearch {
  let all = serverSearches.get(s);
  if (!all) serverSearches.set(s, all = new Map<string, ServerSearch>());
  const key = `${String(pulls)}:${type}:${state}`;
  let search = all.get(key);
  if (!search) {
    const params = new URLSearchParams({type: pulls ? 'pulls' : 'issues', state, limit: String(SERVER_PAGE), [type]: 'true'});
    all.set(key, search = new ServerSearch(app, params));
  }
  return search;
}

const shownSearches = new Set<ServerSearch>();

if (typeof window !== 'undefined') {
  // One listener for every list: failed searches still shown are asked again.
  window.addEventListener('online', () => {
    for (const s of shownSearches) if (s.failed.get()) s.ask();
  });
}

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
  /** The server search of the current state; undefined when the list does not need one. */
  private readonly server = observable.box<ServerSearch | undefined>(undefined, {deep: false});
  /** Ids from the last answered search, listed while another state's search is asked. */
  private lastServerIds: ReadonlySet<number> | undefined;
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
    this.showServer(undefined);
  }

  get serverAnswered(): boolean {
    return this.server.get()?.ids.get() !== undefined;
  }

  /** unanswered is not empty: retry on reconnect; asking is in flight and answered is authoritative. */
  get serverStatus(): 'answered' | 'asking' | 'unanswered' {
    const search = this.server.get();
    if (search?.failed.get()) return 'unanswered';
    // An answer for a previous state cannot establish that this state is empty.
    return search?.ids.get() !== undefined ? 'answered' : 'asking';
  }

  get serverAssisted(): boolean {
    return this.source.kind === 'my' && (this.source.type === 'mentioned' || this.source.type === 'review_requested');
  }

  private compute(): QueryResult {
    this.rev.reportObserved();
    const query = this.query;
    const overlayRev = this.overlay.revision;
    const server = this.server.get()?.ids.get() ?? this.lastServerIds;
    if (server) this.lastServerIds = server;
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
    const s = this.app.session;
    const src = this.source;
    if (this.disposed || !s || src.kind !== 'my' || (src.type !== 'mentioned' && src.type !== 'review_requested')) return;
    const search = serverSearch(this.app, s, src.pulls, src.type, this.query.filter.state);
    this.showServer(search);
    search.ask();
  }

  private showServer(search: ServerSearch | undefined): void {
    const old = this.server.get();
    if (old === search) return;
    if (old && --old.users === 0) shownSearches.delete(old);
    if (search && search.users++ === 0) shownSearches.add(search);
    runInAction(() => {
      this.server.set(search);
    });
  }
}
