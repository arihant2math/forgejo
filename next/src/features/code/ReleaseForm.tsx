// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A writer's release form (Forgejo's `releases/new` and `releases/edit/{tag}`;
// PLAN §5.4: online only, never queued): the tag (an existing one, or a new
// one and the branch it starts from — made when the release is published),
// a title, notes in the markdown editor, pre-release, and assets (uploaded
// after the release is saved: API v1 takes them one by one). "Save draft"
// keeps it a draft (only writers see drafts), "Publish release" publishes
// it. A published release is read from the pool, a draft from API v1
// (refOps.ts drafts: drafts are not synced).

import {useNavigate} from '@tanstack/react-router';
import {AppWindow, ChevronDown, Package, Paperclip, Plus, Tag, Undo2, X} from 'lucide-react';
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
import {Button, Callout, Checkbox, Code, CommandPopover, EmptyState, Icon, IconButton, Input, MoreMenu, Skeleton, SkeletonText} from '../../ui/index.ts';
import {MarkdownField} from '../editor/Composer.tsx';
import {usePool} from '../issues/cells.tsx';
import {CodeFrame, type CodeViewProps} from './CodePage.tsx';
import {refTable, useLoad} from './hooks.ts';
import {codeTo} from './nav.tsx';
import {createRelease, deleteAsset, drafts, editRelease, type RepoRef, repoRef, uploadAsset} from './refOps.ts';
import {RefPicker} from './RefMenu.tsx';
import {useWriteBlock} from './RefDialogs.tsx';
import {type ApiRelease, createReleaseBody, editReleaseBody, type KnownRelease, releaseTagProblem, type ReleaseFields, TAG_MAX, TITLE_MAX} from './refWrite.ts';
import {formatSize} from './tree.tsx';

/** A release being edited, from the pool (published) or API v1 (a draft). */
interface Editing {
  id: number;
  draft: boolean;
  tag: string;
  target: string;
  title: string;
  notes: string;
  prerelease: boolean;
  /** Its assets (a published release's: the pool's, kept current while the form is open). */
  assets: {id: number; name: string; size: number}[];
}

const classicForm = (owner: string, repo: string, tag: string | undefined) =>
  `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/${tag === undefined ? 'new' : `edit/${tag.split('/').map(encodeURIComponent).join('/')}`}`;

export const ReleaseFormView = observer(function ReleaseFormView(props: CodeViewProps & {tag: string | undefined}) {
  const {owner, repo, repoId, tag} = props;
  const session = useSession();
  const title = tag === undefined ? 'New release' : `Edit ${tag}`;
  const controls = <MoreMenu label="More of this page"><ClassicMenuItem to={classicForm(owner, repo, tag)} icon={AppWindow}>This page</ClassicMenuItem></MoreMenu>;
  return (
    <CodeFrame view={props} title={title} controls={controls}>
      {() => (
        <PageColumn>
          {!canWrite(session, repoId) ?
            <EmptyState icon={Package} title="Writers only" description="Only people who may write this repository's releases make or edit them."/> :
            tag === undefined ? <ReleaseEditor {...props} editing={undefined}/> : <EditLoader {...props} tag={tag}/>}
        </PageColumn>
      )}
    </CodeFrame>
  );
});

/** Finds the release of a tag (the pool's, else a draft), with its whole notes, then opens the editor on it. */
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
  // The pool may hold a long text cut short (body_truncated): the whole of it from API v1 before it is edited.
  const repo = repoRef(session, repoId);
  const full = useLoad(pub?.body_truncated && repo ? `release-body:${String(pub.id)}` : undefined, () => undefined,
    async () => (await online<ApiRelease>(app, {api: 'v1', path: `/repos/${encodeURIComponent(repo?.owner ?? '')}/${encodeURIComponent(repo?.name ?? '')}/releases/${String(pub?.id ?? 0)}`}))?.body ?? '');
  // Opened once: the form keeps what is typed while the release changes underneath.
  const [opened, setOpened] = useState<Editing | undefined>(undefined);
  const now: Editing | undefined = pub && (!pub.body_truncated || full.state === 'ready') ?
    {id: pub.id, draft: false, tag: pub.tag_name, target: pub.target_commitish, title: pub.name, notes: full.state === 'ready' ? full.value : pub.body, prerelease: pub.prerelease, assets: []} :
    draft ? {id: draft.id, draft: true, tag: draft.tag_name, target: draft.target_commitish, title: draft.name, notes: draft.body, prerelease: draft.prerelease, assets: draft.assets} :
      undefined;
  if (now && !opened) setOpened(now);
  const editing = opened ?? now;
  if (editing) return <ReleaseEditor {...props} key={editing.id} editing={editing}/>;
  if (full.state === 'error' || full.state === 'offline') return <EmptyState icon={Package} title="Not loaded" description="The release's notes could not be loaded. Try again online."/>;
  if (slot.state === 'loading' || (slot.state === 'ready' && slot.stale) || full.state === 'loading') return <FormSkeleton/>;
  return (
    <EmptyState icon={Tag} title="No release for this tag" description={slot.state === 'offline' ?
      'Drafts are loaded from Forgejo: this one is not on this device.' :
      `The tag “${tag}” has no release${slot.state === 'error' ? ' that this device could load' : ''}.`}/>
  );
});

function FormSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy>
      <Skeleton className="h-8 w-64"/>
      <Skeleton className="h-8 w-full"/>
      <SkeletonText lines={6}/>
    </div>
  );
}

