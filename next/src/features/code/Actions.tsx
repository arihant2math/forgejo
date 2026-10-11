// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Actions (PLAN §5.7): runs and jobs are synced (ActionRun, ActionRunJob in
// the repository's group: their status changes live, offline too); a job's
// log streams over the sync session (B9 log tail, through the leader tab)
// and, once the job finished, is kept by (job, task) in the code cache, so
// a finished log opens offline and never streams again.

import {useNavigate, useSearch} from '@tanstack/react-router';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {connectivity} from '../../app/online.ts';
import {useSession} from '../../app/store.ts';
import {parseAnsi} from '../../code/ansi.ts';
import {finished} from '../../code/logs.ts';
import {LogFeed} from '../../code/logfeed.ts';
import type {ActionRun, ActionRunJob, LogLine} from '../../protocol/types.gen.ts';
import {codeSplat, shortSha} from '../../code/refs.ts';
import {
  AnsiText, Avatar, Callout, CodeLine, CommandPopover, LineNo, ListRow, type PickOption, SegmentedControl, Status, StatusDot, type StatusTone, StepHeader, TextLink,
} from '../../ui/index.ts';
import {usePool} from '../issues/cells.tsx';
import {ago, fullDate} from '../issues/format.ts';
import {CodeFrame, type CodeViewProps} from './CodePage.tsx';
import {useSource} from './hooks.ts';
import {Lines} from './Lines.tsx';
import {Artifacts} from './Artifacts.tsx';
import {CodeLink, codeTo, useCodeRows} from './nav.tsx';
import {RunControls} from './RunControls.tsx';
import {RowList} from './RowList.tsx';
import {DispatchWorkflowDialog, useWorkflowList} from './DispatchWorkflow.tsx';
import {awaitsApproval} from '../pull/checks.ts';
import {APPROVAL_TITLE, ApprovalPanel, useMergeCheck} from '../pull/Approval.tsx';
import {ChevronDownIcon, WorkflowIcon} from '@primer/octicons-react';
import {Button, Label} from '@primer/react';
import {OptionalTooltip} from '../../app/OptionalTooltip.tsx';
import {RouterLink} from '../../app/RouterLinkButton.tsx';
import {Blankslate} from '@primer/react/experimental';

/** Seconds as "45 s", "2 m 5 s", "1 h 3 m". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${String(s)} s`;
  if (s < 3600) return `${String(Math.floor(s / 60))} m ${String(s % 60)} s`;
  return `${String(Math.floor(s / 3600))} h ${String(Math.floor((s % 3600) / 60))} m`;
}

/**
 * How long a run or job took, or has been going ("2 m 5 s"), from its start and stop times. Undefined when
 * it has not started, or when the times contradict each other (a runner's clock skew: never a negative time).
 */
export function took(started: string | undefined, stopped: string | undefined, now = Date.now()): string | undefined {
  const from = started ? Date.parse(started) : NaN;
  const to = stopped ? Date.parse(stopped) : now;
  // Unset times may come as Go's zero time (year 1).
  if (!(from > 0) || Number.isNaN(to) || to < from) return undefined;
  return duration((to - from) / 1000);
}

/** A status in words with its time: "Succeeded · 45 s" (`now`: a running one's clock, see useNow). */
export function statusTime(text: string, started: string | undefined, stopped: string | undefined, now = Date.now()): ReactNode {
  const t = took(started, stopped, now);
  return t ? <>{text}<span className="tabular-nums"> · {t}</span></> : text;
}

/** The time, every second while `ticking` (a run or job is going: its time counts up), else fixed. */
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

/** What started a run: a pull request ("refs/pull/91/head"), a branch or a tag. */
export type Trigger = {kind: 'pull'; number: number} | {kind: 'branch' | 'tag'; name: string} | {kind: 'other'; name: string};

