// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Checks may live in an unloaded tier; fall back to API v1 when the pool has none.
// Delay requests until rows stay visible, cap concurrency, and deduplicate by commit/session.
import {observable, runInAction} from 'mobx';
import {Heading} from '@primer/react';
import {CheckStatus} from './CheckStatus.tsx';
import {observer} from 'mobx-react-lite';
import {type MouseEvent, useEffect} from 'react';
import {online} from '../../app/api.ts';
import {reach} from '../../app/online.ts';
import {useApp, useSession} from '../../app/store.ts';
import type {Pool} from '../../data/pool.ts';
import type {NextConfig} from '../../protocol/types.gen.ts';

import {usePool} from '../issues/cells.tsx';
import {type CheckRepos, type ChecksSummary, checksOf, cleanDescription, summarize} from '../pull/checks.ts';
import {runLook, statusLook} from './Actions.tsx';
import {CodeLink, codeTo} from './nav.tsx';
import type {RowParts} from './RowList.tsx';
import {CheckIcon, DotFillIcon, XIcon} from '@primer/octicons-react';
import {PrimaryAnchor, PrimaryLink} from '../../app/routerLinks.tsx';

export interface CheckItem {
  key: string;
  name: string;
  state: string;
  /** Held for a maintainer's approval (a fork's run). */
  approval: boolean;
  description: string;
  /** Repository-local code path, distinct from an external href. */
  code?: string | undefined;
  href?: string | undefined;
}

export interface CommitChecks {
  summary: ChecksSummary;
  items: CheckItem[];
}

function statusState(state: string): string {
  return state === 'error' ? 'failure' : state === 'pending' ? 'waiting' : state;
}

