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
import {Button, Callout, Code} from '../../ui/index.ts';
import type {Entity} from '../../data/entity.ts';
import {poolHead} from '../../code/pull.ts';
import type {PullRequest} from '../../protocol/types.gen.ts';
import {useLoad} from '../code/hooks.ts';
import {usePool} from '../issues/cells.tsx';
import {bumpMergeCheck, mergeCheckKey, mergeCheckPath} from './mergeCheck.ts';

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
      <Callout tone="warning" title={APPROVAL_TITLE} actions={can && <>
        <Button size="sm" variant="primary" disabled={busy || !isOnline} tooltip={why ?? 'Run the waiting workflows on this commit; later pushes need approval again'} onClick={() => {
          decide('once');
        }}>Approve once</Button>
        <Button size="sm" disabled={busy || !isOnline} tooltip={why ?? 'Run them, and trust this author’s pull requests from now on'} onClick={() => {
          decide('always');
        }}>Approve always</Button>
        <Button size="sm" variant="ghost" disabled={busy || !isOnline} tooltip={why ?? 'Cancel the waiting workflows'} onClick={() => {
          decide('deny');
        }}>Deny</Button>
      </>}>
        The author of this pull request is not trusted to run workflows from a fork, so its <Code>pull_request</Code> workflows have not started.
        {can ? ' Check the changes first: approved workflows run with this repository’s runners.' : ' Someone with write access to this repository’s Actions must approve them.'}
      </Callout>
    );
  }
  if (actions?.poster_trust === 'explicitly' && can) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
        The author of this pull request is always trusted to run workflows.
        <Button size="sm" variant="ghost" disabled={busy || !isOnline} tooltip={why ?? 'Each of their runs will need approval again'} onClick={() => {
          decide('revoke');
        }}>Revoke</Button>
      </p>
    );
  }
  return null;
});