export function triggerOf(ref: string): Trigger {
  const pull = /^refs\/pull\/(\d+)\/(?:head|merge)$/.exec(ref);
  if (pull) return {kind: 'pull', number: Number(pull[1])};
  if (ref.startsWith('refs/heads/')) return {kind: 'branch', name: ref.slice('refs/heads/'.length)};
  if (ref.startsWith('refs/tags/')) return {kind: 'tag', name: ref.slice('refs/tags/'.length)};
  return {kind: 'other', name: ref};
}

/** An event in words: "pull_request_sync" → "pull request sync". */
export function eventText(event: string): string {
  return event.replace(/_/g, ' ');
}

/** Where a run came from, as a link: its pull request, branch or tag. */
function TriggerLink({owner, repo, gitRef}: {owner: string; repo: string; gitRef: string}) {
  const t = triggerOf(gitRef);
  switch (t.kind) {
    case 'pull':
      return <RouterLink to="/$owner/$repo/pulls/$index" params={{owner, repo, index: String(t.number)}} muted className="min-w-0 truncate">#{t.number}</RouterLink>;
    case 'branch':
    case 'tag':
      return <TextLink><CodeLink owner={owner} repo={repo} to={codeSplat('src', {kind: t.kind, ref: t.name})}><span className="font-mono">{t.name}</span></CodeLink></TextLink>;
    default:
      return <span className="font-mono">{t.name}</span>;
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

/**
 * A run's (or one of its jobs') status, saying when it is held for a maintainer's approval (a fork's pull request by
 * an author not trusted with Actions: "Blocked" alone read like any wait).
 */
export function runLook(run: {status: string; need_approval: boolean}, status = run.status): {tone: StatusTone; text: string} {
  return awaitsApproval(run) && !finished(status) ? {tone: 'warning', text: 'Needs approval'} : statusLook(status);
}

export const ActionsView = observer(function ActionsView(props: CodeViewProps) {
  const rows = useCodeRows<ActionRun>(props.owner, props.repo, (r) => `actions/runs/${String(r.run_number)}`);
  const pool = usePool();
  // In the address (?status=failure&workflow=ci.yml): a filtered list can be linked, and Back finds it filtered.
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
    <SegmentedControl label="Show runs" value={filter} onChange={setFilter} options={RUN_FILTERS}/>
    {workflows.length > 0 && (
      <CommandPopover width="md" label="Workflow" placeholder="Find a workflow…" empty="No workflow matches."
        options={[undefined, ...workflows].map((w): PickOption => ({
          value: w ?? '', label: w ?? 'All workflows', checked: w === workflow, onSelect: () => {
            setWorkflow(w);
          },
        }))}
        trigger={<Button variant="invisible" size="small" leadingVisual={WorkflowIcon} type="button">{workflow ?? 'All workflows'}<ChevronDownIcon size={12} className="shrink-0"/></Button>}/>
    )}
    {dispatchable && <OptionalTooltip text={!connectivity.online ? 'Running a workflow requires a connection.' : undefined}><Button size="small" type="button" disabled={!connectivity.online} onClick={() => { setDispatchOpen(true); }}>Run workflow</Button></OptionalTooltip>}
    {workflowError && <OptionalTooltip text={workflowError}><Button variant="invisible" size="small" type="button" onClick={retryWorkflows}>Retry loading workflows</Button></OptionalTooltip>}
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
              leading: <span title={look.text}><StatusDot tone={look.tone}/></span>,
              main: <>{r.title} <span className="text-muted">{r.workflow_id} #{r.run_number}</span>{awaitsApproval(r) ? <> <Label variant="attention">Needs approval</Label></> : <span className="sr-only">, {look.text}</span>}</>,
              trailing: <>
                <TriggerText gitRef={r.ref}/>
                <span className="max-md:hidden">{eventText(r.event)}</span>
                {t && <span className="tabular-nums" title={finished(r.status) ? 'Duration' : 'Running for'}>{t}</span>}
                <time dateTime={r.created_at} title={fullDate(r.created_at)}>{ago(r.created_at)}</time>
              </>,
            };
          }}
          onOpen={rows.onOpen} linkOf={rows.linkOf}/> :
        all.length ?
          <Blankslate><Blankslate.Visual><WorkflowIcon size={24}/></Blankslate.Visual><Blankslate.Heading>No runs match</Blankslate.Heading><Blankslate.Description>No run of this repository matches the filter.</Blankslate.Description>{<Button size="small" type="button" onClick={() => {
            setFilter('all');
            setWorkflow(undefined);
          }}>Show all runs</Button>}</Blankslate> :
          <Blankslate><Blankslate.Visual><WorkflowIcon size={24}/></Blankslate.Visual><Blankslate.Heading>No workflow runs</Blankslate.Heading><Blankslate.Description>This repository has no Actions runs on this device.</Blankslate.Description></Blankslate>)}
    </CodeFrame>
  );
});

