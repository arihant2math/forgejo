// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Branches, tags and releases: synced entities (Branch, Release) read from
// the pool — complete offline, updated live. Release notes are the server's
// rendered markdown (body_html) through the Trusted Types gate.

import {PageColumn} from '../../app/shell/Frame.tsx';
import {FileArchive, GitBranch, GitCompare, GitMerge, GitPullRequest, Package, Paperclip, Tag} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {sitePath} from '../../app/config.ts';
import {canWrite} from '../../app/access.ts';
import {ClassicLink} from '../../app/ClassicLink.tsx';
import {useApp, useSession} from '../../app/store.ts';
import type {Branch, PullRequest, Release} from '../../protocol/types.gen.ts';
import {Link} from '@tanstack/react-router';
import {useLoad, useSource} from './hooks.ts';
import {shortSha} from '../../code/refs.ts';
import {Badge, Button, EmptyState, Icon, TextLink} from '../../ui/index.ts';
import {usePool} from '../issues/cells.tsx';
import {ago, fullDate, shortDate} from '../issues/format.ts';
import {Markdown} from '../issue/Markdown.tsx';
import {CodeFrame, type CodeViewProps} from './CodePage.tsx';
import {CodeLink, useCodeRows} from './nav.tsx';
import {RowList} from './RowList.tsx';
import {formatSize} from './tree.tsx';

export const BranchesView = observer(function BranchesView(props: CodeViewProps) {
  const rows = useCodeRows<Branch>(props.owner, props.repo, (b) => `src/branch/${b.name}`);
  const pool = usePool();
  const def = pool.model('Repository').get(props.repoId)?.get('default_branch') ?? '';
  const branches = [...pool.model('Branch').by('repo_id', props.repoId)].map((b) => b.data).filter((b) => !b.is_deleted)
    .sort((a, b) => Number(b.name === def) - Number(a.name === def) || b.commit_time.localeCompare(a.commit_time));
  const defSha = branches.find((b) => b.name === def)?.commit_id;
  // Each branch's pull request (the open one, else the latest merged one) from this repository.
  const prOf = new Map<string, PullRequest>();
  for (const e of pool.model('PullRequest').all()) {
    const p = e.data;
    if (p.head_repo_id !== props.repoId || p.base_repo_id !== props.repoId) continue;
    const open = pool.model('Issue').get(p.issue_id)?.get('state') === 'open';
    const had = prOf.get(p.head_branch);
    if (!had || open || (p.merged && !had.merged)) prOf.set(p.head_branch, p);
  }
  return (
    <CodeFrame view={props} title="Branches" controls={<RepoClassic {...props} path="branches">Manage branches</RepoClassic>}>
      {(scroller) => (branches.length ?
        <RowList items={branches} scroller={scroller} label="Branches" keyOf={(b) => b.name}
          row={(b) => {
            const pr = prOf.get(b.name);
            return {
              leading: <Icon icon={GitBranch} size="sm"/>,
              main: <><span className="font-mono">{b.name}</span>{b.name === def && <> <Badge>default</Badge></>} <span className="text-fg-subtle">{b.commit_message.split('\n')[0]}</span></>,
              trailing: <>
                {pr && <BranchPull owner={props.owner} repo={props.repo} pr={pr}/>}
                {b.name !== def && defSha && <Divergence repoId={props.repoId} base={defSha} head={b.commit_id} baseName={def}/>}
                <span className="font-mono">{shortSha(b.commit_id)}</span>
                <time dateTime={b.commit_time} title={fullDate(b.commit_time)}>{ago(b.commit_time)}</time>
                {b.name !== def && def && <span className="flex items-center" onClick={(e) => {
                  e.stopPropagation();
                }}>
                  <Button size="sm" variant="ghost" asChild><CodeLink owner={props.owner} repo={props.repo} to={`compare/${def}...${b.name}`}>Compare</CodeLink></Button>
                </span>}
              </>,
            };
          }}
          onOpen={rows.onOpen} linkOf={rows.linkOf}/> :
        <EmptyState icon={GitBranch} title="No branches" description="This repository has no branches on this device."/>)}
    </CodeFrame>
  );
});

