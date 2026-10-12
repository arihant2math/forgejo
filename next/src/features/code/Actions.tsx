// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Finished logs are cached by job and task so they open offline without streaming.

import {useNavigate, useSearch} from '@tanstack/react-router';
import {BranchName} from '@primer/react';
import {Banner} from '@primer/react';
import {Avatar} from '@primer/react';
import {AnsiText, LogLine as LogTextLine, StepHeader} from './LogParts.tsx';
import {CheckStatus, RunStatus, type StatusTone} from './CheckStatus.tsx';
import {observer} from 'mobx-react-lite';
import {memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {connectivity} from '../../app/online.ts';
import {useSession} from '../../app/store.ts';
import {parseAnsi} from '../../code/ansi.ts';
import {finished} from '../../code/logs.ts';
import {LogFeed} from '../../code/logfeed.ts';
import type {ActionRun, ActionRunJob, LogLine, LogStep} from '../../protocol/types.gen.ts';
import {codeSplat} from '../../code/refs.ts';
import {Sha} from '../../components/Sha.tsx';

import {ChoicePanel, type CodeChoice} from './ChoicePanel.tsx';
import {usePool} from '../issues/cells.tsx';
import {TimeAgo} from '../../components/TimeAgo.tsx';
import {CodeFrame, type CodeViewProps} from './CodePage.tsx';
import {useSource} from './hooks.ts';
import {Lines} from './Lines.tsx';
import {Artifacts} from './Artifacts.tsx';
import {CodeLink, codeTo, useCodeRows} from './nav.tsx';
import {RunControls, useRunActions} from './RunControls.tsx';
import {RowList} from './RowList.tsx';
import {DispatchWorkflowDialog, useWorkflowList} from './DispatchWorkflow.tsx';
import {awaitsApproval} from '../pull/checks.ts';
import {APPROVAL_TITLE, ApprovalPanel, useMergeCheck} from '../pull/Approval.tsx';
import {ChevronDownIcon, SyncIcon, WorkflowIcon} from '@primer/octicons-react';
import {ActionMenu, ActionList, Button, Label, NavList} from '@primer/react';
import {Tooltip} from '@primer/react';
import {RouterLink, RouterNavItem} from '../../app/routerLinks.tsx';
import {EmptyState} from '../../components/EmptyState.tsx';

/** Seconds as "45 s", "2 m 5 s", "1 h 3 m". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${String(s)} s`;
  if (s < 3600) return `${String(Math.floor(s / 60))} m ${String(s % 60)} s`;
  return `${String(Math.floor(s / 3600))} h ${String(Math.floor((s % 3600) / 60))} m`;
}

/** Returns undefined for missing start times or contradictory runner clocks. */
export function took(started: string | undefined, stopped: string | undefined, now = Date.now()): string | undefined {
  const from = started ? Date.parse(started) : NaN;
  const to = stopped ? Date.parse(stopped) : now;
  // Unset times may come as Go's zero time (year 1).
  if (!(from > 0) || Number.isNaN(to) || to < from) return undefined;
  return duration((to - from) / 1000);
}

export function statusTime(text: string, started: string | undefined, stopped: string | undefined, now = Date.now()): ReactNode {
  const t = took(started, stopped, now);
  return t ? <>{text}<span className="tabular-nums"> · {t}</span></> : text;
}

/** Returns epoch milliseconds, updating every second while ticking. */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(t);
    };
  }, [ticking]);
  return now;
}

export type Trigger = {kind: 'pull'; number: number} | {kind: 'branch' | 'tag'; name: string} | {kind: 'other'; name: string};

export function triggerOf(ref: string): Trigger {
  const pull = /^refs\/pull\/(\d+)\/(?:head|merge)$/.exec(ref);
  if (pull) return {kind: 'pull', number: Number(pull[1])};
  if (ref.startsWith('refs/heads/')) return {kind: 'branch', name: ref.slice('refs/heads/'.length)};
  if (ref.startsWith('refs/tags/')) return {kind: 'tag', name: ref.slice('refs/tags/'.length)};
  return {kind: 'other', name: ref};
}

