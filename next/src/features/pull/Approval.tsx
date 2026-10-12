// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Workflow runs that wait for a maintainer (the classic page's trust panel):
// a fork's (or AGit) pull request by an author who is not trusted with
// Actions runs its pull_request workflows only once someone with write
// access to Actions approves them. Said wherever those runs show (the merge
// box, the Checks tab, the run page), with the decision for those who may
// make it (POST /-/sync/api/issues/{id}/action-trust).

import {observer} from 'mobx-react-lite';
import {useState} from 'react';
import {failureText, online} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {onlineOnly, reach} from '../../app/online.ts';
import {useApp, useSession} from '../../app/store.ts';
import type {APIMergeActions, APIMergeCheck} from '../../protocol/types.gen.ts';
import type {Entity} from '../../data/entity.ts';
import {poolHead} from '../../code/pull.ts';
import type {PullRequest} from '../../protocol/types.gen.ts';
import {useLoad} from '../code/hooks.ts';
import {usePool} from '../issues/cells.tsx';
import {bumpMergeCheck, mergeCheckKey, mergeCheckPath} from './mergeCheck.ts';
import {Banner, Button, Tooltip} from '@primer/react';

type Trust = 'once' | 'always' | 'deny' | 'revoke';

const DONE: Record<Trust, string> = {
  once: 'Approved: the workflows run now',
  always: 'Approved: this author’s workflows run from now on',
  deny: 'Denied: the waiting workflows were cancelled',
  revoke: 'The author is no longer trusted to run workflows',
};

/** What Forgejo says about merging the pull request (online; asked again when its answer may have changed). */
export function useMergeCheck(issue: Entity<'Issue'> | undefined, pr: PullRequest | undefined) {
  const app = useApp();
  const pool = usePool();
  const key = issue && pr && issue.id > 0 ? mergeCheckKey(pool, issue, pr, poolHead(pool, pr)) : undefined;
  return useLoad<APIMergeCheck>(key, () => undefined, async () => {
    const check = await online<APIMergeCheck>(app, {api: 'sync', path: mergeCheckPath(issue?.id ?? 0)});
    if (!check) throw new Error('Forgejo did not answer.');
    return check;
  });
}

export const APPROVAL_TITLE = 'Workflows are waiting for a maintainer’s approval';

/**
 * The approval notice of a pull request (`issueId`): `actions` is what Forgejo said (the merge check), `waiting`
 * whether the pool already holds runs that wait (said before Forgejo answers, and offline).
 */
export const ApprovalPanel = observer(function ApprovalPanel({issueId, actions, waiting}: {issueId: number; actions: APIMergeActions | undefined; waiting: boolean}) {
  const app = useApp();
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const isOnline = reach(session.data.status.connection) === 'online';
  const decide = (trust: Trust) => {
    if (busy || reach(session.data.status.connection) !== 'online' || actions?.can_decide !== true) return;
    setBusy(true);
    online(app, {method: 'POST', api: 'sync', path: `/issues/${String(issueId)}/action-trust`, body: {trust}}).then(() => {
      notify(app, {tone: 'success', title: DONE[trust]});
      bumpMergeCheck(issueId);
    }, (err: unknown) => {
      notify(app, {tone: 'danger', title: 'The decision was not saved', description: failureText(err)});
    }).finally(() => {
      setBusy(false);
    });
  };
  const why = isOnline ? undefined : onlineOnly('Approving workflows');
  const can = actions?.can_decide === true;
  if (actions?.need_approval || (waiting && actions?.need_approval !== false)) {
    return (
      <Banner variant="warning" title={APPROVAL_TITLE} description={<>
        The author of this pull request is not trusted to run workflows from a fork, so its <code>pull_request</code> workflows have not started.
        {can ? ' Check the changes first: approved workflows run with this repository’s runners.' : ' Someone with write access to this repository’s Actions must approve them.'}
        {can && why && <p>{why}</p>}
      </>} primaryAction={can && (
        <Tooltip text={why ?? 'Run the waiting workflows on this commit; later pushes need approval again'}>
          <Button variant="primary" size="small" type="button" disabled={busy} inactive={!isOnline} aria-disabled={!isOnline || busy} onClick={() => { decide('once'); }}>Approve once</Button>
        </Tooltip>
      )} secondaryAction={can && <div className="flex flex-wrap gap-2">
        <Tooltip text={why ?? 'Run them, and trust this author’s pull requests from now on'}>
          <Button size="small" type="button" disabled={busy} inactive={!isOnline} aria-disabled={!isOnline || busy} onClick={() => { decide('always'); }}>Approve always</Button>
        </Tooltip>
        <Tooltip text={why ?? 'Cancel the waiting workflows'}>
          <Button variant="invisible" size="small" type="button" disabled={busy} inactive={!isOnline} aria-disabled={!isOnline || busy} onClick={() => { decide('deny'); }}>Deny</Button>
        </Tooltip>
      </div>}/>
    );
  }
  if (actions?.poster_trust === 'explicitly' && can) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-base text-muted">
        The author of this pull request is always trusted to run workflows.
        {why && <span>{why}</span>}
        <Tooltip text={why ?? 'Each of their runs will need approval again'}>
          <Button variant="invisible" size="small" type="button" disabled={busy} inactive={!isOnline} aria-disabled={!isOnline || busy} onClick={() => { decide('revoke'); }}>Revoke</Button>
        </Tooltip>
      </p>
    );
  }
  return null;
});
