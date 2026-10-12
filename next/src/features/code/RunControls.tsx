// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {apiRepoPath} from '../../app/paths.ts';
import {observer} from 'mobx-react-lite';
import {useRef, useState} from 'react';
import {canWrite} from '../../app/access.ts';
import {failureText, online} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {connectivity} from '../../app/online.ts';
import {useShortcut} from '../../app/shortcuts/index.ts';
import {useApp, useSession} from '../../app/store.ts';
import {finished} from '../../code/logs.ts';
import type {ActionRun, ActionRunJob} from '../../protocol/types.gen.ts';
import {SyncIcon, TriangleDownIcon} from '@primer/octicons-react';
import {Button, IconButton, Tooltip, ActionMenu, ActionList} from '@primer/react';

type Operation = 'all' | 'failed' | 'job' | 'cancel';

export function actionPaths(owner: string, repo: string, run: ActionRun, jobs: readonly ActionRunJob[], operation: Operation): string[] {
  const base = `${apiRepoPath(owner, repo)}/actions`;
  if (operation === 'all' || operation === 'cancel') return [`${base}/runs/${String(run.id)}/${operation === 'all' ? 'rerun' : 'cancel'}`];
  const byName = new Map(jobs.map((j) => [j.job_id, j]));
  const hasFailedAncestor = (job: ActionRunJob, seen = new Set<string>()): boolean => job.needs.some((name) => {
    if (seen.has(name)) return false;
    seen.add(name);
    const parent = byName.get(name);
    return !!parent && (parent.status === 'failure' || hasFailedAncestor(parent, seen));
  });
  // A job rerun also resets its dependents: do not rerun those twice.
  return jobs.filter((j) => operation === 'job' || (j.status === 'failure' && !hasFailedAncestor(j))).map((j) => `${base}/jobs/${String(j.id)}/rerun`);
}

/** Re-run and cancel state for a run, or for one of its jobs; `palette` binds the shortcuts. */
export function useRunActions(owner: string, repo: string, run: ActionRun, jobs: readonly ActionRunJob[], job: ActionRunJob | undefined, palette: boolean) {
  const app = useApp();
  const session = useSession();
  const [requested, setPending] = useState<{label: string; echo: string} | undefined>();
  const busy = useRef(false);
  const echo = JSON.stringify([run, ...(job ? [job] : jobs)]);
  // A request is pending until the run or job changes.
  const pending = requested?.echo === echo ? requested : undefined;
  const reason = !canWrite(session, run.repo_id) ? 'Repository write access is required.' : !connectivity.online ? 'Connect to Forgejo to manage runs.' : pending ? pending.label : undefined;
  const complete = finished(job?.status ?? run.status);
  const failed = jobs.some((j) => j.status === 'failure');
  const execute = async (operation: Operation) => {
    if (reason || busy.current || (operation === 'cancel' ? complete : !complete) || (operation === 'failed' && !failed)) return;
    busy.current = true;
    setPending({label: operation === 'cancel' ? 'Cancelling…' : 'Re-running…', echo});
    try {
      // Sequential requests avoid racing the backend's dependent-job resets.
      for (const path of actionPaths(owner, repo, run, job ? [job] : jobs, operation)) await online(app, {api: 'v1', method: 'POST', path});
    } catch (err) {
      setPending(undefined);
      notify(app, {tone: 'danger', title: failureText(err)});
    } finally {
      busy.current = false;
    }
  };
  useShortcut('actions.rerunAll', () => { void execute('all'); }, palette && !job, () => !reason && complete);
  useShortcut('actions.rerunFailed', () => { void execute('failed'); }, palette && !job, () => !reason && complete && failed);
  useShortcut('actions.cancel', () => { void execute('cancel'); }, palette && !job, () => !reason && !complete);
  useShortcut('actions.rerunJob', () => { void execute('job'); }, palette && !!job, () => !reason && complete);
  return {reason, pending: pending?.label, complete, failed, execute};
}

/** GitHub's run header control: "Re-run jobs" with all/failed once finished, "Cancel workflow" before; a job gets a re-run icon. */
export const RunControls = observer(function RunControls({owner, repo, run, jobs, job, palette = false}: {
  owner: string; repo: string; run: ActionRun; jobs: readonly ActionRunJob[]; job?: ActionRunJob; palette?: boolean;
}) {
  const {reason, pending, complete, failed, execute} = useRunActions(owner, repo, run, jobs, job, palette);
  if (job) {
    const why = reason ?? (!complete ? (run.need_approval ? 'This run waits for a maintainer’s approval.' : 'Wait for this job to finish.') : undefined);
    return <IconButton icon={SyncIcon} variant="invisible" size="small" type="button" aria-label={`Re-run ${job.name}`} {...(why ? {description: why} : {})}
      inactive={Boolean(why)} aria-disabled={Boolean(why)} onClick={() => { void execute('job'); }}/>;
  }
  if (!complete) {
    return <Tooltip text={reason ?? 'Cancel workflow'}><Button size="small" type="button" inactive={Boolean(reason)} aria-disabled={Boolean(reason)} onClick={() => { void execute('cancel'); }}>{pending ?? 'Cancel workflow'}</Button></Tooltip>;
  }
  if (reason) return <Tooltip text={reason}><Button size="small" type="button" trailingVisual={TriangleDownIcon} inactive aria-disabled>{pending ?? 'Re-run jobs'}</Button></Tooltip>;
  return (
    <ActionMenu>
      <ActionMenu.Button size="small">Re-run jobs</ActionMenu.Button>
      <ActionMenu.Overlay align="end"><ActionList>
        <ActionList.Item disabled={!failed} onSelect={() => { void execute('failed'); }}>Re-run failed jobs</ActionList.Item>
        <ActionList.Item onSelect={() => { void execute('all'); }}>Re-run all jobs</ActionList.Item>
      </ActionList></ActionMenu.Overlay>
    </ActionMenu>
  );
});