export function eventText(event: string): string {
  return event.replace(/_/g, ' ');
}

function TriggerLink({owner, repo, gitRef}: {owner: string; repo: string; gitRef: string}) {
  const t = triggerOf(gitRef);
  switch (t.kind) {
    case 'pull':
      return <RouterLink to="/$owner/$repo/pulls/$index" params={{owner, repo, index: String(t.number)}} muted className="min-w-0 truncate">#{t.number}</RouterLink>;
    case 'branch':
    case 'tag':
      return <CodeLink owner={owner} repo={repo} to={codeSplat('src', {kind: t.kind, ref: t.name})} className="text-default hover:text-accent hover:underline">{t.name}</CodeLink>;
    default:
      return <BranchName as="span">{t.name}</BranchName>;
  }
}

type RunFilter = 'all' | 'failure' | 'running' | 'approval' | 'success' | 'cancelled';
const RUN_FILTERS: readonly {value: RunFilter; label: string}[] = [
  {value: 'all', label: 'All'}, {value: 'failure', label: 'Failed'}, {value: 'running', label: 'In progress'}, {value: 'approval', label: 'Needs approval'},
  {value: 'success', label: 'Succeeded'}, {value: 'cancelled', label: 'Cancelled'},
];

export function runMatches(filter: RunFilter, run: {status: string; need_approval: boolean}): boolean {
  if (filter === 'all') return true;
  if (filter === 'running') return !finished(run.status);
  if (filter === 'approval') return awaitsApproval(run);
  return run.status === filter;
}

export function statusLook(status: string): {tone: StatusTone; text: string} {
  switch (status) {
    case 'success':
      return {tone: 'success', text: 'Succeeded'};
    case 'failure':
      return {tone: 'danger', text: 'Failed'};
    case 'running':
      return {tone: 'running', text: 'Running'};
    case 'waiting':
      return {tone: 'warning', text: 'Waiting'};
    case 'blocked':
      return {tone: 'warning', text: 'Blocked'};
    case 'cancelled':
      return {tone: 'cancelled', text: 'Cancelled'};
    case 'skipped':
      return {tone: 'skipped', text: 'Skipped'};
    default:
      return {tone: 'muted', text: status || 'Unknown'};
  }
}

/** Distinguishes maintainer approval from other blocked states. */
export function runLook(run: {status: string; need_approval: boolean}, status = run.status): {tone: StatusTone; text: string} {
  return awaitsApproval(run) && !finished(status) ? {tone: 'warning', text: 'Needs approval'} : statusLook(status);
}

