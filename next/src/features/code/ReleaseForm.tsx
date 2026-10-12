// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Release writes are online-only and never queued; upload assets individually after saving.
// Published releases come from the pool, unsynced drafts from API v1.

import {apiRepoPath, type RepoRef} from '../../app/paths.ts';
import {useNavigate} from '@tanstack/react-router';
import {Banner} from '@primer/react';
import {observer} from 'mobx-react-lite';
import {useEffect, useRef, useState} from 'react';
import {canWrite} from '../../app/access.ts';
import {failureText, online} from '../../app/api.ts';
import {ClassicMenuItem} from '../../app/ClassicMenuItem.tsx';
import {PageColumn} from '../../app/shell/Frame.tsx';
import {notify} from '../../app/notices.ts';
import {shortcutHint} from '../../app/shortcuts/index.ts';
import {useApp, useSession} from '../../app/store.ts';
import {shortSha} from '../../code/refs.ts';

import {ChoicePanel} from './ChoicePanel.tsx';
import {MarkdownField} from '../editor/Composer.tsx';
import {usePool} from '../issues/cells.tsx';
import {CodeFrame, type CodeViewProps} from './CodePage.tsx';
import {refTable, useLoad, useSource} from './hooks.ts';
import {summary} from './bits.tsx';
import type {CommitInfo} from '../../code/source.ts';
import {codeTo} from './nav.tsx';
import {createRelease, deleteAsset, drafts, editRelease, repoRef, uploadAsset} from './refOps.ts';
import {RefPicker} from './RefMenu.tsx';
import {useWriteBlock} from './RefDialogs.tsx';
import {
  type ApiRelease, createReleaseBody, editReleaseBody, type KnownRelease, type RefChoice, refSpec, releaseTagProblem, releaseTarget, type ReleaseFields, TAG_MAX,
  targetCommit, TITLE_MAX,
} from './refWrite.ts';
import {formatSize} from './tree.tsx';
import {BrowserIcon, ChevronDownIcon, PackageIcon, PaperclipIcon, PlusIcon, TagIcon, UndoIcon, XIcon, KebabHorizontalIcon} from '@primer/octicons-react';
import {Button, IconButton, ActionMenu, ActionList, Checkbox, FormControl, TextInput} from '@primer/react';
import {Tooltip} from '@primer/react';
import {Blankslate, SkeletonBox, SkeletonText} from '@primer/react/experimental';

interface Editing {
  id: number;
  draft: boolean;
  tag: string;
  target: string;
  title: string;
  notes: string;
  prerelease: boolean;
  assets: {id: number; name: string; size: number}[];
}

const classicForm = (owner: string, repo: string, tag: string | undefined) =>
  `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/${tag === undefined ? 'new' : `edit/${tag.split('/').map(encodeURIComponent).join('/')}`}`;

export const ReleaseFormView = observer(function ReleaseFormView(props: CodeViewProps & {tag: string | undefined}) {
  const {owner, repo, repoId, tag} = props;
  const session = useSession();
  const title = tag === undefined ? 'New release' : `Edit ${tag}`;
  const controls = <ActionMenu><ActionMenu.Button variant="invisible" size="small" leadingVisual={KebabHorizontalIcon} aria-label="More of this page">More</ActionMenu.Button><ActionMenu.Overlay><ActionList><ClassicMenuItem to={classicForm(owner, repo, tag)} icon={BrowserIcon}>This page</ClassicMenuItem></ActionList></ActionMenu.Overlay></ActionMenu>;
  return (
    <CodeFrame view={props} title={title} controls={controls}>
      {() => (
        <PageColumn>
          {!canWrite(session, repoId) ?
            <Blankslate><Blankslate.Visual><PackageIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Writers only</Blankslate.Heading><Blankslate.Description>Only people who may write this repository's releases make or edit them.</Blankslate.Description></Blankslate> :
            tag === undefined ? <ReleaseEditor {...props} editing={undefined}/> : <EditLoader {...props} tag={tag}/>}
        </PageColumn>
      )}
    </CodeFrame>
  );
});

