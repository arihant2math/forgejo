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
import {parseAnsi} from '../../code/ansi.ts';
import {finished} from '../../code/logs.ts';
import {LogFeed} from '../../code/logfeed.ts';
import type {ActionRun, ActionRunJob, LogLine} from '../../protocol/types.gen.ts';
import {AnsiText, CodeLine, EmptyState, LineNo, ListRow, Status, StatusDot, type StatusTone, StepHeader} from '../../ui/index.ts';
import {usePool} from '../issues/cells.tsx';
import {ago, fullDate} from '../issues/format.ts';
import {CodeFrame, type CodeViewProps} from './CodePage.tsx';
import {useSource} from './hooks.ts';
import {Lines} from './Lines.tsx';
import {CodeLink, codeTo} from './nav.tsx';
import {RowList} from './RowList.tsx';

/** Seconds as "45 s", "2 m 5 s", "1 h 3 m". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${String(s)} s`;
  if (s < 3600) return `${String(Math.floor(s / 60))} m ${String(s % 60)} s`;
  return `${String(Math.floor(s / 3600))} h ${String(Math.floor((s % 3600) / 60))} m`;
}

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
          <nav aria-label="Jobs" className="sticky top-0 left-0 w-pane shrink-0 self-start border-r border-border py-2">
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
        <StepHeader expanded={!closed.has(r.s)} mark={<StatusDot tone={look.tone}/>}
          meta={st.stopped && st.started ? duration(st.stopped - st.started) : look.text}
          onToggle={() => {
            setClosed((c) => {
              const n = new Set(c);
              if (n.has(r.s)) n.delete(r.s);
              else n.add(r.s);
              return n;
            });
          }}>{st.name}</StepHeader>
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
    if (feed.closed) return <EmptyState icon={Workflow} title="Log not available" description={feed.closed === 'limit' ? 'Too many logs are open in this browser: close one and come back.' : 'This log cannot be read (it does not exist, or you may not see it any more).'}/>;
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