export const ActionsView = observer(function ActionsView(props: CodeViewProps) {
  const rows = useCodeRows<ActionRun>(props.owner, props.repo, (r) => `actions/runs/${String(r.run_number)}`);
  const pool = usePool();
  // Keep filters in the URL for sharing and Back navigation.
  const navigate = useNavigate();
  // The code route parses no search params: these are the address's strings (parsePlainSearch).
  const rawStatus: unknown = useSearch({strict: false, select: (s): unknown => (s as Record<string, unknown>).status});
  const rawWorkflow: unknown = useSearch({strict: false, select: (s): unknown => (s as Record<string, unknown>).workflow});
  const filter: RunFilter = RUN_FILTERS.some((f) => f.value === rawStatus) ? rawStatus as RunFilter : 'all';
  const workflow = typeof rawWorkflow === 'string' && rawWorkflow ? rawWorkflow : undefined;
  const setSearch = (patch: {status?: RunFilter; workflow?: string | undefined}) => {
    void navigate({to: '.', replace: true, search: ((prev: Record<string, unknown>) => {
      const next = {...prev, ...patch};
      if (!next.status || next.status === 'all') delete next.status;
      if (!next.workflow) delete next.workflow;
      return next;
    }) as never});
  };
  const setFilter = (status: RunFilter) => {
    setSearch({status});
  };
  const setWorkflow = (w: string | undefined) => {
    setSearch({workflow: w});
  };
  const all = [...pool.model('ActionRun').by('repo_id', props.repoId)].map((r) => r.data).sort((a, b) => b.run_number - a.run_number);
  const {list, error: workflowError, retry: retryWorkflows} = useWorkflowList(props.repoId);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const workflows = [...new Set([...all.map((r) => r.workflow_id), ...(list?.workflows.map((w) => w.file) ?? [])])].sort();
  const dispatchable = list?.can_dispatch && list.workflows.some((w) => w.file === workflow && w.dispatchable);
  const runs = all.filter((r) => runMatches(filter, r) && (workflow === undefined || r.workflow_id === workflow));
  const now = useNow(runs.some((r) => !finished(r.status)));
  const controls = <>
    <ActionMenu><ActionMenu.Button size="small">Show runs: {RUN_FILTERS.find((item) => item.value === filter)?.label}</ActionMenu.Button><ActionMenu.Overlay><ActionList selectionVariant="single">{RUN_FILTERS.map((item) => <ActionList.Item key={item.value} selected={item.value === filter} onSelect={() => { setFilter(item.value); }}>{item.label}</ActionList.Item>)}</ActionList></ActionMenu.Overlay></ActionMenu>
    {workflows.length > 0 && (
      <ChoicePanel title="Workflow" placeholder="Find a workflow…" empty="No workflow matches."
        choices={[undefined, ...workflows].map((w): CodeChoice => ({
          value: w ?? '', label: w ?? 'All workflows', checked: w === workflow, onSelect: () => {
            setWorkflow(w);
          },
        }))}
        anchor={<Button variant="invisible" size="small" leadingVisual={WorkflowIcon} trailingVisual={ChevronDownIcon} type="button">{workflow ?? 'All workflows'}</Button>}/>
    )}
    {dispatchable && <Tooltip text={!connectivity.online ? 'Running a workflow requires a connection.' : 'Run this workflow'}><Button size="small" type="button" inactive={!connectivity.online} aria-disabled={!connectivity.online} onClick={() => { if (connectivity.online) setDispatchOpen(true); }}>Run workflow</Button></Tooltip>}
    {workflowError && <Tooltip text={workflowError}><Button variant="invisible" size="small" type="button" onClick={retryWorkflows}>Retry loading workflows</Button></Tooltip>}
    {dispatchOpen && workflow && <DispatchWorkflowDialog repoId={props.repoId} owner={props.owner} repo={props.repo} file={workflow} onClose={() => { setDispatchOpen(false); }} onRun={(number) => {
      setDispatchOpen(false);
      void navigate(codeTo(props.owner, props.repo, `actions/runs/${String(number)}`));
    }}/>}
  </>;
  return (
    <CodeFrame view={props} title="Actions" controls={controls}>
      {(scroller) => (runs.length ?
        <RowList items={runs} scroller={scroller} label="Workflow runs" keyOf={(r) => String(r.id)}
          row={(r) => {
            const look = runLook(r);
            const t = took(r.started, finished(r.status) ? r.stopped : undefined, now);
            return {
              leading: <span className="inline-flex items-center" title={look.text}><CheckStatus tone={look.tone}/></span>,
              main: <>{r.title} <span className="ml-2 text-sm text-muted">{r.workflow_id} #{r.run_number}</span>{awaitsApproval(r) ? <> <Label variant="attention">Needs approval</Label></> : <span className="sr-only">, {look.text}</span>}</>,
              trailing: <>
                <TriggerText gitRef={r.ref}/>
                <span className="max-md:hidden">{eventText(r.event)}</span>
                {t && <span className="tabular-nums" title={finished(r.status) ? 'Duration' : 'Running for'}>{t}</span>}
                <TimeAgo at={r.created_at} className="w-12 text-right"/>
              </>,
            };
          }}
          onOpen={rows.onOpen} linkOf={rows.linkOf}/> :
        all.length ?
          <EmptyState icon={WorkflowIcon} title="No runs match" description="No run of this repository matches the filter." action={<Button size="small" type="button" onClick={() => {
            setFilter('all');
            setWorkflow(undefined);
          }}>Show all runs</Button>}/> :
          <EmptyState icon={WorkflowIcon} title="No workflow runs" description="This repository has no Actions runs on this device."/>)}
    </CodeFrame>
  );
});

