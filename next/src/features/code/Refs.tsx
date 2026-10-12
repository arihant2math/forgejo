// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Draft releases are not synced; fetch them via API v1. Writes are online-only.
// Server-rendered release notes pass through the Trusted Types gate.

import {count} from '../../app/words.ts';
import {PageColumn} from '../../app/shell/Frame.tsx';
import {BranchName, CounterLabel, Heading, Link as PrimerLink, SubNav, TextInput} from '@primer/react';
import {createLink} from '@tanstack/react-router';

import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useState} from 'react';
import type {CompareInfo} from '../../code/source.ts';
import {sitePath} from '../../app/config.ts';
import {canWrite} from '../../app/access.ts';
import {failureText} from '../../app/api.ts';
import {ClassicMenuItem} from '../../app/ClassicMenuItem.tsx';
import {notify} from '../../app/notices.ts';
import {useApp, useSession} from '../../app/store.ts';
import type {Branch, PullRequest, Release} from '../../protocol/types.gen.ts';

import {refTable, useLoad, useSource} from './hooks.ts';
import {Sha, summary} from '../../components/Sha.tsx';

import {MarkdownPreview} from '../editor/Composer.tsx';
import {usePool} from '../../app/store.ts';
import {fullDate, shortDate} from '../../app/time.ts';
import {TimeAgo} from '../../components/TimeAgo.tsx';
import {Markdown} from '../issue/Markdown.tsx';
import {releaseSummary} from '../repo/about.ts';
import {CodeFrame, type CodeViewProps} from './CodePage.tsx';
import {codeTo, useCodeRows} from './nav.tsx';
import {compareSplat, forkHead} from './proposal.ts';
import {useUpstream} from './upstream.ts';
import {ConfirmDelete, DeleteBranchDialog, DeleteTagDialog, NewBranchDialog, NewTagDialog, useWriteBlock} from './RefDialogs.tsx';
import {deleteRelease, type DraftSlot, drafts, editRelease, repoRef} from './refOps.ts';
import {type DraftRelease, type RefChoice, releaseTarget, targetCommit} from './refWrite.ts';
import {RowList} from './RowList.tsx';
import {formatSize} from './tree.tsx';
import {BrowserIcon, FileZipIcon, GitBranchIcon, GitCompareIcon, GitMergeIcon, GitPullRequestIcon, PackageIcon, PaperclipIcon, PencilIcon, PlusIcon, PaperAirplaneIcon, SearchIcon, TagIcon, TrashIcon, TriangleDownIcon, TriangleRightIcon, UndoIcon, KebabHorizontalIcon} from '@primer/octicons-react';
import {Button as PrimerButton, IconButton, ActionMenu, ActionList, Label} from '@primer/react';
import {Tooltip} from '@primer/react';
import {RouterLink, RouterLinkButton, PrimaryLink} from '../../app/routerLinks.tsx';
import {EmptyState} from '../../components/EmptyState.tsx';

function RowControls({children, wide = false}: {children: ReactNode; wide?: boolean}) {
  return (
    <span className={wide ? 'flex w-44 items-center justify-end gap-1' : 'flex items-center gap-1'} onClick={(e) => {
      e.stopPropagation();
    }}>{children}</span>
  );
}

