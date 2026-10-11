// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Branches, tags and releases: synced entities (Branch, Release) read from
// the pool — complete offline, updated live. Release notes are the server's
// rendered markdown (body_html) through the Trusted Types gate. Writers
// create and delete branches and tags here (RefDialogs.tsx), and make, edit,
// publish and delete releases (ReleaseForm.tsx); their draft releases, which
// are not synced (B3), come from API v1 (refOps.ts drafts). Every write is
// online only.

import {PageColumn} from '../../app/shell/Frame.tsx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useState} from 'react';
import type {CompareInfo} from '../../code/source.ts';
import {sitePath} from '../../app/config.ts';
import {canWrite} from '../../app/access.ts';
import {failureText} from '../../app/api.ts';
import {ClassicLink} from '../../app/ClassicLink.tsx';
import {ClassicMenuItem} from '../../app/ClassicMenuItem.tsx';
import {notify} from '../../app/notices.ts';
import {useApp, useSession} from '../../app/store.ts';
import type {Branch, PullRequest, Release} from '../../protocol/types.gen.ts';
import {Link} from '@tanstack/react-router';
import {refTable, useLoad, useSource} from './hooks.ts';
import {shortSha} from '../../code/refs.ts';
import {Badge, Button, EmptyState, TextLink} from '../../ui/index.ts';
import {MarkdownPreview} from '../editor/Composer.tsx';
import {usePool} from '../issues/cells.tsx';
import {ago, fullDate, shortDate} from '../issues/format.ts';
import {Markdown} from '../issue/Markdown.tsx';
import {releaseSummary} from '../repo/about.ts';
import {CodeFrame, type CodeViewProps} from './CodePage.tsx';
import {CodeLink, codeTo, useCodeRows} from './nav.tsx';
import {compareSplat, forkHead} from './proposal.ts';
import {useUpstream} from './upstream.ts';
import {ConfirmDelete, DeleteBranchDialog, DeleteTagDialog, NewBranchDialog, NewTagDialog, useWriteBlock} from './RefDialogs.tsx';
import {deleteRelease, type DraftSlot, drafts, editRelease, repoRef} from './refOps.ts';
import {type DraftRelease, type RefChoice, releaseTarget, targetCommit} from './refWrite.ts';
import {RowList} from './RowList.tsx';
import {formatSize} from './tree.tsx';
import {BrowserIcon, FileZipIcon, GitBranchIcon, GitCompareIcon, GitMergeIcon, GitPullRequestIcon, PackageIcon, PaperclipIcon, PencilIcon, PlusIcon, PaperAirplaneIcon, TagIcon, TrashIcon, UndoIcon, KebabHorizontalIcon} from '@primer/octicons-react';
import {Button as PrimerButton, IconButton, LinkButton, ActionMenu, ActionList} from '@primer/react';
import {OptionalTooltip} from '../../app/OptionalTooltip.tsx';
import {RouterLinkButton} from '../../app/RouterLinkButton.tsx';

/** Stops a row's click (it opens the row) at the controls inside it. */
function RowControls({children}: {children: ReactNode}) {
  return (
    <span className="flex items-center gap-1" onClick={(e) => {
      e.stopPropagation();
    }}>{children}</span>
  );
}

/** A writer's delete button in a row: disabled, and saying why, when the write cannot happen now. */
function RowDelete({name, block, onDelete}: {name: string; block: string | undefined; onDelete: () => void}) {
  return (
    <IconButton icon={TrashIcon} variant="invisible" size="small" aria-label={block ? `Delete ${name}: ${block}` : `Delete ${name}`} type="button" aria-disabled={Boolean(block)} onClick={() => {
      if (!block) onDelete();
    }}/>
  );
}

type BranchDialog = {kind: 'new'} | {kind: 'delete'; name: string; openPull: number | undefined};

