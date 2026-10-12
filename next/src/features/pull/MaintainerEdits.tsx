// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {apiRepoPath} from '../../app/paths.ts';
import {useState} from 'react';
import {observer} from 'mobx-react-lite';
import {onlineWrite} from '../../app/api.ts';
import {reach} from '../../app/online.ts';
import {pullOf} from '../../code/pull.ts';
import {repoGroup} from '../../data/models.ts';
import {settleWrite} from '../../sync/data.ts';
import {useApp, useSession} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import {Banner, Checkbox, FormControl} from '@primer/react';

export const MaintainerEdits = observer(function MaintainerEdits({issue}: {issue: Entity<'Issue'>}) {
  const app = useApp();
  const session = useSession();
  const pr = pullOf(session.data.pool, issue.id);
  const repo = session.data.pool.model('Repository').get(issue.get('repo_id'))?.data;
  // The choice shows at once and stays until the change has synced back (or fails).
  const [pending, setPending] = useState<boolean>();
  const [error, setError] = useState('');
  if (!pr || !repo || pr.head_repo_id === pr.base_repo_id || pr.merged || issue.get('poster_id') !== session.userId) return null;
  const busy = pending !== undefined;
  const offline = reach(session.data.status.connection) !== 'online';
  const changePermission = (checked: boolean) => {
    if (busy || reach(session.data.status.connection) !== 'online') return;
    setPending(checked);
    setError('');
    void onlineWrite(app, {method: 'PATCH', api: 'v1', path: `${apiRepoPath(repo.owner_name, repo.name)}/pulls/${String(issue.get('number'))}`, body: {allow_maintainer_edit: checked}})
      .then((written) => settleWrite(session.data, repoGroup(repo.id), written.syncId))
      .catch(() => { setError('Could not change maintainer permissions. Try again.'); })
      .finally(() => { setPending(undefined); });
  };
  return (
    <div className="flex flex-col gap-2">
      <FormControl disabled={busy || offline}>
        <Checkbox checked={pending ?? pr.allow_maintainer_edit} onChange={(event) => { changePermission(event.target.checked); }}/>
        <FormControl.Label>Allow edits by maintainers</FormControl.Label>
        {offline && <FormControl.Caption>Changing permissions requires a connection.</FormControl.Caption>}
      </FormControl>
      {error && <Banner variant="critical" title="Update failed" description={error}/>}
    </div>
  );
});