/** Accept absolute API v1 URLs or site paths from the pool; route local runs in-app. */
export function checkTarget(url: string, owner: string, repo: string, config: Pick<NextConfig, 'app_url' | 'app_sub_url'>): {code?: string; href?: string} {
  if (!url) return {};
  let path: string | undefined;
  if (url.startsWith('/') && !url.startsWith('//')) path = url;
  else if (url.startsWith(config.app_url)) path = `/${url.slice(config.app_url.length)}`;
  if (path !== undefined) {
    const sub = config.app_sub_url;
    if (url.startsWith('/') && sub && (path === sub || path.startsWith(`${sub}/`))) path = path.slice(sub.length) || '/';
    const m = /^\/([^/]+)\/([^/]+)\/(actions\/runs\/\d+(?:\/jobs\/\d+)?)(?:\/attempt\/\d+)?\/?$/.exec(path.split(/[?#]/)[0] ?? '');
    if (m && decodeURIComponent(m[1] ?? '').toLowerCase() === owner.toLowerCase() && decodeURIComponent(m[2] ?? '').toLowerCase() === repo.toLowerCase()) return {code: m[3] ?? ''};
    return {href: `${sub}${path}`};
  }
  return /^https?:\/\//.test(url) ? {href: url} : {};
}

/** Undefined means the pool holds no checks, possibly because their tier is unloaded. */
export function poolCommitChecks(pool: Pool, repos: CheckRepos, sha: string, owner: string, repo: string, config: Pick<NextConfig, 'app_url' | 'app_sub_url'>): CommitChecks | undefined {
  const c = checksOf(pool, repos, sha);
  if (c.summary === 'none') return undefined;
  const items: CheckItem[] = [];
  for (const r of c.runs) {
    const jobs = [...pool.model('ActionRunJob').by('run_id', r.id)].map((j) => j.data).sort((a, b) => a.id - b.id);
    const approval = runLook(r.data).text === 'Needs approval';
    if (!jobs.length) {
      items.push({key: `run:${String(r.id)}`, name: r.data.workflow_id, state: r.data.status, approval, description: '', code: `actions/runs/${String(r.data.run_number)}`});
    }
    jobs.forEach((j, i) => {
      items.push({key: `job:${String(j.id)}`, name: `${r.data.workflow_id} / ${j.name}`, state: j.status, approval, description: '', code: `actions/runs/${String(r.data.run_number)}/jobs/${String(i)}`});
    });
  }
  for (const s of c.statuses) {
    items.push({key: `status:${String(s.id)}`, name: s.get('context'), state: statusState(s.get('state')), approval: false, description: cleanDescription(s.get('description')),
      ...checkTarget(s.get('target_url'), owner, repo, config)});
  }
  return {summary: c.summary, items};
}

export interface CombinedStatus {
  state?: string;
  statuses?: {id?: number; context?: string; status?: string; target_url?: string; description?: string}[] | null;
}

export function apiCommitChecks(json: CombinedStatus | undefined, owner: string, repo: string, config: Pick<NextConfig, 'app_url' | 'app_sub_url'>): CommitChecks {
  const items: CheckItem[] = (json?.statuses ?? []).map((s, i) => ({
    key: `status:${String(s.id ?? i)}`, name: s.context ?? '', state: statusState(s.status ?? ''), approval: false,
    description: cleanDescription(s.description ?? ''), ...checkTarget(s.target_url ?? '', owner, repo, config),
  }));
  return {summary: summarize(items.map((it) => it.state)), items};
}

const FETCH_CONCURRENCY = 4;
const SETTLE_MS = 250;
const fetched = observable.map<string, CommitChecks | 'error'>({}, {deep: false});
const queued = new Set<string>();
const waiting: (() => Promise<void>)[] = [];
let running = 0;

function pump(): void {
  while (running < FETCH_CONCURRENCY && waiting.length) {
    const job = waiting.shift();
    if (!job) break;
    running++;
    void job().finally(() => {
      running--;
      pump();
    });
  }
}

function request(app: ReturnType<typeof useApp>, owner: string, repo: string, sha: string): void {
  const key = `${owner}/${repo}@${sha}`.toLowerCase();
  if (queued.has(key)) return;
  queued.add(key);
  waiting.push(async () => {
    try {
      const json = await online<CombinedStatus>(app, {api: 'v1', path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${sha}/status?limit=50`});
      runInAction(() => {
        fetched.set(key, apiCommitChecks(json, owner, repo, app.config));
      });
    } catch {
      runInAction(() => {
        fetched.set(key, 'error');
      });
      // Retry on a later visit without retrying on every render.
      setTimeout(() => queued.delete(key), 60_000);
    }
  });
  pump();
}

export function resetCommitChecks(): void {
  runInAction(() => {
    fetched.clear();
  });
  queued.clear();
  waiting.length = 0;
}

/** Prefer synced checks, then API v1 online; undefined means unknown. */
export function useCommitChecks(owner: string, repo: string, repos: CheckRepos, sha: string): CommitChecks | 'error' | undefined {
  const app = useApp();
  const pool = usePool();
  const isOnline = reach(useSession().data.status.connection) === 'online';
  const local = poolCommitChecks(pool, repos, sha, owner, repo, app.config);
  const key = `${owner}/${repo}@${sha}`.toLowerCase();
  const known = local !== undefined;
  useEffect(() => {
    if (known || !isOnline) return undefined;
    // Scrolling past rows must not trigger requests for an entire history.
    const t = setTimeout(() => {
      request(app, owner, repo, sha);
    }, SETTLE_MS);
    return () => {
      clearTimeout(t);
    };
  }, [known, isOnline, app, owner, repo, sha]);
  return local ?? fetched.get(key);
}

const ICON = {success: CheckIcon, failure: XIcon, pending: DotFillIcon} as const;
const TONE = {success: 'text-success', failure: 'text-danger', pending: 'text-attention'} as const;
const WORDS = {success: 'Checks passed', failure: 'Some checks failed', pending: 'Checks are not done yet'} as const;

function firstTarget(c: CommitChecks): CheckItem | undefined {
  const bad = c.summary === 'failure' ? c.items.filter((it) => statusLook(it.state).tone === 'danger') : c.summary === 'pending' ? c.items.filter((it) => statusLook(it.state).tone !== 'success') : [];
  return bad.find((it) => it.code);
}

const stop = (e: MouseEvent) => {
  e.stopPropagation();
};

export const CommitCheckMark = observer(function CommitCheckMark({owner, repo, repos, sha}: {owner: string; repo: string; repos: CheckRepos; sha: string}) {
  const c = useCommitChecks(owner, repo, repos, sha);
  if (!c || c === 'error' || c.summary === 'none') return null;
  const summary = c.summary;
  const Mark = ICON[summary];
  const target = firstTarget(c);
  const label = `${WORDS[summary]}${target ? `: ${target.name}` : ''}`;
  return (
    <span className="flex" onClick={stop}>
      <CodeLink owner={owner} repo={repo} to={target?.code ?? `commit/${sha}`} {...(target?.code ? {} : {hash: 'checks'})} label={label}>
        <span title={label} role="img" aria-label={label}><Mark size={16} className={TONE[summary]}/></span>
      </CodeLink>
    </span>
  );
});

export const CommitChecksSection = observer(function CommitChecksSection({owner, repo, repoId, sha}: {owner: string; repo: string; repoId: number; sha: string}) {
  const c = useCommitChecks(owner, repo, {base_repo_id: repoId, head_repo_id: repoId}, sha);
  if (c === 'error') return <p className="text-sm text-muted">This commit’s checks could not be loaded.</p>;
  if (!c || c.summary === 'none') return null;
  return (
    <section id="checks" aria-label="Checks" className="flex flex-col gap-1">
      <Heading as="h2" variant="small">{`Checks · ${WORDS[c.summary]}`}</Heading>
      <ul className="flex flex-col gap-1 text-base">
        {c.items.map((it) => {
          const look = it.approval ? {tone: 'warning' as const, text: 'Needs approval'} : statusLook(it.state);
          const name = it.code ? <PrimaryLink {...codeTo(owner, repo, it.code)} className="min-w-0 truncate">{it.name}</PrimaryLink> :
            it.href ? <PrimaryAnchor href={it.href} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate">{it.name}</PrimaryAnchor> : it.name;
          return (
            <li key={it.key} className="flex flex-wrap items-center gap-2">
              <span className="flex w-4 shrink-0 items-center"><CheckStatus tone={look.tone}/></span>{name}
              <span className="text-sm text-muted">{look.text}{it.description ? ` · ${it.description}` : ''}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
});

export function withChecks<T extends {sha: string}>(row: (c: T) => RowParts, owner: string, repo: string, repos: CheckRepos): (c: T) => RowParts {
  return (c) => {
    const parts = row(c);
    return {...parts, trailing: <><CommitCheckMark owner={owner} repo={repo} repos={repos} sha={c.sha}/>{parts.trailing}</>};
  };
}