export const BranchesView = observer(function BranchesView(props: CodeViewProps) {
  const rows = useCodeRows<Branch>(props.owner, props.repo, (b) => `src/branch/${b.name}`);
  const pool = usePool();
  const writer = canWrite(useSession(), props.repoId);
  const block = useWriteBlock(props.repoId, 'Deleting a branch', true);
  const [dialog, setDialog] = useState<BranchDialog | undefined>(undefined);
  const def = pool.model('Repository').get(props.repoId)?.get('default_branch') ?? '';
  const branches = [...pool.model('Branch').by('repo_id', props.repoId)].map((b) => b.data).filter((b) => !b.is_deleted)
    .sort((a, b) => Number(b.name === def) - Number(a.name === def) || b.commit_time.localeCompare(a.commit_time));
  const defSha = branches.find((b) => b.name === def)?.commit_id;
  // A fork's branches are proposed to its upstream (as GitHub's and classic Forgejo's forks do).
  const up = useUpstream(props.owner, props.repo, props.repoId);
  const parentId = pool.model('Repository').get(props.repoId)?.get('parent_id') ?? 0;
  // Each branch's pull request (the open one, else the latest merged one) from this repository, into it or its upstream.
  const prOf = new Map<string, {pr: PullRequest; open: boolean}>();
  for (const e of pool.model('PullRequest').all()) {
    const p = e.data;
    if (p.head_repo_id !== props.repoId || (p.base_repo_id !== props.repoId && (!up || p.base_repo_id !== parentId))) continue;
    const open = pool.model('Issue').get(p.issue_id)?.get('state') === 'open';
    const had = prOf.get(p.head_branch);
    if (!had || open || (p.merged && !had.pr.merged)) prOf.set(p.head_branch, {pr: p, open});
  }
  const controls = writer && <>
    <PrimerButton size="small" leadingVisual={GitBranchIcon} type="button" onClick={() => {
      setDialog({kind: 'new'});
    }}>New branch</PrimerButton>
    <ActionMenu><ActionMenu.Button variant="invisible" size="small" leadingVisual={KebabHorizontalIcon} aria-label="More of the branches">More</ActionMenu.Button><ActionMenu.Overlay><ActionList>
      <ClassicMenuItem to={`/${encodeURIComponent(props.owner)}/${encodeURIComponent(props.repo)}/branches`} icon={UndoIcon}>Restore a deleted branch</ClassicMenuItem>
    </ActionList></ActionMenu.Overlay></ActionMenu>
  </>;
  return (
    <CodeFrame view={props} title="Branches" controls={controls}>
      {(scroller) => <>
        {branches.length ?
          <RowList items={branches} scroller={scroller} label="Branches" keyOf={(b) => b.name}
            row={(b) => {
              const pull = prOf.get(b.name);
              return {
                leading: <GitBranchIcon size={12} className="shrink-0"/>,
                main: <><span className="font-mono">{b.name}</span>{b.name === def && <> <Badge>default</Badge></>} <span className="text-fg-subtle">{b.commit_message.split('\n')[0]}</span></>,
                trailing: <>
                  {pull && <BranchPull {...(pull.pr.base_repo_id === props.repoId || !up ? {owner: props.owner, repo: props.repo} : {owner: up.owner, repo: up.name})} pr={pull.pr}/>}
                  {b.name !== def && defSha && <Divergence repoId={props.repoId} base={defSha} head={b.commit_id} baseName={def}/>}
                  <span className="font-mono">{shortSha(b.commit_id)}</span>
                  <time dateTime={b.commit_time} title={fullDate(b.commit_time)}>{ago(b.commit_time)}</time>
                  {def && (b.name !== def || up !== undefined) && <RowControls>
                    {b.name !== def && (pull?.open === true || up !== undefined) &&
                      <PrimerButton as={CodeLink} variant="invisible" size="small" owner={props.owner} repo={props.repo} to={compareSplat(def, b.name)}>Compare</PrimerButton>}
                    {!pull?.open && (up ?
                      <NewPullLink owner={up.owner} repo={up.name} base={up.defaultBranch} head={forkHead(props.owner, props.repo, up.owner, b.name)}
                        tooltip={`Propose ${b.name} to ${up.owner}/${up.name}:${up.defaultBranch}`}/> :
                      b.name !== def && <NewPullLink owner={props.owner} repo={props.repo} base={def} head={b.name}/>)}
                    {writer && b.name !== def && <RowDelete name={b.name} block={block} onDelete={() => {
                      setDialog({kind: 'delete', name: b.name, openPull: pull?.open ? pull.pr.number : undefined});
                    }}/>}
                  </RowControls>}
                </>,
              };
            }}
            onOpen={rows.onOpen} linkOf={rows.linkOf}/> :
          <EmptyState icon={GitBranchIcon} title="No branches" description="This repository has no branches on this device."/>}
        {dialog?.kind === 'new' && <NewBranchDialog repoId={props.repoId} onClose={() => {
          setDialog(undefined);
        }}/>}
        {dialog?.kind === 'delete' && <DeleteBranchDialog repoId={props.repoId} name={dialog.name} openPull={dialog.openPull} onClose={() => {
          setDialog(undefined);
        }}/>}
      </>}
    </CodeFrame>
  );
});