/**
 * A run held for approval: the pull request's approval panel (approve, deny) when the pull request is on this device,
 * else where to go.
 */
const RunApproval = observer(function RunApproval({owner, repo, run}: {owner: string; repo: string; run: ActionRun}) {
  const pool = usePool();
  const pr = pool.model('PullRequest').get(run.pull_request_id)?.data;
  const issue = pr ? pool.model('Issue').get(pr.issue_id) : undefined;
  const check = useMergeCheck(issue, pr);
  if (issue && pr) return <ApprovalPanel issueId={issue.id} actions={check.state === 'ready' ? check.value.actions ?? undefined : undefined} waiting/>;
  return (
    <Callout tone="warning" title={APPROVAL_TITLE}>
      This run of a pull request from a fork starts once a maintainer approves it on the pull request <TriggerLink owner={owner} repo={repo} gitRef={run.ref}/>.
    </Callout>
  );
});

/** A run's trigger in a row (the row is the link: plain text, "#91" or the branch). */
function TriggerText({gitRef}: {gitRef: string}) {
  const t = triggerOf(gitRef);
  return <span className="font-mono">{t.kind === 'pull' ? `#${String(t.number)}` : t.name}</span>;
}

/** A run of the repository by its number (observes the repository's runs). */
function findRun(pool: ReturnType<typeof usePool>, repoId: number, n: number): ActionRun | undefined {
  for (const r of pool.model('ActionRun').by('repo_id', repoId)) if (r.data.run_number === n) return r.data;
  return undefined;
}

