// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {useEffect, useState} from 'react';
import {Link} from '@tanstack/react-router';
import {online} from '../../app/api.ts';
import {useApp} from '../../app/store.ts';
import {Button, Callout} from '../../ui/index.ts';
import {compareSplat} from '../code/proposal.ts';
import {codeTo} from '../code/nav.tsx';

export function Contribute({owner, repo}: {owner: string; repo: string}) {
  const app = useApp();
  const [parent, setParent] = useState<{owner: {login: string}; name: string; default_branch: string}>();
  const [head, setHead] = useState('');
  useEffect(() => {
    const ctl = new AbortController();
    void (async () => {
      const fork = await online<{default_branch: string; parent?: {owner: {login: string}; name: string; default_branch: string}}>(app, {api: 'v1', path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, signal: ctl.signal});
      if (!fork?.parent) return;
      const p = fork.parent;
      const h = `${owner === p.owner.login ? `${owner}/${repo}` : owner}:${fork.default_branch}`;
      const info = await online<{total_commits: number}>(app, {api: 'v1', path: `/repos/${encodeURIComponent(p.owner.login)}/${encodeURIComponent(p.name)}/compare/${encodeURIComponent(p.default_branch)}...${encodeURIComponent(h)}`, signal: ctl.signal});
      if (info?.total_commits && !ctl.signal.aborted) { setParent(p); setHead(h); }
    })().catch(() => undefined);
    return () => { ctl.abort(); };
  }, [app, owner, repo]);
  if (!parent) return null;
  return <Callout title="Contribute to upstream"><Button variant="secondary" asChild><Link {...codeTo(parent.owner.login, parent.name, compareSplat(parent.default_branch, head))} search={{expand: '1'} as never}>Compare &amp; open pull request</Link></Button></Callout>;
}