/**
 * A branch's way to a new pull request: its comparison with the default branch (a fork's: with its upstream's), the
 * form open (`?expand=1`).
 */
function NewPullLink({owner, repo, base, head, tooltip}: {owner: string; repo: string; base: string; head: string; tooltip?: string}) {
  return (
    <OptionalTooltip text={tooltip}><RouterLinkButton variant="invisible" size="small" leadingVisual={GitPullRequestIcon} {...codeTo(owner, repo, compareSplat(base, head))} search={{expand: '1'} as never}>New pull request</RouterLinkButton></OptionalTooltip>
  );
}

/** A branch's pull request: open (a link to it), or merged (marked). */
const BranchPull = observer(function BranchPull({owner, repo, pr}: {owner: string; repo: string; pr: PullRequest}) {
  return (
    <span className="flex items-center gap-1" onClick={(e) => {
      e.stopPropagation();
    }}>
      {pr.merged && <Badge tone="done"><GitMergeIcon size={12} className="shrink-0"/>Merged</Badge>}
      <TextLink><Link className="flex items-center gap-1" to="/$owner/$repo/pulls/$index" params={{owner, repo, index: String(pr.number)}}><GitPullRequestIcon size={12} className="shrink-0"/>#{pr.number}</Link></TextLink>
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

type TagDialog = {kind: 'new'} | {kind: 'delete'; name: string; hasRelease: boolean};

export const TagsView = observer(function TagsView(props: CodeViewProps) {
  const rows = useCodeRows<Release>(props.owner, props.repo, (t) => `src/tag/${t.tag_name}`);
  const pool = usePool();
  const writer = canWrite(useSession(), props.repoId);
  const block = useWriteBlock(props.repoId, 'Deleting a tag', true);
  const [dialog, setDialog] = useState<TagDialog | undefined>(undefined);
  const tags = [...pool.model('Release').by('repo_id', props.repoId)].map((r) => r.data).filter((r) => !r.draft && r.sha)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.tag_name.localeCompare(a.tag_name));
  const def = pool.model('Repository').get(props.repoId)?.get('default_branch') ?? '';
  const controls = writer && <PrimerButton size="small" leadingVisual={PlusIcon} type="button" onClick={() => {
    setDialog({kind: 'new'});
  }}>New tag</PrimerButton>;
  return (
    <CodeFrame view={props} title="Tags" controls={controls}>
      {(scroller) => <>
        {tags.length ?
          <RowList items={tags} scroller={scroller} label="Tags" keyOf={(t) => t.tag_name}
            row={(t) => ({
              leading: <TagIcon size={12} className="shrink-0"/>,
              main: <><span className="font-mono">{t.tag_name}</span>{!t.is_tag && t.name && <> <span className="text-fg-subtle">{t.name}</span></>}</>,
              trailing: <>
                <span className="font-mono">{shortSha(t.sha)}</span><time dateTime={t.created_at} title={fullDate(t.created_at)}>{ago(t.created_at)}</time>
                {(def || writer) && <RowControls>
                  {/* What the default branch has gained since the tag ("previous tag vs main"). */}
                  {def && <OptionalTooltip text={`What ${def} has that ${t.tag_name} lacks`}><RouterLinkButton variant="invisible" size="small" leadingVisual={GitCompareIcon} {...codeTo(props.owner, props.repo, compareSplat(t.tag_name, def))} aria-label={`Compare ${t.tag_name} with ${def}`}>Compare</RouterLinkButton></OptionalTooltip>}
                  {writer && <RowDelete name={t.tag_name} block={block} onDelete={() => {
                    setDialog({kind: 'delete', name: t.tag_name, hasRelease: !t.is_tag});
                  }}/>}
                </RowControls>}
              </>,
            })}
            onOpen={rows.onOpen} linkOf={rows.linkOf}/> :
          <EmptyState icon={TagIcon} title="No tags" description="This repository has no tags on this device."/>}
        {dialog?.kind === 'new' && <NewTagDialog repoId={props.repoId} onClose={() => {
          setDialog(undefined);
        }}/>}
        {dialog?.kind === 'delete' && <DeleteTagDialog repoId={props.repoId} name={dialog.name} hasRelease={dialog.hasRelease} onClose={() => {
          setDialog(undefined);
        }}/>}
      </>}
    </CodeFrame>
  );
});

/** A writer's way to what the app does not do here (re-run a workflow), on the classic page of the same list. */
export const RepoClassic = observer(function RepoClassic({owner, repo, repoId, path, children}: CodeViewProps & {path: string; children: string}) {
  if (!canWrite(useSession(), repoId)) return null;
  return <ClassicLink size="sm" to={`/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${path}`}>{children}</ClassicLink>;
});

export const ReleasesView = observer(function ReleasesView(props: CodeViewProps) {
  const app = useApp();
  const pool = usePool();
  const session = useSession();
  const writer = canWrite(session, props.repoId);
  const store = drafts(app);
  // A writer's drafts: API v1's (not synced), the device's copy first.
  useEffect(() => {
    const r = writer ? repoRef(session, props.repoId) : undefined;
    if (r) void store.load(r);
  }, [writer, session, store, props.repoId]);
  const slot: DraftSlot | undefined = writer ? store.slot(props.repoId) : undefined;
  const all = [...pool.model('Release').by('repo_id', props.repoId)].map((r) => r.data);
  const releases = all.filter((r) => !r.is_tag && !r.draft).sort((a, b) => b.created_at.localeCompare(a.created_at));
  // The same "Latest" as the repository's overview (the newest release that is not a pre-release).
  const latest = releaseSummary(all).latest?.id;
  // A draft published elsewhere is in the pool before the drafts are asked for again.
  const shownDrafts = (slot?.state === 'ready' ? slot.list : []).filter((d) => !releases.some((r) => r.id === d.id));
  const newRelease = <CodeLink owner={props.owner} repo={props.repo} to="releases/new"><PlusIcon size={12} className="shrink-0"/>New release</CodeLink>;
  return (
    <CodeFrame view={props} title="Releases" controls={writer && <Button size="sm" variant="primary" asChild>{newRelease}</Button>}>
      {() => (releases.length || shownDrafts.length ?
        // Not virtualized (each release's notes have their own height): off-screen ones are not rendered.
        <PageColumn wide>
          {shownDrafts.length > 0 && (
            <section aria-label="Drafts">{shownDrafts.map((d) => <DraftItem key={d.id} owner={props.owner} repo={props.repo} repoId={props.repoId} d={d}/>)}</section>
          )}
          <div>{releases.map((r, i) => <ReleaseItem key={r.id} owner={props.owner} repo={props.repo} r={r} previous={releases[i + 1]?.tag_name} writer={writer} latest={r.id === latest && !r.prerelease}/>)}</div>
        </PageColumn> :
        <EmptyState icon={PackageIcon} title="No releases" description="This repository has no published releases on this device."
          action={writer ? <Button size="sm" asChild>{newRelease}</Button> : undefined}/>)}
    </CodeFrame>
  );
});

/** Publishes a draft, or sets a release back to draft; the pool (and the drafts) show it when the notice comes. */
function usePublish(repoId: number) {
  const app = useApp();
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const run = (r: {id: number; name: string; tag_name: string; prerelease: boolean}, draft: boolean) => {
    const repo = repoRef(session, repoId);
    if (!repo || busy) return;
    setBusy(true);
    const name = r.name || r.tag_name;
    editRelease(app, repo, r.id, {draft, name, prerelease: r.prerelease}).then(() => {
      setBusy(false);
      notify(app, {tone: 'success', title: draft ? `${name} is a draft again` : `Published ${name}`});
    }, (err: unknown) => {
      setBusy(false);
      notify(app, {tone: 'danger', title: draft ? `${name} is still published` : `${name} was not published`, description: failureText(err)});
    });
  };
  return {busy, run};
}

/** Asks before a release is deleted (its tag stays). */
function DeleteReleaseDialog({repoId, id, name, draft, onClose}: {repoId: number; id: number; name: string; draft: boolean; onClose: () => void}) {
  const app = useApp();
  const session = useSession();
  return (
    <ConfirmDelete title={`Delete ${draft ? 'the draft ' : ''}${name}?`} onClose={onClose}
      description="The release, its notes and its assets are deleted for everyone. Its tag stays (delete it under Tags)."
      onDelete={async () => {
        const repo = repoRef(session, repoId);
        if (!repo) return;
        await deleteRelease(app, repo, id, draft);
        notify(app, {tone: 'success', title: `Deleted ${name}`});
      }}/>
  );
}

/** A writer's draft: its title and tag, notes (rendered online), assets; edit, publish, delete. */
const DraftItem = observer(function DraftItem({owner, repo, repoId, d}: {owner: string; repo: string; repoId: number; d: DraftRelease}) {
  const block = useWriteBlock(repoId, 'Publishing a release', false);
  const publish = usePublish(repoId);
  const [deleting, setDeleting] = useState(false);
  const name = d.name || d.tag_name;
  const refs = refTable(usePool(), repoId);
  // Where its tag will be: an existing tag stays where it is, a new one is made at the target when published.
  const tagged = refs.tags.get(d.tag_name);
  const target = releaseTarget(d.target_commitish || refs.defaultBranch, refs);
  const at = tagged ?? targetCommit(target, refs);
  return (
    <article aria-label={`Draft ${name}`} className="-mx-1 flex flex-col gap-3 border-b border-border-subtle px-1 py-6 first:pt-0">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-fg">{name}</h2>
        <Badge>Draft</Badge>
        {d.prerelease && <Badge tone="warning">Pre-release</Badge>}
        <span className="text-sm text-fg-subtle">
          <span className="font-mono">{d.tag_name}</span>
          {d.created_at && <>{' · '}<time dateTime={d.created_at} title={fullDate(d.created_at)}>{shortDate(d.created_at)}</time></>}
          {' · '}
          <DraftTarget tagged={Boolean(tagged)} target={target} at={at}/>
        </span>
        <span className="ml-auto flex items-center gap-1">
          <PrimerButton as={CodeLink} variant="invisible" size="small" leadingVisual={PencilIcon} owner={owner} repo={repo} to={`releases/edit/${d.tag_name}`}>Edit</PrimerButton>
          <OptionalTooltip text={block}><PrimerButton size="small" leadingVisual={PaperAirplaneIcon} type="button" aria-disabled={Boolean(block) || publish.busy} onClick={() => {
            if (!block) publish.run(d, false);
          }}>{publish.busy ? 'Publishing…' : 'Publish'}</PrimerButton></OptionalTooltip>
          <ActionMenu><ActionMenu.Button variant="invisible" size="small" leadingVisual={KebabHorizontalIcon} aria-label={`More of ${name}`}>More</ActionMenu.Button><ActionMenu.Overlay><ActionList>
            <ActionList.Item variant="danger" disabled={Boolean(block)} onSelect={() => {
              setDeleting(true);
            }}><ActionList.LeadingVisual><TrashIcon/></ActionList.LeadingVisual>Delete draft</ActionList.Item>
          </ActionList></ActionMenu.Overlay></ActionMenu>
        </span>
      </header>
      {d.body.trim() && <MarkdownPreview repoId={repoId} text={d.body}/>}
      {d.assets.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Assets">
          {d.assets.map((a) => (
            <li key={a.id} className="flex items-center gap-2 text-base">
              <PaperclipIcon size={12} className="shrink-0"/>{a.name}<span className="text-sm text-fg-subtle tabular-nums">{formatSize(a.size)}</span>
            </li>
          ))}
        </ul>
      )}
      {deleting && <DeleteReleaseDialog repoId={repoId} id={d.id} name={name} draft onClose={() => {
        setDeleting(false);
      }}/>}
    </article>
  );
});

/** Which commit a draft's tag will name: an existing tag's, or its target's (a branch's moves until it is published). */
function DraftTarget({tagged, target, at}: {tagged: boolean; target: RefChoice; at: string | undefined}) {
  const sha = at ? <span className="font-mono" title={at}>{shortSha(at)}</span> : undefined;
  if (tagged) return <span>existing tag{sha && <> at {sha}</>}</span>;
  if (target.kind === 'commit') return <span>at commit {sha}</span>;
  return (
    <span>
      from {target.kind === 'tag' ? 'tag' : 'branch'} <span className="font-mono">{target.ref}</span>
      {sha && <> at {sha}</>}{target.kind === 'branch' && ' (its head when published)'}
    </span>
  );
}

/** A published release's writer controls: edit, back to draft, delete, its classic page. */
const ReleaseControls = observer(function ReleaseControls({owner, repo, r}: {owner: string; repo: string; r: Release}) {
  const block = useWriteBlock(r.repo_id, 'Changing a release', false);
  const publish = usePublish(r.repo_id);
  const [deleting, setDeleting] = useState(false);
  const name = r.name || r.tag_name;
  return (
    <span className="ml-auto flex items-center gap-1">
      <PrimerButton as={CodeLink} variant="invisible" size="small" leadingVisual={PencilIcon} owner={owner} repo={repo} to={`releases/edit/${r.tag_name}`}>Edit</PrimerButton>
      <ActionMenu><ActionMenu.Button variant="invisible" size="small" leadingVisual={KebabHorizontalIcon} aria-label={`More of ${name}`}>More</ActionMenu.Button><ActionMenu.Overlay><ActionList>
        <ActionList.Item disabled={Boolean(block) || publish.busy} onSelect={() => {
          publish.run(r, true);
        }}><ActionList.LeadingVisual><UndoIcon/></ActionList.LeadingVisual>Back to draft</ActionList.Item>
        <ActionList.Item variant="danger" disabled={Boolean(block)} onSelect={() => {
          setDeleting(true);
        }}><ActionList.LeadingVisual><TrashIcon/></ActionList.LeadingVisual>Delete release</ActionList.Item>
        <ActionList.Divider/>
        <ClassicMenuItem to={`/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/tag/${r.tag_name.split('/').map(encodeURIComponent).join('/')}`} icon={BrowserIcon}>This release</ClassicMenuItem>
      </ActionList></ActionMenu.Overlay></ActionMenu>
      {deleting && <DeleteReleaseDialog repoId={r.repo_id} id={r.id} name={name} draft={false} onClose={() => {
        setDeleting(false);
      }}/>}
    </span>
  );
});

/**
 * A release: its notes, its assets (size, downloads), the source archives, the changes since `previous` and what its
 * branch has gained since. `latest`: the repository's latest release (as its overview marks it).
 */
const ReleaseItem = observer(function ReleaseItem({owner, repo, r, previous, writer, latest}: {
  owner: string; repo: string; r: Release; previous: string | undefined; writer: boolean; latest: boolean;
}) {
  const app = useApp();
  const pool = usePool();
  const assets = [...pool.model('Attachment').by('release_id', r.id)].map((a) => a.data);
  return (
    <article className="-mx-1 flex flex-col gap-3 border-b border-border-subtle px-1 py-6 render-lazy first:pt-0">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-fg">{r.name || r.tag_name}</h2>
        {latest && <Badge tone="success">Latest</Badge>}
        {r.prerelease && <Badge tone="warning">Pre-release</Badge>}
        <span className="text-sm text-fg-subtle">
          <TextLink><CodeLink owner={owner} repo={repo} to={`src/tag/${r.tag_name}`}><span className="font-mono">{r.tag_name}</span></CodeLink></TextLink>
          {' · '}<time dateTime={r.created_at} title={fullDate(r.created_at)}>{shortDate(r.created_at)}</time>
        </span>
        {writer && <ReleaseControls owner={owner} repo={repo} r={r}/>}
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
                  <PaperclipIcon size={12} className="shrink-0"/>{a.name}
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
            <LinkButton variant="invisible" size="small" leadingVisual={FileZipIcon} href={sitePath(app.config, `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/archive/${encodeURIComponent(r.tag_name)}.${ext}`)} download="">Source code ({ext})
              </LinkButton>
          </li>
        ))}
        {previous && (
          <li>
            <PrimerButton as={CodeLink} variant="invisible" size="small" leadingVisual={GitCompareIcon} owner={owner} repo={repo} to={`compare/${previous}...${r.tag_name}`}>Changes since {previous}</PrimerButton>
          </li>
        )}
        <SinceRelease owner={owner} repo={repo} r={r}/>
      </ul>
    </article>
  );
});