/** A branch's pull request: open (a link to it), or merged (marked). */
const BranchPull = observer(function BranchPull({owner, repo, pr}: {owner: string; repo: string; pr: PullRequest}) {
  return (
    <span className="flex items-center gap-1" onClick={(e) => {
      e.stopPropagation();
    }}>
      {pr.merged && <Badge tone="done"><Icon icon={GitMerge} size="sm"/>Merged</Badge>}
      <TextLink><Link className="flex items-center gap-1" to="/$owner/$repo/pulls/$index" params={{owner, repo, index: String(pr.number)}}><Icon icon={GitPullRequest} size="sm"/>#{pr.number}</Link></TextLink>
    </span>
  );
});

/**
 * How far a branch is from the default one: commits ahead and behind (two comparisons, cached by commit; asked for
 * the rows in view only, as the list is virtualized). Nothing until both are known.
 */
const Divergence = observer(function Divergence({repoId, base, head, baseName}: {repoId: number; base: string; head: string; baseName: string}) {
  const src = useSource();
  const ahead = useLoad(`ahead:${String(repoId)}:${base}:${head}`, () => undefined, async () => (await src.compare(repoId, base, head)).total);
  const behind = useLoad(`behind:${String(repoId)}:${base}:${head}`, () => undefined, async () => (await src.compare(repoId, head, base)).total);
  if (ahead.state !== 'ready' || behind.state !== 'ready') return null;
  return <span className="text-fg-subtle tabular-nums" title={`${String(ahead.value)} ahead of ${baseName}, ${String(behind.value)} behind`}>↑{ahead.value} ↓{behind.value}</span>;
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
        <PageColumn wide>
          <div>{releases.map((r, i) => <ReleaseItem key={r.id} owner={props.owner} repo={props.repo} r={r} previous={releases[i + 1]?.tag_name}/>)}</div>
        </PageColumn> :
        <EmptyState icon={Package} title="No releases" description="This repository has no published releases on this device."/>)}
    </CodeFrame>
  );
});

/** A release: its notes, its assets (size, downloads), the source archives and the changes since `previous`. */
const ReleaseItem = observer(function ReleaseItem({owner, repo, r, previous}: {owner: string; repo: string; r: Release; previous: string | undefined}) {
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
            <li key={a.id} className="flex items-center gap-2">
              <Button size="sm" variant="ghost" asChild>
                {/* A download (the file, not a page): the app stays; an external asset opens in a new tab. */}
                <a {...(a.external_url && /^https?:\/\//.test(a.external_url) ?
                  {href: a.external_url, target: '_blank'} :
                  {href: sitePath(app.config, `/attachments/${encodeURIComponent(a.uuid)}`), download: a.name})} rel="noopener noreferrer">
                  <Icon icon={Paperclip} size="sm"/>{a.name}
                </a>
              </Button>
              <span className="text-sm text-fg-subtle tabular-nums">
                {formatSize(a.size)} · {a.download_count === 1 ? '1 download' : `${String(a.download_count)} downloads`}
              </span>
            </li>
          ))}
        </ul>
      )}
      <ul className="flex flex-wrap items-center gap-1" aria-label="Source code">
        {(['zip', 'tar.gz'] as const).map((ext) => (
          <li key={ext}>
            <Button size="sm" variant="ghost" asChild>
              <a href={sitePath(app.config, `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/archive/${encodeURIComponent(r.tag_name)}.${ext}`)} download>
                <Icon icon={FileArchive} size="sm"/>Source code ({ext})
              </a>
            </Button>
          </li>
        ))}
        {previous && (
          <li>
            <Button size="sm" variant="ghost" asChild>
              <CodeLink owner={owner} repo={repo} to={`compare/${previous}...${r.tag_name}`}><Icon icon={GitCompare} size="sm"/>Changes since {previous}</CodeLink>
            </Button>
          </li>
        )}
      </ul>
    </article>
  );
});