const EditLoader = observer(function EditLoader(props: CodeViewProps & {tag: string}) {
  const {repoId, tag} = props;
  const app = useApp();
  const session = useSession();
  const pool = usePool();
  const store = drafts(app);
  useEffect(() => {
    const r = repoRef(session, repoId);
    if (r) void store.load(r);
  }, [session, store, repoId]);
  const pub = [...pool.model('Release').by('repo_id', repoId)].map((r) => r.data).find((r) => r.tag_name === tag && !r.is_tag && !r.draft);
  const draft = pub ? undefined : store.find(repoId, (d) => d.tag_name === tag);
  const slot = store.slot(repoId);
  // Fetch complete notes before editing a truncated pool body.
  const repo = repoRef(session, repoId);
  const full = useLoad(pub?.body_truncated && repo ? `release-body:${String(pub.id)}` : undefined, () => undefined,
    async () => (await online<ApiRelease>(app, {api: 'v1', path: `${apiRepoPath(repo?.owner ?? '', repo?.name ?? '')}/releases/${String(pub?.id ?? 0)}`}))?.body ?? '');
  // Open once so live updates cannot overwrite edits.
  const [opened, setOpened] = useState<Editing | undefined>(undefined);
  const now: Editing | undefined = pub && (!pub.body_truncated || full.state === 'ready') ?
    {id: pub.id, draft: false, tag: pub.tag_name, target: pub.target_commitish, title: pub.name, notes: full.state === 'ready' ? full.value : pub.body, prerelease: pub.prerelease, assets: []} :
    draft ? {id: draft.id, draft: true, tag: draft.tag_name, target: draft.target_commitish, title: draft.name, notes: draft.body, prerelease: draft.prerelease, assets: draft.assets} :
      undefined;
  if (now && !opened) setOpened(now);
  const editing = opened ?? now;
  if (editing) return <ReleaseEditor {...props} key={editing.id} editing={editing}/>;
  if (full.state === 'error' || full.state === 'offline') return <Blankslate><Blankslate.Visual><PackageIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Not loaded</Blankslate.Heading><Blankslate.Description>The release's notes could not be loaded. Try again online.</Blankslate.Description></Blankslate>;
  if (slot.state === 'loading' || (slot.state === 'ready' && slot.stale) || full.state === 'loading') return <FormSkeleton/>;
  return (
    <Blankslate><Blankslate.Visual><TagIcon size={24}/></Blankslate.Visual><Blankslate.Heading>No release for this tag</Blankslate.Heading><Blankslate.Description>{slot.state === 'offline' ?
      'Drafts are loaded from Forgejo: this one is not on this device.' :
      `The tag “${tag}” has no release${slot.state === 'error' ? ' that this device could load' : ''}.`}</Blankslate.Description></Blankslate>
  );
});

function FormSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy>
      <SkeletonBox className="h-8 w-64"/>
      <SkeletonBox className="h-8 w-full"/>
      <SkeletonText lines={6}/>
    </div>
  );
}