/** Whether an element has come into view (once): what is below the fold asks for nothing until it is scrolled to. */
function useSeen<T extends Element>(): [boolean, (el: T | null) => void] {
  // Without IntersectionObserver (old browsers, tests): seen at once.
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  const [el, setEl] = useState<T | null>(null);
  useEffect(() => {
    if (seen || !el) return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true);
    }, {rootMargin: '200px'});
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, [el, seen]);
  return [seen, setEl];
}

/**
 * "N commits to main since this release" (classic's TargetBehind): the comparison of the release's tag with the
 * branch it was made from (else the default branch), counted once the release is in view (cached by commit).
 */
const SinceRelease = observer(function SinceRelease({owner, repo, r}: {owner: string; repo: string; r: Release}) {
  const pool = usePool();
  const src = useSource();
  const refs = refTable(pool, r.repo_id);
  const target = refs.branches.has(r.target_commitish) ? r.target_commitish : refs.defaultBranch;
  const head = refs.branches.get(target);
  const [seen, ref] = useSeen<HTMLLIElement>();
  const key = seen && head && r.sha ? `compare:${String(r.repo_id)}:${r.sha}:${head}` : undefined;
  const since = useLoad(key, () => (key ? src.peek<CompareInfo>(key)?.total : undefined), async () => (await src.compare(r.repo_id, r.sha, head ?? '')).total);
  if (!target || !r.sha) return null;
  return (
    <li ref={ref}>
      <PrimerButton as={CodeLink} variant="invisible" size="small" leadingVisual={GitCompareIcon} owner={owner} repo={repo} to={compareSplat(r.tag_name, target)}>{since.state === 'ready' ? `${String(since.value)} ${since.value === 1 ? 'commit' : 'commits'} to ${target} since this release` : `Compare with ${target}`}</PrimerButton>
    </li>
  );
});