export const RunView = observer(function RunView(props: CodeViewProps & {run: number; job: number}) {
  const pool = usePool();
  const run = findRun(pool, props.repoId, props.run);
  const jobs = run ? [...pool.model('ActionRunJob').by('run_id', run.id)].map((j) => j.data).sort((a, b) => a.id - b.id) : [];
  // A run opened without a job shows the one to look at first: the first that failed, else one still going.
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
      <Status tone={look.tone}>{statusTime(look.text, run.started, finished(run.status) ? run.stopped : undefined, now)}</Status>
      <RunControls owner={props.owner} repo={props.repo} run={run} jobs={jobs} palette/>
      {job && <RunControls owner={props.owner} repo={props.repo} run={run} jobs={jobs} job={job} palette/>}
    </>}>
      {(scroller) => (!run ?
        <Blankslate><Blankslate.Visual><WorkflowIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Run not found</Blankslate.Heading><Blankslate.Description>This run does not exist, or is not on this device.</Blankslate.Description></Blankslate> :
        <div className="flex min-h-full flex-col">
          {/* What started it: the workflow, the event, its pull request or branch, the commit, who. */}
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-default px-4 py-2 text-sm text-muted">
            <span className="font-mono text-default">{run.workflow_id}</span>
            <span>{eventText(run.event)}</span>
            <TriggerLink owner={props.owner} repo={props.repo} gitRef={run.ref}/>
            {run.commit_sha && <TextLink><CodeLink owner={props.owner} repo={props.repo} to={`commit/${run.commit_sha}`}><span className="font-mono tabular-nums">{shortSha(run.commit_sha)}</span></CodeLink></TextLink>}
            {actor && <span className="flex items-center gap-1.5"><Avatar name={actor.full_name || actor.login} src={actor.avatar_url === '' ? undefined : actor.avatar_url} size="sm"/>{actor.login}</span>}
            <time dateTime={run.created_at} title={fullDate(run.created_at)}>{ago(run.created_at)}</time>
          </p>
          {awaitsApproval(run) && <div className="border-b border-default px-4 py-2"><RunApproval owner={props.owner} repo={props.repo} run={run}/></div>}
          <div className="flex min-h-full flex-col @xl:flex-row">
          <nav aria-label="Jobs" className="shrink-0 border-b border-default py-2 @xl:sticky @xl:top-0 @xl:left-0 @xl:w-pane @xl:self-start @xl:border-r @xl:border-b-0">
            {jobs.map((j, i) => {
              const jl = runLook(run, j.status);
              return (
                <div key={j.id} className="flex items-center gap-1 pr-2">
                <CodeLink className="min-w-0 flex-1" owner={props.owner} repo={props.repo} to={`actions/runs/${String(props.run)}/jobs/${String(i)}`} exact>
                  <ListRow role="presentation" active={i === first} leading={<StatusDot tone={jl.tone}/>} trailing={statusTime(jl.text, j.started, finished(j.status) ? j.stopped : undefined, now)}>{j.name}</ListRow>
                </CodeLink>
                <RunControls owner={props.owner} repo={props.repo} run={run} jobs={jobs} job={j}/>
                </div>
              );
            })}
          </nav>
          <section aria-label="Log" className="min-w-0 flex-1">
            {job ? <JobLog key={`${String(job.id)}:${String(job.task_id)}`} repoId={props.repoId} job={job} scroller={scroller} approval={awaitsApproval(run)}/> :
              <Blankslate><Blankslate.Visual><WorkflowIcon size={24}/></Blankslate.Visual><Blankslate.Heading>No such job</Blankslate.Heading></Blankslate>}
          </section>
          </div>
          <Artifacts key={run.id} {...props} runId={run.id} done={finished(run.status)} scroller={scroller}/>
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

const JobLog = observer(function JobLog({repoId, job, scroller, approval = false}: {repoId: number; job: ActionRunJob; scroller: HTMLDivElement | null; approval?: boolean}) {
  const feed = useJobLog(repoId, job);
  const {log, source} = feed;
  const [closed, setClosed] = useState<ReadonlySet<number>>(() => new Set());
  const count = log.lines.length;
  const steps = log.steps;
  // A failed job opens on what failed: the steps that passed start folded (once, when the steps are known).
  const folded = useRef(false);
  useEffect(() => {
    if (folded.current || !steps.length || job.status !== 'failure') return;
    folded.current = true;
    if (steps.some((st) => st.status === 'failure')) setClosed(new Set(steps.flatMap((st, i) => (st.status === 'success' || st.status === 'skipped' ? [i] : []))));
  }, [steps, job.status]);
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
    if (log.expired) return <Blankslate><Blankslate.Visual><WorkflowIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Log removed</Blankslate.Heading><Blankslate.Description>This log was removed by the instance's log retention.</Blankslate.Description></Blankslate>;
    if (source === 'none' && !connectivity.online) return <Blankslate><Blankslate.Visual><WorkflowIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Not available offline</Blankslate.Heading><Blankslate.Description>This job's log is not on this device.</Blankslate.Description></Blankslate>;
    if (feed.closed) return <Blankslate><Blankslate.Visual><WorkflowIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Log not available</Blankslate.Heading><Blankslate.Description>{feed.closed === 'limit' ? 'Too many logs are open in this browser: close one and come back.' : 'This log cannot be read (it does not exist, or you may not see it any more).'}</Blankslate.Description></Blankslate>;
    return <p className="px-4 py-3 text-sm text-muted">{job.task_id ? 'Waiting for the log…' : approval ? 'Not started: this run waits for a maintainer’s approval.' : 'Waiting for a runner…'}</p>;
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
