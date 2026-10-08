// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Actions (PLAN §5.7): runs and jobs are synced (ActionRun, ActionRunJob in
// the repository's group: their status changes live, offline too); a job's
// log streams over the sync session (B9 log tail, through the leader tab)
// and, once the job finished, is kept by (job, task) in the code cache, so
// a finished log opens offline and never streams again.

import {useNavigate} from '@tanstack/react-router';
import {Workflow} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useCallback, useEffect, useMemo, useState, useSyncExternalStore} from 'react';
import {connectivity} from '../../app/online.ts';
import {useSession} from '../../app/store.ts';
import type {CodeSource} from '../../code/source.ts';
import type {Data} from '../../sync/data.ts';
import {parseAnsi} from '../../code/ansi.ts';
import {applyLog, emptyLog, finished, type LogState} from '../../code/logs.ts';
import type {ActionRun, ActionRunJob, LogLine, LogStep} from '../../protocol/types.gen.ts';
import {AnsiText, CodeLine, EmptyState, LineNo, ListRow, Status, StatusDot, type StatusTone} from '../../ui/index.ts';
import {usePool} from '../issues/cells.tsx';
import {ago, fullDate} from '../issues/format.ts';
import {CodeFrame, type CodeViewProps} from './CodePage.tsx';
import {useSource} from './hooks.ts';
import {Lines} from './Lines.tsx';
import {CodeLink, codeTo} from './nav.tsx';
import {RowList} from './RowList.tsx';

/** A run, job or step status as a dot tone and words. */
export function statusLook(status: string): {tone: StatusTone; text: string} {
  switch (status) {
    case 'success':
      return {tone: 'success', text: 'Succeeded'};
    case 'failure':
      return {tone: 'danger', text: 'Failed'};
    case 'running':
      return {tone: 'accent', text: 'Running'};
    case 'waiting':
      return {tone: 'warning', text: 'Waiting'};
    case 'blocked':
      return {tone: 'warning', text: 'Blocked'};
    case 'cancelled':
      return {tone: 'muted', text: 'Cancelled'};
    case 'skipped':
      return {tone: 'muted', text: 'Skipped'};
    default:
      return {tone: 'muted', text: status || 'Unknown'};
  }
}