const ReleaseEditor = observer(function ReleaseEditor({owner, repo, repoId, editing}: CodeViewProps & {editing: Editing | undefined}) {
  const app = useApp();
  const session = useSession();
  const pool = usePool();
  const navigate = useNavigate();
  const refs = refTable(pool, repoId);
  const store = drafts(app);
  const [fields, setFields] = useState<ReleaseFields>(() => ({
    tag: editing?.tag ?? '', target: [editing?.target, refs.defaultBranch].find(Boolean) ?? '', title: editing?.title ?? '', notes: editing?.notes ?? '', prerelease: editing?.prerelease ?? false,
  }));
  const [files, setFiles] = useState<File[]>([]);
  const [removed, setRemoved] = useState<number[]>([]);
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState<{draft: boolean; label: string} | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const picker = useRef<HTMLInputElement | null>(null);
  const block = useWriteBlock(repoId, 'Saving a release', false);
  const set = (patch: Partial<ReleaseFields>) => {
    setFields((f) => ({...f, ...patch}));
  };
  // Published tags are fixed; draft tags are created on publication.
  const tagFixed = editing !== undefined && !editing.draft;
  const slot = store.slot(repoId);
  const known: KnownRelease[] = [
    ...[...pool.model('Release').by('repo_id', repoId)].map((r) => ({id: r.data.id, tag_name: r.data.tag_name, is_tag: r.data.is_tag})),
    ...(slot.state === 'ready' ? slot.list.map((d) => ({id: d.id, tag_name: d.tag_name, is_tag: false})) : []),
  ];
  const tag = fields.tag.trim();
  const target = releaseTarget(fields.target, refs);
  const problem = tagFixed ? undefined : releaseTagProblem(tag, refs, known, editing?.id);
  const existing = refs.tags.get(tag);
  const assets = editing && !editing.draft ?
    [...pool.model('Attachment').by('release_id', editing.id)].map((a) => ({id: a.data.id, name: a.data.name, size: a.data.size})) :
    editing?.assets ?? [];
  const freeTags = [...pool.model('Release').by('repo_id', repoId)].map((r) => r.data).filter((r) => r.is_tag && r.sha)
    .map((r) => r.tag_name).sort((a, b) => b.localeCompare(a, undefined, {numeric: true}));
  const back = () => {
    void navigate(codeTo(owner, repo, 'releases'));
  };
  const save = (draft: boolean) => {
    setAsked(true);
    const r = repoRef(session, repoId);
    if (busy || block || problem || !r) return;
    setError(undefined);
    setBusy({draft, label: draft || (editing && !editing.draft) ? 'Saving…' : 'Publishing…'});
    void submit(r, draft).then((warning) => {
      setBusy(undefined);
      const name = fields.title.trim() || tag;
      if (warning) notify(app, {tone: 'warning', title: `${name} is saved, but an asset is not`, description: warning});
      else notify(app, {tone: 'success', title: draft ? `Saved the draft ${name}` : editing && !editing.draft ? `Saved ${name}` : `Published ${name}`});
      back();
    }, (err: unknown) => {
      setBusy(undefined);
      setError(failureText(err));
    });
  };
  /** Asset uploads follow the save; return any upload failure separately. */
  const submit = async (r: RepoRef, draft: boolean): Promise<string | undefined> => {
    const f = {...fields, tag};
    const id = editing ?
      (await editRelease(app, r, editing.id, editReleaseBody(f, {notes: editing.notes, draft: editing.draft}, draft)), editing.id) :
      await createRelease(app, r, createReleaseBody(f, draft));
    let warning: string | undefined;
    try {
      for (const a of removed) await deleteAsset(app, r, id, a);
      for (const [i, file] of files.entries()) {
        setBusy({draft, label: `Uploading ${String(i + 1)} of ${String(files.length)}…`});
        await uploadAsset(app, r, id, file);
      }
    } catch (err) {
      warning = failureText(err);
    }
    if (draft || editing?.draft) store.changed(r);
    return warning;
  };
  const tagBad = asked && problem !== undefined;
  const publishing = !editing || editing.draft;
  return (
    <div className="flex flex-col gap-4" onKeyDown={(e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.defaultPrevented) {
        e.preventDefault();
        save(false);
      }
    }}>
      {error && <Banner variant="critical" title="Not saved" description={<>{error}</>}/>}
      <section aria-label="Tag" className="flex flex-col gap-2">
        {tagFixed ?
          <p className="flex items-center gap-2 text-base text-muted"><TagIcon size={12} className="shrink-0"/><code>{tag}</code>{existing && <span>at <span className="font-mono">{shortSha(existing)}</span></span>}</p> :
          <>
            <div className="flex flex-wrap items-center gap-2">
              <TextInput aria-label="Tag name" placeholder="Tag, e.g. v1.0.0" value={fields.tag} autoFocus={!editing} className="w-64" maxLength={TAG_MAX} spellCheck={false} autoComplete="off" aria-describedby={tagBad ? 'release-tag-problem' : 'release-tag-state'} onChange={(e) => {
                  set({tag: e.target.value});
                }} {...(tagBad ? {validationStatus: 'error' as const} : {})}/>
              {freeTags.length > 0 && (
                <ChoicePanel title="Existing tags" placeholder="Find a tag…" empty="No tag without a release."
                  choices={freeTags.map((t) => ({value: t, label: t, icon: TagIcon, checked: t === tag, onSelect: () => {
                    set({tag: t});
                  }}))}
                  anchor={<Button variant="invisible" size="small" trailingVisual={ChevronDownIcon} type="button">Existing tag</Button>}/>
              )}
            </div>
            {tagBad ? <p id="release-tag-problem" role="alert" className="text-sm text-danger">{problem}</p> :
              tag && (existing ?
                <p id="release-tag-state" className="text-sm text-muted">The existing tag, at <span className="font-mono">{shortSha(existing)}</span>.</p> :
                <div id="release-tag-state" className="flex flex-wrap items-center gap-2 text-sm text-muted">
                  <span>A new tag, made when the release is published, at</span>
                  <RefPicker repoId={repoId} label="Target" value={target} commits onChange={(c) => {
                    set({target: refSpec(c, refs)});
                  }}/>
                  <TargetCommit repoId={repoId} target={target} sha={targetCommit(target, refs)}/>
                </div>)}
          </>}
      </section>
      <FormControl><FormControl.Label>Title</FormControl.Label><TextInput aria-label="Title" placeholder={tag ? `Title (${tag} if empty)` : 'Title'} value={fields.title} autoFocus={Boolean(editing)} block maxLength={TITLE_MAX} onChange={(e) => {
          set({title: e.target.value});
        }}/></FormControl>
      <MarkdownField attachments={false} repoId={repoId} label="Release notes" placeholder="Describe this release…" value={fields.notes} rows={10}
        onChange={(notes) => {
          set({notes});
        }} onSubmit={() => {
          save(false);
        }} onCancel={back}/>
      <section aria-label="Assets" className="flex flex-col gap-1">
        {assets.map((a) => {
          const gone = removed.includes(a.id);
          return (
            <div key={a.id} className="flex items-center gap-2 text-base">
              <PaperclipIcon size={12} className="shrink-0"/>
              <span className={gone ? 'text-muted line-through' : 'text-default'}>{a.name}</span>
              <span className="text-sm text-muted tabular-nums">{formatSize(a.size)}</span>
              <IconButton icon={gone ? UndoIcon : XIcon} variant="invisible" size="small" aria-label={gone ? `Keep ${a.name}` : `Remove ${a.name}`} type="button" onClick={() => {
                setRemoved((r) => (gone ? r.filter((x) => x !== a.id) : [...r, a.id]));
              }}/>
            </div>
          );
        })}
        {files.map((f, i) => (
          <div key={`${f.name}:${String(i)}`} className="flex items-center gap-2 text-base">
            <PlusIcon size={12} className="shrink-0"/><span className="text-default">{f.name}</span>
            <span className="text-sm text-muted tabular-nums">{formatSize(f.size)}</span>
            <IconButton icon={XIcon} variant="invisible" size="small" aria-label={`Do not upload ${f.name}`} type="button" onClick={() => {
              setFiles((fs) => fs.filter((_, k) => k !== i));
            }}/>
          </div>
        ))}
        <div>
          <input ref={picker} type="file" multiple hidden onChange={(e) => {
            const picked = [...e.target.files ?? []];
            setFiles((fs) => [...fs, ...picked]);
            e.target.value = '';
          }}/>
          <Button variant="invisible" size="small" leadingVisual={PaperclipIcon} type="button" onClick={() => picker.current?.click()}>Attach files</Button>
        </div>
      </section>
      <FormControl><Checkbox checked={fields.prerelease} onChange={(event) => { const prerelease = event.target.checked; set({prerelease}); }}/><FormControl.Label>This is a pre-release (not ready for production)</FormControl.Label></FormControl>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {block && <span className="mr-auto text-sm text-muted">{block}</span>}
        <Button variant="invisible" type="button" onClick={back}>Cancel</Button>
        {publishing && <Tooltip text={block ?? 'Only writers see a draft'}><Button type="button" inactive={Boolean(block) || Boolean(busy)} aria-disabled={Boolean(block) || Boolean(busy)} onClick={() => {
          save(true);
        }}>{busy?.draft ? busy.label : 'Save draft'}</Button></Tooltip>}
        <Tooltip text={block ?? ''} keybindingHint={shortcutHint('submit')}><Button variant="primary" type="button" inactive={Boolean(block) || Boolean(busy)} aria-disabled={Boolean(block) || Boolean(busy)} onClick={() => {
          save(false);
        }}>{busy && !busy.draft ? busy.label : publishing ? 'Publish release' : 'Save'}</Button></Tooltip>
      </div>
    </div>
  );
});

const TargetCommit = observer(function TargetCommit({repoId, target, sha}: {repoId: number; target: RefChoice; sha: string | undefined}) {
  const src = useSource();
  const key = sha ? `commit:${String(repoId)}:${sha}` : undefined;
  const commit = useLoad(key, () => (key ? src.peek<CommitInfo>(key) : undefined), () => src.commit(repoId, sha ?? ''));
  if (!sha) return <span role="status">{target.ref ? `${target.ref} is not on this device.` : 'Choose where the tag is made.'}</span>;
  if (commit.state === 'error') {
    return <span role="status" className="text-danger">{target.kind === 'commit' ? `No commit ${target.ref} in this repository.` : `${shortSha(sha)} could not be loaded.`}</span>;
  }
  const full = commit.state === 'ready' ? commit.value.sha : sha;
  return (
    <span role="status" aria-label="Target commit" className="flex min-w-0 items-center gap-1">
      <span className="font-mono" title={full}>{shortSha(full)}</span>
      {commit.state === 'ready' && <span className="truncate text-muted">{summary(commit.value.message)}</span>}
      {target.kind === 'branch' && <span>({target.ref}’s head now: the tag is made at its head when published)</span>}
    </span>
  );
});