const RunApproval = observer(function RunApproval({owner, repo, run}: {owner: string; repo: string; run: ActionRun}) {
  const pool = usePool();
  const pr = pool.model('PullRequest').get(run.pull_request_id)?.data;
  const issue = pr ? pool.model('Issue').get(pr.issue_id) : undefined;
  const check = useMergeCheck(issue, pr);
  if (issue && pr) return <ApprovalPanel issueId={issue.id} actions={check.state === 'ready' ? check.value.actions ?? undefined : undefined} waiting/>;
  return (
    <Banner variant="warning" title={APPROVAL_TITLE} description={<>
      This run of a pull request from a fork starts once a maintainer approves it on the pull request <TriggerLink owner={owner} repo={repo} gitRef={run.ref}/>.
    </>}/>
  );
});

function TriggerText({gitRef}: {gitRef: string}) {
  const t = triggerOf(gitRef);
  return <span className="font-mono">{t.kind === 'pull' ? `#${String(t.number)}` : t.name}</span>;
}

function findRun(pool: ReturnType<typeof usePool>, repoId: number, n: number): ActionRun | undefined {
  for (const r of pool.model('ActionRun').by('repo_id', repoId)) if (r.data.run_number === n) return r.data;
  return undefined;
}

export const RunView = observer(function RunView(props: CodeViewProps & {run: number; job: number}) {
  const pool = usePool();
  const run = findRun(pool, props.repoId, props.run);
  const jobs = run ? [...pool.model('ActionRunJob').by('run_id', run.id)].map((j) => j.data).sort((a, b) => a.id - b.id) : [];
  const first = props.job >= 0 ? props.job : (() => {
    const failed = jobs.findIndex((j) => j.status === 'failure');
    if (failed >= 0) return failed;
    const running = jobs.findIndex((j) => j.status === 'running');
    return running >= 0 ? running : 0;
  })();
  const job = jobs[first];
  const look = run ? runLook(run) : statusLook('');
  const now = useNow(jobs.some((j) => !finished(j.status)));
  const actor = run ? pool.model('User').get(run.trigger_user_id)?.data : undefined;
  return (
    <CodeFrame view={props} title={run ? `${run.title} #${String(run.run_number)}` : `Run #${String(props.run)}`} controls={run && <>
      <RunStatus tone={look.tone}>{statusTime(look.text, run.started, finished(run.status) ? run.stopped : undefined, now)}</RunStatus>
      <RunControls owner={props.owner} repo={props.repo} run={run} jobs={jobs} palette/>
    </>}>
      {(scroller) => (!run ?
        <EmptyState icon={WorkflowIcon} title="Run not found" description="This run does not exist, or is not on this device."/> :
        <div className="flex min-h-full flex-col">
          <p className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-default px-4 py-2 text-base text-muted">
            <span className="font-mono text-default">{run.workflow_id}</span>
            <span>{eventText(run.event)}</span>
            <TriggerLink owner={props.owner} repo={props.repo} gitRef={run.ref}/>
            {run.commit_sha && <CodeLink owner={props.owner} repo={props.repo} to={`commit/${run.commit_sha}`} className="text-sm text-muted hover:text-accent hover:underline"><Sha sha={run.commit_sha}/></CodeLink>}
            {actor && <span className="flex items-center gap-2 text-default">{actor.avatar_url ? <Avatar alt={actor.full_name || actor.login} src={actor.avatar_url} size={20}/> : null}{actor.login}</span>}
            <TimeAgo at={run.created_at} className="text-sm"/>
          </p>
          {awaitsApproval(run) && <div className="border-b border-default px-4 py-2"><RunApproval owner={props.owner} repo={props.repo} run={run}/></div>}
          <div className="flex min-h-full flex-col @xl:flex-row">
          <div className="shrink-0 border-b border-default p-2 @xl:sticky @xl:top-0 @xl:left-0 @xl:w-pane @xl:self-start @xl:border-r @xl:border-b-0">
            {/* The visible heading names the navigation, so 'Jobs' is announced once. */}
            <NavList>
              <NavList.Heading as="h2">Jobs</NavList.Heading>
              {jobs.map((j, i) => <JobItem key={j.id} owner={props.owner} repo={props.repo} run={run} jobs={jobs} job={j} index={i} current={i === first} now={now}/>)}
            </NavList>
          </div>
          <section aria-label="Log" className="min-w-0 flex-1">
            {job ? <JobLog key={`${String(job.id)}:${String(job.task_id)}`} repoId={props.repoId} job={job} scroller={scroller} approval={awaitsApproval(run)}/> :
              <EmptyState icon={WorkflowIcon} title="No such job"/>}
          </section>
          </div>
          <Artifacts key={run.id} {...props} runId={run.id} done={finished(run.status)} scroller={scroller}/>
        </div>)}
    </CodeFrame>
  );
});