export const ActionsView = observer(function ActionsView(props: CodeViewProps) {
  const pool = usePool();
  const navigate = useNavigate();
  const runs = [...pool.model('ActionRun').by('repo_id', props.repoId)].map((r) => r.data).sort((a, b) => b.run_number - a.run_number);
  return (
    <CodeFrame view={props} title="Actions">
      {(scroller) => (runs.length ?
        <RowList items={runs} scroller={scroller} label="Workflow runs" keyOf={(r) => String(r.id)}
          row={(r) => {
            const look = statusLook(r.status);
            return {
              leading: <span title={look.text}><StatusDot tone={look.tone}/></span>,
              main: <>{r.title} <span className="text-fg-subtle">{r.workflow_id} #{r.run_number}</span><span className="sr-only">, {look.text}</span></>,
              trailing: <><span className="font-mono">{r.ref.replace(/^refs\/(heads|tags)\//, '')}</span><span>{r.event}</span><time dateTime={r.created_at} title={fullDate(r.created_at)}>{ago(r.created_at)}</time></>,
            };
          }}
          onOpen={(r) => {
            void navigate(codeTo(props.owner, props.repo, `actions/runs/${String(r.run_number)}`));
          }}/> :
        <EmptyState icon={Workflow} title="No workflow runs" description="This repository has no Actions runs on this device."/>)}
    </CodeFrame>
  );
});

/** A run of the repository by its number (observes the repository's runs). */
function findRun(pool: ReturnType<typeof usePool>, repoId: number, n: number): ActionRun | undefined {
  for (const r of pool.model('ActionRun').by('repo_id', repoId)) if (r.data.run_number === n) return r.data;
  return undefined;
}

export const RunView = observer(function RunView(props: CodeViewProps & {run: number; job: number}) {
  const pool = usePool();
  const run = findRun(pool, props.repoId, props.run);
  const jobs = run ? [...pool.model('ActionRunJob').by('run_id', run.id)].map((j) => j.data).sort((a, b) => a.id - b.id) : [];
  const job = jobs[props.job];
  const look = statusLook(run?.status ?? '');
  return (
    <CodeFrame view={props} title={run ? `${run.title} #${String(run.run_number)}` : `Run #${String(props.run)}`} controls={run && <Status tone={look.tone}>{look.text}</Status>}>
      {(scroller) => (!run ?
        <EmptyState icon={Workflow} title="Run not found" description="This run does not exist, or is not on this device."/> :
        <div className="flex min-h-full">
          <nav aria-label="Jobs" className="w-pane shrink-0 border-r border-border py-2">
            {jobs.map((j, i) => {
              const jl = statusLook(j.status);
              return (
                <CodeLink key={j.id} owner={props.owner} repo={props.repo} to={`actions/runs/${String(props.run)}/jobs/${String(i)}`} exact>
                  <ListRow role="presentation" active={i === props.job} leading={<StatusDot tone={jl.tone}/>} trailing={jl.text}>{j.name}</ListRow>
                </CodeLink>
              );
            })}
          </nav>
          <section aria-label="Log" className="min-w-0 flex-1">
            {job ? <JobLog key={`${String(job.id)}:${String(job.task_id)}`} repoId={props.repoId} job={job} scroller={scroller}/> :
              <EmptyState icon={Workflow} title="No such job"/>}
          </section>
        </div>)}
    </CodeFrame>
  );
});

/** A finished job's log as cached (by job and task). */
interface StoredLog {
  taskId: number;
  lines: LogLine[];
  steps: LogStep[];
  expired: boolean;
}

const logKey = (repoId: number, jobId: number, taskId: number) => `log:${String(repoId)}:${String(jobId)}:${String(taskId)}`;

/**
 * A job's log: the cached copy of a finished task, else the live tail over
 * the sync session (merged by offset: repeats dropped, gaps asked for again).
 * Listeners hear at most once a frame however fast lines arrive.
 */
class LogFeed {
  readonly log: LogState = emptyLog();
  source: 'cache' | 'live' | 'none' = 'none';
  private version = 0;
  private frame = 0;
  private readonly listeners = new Set<() => void>();
  private readonly data: Data;
  private readonly src: CodeSource;
  private readonly repoId: number;
  private readonly job: ActionRunJob;

  constructor(data: Data, src: CodeSource, repoId: number, job: ActionRunJob) {
    this.data = data;
    this.src = src;
    this.repoId = repoId;
    this.job = job;
  }

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  readonly snapshot = (): number => this.version;

  private paint(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.version++;
      for (const fn of this.listeners) fn();
    });
  }

  /** Loads (cache) or tails (live, when online); returns the stop. */
  start(online: boolean): () => void {
    let live = true;
    const isLive = () => live;
    let untail: (() => void) | undefined;
    const {data, job, log} = this;
    const tail = () => {
      untail?.();
      this.source = 'live';
      untail = data.tailLog(job.id, log.taskId ? {taskId: log.taskId, offset: log.lines.length} : undefined, (msg) => {
        if (msg.type === 'log_closed') {
          untail?.();
          untail = undefined;
          this.paint();
          return;
        }
        // A gap (this tab joined late, a message lost): tail again from the lines held.
        if (!applyLog(log, msg).ok) {
          tail();
          return;
        }
        if (log.done && log.taskId === job.task_id) {
          this.src.cache.put(logKey(this.repoId, job.id, log.taskId), {taskId: log.taskId, lines: log.lines, steps: log.steps, expired: log.expired} satisfies StoredLog);
        }
        this.paint();
      });
    };
    void (async () => {
      if (finished(job.status) && job.task_id) {
        const cached = await this.src.cache.get<StoredLog>(logKey(this.repoId, job.id, job.task_id));
        if (!isLive()) return;
        if (cached) {
          Object.assign(log, {taskId: cached.taskId, lines: cached.lines, steps: cached.steps, done: true, expired: cached.expired});
          this.source = 'cache';
          this.paint();
          return;
        }
      }
      if (online) tail();
      else this.paint();
    })();
    return () => {
      live = false;
      untail?.();
    };
  }

  close(): void {
    cancelAnimationFrame(this.frame);
  }
}

