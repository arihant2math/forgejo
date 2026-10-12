// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {WorkflowIcon} from '@primer/octicons-react';
import {Heading, Link as PrimerLink} from '@primer/react';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';
import {PageColumn} from '../../app/shell/Frame.tsx';
import type {PullCommits} from '../../code/pull.ts';
import {shortSha} from '../../code/refs.ts';
import type {CommitInfo, CompareInfo} from '../../code/source.ts';
import {EmptyState} from '../../components/EmptyState.tsx';
import type {PullRequest} from '../../protocol/types.gen.ts';
import {runLook, statusLook, statusTime} from '../code/Actions.tsx';
import {CheckStatus} from '../code/CheckStatus.tsx';
import {RowList} from '../code/RowList.tsx';
import {RunControls} from '../code/RunControls.tsx';
import {commitRow} from '../code/bits.tsx';
import {withChecks} from '../code/commitChecks.tsx';
import {useLoad, useSource} from '../code/hooks.ts';
import {CodeLink, useCodeRows} from '../code/nav.tsx';
import {Unloaded} from '../code/states.tsx';
import {usePool} from '../issues/cells.tsx';
import {ApprovalPanel, useMergeCheck} from './Approval.tsx';
import {checksOf, cleanDescription} from './checks.ts';
import type {TabProps} from './types.ts';

export const CommitsTab = observer(function CommitsTab({owner, repo, pr, commits}: TabProps & {pr: PullRequest; commits: PullCommits}) {
  const rows = useCodeRows<CommitInfo>(owner, repo, (c) => `commit/${c.sha}`);
  const src = useSource();
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const key = `compare:${String(pr.base_repo_id)}:${commits.base}:${commits.head}`;
  const info = useLoad(key, () => src.peek<CompareInfo>(key), () => src.compare(pr.base_repo_id, commits.base, commits.head));
  return (
    <div ref={setScroller} className="h-full overflow-y-auto">
      {info.state !== 'ready' ? <Unloaded loaded={info} what="These commits"/> :
        <RowList items={info.value.commits} scroller={scroller} label="Commits" keyOf={(c) => c.sha}
          row={withChecks(commitRow, owner, repo, pr)}
          onOpen={rows.onOpen} linkOf={rows.linkOf}/>}
    </div>
  );
});

export const ChecksTab = observer(function ChecksTab({issue, owner, repo, pr, commits}: TabProps & {pr: PullRequest; commits: PullCommits}) {
  const pool = usePool();
  const {statuses, runs, awaitingApproval} = checksOf(pool, pr, commits.head);
  const check = useMergeCheck(awaitingApproval > 0 ? issue : undefined, pr);
  if (!statuses.length && !runs.length) return <EmptyState icon={WorkflowIcon} title="No checks" description={`Nothing reported for ${shortSha(commits.head)} on this device.`}/>;
  return (
    <PageColumn wide>
      {awaitingApproval > 0 && <ApprovalPanel issueId={issue.id} actions={check.state === 'ready' ? check.value.actions ?? undefined : undefined} waiting/>}
      {runs.length > 0 && (
        <section aria-label="Workflow runs" className="flex flex-col">
          <Heading as="h3" variant="small">Workflow runs</Heading>
          {runs.map((r) => <RunRow key={r.id} owner={owner} repo={repo} runId={r.id} runNumber={r.data.run_number}/>)}
        </section>
      )}
      {statuses.length > 0 && (
        <section aria-label="Statuses" className="flex flex-col">
          <Heading as="h3" variant="small">Statuses</Heading>
          {statuses.map((s) => {
            const look = statusLook(s.get('state') === 'error' ? 'failure' : s.get('state') === 'pending' ? 'waiting' : s.get('state'));
            const url = s.get('target_url');
            const description = cleanDescription(s.get('description'));
            return (
              <div key={s.id} className="flex items-center gap-2 border-b border-muted px-3 py-2"><CheckStatus tone={look.tone}/><span className="min-w-0 flex-1">
                {/^https?:\/\//.test(url) ? <PrimerLink href={url} target="_blank" rel="noopener noreferrer" muted className="min-w-0 truncate">{s.get('context')}</PrimerLink> : s.get('context')}
                {description && <span className="text-muted"> {description}</span>}
              </span><span className="text-muted">{look.text}</span></div>
            );
          })}
        </section>
      )}
    </PageColumn>
  );
});

const RunRow = observer(function RunRow({owner, repo, runId, runNumber}: {owner: string; repo: string; runId: number; runNumber: number}) {
  const pool = usePool();
  const run = pool.model('ActionRun').get(runId);
  const jobs = [...pool.model('ActionRunJob').by('run_id', runId)].sort((a, b) => a.id - b.id);
  if (!run) return null;
  return (
    <>
      <RunControls owner={owner} repo={repo} run={run.data} jobs={jobs.map((j) => j.data)}/>
      {jobs.map((j, i) => {
        const look = runLook(run.data, j.get('status'));
        return (
          <div key={j.id} className="flex items-center gap-1 pr-2">
          <CodeLink className="min-w-0 flex-1" owner={owner} repo={repo} to={`actions/runs/${String(runNumber)}/jobs/${String(i)}`}>
            <div className="flex items-center gap-2 border-b border-muted px-3 py-2"><CheckStatus tone={look.tone}/><span className="min-w-0 flex-1">
              {run.get('workflow_id')} / {j.get('name')}
            </span><span className="text-muted">{statusTime(look.text, j.get('started'), j.get('stopped'))}</span></div>
          </CodeLink>
          <RunControls owner={owner} repo={repo} run={run.data} jobs={jobs.map((item) => item.data)} job={j.data}/>
          </div>
        );
      })}
    </>
  );
});
