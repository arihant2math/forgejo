// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {useState} from 'react';
import {observer} from 'mobx-react-lite';
import {onlineWrite} from '../../app/api.ts';
import {reach} from '../../app/online.ts';
import {useApp, useSession} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import {Checkbox, Callout} from '../../ui/index.ts';

export const MaintainerEdits = observer(function MaintainerEdits({issue}: {issue: Entity<'Issue'>}) {
  const app = useApp();
  const session = useSession();
  const pr = [...session.data.pool.model('PullRequest').all()].find((p) => p.get('issue_id') === issue.id);
  const repo = session.data.pool.model('Repository').get(issue.get('repo_id'))?.data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!pr || !repo || pr.get('head_repo_id') === pr.get('base_repo_id') || pr.get('merged') || issue.get('poster_id') !== session.userId) return null;
  const offline = reach(session.data.status.connection) !== 'online';
  return <div className="flex flex-col gap-2"><Checkbox label="Allow edits by maintainers" checked={pr.get('allow_maintainer_edit')} disabled={busy || offline} onChange={(checked) => {
    setBusy(true);
    setError('');
    void onlineWrite(app, {method: 'PATCH', api: 'v1', path: `/repos/${encodeURIComponent(repo.owner_name)}/${encodeURIComponent(repo.name)}/pulls/${String(issue.get('number'))}`, body: {allow_maintainer_edit: checked}}).catch(() => { setError('Could not change maintainer permissions. Try again.'); }).finally(() => { setBusy(false); });
  }}/>{offline && <span className="text-sm text-fg-muted">Changing permissions requires a connection.</span>}{error && <Callout tone="danger" title="Update failed">{error}</Callout>}</div>;
});
