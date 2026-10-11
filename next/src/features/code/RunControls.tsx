// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {observer} from 'mobx-react-lite';
import {useEffect, useRef, useState} from 'react';
import {canWrite} from '../../app/access.ts';
import {failureText, online} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {connectivity} from '../../app/online.ts';
import {useShortcut} from '../../app/shortcuts/index.ts';
import {useApp, useSession} from '../../app/store.ts';
import {finished} from '../../code/logs.ts';
import type {ActionRun, ActionRunJob} from '../../protocol/types.gen.ts';
import {ChevronDownIcon} from '@primer/octicons-react';
import {Button, IconButton, Tooltip, ActionMenu, ActionList} from '@primer/react';

type Operation = 'all' | 'failed' | 'job' | 'cancel';

export function actionPaths(owner: string, repo: string, run: ActionRun, jobs: readonly ActionRunJob[], operation: Operation): string[] {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions`;
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

export const RunControls = observer(function RunControls({owner, repo, run, jobs, job, palette = false}: {
  owner: string; repo: string; run: ActionRun; jobs: readonly ActionRunJob[]; job?: ActionRunJob; palette?: boolean;
}) {
  const app = useApp();
  const session = useSession();
  const [pending, setPending] = useState<{label: string; echo: string} | undefined>();
  const busy = useRef(false);
  const echo = JSON.stringify([run, ...(job ? [job] : jobs)]);
  useEffect(() => {
    if (pending && pending.echo !== echo) setPending(undefined);
  }, [echo, pending]);
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
  if (job) return <Tooltip text={reason ?? (!complete ? (run.need_approval ? 'This run waits for a maintainer’s approval.' : 'Wait for this job to finish.') : `Re-run ${job.name}`)}><Button variant="invisible" size="small" type="button" inactive={Boolean(reason) || !complete} aria-disabled={Boolean(reason) || !complete} onClick={() => { void execute('job'); }}>{pending?.label ?? 'Re-run job'}</Button></Tooltip>;
  return <div className="flex items-center gap-1">
    {complete ? <>
      <Tooltip text={reason ?? 'Re-run all jobs' }><Button size="small" type="button" inactive={Boolean(reason)} aria-disabled={Boolean(reason)} onClick={() => { void execute('all'); }}>{pending?.label ?? 'Re-run'}</Button></Tooltip>
      <ActionMenu><ActionMenu.Anchor><IconButton icon={ChevronDownIcon} size="small" type="button" inactive={Boolean(reason)} aria-disabled={Boolean(reason)} aria-label="Re-run options" {...(reason ? {description: reason} : {})}/></ActionMenu.Anchor>
        <ActionMenu.Overlay><ActionList><ActionList.Item onSelect={() => { void execute('all'); }}>Re-run all jobs</ActionList.Item><ActionList.Item disabled={!failed} onSelect={() => { void execute('failed'); }}>Re-run failed jobs</ActionList.Item></ActionList></ActionMenu.Overlay>
      </ActionMenu>
    </> : <Tooltip text={reason ?? 'Cancel workflow' }><Button size="small" type="button" inactive={Boolean(reason)} aria-disabled={Boolean(reason)} onClick={() => { void execute('cancel'); }}>{pending?.label ?? 'Cancel workflow'}</Button></Tooltip>}
  </div>;
});