/** The form. `editing` undefined: a new release. */
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
  /** The button pressed (a draft or not) and what it says meanwhile. */
  const [busy, setBusy] = useState<{draft: boolean; label: string} | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const picker = useRef<HTMLInputElement | null>(null);
  const block = useWriteBlock(repoId, 'Saving a release', false);
  const set = (patch: Partial<ReleaseFields>) => {
    setFields((f) => ({...f, ...patch}));
  };
  // A published release's tag stays (Forgejo moves no tag under a release); a draft's tag is made when it is published.
  const tagFixed = editing !== undefined && !editing.draft;
  const slot = store.slot(repoId);
  const known: KnownRelease[] = [
    ...[...pool.model('Release').by('repo_id', repoId)].map((r) => ({id: r.data.id, tag_name: r.data.tag_name, is_tag: r.data.is_tag})),
    ...(slot.state === 'ready' ? slot.list.map((d) => ({id: d.id, tag_name: d.tag_name, is_tag: false})) : []),
  ];
  const tag = fields.tag.trim();
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
  /** Saves the release, then its assets; resolves with what went wrong with an asset, if anything. */
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
      {error && <Callout tone="danger" title="Not saved">{error}</Callout>}
      <section aria-label="Tag" className="flex flex-col gap-2">
        {tagFixed ?
          <p className="flex items-center gap-2 text-base text-fg-muted"><Icon icon={Tag} size="sm"/><Code>{tag}</Code>{existing && <span>at <span className="font-mono">{shortSha(existing)}</span></span>}</p> :
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Input aria-label="Tag name" placeholder="Tag, e.g. v1.0.0" value={fields.tag} autoFocus={!editing} className="w-64" maxLength={TAG_MAX}
                spellCheck={false} autoComplete="off" invalid={tagBad} aria-describedby={tagBad ? 'release-tag-problem' : 'release-tag-state'}
                onChange={(e) => {
                  set({tag: e.target.value});
                }}/>
              {freeTags.length > 0 && (
                <CommandPopover width="md" label="Existing tags" placeholder="Find a tag…" empty="No tag without a release."
                  options={freeTags.map((t) => ({value: t, label: t, icon: Tag, checked: t === tag, onSelect: () => {
                    set({tag: t});
                  }}))}
                  trigger={<Button size="sm" variant="ghost">Existing tag<Icon icon={ChevronDown} size="sm"/></Button>}/>
              )}
            </div>
            {tagBad ? <p id="release-tag-problem" role="alert" className="text-sm text-danger">{problem}</p> :
              tag && (existing ?
                <p id="release-tag-state" className="text-sm text-fg-subtle">The existing tag, at <span className="font-mono">{shortSha(existing)}</span>.</p> :
                <div id="release-tag-state" className="flex flex-wrap items-center gap-2 text-sm text-fg-subtle">
                  <span>A new tag, made when the release is published, from</span>
                  <RefPicker repoId={repoId} label="Target branch" value={{kind: 'branch', ref: fields.target}} branchesOnly onChange={(c) => {
                    set({target: c.ref});
                  }}/>
                </div>)}
          </>}
      </section>
      <Input aria-label="Title" placeholder={tag ? `Title (${tag} if empty)` : 'Title'} value={fields.title} autoFocus={Boolean(editing)} className="w-full" maxLength={TITLE_MAX}
        onChange={(e) => {
          set({title: e.target.value});
        }}/>
      <MarkdownField repoId={repoId} label="Release notes" placeholder="Describe this release…" value={fields.notes} rows={10}
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
              <Icon icon={Paperclip} size="sm"/>
              <span className={gone ? 'text-fg-subtle line-through' : 'text-fg'}>{a.name}</span>
              <span className="text-sm text-fg-subtle tabular-nums">{formatSize(a.size)}</span>
              <IconButton size="sm" icon={gone ? Undo2 : X} label={gone ? `Keep ${a.name}` : `Remove ${a.name}`} onClick={() => {
                setRemoved((r) => (gone ? r.filter((x) => x !== a.id) : [...r, a.id]));
              }}/>
            </div>
          );
        })}
        {files.map((f, i) => (
          <div key={`${f.name}:${String(i)}`} className="flex items-center gap-2 text-base">
            <Icon icon={Plus} size="sm"/><span className="text-fg">{f.name}</span>
            <span className="text-sm text-fg-subtle tabular-nums">{formatSize(f.size)}</span>
            <IconButton size="sm" icon={X} label={`Do not upload ${f.name}`} onClick={() => {
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
          <Button size="sm" variant="ghost" icon={Paperclip} onClick={() => picker.current?.click()}>Attach files</Button>
        </div>
      </section>
      <Checkbox label="This is a pre-release (not ready for production)" checked={fields.prerelease} onChange={(prerelease) => {
        set({prerelease});
      }}/>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {block && <span className="mr-auto text-sm text-fg-subtle">{block}</span>}
        <Button variant="ghost" onClick={back}>Cancel</Button>
        {publishing && <Button aria-disabled={Boolean(block) || Boolean(busy)} tooltip={block ?? 'Only writers see a draft'} onClick={() => {
          save(true);
        }}>{busy?.draft ? busy.label : 'Save draft'}</Button>}
        <Button variant="primary" shortcut={shortcutHint('submit')} aria-disabled={Boolean(block) || Boolean(busy)} tooltip={block} onClick={() => {
          save(false);
        }}>{busy && !busy.draft ? busy.label : publishing ? 'Publish release' : 'Save'}</Button>
      </div>
    </div>
  );
});