function RowDelete({name, block, onDelete}: {name: string; block: string | undefined; onDelete: () => void}) {
  return (
    <IconButton icon={TrashIcon} variant="invisible" size="small" aria-label={`Delete ${name}`} {...(block ? {description: block} : {})} type="button" inactive={Boolean(block)} aria-disabled={Boolean(block)} onClick={() => {
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
  const [query, setQuery] = useState('');
  const def = pool.model('Repository').get(props.repoId)?.get('default_branch') ?? '';
  const all = [...pool.model('Branch').by('repo_id', props.repoId)].map((b) => b.data).filter((b) => !b.is_deleted);
  const defSha = all.find((b) => b.name === def)?.commit_id;
  const typed = query.trim().toLowerCase();
  const branches = all.filter((b) => b.name.toLowerCase().includes(typed))
    .sort((a, b) => Number(b.name === def) - Number(a.name === def) || b.commit_time.localeCompare(a.commit_time));
  const up = useUpstream(props.owner, props.repo, props.repoId);
  const parentId = pool.model('Repository').get(props.repoId)?.get('parent_id') ?? 0;
  const prOf = new Map<string, {pr: PullRequest; open: boolean}>();
  for (const e of pool.model('PullRequest').by('head_repo_id', props.repoId)) {
    const p = e.data;
    if (p.base_repo_id !== props.repoId && (!up || p.base_repo_id !== parentId)) continue;
    const open = pool.model('Issue').get(p.issue_id)?.get('state') === 'open';
    const had = prOf.get(p.head_branch);
    if (!had || open || (p.merged && !had.pr.merged)) prOf.set(p.head_branch, {pr: p, open});
  }
  const controls = writer && <>
    <ActionMenu><ActionMenu.Button variant="invisible" size="small" leadingVisual={KebabHorizontalIcon} aria-label="More of the branches">More</ActionMenu.Button><ActionMenu.Overlay><ActionList>
      <ClassicMenuItem to={`/${encodeURIComponent(props.owner)}/${encodeURIComponent(props.repo)}/branches`} icon={UndoIcon}>Restore a deleted branch</ClassicMenuItem>
    </ActionList></ActionMenu.Overlay></ActionMenu>
    <PrimerButton variant="primary" size="small" leadingVisual={GitBranchIcon} type="button" onClick={() => {
      setDialog({kind: 'new'});
    }}>New branch</PrimerButton>
  </>;
  return (
    <CodeFrame view={props} title="Branches" controls={controls}>
      {(scroller) => <>
        {all.length > 0 && (
          <div className="sticky left-0 w-view border-b border-default px-4 py-2">
            <TextInput leadingVisual={SearchIcon} aria-label="Search branches" placeholder="Search branches…" value={query} className="w-full max-w-md"
              onChange={(e) => { setQuery(e.target.value); }}/>
          </div>
        )}
        {all.length > 0 && !branches.length && <EmptyState icon={GitBranchIcon} title="No branch matches" description={`No branch name contains “${query.trim()}”.`}/>}
        {branches.length ?
          <RowList items={branches} scroller={scroller} label="Branches" keyOf={(b) => b.name}
            row={(b) => {
              const pull = prOf.get(b.name);
              return {
                leading: <GitBranchIcon size={16}/>,
                main: <><BranchName as="span">{b.name}</BranchName>{b.name === def && <> <Label>default</Label></>} <span className="ml-2 text-muted">{summary(b.commit_message)}</span></>,
                trailing: <>
                  {pull && <BranchPull {...(pull.pr.base_repo_id === props.repoId || !up ? {owner: props.owner, repo: props.repo} : {owner: up.owner, repo: up.name})} pr={pull.pr}/>}
                  {b.name !== def && defSha && <Divergence repoId={props.repoId} base={defSha} head={b.commit_id} baseName={def}/>}
                  <Sha sha={b.commit_id}/>
                  <TimeAgo at={b.commit_time} className="w-12 text-right"/>
                  {def && (b.name !== def || up !== undefined) ? <RowControls wide>
                    {b.name !== def && (pull?.open === true || up !== undefined) &&
                      <RouterLinkButton variant="invisible" size="small" {...codeTo(props.owner, props.repo, compareSplat(def, b.name))}>Compare</RouterLinkButton>}
                    {!pull?.open && (up ?
                      <NewPullLink owner={up.owner} repo={up.name} base={up.defaultBranch} head={forkHead(props.owner, props.repo, up.owner, b.name)}
                        tooltip={`Propose ${b.name} to ${up.owner}/${up.name}:${up.defaultBranch}`}/> :
                      b.name !== def && <NewPullLink owner={props.owner} repo={props.repo} base={def} head={b.name}/>)}
                    {writer && b.name !== def && <RowDelete name={b.name} block={block} onDelete={() => {
                      setDialog({kind: 'delete', name: b.name, openPull: pull?.open ? pull.pr.number : undefined});
                    }}/>}
                  </RowControls> : <span className="w-44"/>}
                </>,
              };
            }}
            onOpen={rows.onOpen} linkOf={rows.linkOf}/> :
          !all.length && <EmptyState icon={GitBranchIcon} title="No branches" description="This repository has no branches on this device."/>}
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

function NewPullLink({owner, repo, base, head, tooltip}: {owner: string; repo: string; base: string; head: string; tooltip?: string}) {
  return (
    <Tooltip text={tooltip ?? ''}><RouterLinkButton variant="invisible" size="small" leadingVisual={GitPullRequestIcon} {...codeTo(owner, repo, compareSplat(base, head))} search={{expand: '1'} as never}>New pull request</RouterLinkButton></Tooltip>
  );
}

const BranchPull = observer(function BranchPull({owner, repo, pr}: {owner: string; repo: string; pr: PullRequest}) {
  return (
    <span className="flex items-center gap-1" onClick={(e) => {
      e.stopPropagation();
    }}>
      {pr.merged && <Label variant="done"><span className="inline-flex items-center gap-1"><GitMergeIcon size={12}/>Merged</span></Label>}
      <RouterLink to="/$owner/$repo/pulls/$index" params={{owner, repo, index: String(pr.number)}} className="inline-flex items-center gap-1"><GitPullRequestIcon size={12}/>#{pr.number}</RouterLink>
    </span>
  );
});

/** Load divergence only for visible rows; comparisons are cached by commit. */
const Divergence = observer(function Divergence({repoId, base, head, baseName}: {repoId: number; base: string; head: string; baseName: string}) {
  const src = useSource();
  const ahead = useLoad(`ahead:${String(repoId)}:${base}:${head}`, () => undefined, async () => (await src.compare(repoId, base, head)).total);
  const behind = useLoad(`behind:${String(repoId)}:${base}:${head}`, () => undefined, async () => (await src.compare(repoId, head, base)).total);
  if (ahead.state !== 'ready' || behind.state !== 'ready') return null;
  const text = `${count(behind.value, 'commit')} behind, ${count(ahead.value, 'commit')} ahead of ${baseName}`;
  // GitHub's Behind | Ahead pair.
  return (
    <span className="flex w-20 items-center tabular-nums" title={text}>
      <span aria-hidden className="flex-1 pr-1 text-right">{behind.value}</span>
      <span aria-hidden className="h-4 border-l border-default"/>
      <span aria-hidden className="flex-1 pl-1">{ahead.value}</span>
      <span className="sr-only">{text}</span>
    </span>
  );
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
        <ReleasesNav owner={props.owner} repo={props.repo} current="tags"/>
        {tags.length ?
          <RowList items={tags} scroller={scroller} label="Tags" keyOf={(t) => t.tag_name}
            row={(t) => ({
              leading: <TagIcon size={16}/>,
              main: <><span className="font-mono">{t.tag_name}</span>{!t.is_tag && t.name && <> <span className="ml-2 text-muted">{t.name}</span></>}</>,
              trailing: <>
                <Sha sha={t.sha}/><TimeAgo at={t.created_at} className="w-12 text-right"/>
                {(def || writer) && <RowControls>
                  {def && <Tooltip text={`What ${def} has that ${t.tag_name} lacks`}><RouterLinkButton variant="invisible" size="small" leadingVisual={GitCompareIcon} {...codeTo(props.owner, props.repo, compareSplat(t.tag_name, def))} aria-label={`Compare ${t.tag_name} with ${def}`}>Compare</RouterLinkButton></Tooltip>}
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

export const ReleasesView = observer(function ReleasesView(props: CodeViewProps) {
  const app = useApp();
  const pool = usePool();
  const session = useSession();
  const writer = canWrite(session, props.repoId);
  const store = drafts(app);
  useEffect(() => {
    const r = writer ? repoRef(session, props.repoId) : undefined;
    if (r) void store.load(r);
  }, [writer, session, store, props.repoId]);
  const slot: DraftSlot | undefined = writer ? store.slot(props.repoId) : undefined;
  const all = [...pool.model('Release').by('repo_id', props.repoId)].map((r) => r.data);
  const releases = all.filter((r) => !r.is_tag && !r.draft).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const latest = releaseSummary(all).latest?.id;
  // A published draft may reach the pool before the draft list refreshes.
  const shownDrafts = (slot?.state === 'ready' ? slot.list : []).filter((d) => !releases.some((r) => r.id === d.id));
  const newRelease = <RouterLinkButton {...codeTo(props.owner, props.repo, 'releases/new')} variant="primary" size="small">Draft a new release</RouterLinkButton>;
  return (
    <CodeFrame view={props} title="Releases" controls={writer && newRelease}>
      {() => <>
        <ReleasesNav owner={props.owner} repo={props.repo} current="releases"/>
        {releases.length || shownDrafts.length ?
        // Variable-height release notes use lazy rendering rather than row virtualization.
        <PageColumn wide>
          {shownDrafts.length > 0 && (
            <section aria-label="Drafts">{shownDrafts.map((d) => <DraftItem key={d.id} owner={props.owner} repo={props.repo} repoId={props.repoId} d={d}/>)}</section>
          )}
          <div>{releases.map((r, i) => <ReleaseItem key={r.id} owner={props.owner} repo={props.repo} r={r} previous={releases[i + 1]?.tag_name} writer={writer} latest={r.id === latest && !r.prerelease}/>)}</div>
        </PageColumn> :
        <EmptyState icon={PackageIcon} title="No releases" description="This repository has no published releases on this device." action={writer ? newRelease : undefined}/>}
      </>}
    </CodeFrame>
  );
});

const SubNavLink = createLink(SubNav.Link);

/** GitHub's Releases | Tags switch. */
function ReleasesNav({owner, repo, current}: {owner: string; repo: string; current: 'releases' | 'tags'}) {
  return (
    <div className="px-4 pt-4 pb-2">
      <SubNav aria-label="Releases and tags">
        <SubNav.Links>
          {(['releases', 'tags'] as const).map((page) => (
            <SubNavLink key={page} {...codeTo(owner, repo, page)} selected={page === current} aria-current={page === current ? 'page' : false} activeProps={{}}>
              {page === 'releases' ? 'Releases' : 'Tags'}
            </SubNavLink>
          ))}
        </SubNav.Links>
      </SubNav>
    </div>
  );
}

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

const DraftItem = observer(function DraftItem({owner, repo, repoId, d}: {owner: string; repo: string; repoId: number; d: DraftRelease}) {
  const block = useWriteBlock(repoId, 'Publishing a release', false);
  const publish = usePublish(repoId);
  const [deleting, setDeleting] = useState(false);
  const name = d.name || d.tag_name;
  const refs = refTable(usePool(), repoId);
  const tagged = refs.tags.get(d.tag_name);
  const target = releaseTarget(d.target_commitish || refs.defaultBranch, refs);
  const at = tagged ?? targetCommit(target, refs);
  return (
    <article aria-label={`Draft ${name}`} className="flex flex-col gap-4 border-b border-muted py-6 first:pt-0">
      <header className="flex flex-wrap items-center gap-2">
        <Heading as="h2" variant="small">{name}</Heading>
        <Label>Draft</Label>
        {d.prerelease && <Label variant="attention">Pre-release</Label>}
        <span className="text-sm text-muted">
          <span className="font-mono">{d.tag_name}</span>
          {d.created_at && <>{' · '}<time dateTime={d.created_at} title={fullDate(d.created_at)}>{shortDate(d.created_at)}</time></>}
          {' · '}
          <DraftTarget tagged={Boolean(tagged)} target={target} at={at}/>
        </span>
        <span className="ml-auto flex items-center gap-1">
          <RouterLinkButton variant="invisible" size="small" leadingVisual={PencilIcon} {...codeTo(owner, repo, `releases/edit/${d.tag_name}`)}>Edit</RouterLinkButton>
          <Tooltip text={block ?? ''}><PrimerButton size="small" leadingVisual={PaperAirplaneIcon} type="button" inactive={Boolean(block) || publish.busy} aria-disabled={Boolean(block) || publish.busy} onClick={() => {
            if (!block) publish.run(d, false);
          }}>{publish.busy ? 'Publishing…' : 'Publish'}</PrimerButton></Tooltip>
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
              <PaperclipIcon size={16} className="shrink-0"/>{a.name}<span className="text-sm text-muted tabular-nums">{formatSize(a.size)}</span>
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

/** An existing tag stays fixed; a target branch can move until publication. */
function DraftTarget({tagged, target, at}: {tagged: boolean; target: RefChoice; at: string | undefined}) {
  const sha = at ? <Sha sha={at}/> : undefined;
  if (tagged) return <span>existing tag{sha && <> at {sha}</>}</span>;
  if (target.kind === 'commit') return <span>at commit {sha}</span>;
  return (
    <span>
      from {target.kind === 'tag' ? 'tag' : 'branch'} <span className="font-mono">{target.ref}</span>
      {sha && <> at {sha}</>}{target.kind === 'branch' && ' (its head when published)'}
    </span>
  );
}

const ReleaseControls = observer(function ReleaseControls({owner, repo, r}: {owner: string; repo: string; r: Release}) {
  const block = useWriteBlock(r.repo_id, 'Changing a release', false);
  const publish = usePublish(r.repo_id);
  const [deleting, setDeleting] = useState(false);
  const name = r.name || r.tag_name;
  return (
    <span className="ml-auto flex items-center gap-1">
      <RouterLinkButton variant="invisible" size="small" leadingVisual={PencilIcon} {...codeTo(owner, repo, `releases/edit/${r.tag_name}`)}>Edit</RouterLinkButton>
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

const ReleaseItem = observer(function ReleaseItem({owner, repo, r, previous, writer, latest}: {
  owner: string; repo: string; r: Release; previous: string | undefined; writer: boolean; latest: boolean;
}) {
  const app = useApp();
  const pool = usePool();
  const assets = [...pool.model('Attachment').by('release_id', r.id)].map((a) => a.data);
  const [open, setOpen] = useState(latest);
  const Triangle = open ? TriangleDownIcon : TriangleRightIcon;
  const archives = r.hide_archive_links ? [] : ['zip', 'tar.gz'] as const;
  return (
    <article className="flex flex-col gap-4 border-b border-muted py-6 render-lazy first:pt-0">
      <header className="flex flex-wrap items-center gap-2">
        <Heading as="h2" variant="small">{r.name || r.tag_name}</Heading>
        {latest && <Label variant="success">Latest</Label>}
        {r.prerelease && <Label variant="attention">Pre-release</Label>}
        <span className="flex items-center gap-2">
          <PrimaryLink {...codeTo(owner, repo, `src/tag/${r.tag_name}`)} className="font-mono text-base">{r.tag_name}</PrimaryLink>
          <time className="text-sm text-muted" dateTime={r.created_at} title={fullDate(r.created_at)}>{shortDate(r.created_at)}</time>
        </span>
        {writer && <ReleaseControls owner={owner} repo={repo} r={r}/>}
      </header>
      {r.body_html && <Markdown html={r.body_html}/>}
      {/* GitHub's Assets disclosure: uploads, then the source archives. A flex summary loses its marker, so the triangle is drawn. */}
      {assets.length + archives.length > 0 && <details open={open} onToggle={(e) => {
        setOpen(e.currentTarget.open);
      }}>
        <summary className="flex cursor-pointer items-center gap-2">
          <Triangle size={16} className="shrink-0 text-muted"/><Heading as="h3" variant="small">Assets</Heading><CounterLabel>{assets.length + archives.length}</CounterLabel>
        </summary>
        <ul className="mt-2 flex flex-col rounded-md border border-default" aria-label="Assets">
          {assets.map((a) => (
            <li key={a.id} className="flex items-center gap-2 border-b border-muted px-3 py-2 text-base last:border-b-0">
              <PackageIcon size={16} className="shrink-0 text-muted"/>
              <PrimerLink className="min-w-0 truncate" {...(a.external_url && /^https?:\/\//.test(a.external_url) ?
                {href: a.external_url, target: '_blank'} :
                {href: sitePath(app.config, `/attachments/${encodeURIComponent(a.uuid)}`), download: a.name})} rel="noopener noreferrer">{a.name}</PrimerLink>
              <span className="ml-auto shrink-0 text-sm text-muted tabular-nums">
                {formatSize(a.size)} · {count(a.download_count, 'download', 'downloads')}
              </span>
            </li>
          ))}
          {archives.map((ext) => (
            <li key={ext} className="flex items-center gap-2 border-b border-muted px-3 py-2 text-base last:border-b-0">
              <FileZipIcon size={16} className="shrink-0 text-muted"/>
              <PrimerLink href={sitePath(app.config, `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/archive/${encodeURIComponent(r.tag_name)}.${ext}`)} download="">Source code ({ext})</PrimerLink>
            </li>
          ))}
        </ul>
      </details>}
      <ul className="flex flex-wrap items-center gap-2" aria-label="Compare">
        {previous && (
          <li>
            <RouterLinkButton variant="invisible" size="small" leadingVisual={GitCompareIcon} {...codeTo(owner, repo, `compare/${previous}...${r.tag_name}`)}>Changes since {previous}</RouterLinkButton>
          </li>
        )}
        <SinceRelease owner={owner} repo={repo} r={r}/>
      </ul>
    </article>
  );
});

/** Defer requests below the fold until the element has been visible once. */
function useSeen<T extends Element>(): [boolean, (el: T | null) => void] {
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
      <RouterLinkButton variant="invisible" size="small" leadingVisual={GitCompareIcon} {...codeTo(owner, repo, compareSplat(r.tag_name, target))}>{since.state === 'ready' ? `${count(since.value, 'commit', 'commits')} to ${target} since this release` : `Compare with ${target}`}</RouterLinkButton>
    </li>
  );
});
