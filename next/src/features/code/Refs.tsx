// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Branches, tags and releases: synced entities (Branch, Release) read from
// the pool — complete offline, updated live. Release notes are the server's
// rendered markdown (body_html) through the Trusted Types gate.

import {PageColumn} from '../../app/shell/Frame.tsx';
import {GitBranch, Package, Paperclip, Tag} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {sitePath} from '../../app/config.ts';
import {canWrite} from '../../app/access.ts';
import {ClassicLink} from '../../app/ClassicLink.tsx';
import {useApp, useSession} from '../../app/store.ts';
import type {Branch, Release} from '../../protocol/types.gen.ts';
import {shortSha} from '../../code/refs.ts';
import {Badge, Button, EmptyState, Icon, TextLink} from '../../ui/index.ts';
import {usePool} from '../issues/cells.tsx';
import {ago, fullDate, shortDate} from '../issues/format.ts';
import {Markdown} from '../issue/Markdown.tsx';
import {CodeFrame, type CodeViewProps} from './CodePage.tsx';
import {CodeLink, useCodeRows} from './nav.tsx';
import {RowList} from './RowList.tsx';

export const BranchesView = observer(function BranchesView(props: CodeViewProps) {
  const rows = useCodeRows<Branch>(props.owner, props.repo, (b) => `src/branch/${b.name}`);
  const pool = usePool();
  const def = pool.model('Repository').get(props.repoId)?.get('default_branch') ?? '';
  const branches = [...pool.model('Branch').by('repo_id', props.repoId)].map((b) => b.data).filter((b) => !b.is_deleted)
    .sort((a, b) => Number(b.name === def) - Number(a.name === def) || b.commit_time.localeCompare(a.commit_time));
  return (
    <CodeFrame view={props} title="Branches" controls={<RepoClassic {...props} path="branches">Manage branches</RepoClassic>}>
      {(scroller) => (branches.length ?
        <RowList items={branches} scroller={scroller} label="Branches" keyOf={(b) => b.name}
          row={(b) => ({
            leading: <Icon icon={GitBranch} size="sm"/>,
            main: <><span className="font-mono">{b.name}</span>{b.name === def && <> <Badge>default</Badge></>} <span className="text-fg-subtle">{b.commit_message.split('\n')[0]}</span></>,
            trailing: <>
              <span className="font-mono">{shortSha(b.commit_id)}</span>
              <time dateTime={b.commit_time} title={fullDate(b.commit_time)}>{ago(b.commit_time)}</time>
            </>,
          })}
          onOpen={rows.onOpen} linkOf={rows.linkOf}/> :
        <EmptyState icon={GitBranch} title="No branches" description="This repository has no branches on this device."/>)}
    </CodeFrame>
  );
});

export const TagsView = observer(function TagsView(props: CodeViewProps) {
  const rows = useCodeRows<Release>(props.owner, props.repo, (t) => `src/tag/${t.tag_name}`);
  const pool = usePool();
  const tags = [...pool.model('Release').by('repo_id', props.repoId)].map((r) => r.data).filter((r) => !r.draft && r.sha)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.tag_name.localeCompare(a.tag_name));
  return (
    <CodeFrame view={props} title="Tags">
      {(scroller) => (tags.length ?
        <RowList items={tags} scroller={scroller} label="Tags" keyOf={(t) => t.tag_name}
          row={(t) => ({
            leading: <Icon icon={Tag} size="sm"/>,
            main: <><span className="font-mono">{t.tag_name}</span>{!t.is_tag && t.name && <> <span className="text-fg-subtle">{t.name}</span></>}</>,
            trailing: <><span className="font-mono">{shortSha(t.sha)}</span><time dateTime={t.created_at} title={fullDate(t.created_at)}>{ago(t.created_at)}</time></>,
          })}
          onOpen={rows.onOpen} linkOf={rows.linkOf}/> :
        <EmptyState icon={Tag} title="No tags" description="This repository has no tags on this device."/>)}
    </CodeFrame>
  );
});

/**
 * A writer's way to what the app does not do here (create or delete branches, draft and publish releases:
 * drafts are not synced, B3), on the classic page of the same list.
 */
export const RepoClassic = observer(function RepoClassic({owner, repo, repoId, path, children}: CodeViewProps & {path: string; children: string}) {
  if (!canWrite(useSession(), repoId)) return null;
  return <ClassicLink size="sm" to={`/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${path}`}>{children}</ClassicLink>;
});

export const ReleasesView = observer(function ReleasesView(props: CodeViewProps) {
  const pool = usePool();
  const releases = [...pool.model('Release').by('repo_id', props.repoId)].map((r) => r.data).filter((r) => !r.is_tag && !r.draft)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return (
    <CodeFrame view={props} title="Releases" controls={<RepoClassic {...props} path="releases">Drafts and new release</RepoClassic>}>
      {() => (releases.length ?
        // Not virtualized (each release's notes have their own height): off-screen ones are not rendered.
        <PageColumn>
          <div>{releases.map((r) => <ReleaseItem key={r.id} owner={props.owner} repo={props.repo} r={r}/>)}</div>
        </PageColumn> :
        <EmptyState icon={Package} title="No releases" description="This repository has no published releases on this device."/>)}
    </CodeFrame>
  );
});

const ReleaseItem = observer(function ReleaseItem({owner, repo, r}: {owner: string; repo: string; r: Release}) {
  const app = useApp();
  const pool = usePool();
  const assets = [...pool.model('Attachment').by('release_id', r.id)].map((a) => a.data);
  return (
    <article className="-mx-1 flex flex-col gap-3 border-b border-border-subtle px-1 py-6 render-lazy first:pt-0">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-fg">{r.name || r.tag_name}</h2>
        {r.prerelease && <Badge tone="warning">Pre-release</Badge>}
        <span className="text-sm text-fg-subtle">
          <TextLink><CodeLink owner={owner} repo={repo} to={`src/tag/${r.tag_name}`}><span className="font-mono">{r.tag_name}</span></CodeLink></TextLink>
          {' · '}<time dateTime={r.created_at} title={fullDate(r.created_at)}>{shortDate(r.created_at)}</time>
        </span>
      </header>
      {r.body_html && <Markdown html={r.body_html}/>}
      {assets.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Assets">
          {assets.map((a) => (
            <li key={a.id}>
              <Button size="sm" variant="ghost" asChild>
                {/* A download (the file, not a page): the app stays; an external asset opens in a new tab. */}
                <a {...(a.external_url && /^https?:\/\//.test(a.external_url) ?
                  {href: a.external_url, target: '_blank'} :
                  {href: sitePath(app.config, `/attachments/${encodeURIComponent(a.uuid)}`), download: a.name})} rel="noopener noreferrer">
                  <Icon icon={Paperclip} size="sm"/>{a.name}
                </a>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
});