const JobItem = observer(function JobItem({owner, repo, run, jobs, job, index, current, now}: {
  owner: string; repo: string; run: ActionRun; jobs: readonly ActionRunJob[]; job: ActionRunJob; index: number; current: boolean; now: number;
}) {
  // The current job's re-run is the palette's "Re-run job".
  const {reason, pending, complete, execute} = useRunActions(owner, repo, run, jobs, job, current);
  const look = runLook(run, job.status);
  const t = took(job.started, finished(job.status) ? job.stopped : undefined, now);
  return (
    <RouterNavItem {...codeTo(owner, repo, `actions/runs/${String(run.run_number)}/jobs/${String(index)}`)} aria-current={current ? 'page' : false} activeProps={{}}>
      <NavList.LeadingVisual><CheckStatus tone={look.tone}/></NavList.LeadingVisual>
      {job.name}<span className="sr-only">, {look.text}</span>
      {t && <NavList.TrailingVisual><span className="tabular-nums">{t}</span></NavList.TrailingVisual>}
      {complete && (!reason || pending) && <NavList.TrailingAction icon={SyncIcon} label={`Re-run ${job.name}`} loading={Boolean(pending)} onClick={() => { void execute('job'); }}/>}
    </RouterNavItem>
  );
});

function useJobLog(repoId: number, job: ActionRunJob): LogFeed {
  const src = useSource();
  const {data} = useSession();
  // The caller must key by job and task so each rerun gets a fresh feed.
  const [feed] = useState(() => new LogFeed(data, src, repoId, job));
  const online = connectivity.online;
  useEffect(() => feed.start(online), [feed, online]);
  useEffect(() => () => {
    feed.close();
  }, [feed]);
  useSyncExternalStore(feed.subscribe, feed.snapshot);
  return feed;
}

type LogRow = {t: 'step'; s: number} | {t: 'step-space'} | {t: 'line'; l: number};

/** Each step takes a header and a spacer row (two 20 px slots, keeping log text on its line grid), then its received lines unless folded. */
export interface LogLayout {
  rows: number;
  /** The header row of each step; empty without steps (row i is line i). */
  starts: number[];
}

export function logLayout(steps: readonly LogStep[], closed: ReadonlySet<number>, count: number): LogLayout {
  if (!steps.length) return {rows: count, starts: []};
  const starts: number[] = [];
  let rows = 0;
  steps.forEach((st, s) => {
    starts.push(rows);
    rows += 2 + (closed.has(s) ? 0 : Math.max(0, Math.min(count, st.log_index + st.log_length) - st.log_index));
  });
  return {rows, starts};
}

export function logRow(layout: LogLayout, steps: readonly LogStep[], i: number): LogRow | undefined {
  if (i < 0 || i >= layout.rows) return undefined;
  if (!layout.starts.length) return {t: 'line', l: i};
  let lo = 0;
  let hi = layout.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((layout.starts[mid] ?? 0) <= i) lo = mid;
    else hi = mid - 1;
  }
  const off = i - (layout.starts[lo] ?? 0);
  return off === 0 ? {t: 'step', s: lo} : off === 1 ? {t: 'step-space'} : {t: 'line', l: (steps[lo]?.log_index ?? 0) + off - 2};
}