function useJobLog(repoId: number, job: ActionRunJob): LogFeed {
  const src = useSource();
  const {data} = useSession();
  // One feed per job and task (the component is keyed by both).
  const [feed] = useState(() => new LogFeed(data, src, repoId, job));
  const online = connectivity.online;
  useEffect(() => feed.start(online), [feed, online]);
  useEffect(() => () => {
    feed.close();
  }, [feed]);
  useSyncExternalStore(feed.subscribe, feed.snapshot);
  return feed;
}

/** A display row of a log: a step's header, or one of its lines. */
type LogRow = {t: 'step'; s: number} | {t: 'line'; l: number};

const JobLog = observer(function JobLog({repoId, job, scroller}: {repoId: number; job: ActionRunJob; scroller: HTMLDivElement | null}) {
  const feed = useJobLog(repoId, job);
  const {log, source} = feed;
  const [closed, setClosed] = useState<ReadonlySet<number>>(() => new Set());
  const count = log.lines.length;
  const steps = log.steps;
  const rows = useMemo(() => {
    const out: LogRow[] = [];
    if (!steps.length) {
      for (let l = 0; l < count; l++) out.push({t: 'line', l});
      return out;
    }
    steps.forEach((st, s) => {
      out.push({t: 'step', s});
      if (closed.has(s)) return;
      for (let l = st.log_index; l < Math.min(count, st.log_index + st.log_length); l++) out.push({t: 'line', l});
    });
    return out;
    // `count` and `steps` change as the log streams.
  }, [count, steps, closed]);
  const line = useCallback((i: number): ReactNode => {
    const r = rows[i];
    if (!r) return null;
    if (r.t === 'step') {
      const st = steps[r.s];
      if (!st) return null;
      const look = statusLook(st.status);
      return (
        <button type="button" aria-expanded={!closed.has(r.s)} className="interactive flex h-line w-full items-center gap-2 bg-canvas px-3 text-left text-sm text-fg hover:bg-hover"
          onClick={() => {
            setClosed((c) => {
              const n = new Set(c);
              if (n.has(r.s)) n.delete(r.s);
              else n.add(r.s);
              return n;
            });
          }}>
          <StatusDot tone={look.tone}/>
          <span className="min-w-0 flex-1 truncate font-medium">{st.name}</span>
          <span className="text-fg-subtle tabular-nums">{st.stopped && st.started ? `${String(st.stopped - st.started)} s` : look.text}</span>
        </button>
      );
    }
    const l = log.lines[r.l];
    return (
      <CodeLine gutter={<LineNo n={r.l + 1}/>}>
        <AnsiText spans={ansiOf(l)}/>
      </CodeLine>
    );
  }, [rows, steps, closed, log.lines]);
  if (!count && !steps.length) {
    if (log.expired) return <EmptyState icon={Workflow} title="Log removed" description="This log was removed by the instance's log retention."/>;
    if (source === 'none' && !connectivity.online) return <EmptyState icon={Workflow} title="Not available offline" description="This job's log is not on this device."/>;
    return <p className="px-4 py-3 text-sm text-fg-subtle">{job.task_id ? 'Waiting for the log…' : 'Waiting for a runner…'}</p>;
  }
  return <Lines count={rows.length} scroller={scroller} line={line} label={`Log of ${job.name}`} follow={!finished(job.status)}/>;
});

// Parsed spans per line object (a line is immutable once received).
const ansiCache = new WeakMap<LogLine, ReturnType<typeof parseAnsi>>();

function ansiOf(l: LogLine | undefined): ReturnType<typeof parseAnsi> {
  if (!l) return [];
  let s = ansiCache.get(l);
  if (!s) ansiCache.set(l, s = parseAnsi(l.c));
  return s;
}