const LogTextRow = memo(function LogTextRow({line, n}: {line: LogLine | undefined; n: number}) {
  return <LogTextLine number={n}><AnsiText spans={ansiOf(line)}/></LogTextLine>;
});

const StepRow = memo(function StepRow({step, index, expanded, onToggle}: {step: LogStep; index: number; expanded: boolean; onToggle: (index: number) => void}) {
  const look = statusLook(step.status);
  return (
    <StepHeader expanded={expanded} mark={<CheckStatus tone={look.tone}/>} meta={step.stopped && step.started ? duration(step.stopped - step.started) : look.text}
      onToggle={() => { onToggle(index); }}>{step.name}</StepHeader>
  );
});

const JobLog = observer(function JobLog({repoId, job, scroller, approval = false}: {repoId: number; job: ActionRunJob; scroller: HTMLDivElement | null; approval?: boolean}) {
  const feed = useJobLog(repoId, job);
  const {log, source} = feed;
  const [closed, setClosed] = useState<ReadonlySet<number>>(() => new Set());
  const count = log.lines.length;
  const steps = log.steps;
  // Fold passed steps once so a failed job opens on the failure.
  const folded = useRef(false);
  useEffect(() => {
    if (folded.current || !steps.length || job.status !== 'failure') return;
    folded.current = true;
    if (steps.some((st) => st.status === 'failure')) setClosed(new Set(steps.flatMap((st, i) => (st.status === 'success' || st.status === 'skipped' ? [i] : []))));
  }, [steps, job.status]);
  // O(steps) per streamed frame; rows map to lines arithmetically.
  const layout = useMemo(() => logLayout(steps, closed, count), [steps, closed, count]);
  const toggle = useCallback((s: number) => {
    setClosed((c) => {
      const n = new Set(c);
      if (n.has(s)) n.delete(s);
      else n.add(s);
      return n;
    });
  }, []);
  const lines = log.lines;
  // Rows are memoized by their line, so a growing log re-renders only what changed.
  const line = useCallback((i: number): ReactNode => {
    const r = logRow(layout, steps, i);
    if (!r || r.t === 'step-space') return null;
    if (r.t === 'step') {
      const st = steps[r.s];
      return st ? <StepRow step={st} index={r.s} expanded={!closed.has(r.s)} onToggle={toggle}/> : null;
    }
    return <LogTextRow line={lines[r.l]} n={r.l + 1}/>;
  }, [layout, steps, closed, lines, toggle]);
  if (!count && !steps.length) {
    if (log.expired) return <EmptyState icon={WorkflowIcon} title="Log removed" description="This log was removed by the instance's log retention." spacious={false}/>;
    if (source === 'none' && !connectivity.online) return <EmptyState icon={WorkflowIcon} title="Not available offline" description="This job's log is not on this device." spacious={false}/>;
    if (feed.closed) return <EmptyState icon={WorkflowIcon} title="Log not available" description={feed.closed === 'limit' ? 'Too many logs are open in this browser: close one and come back.' : 'This log cannot be read (it does not exist, or you may not see it any more).'} spacious={false}/>;
    return <p className="px-4 py-3 text-sm text-muted">{job.task_id ? 'Waiting for the log…' : approval ? 'Not started: this run waits for a maintainer’s approval.' : 'Waiting for a runner…'}</p>;
  }
  return <Lines count={layout.rows} scroller={scroller} line={line} label={`Log of ${job.name}`} follow={!finished(job.status)}/>;
});

// Received lines are immutable, so parsed ANSI spans can be cached by identity.
const ansiCache = new WeakMap<LogLine, ReturnType<typeof parseAnsi>>();

function ansiOf(l: LogLine | undefined): ReturnType<typeof parseAnsi> {
  if (!l) return [];
  let s = ansiCache.get(l);
  if (!s) ansiCache.set(l, s = parseAnsi(l.c));
  return s;
}
