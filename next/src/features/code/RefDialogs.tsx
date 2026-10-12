// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Wait for ref changes to sync before closing; server refusals remain in the dialog.

import {observer} from 'mobx-react-lite';
import {type ReactNode, type RefObject, useRef, useState} from 'react';
import {failureText} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {reach} from '../../app/online.ts';
import {useApp, useSession} from '../../app/store.ts';
import {usePool} from '../issues/cells.tsx';
import {refTable, useLoad} from './hooks.ts';
import {branchProtected, createBranch, createTag, deleteBranch, deleteTag, repoRef} from './refOps.ts';
import {RefPicker} from './RefMenu.tsx';
import {BRANCH_MAX, branchDeleteBlock, createBranchBody, createTagBody, type RefChoice, refNameProblem, TAG_MAX, tagDeleteBlock, writeBlock} from './refWrite.ts';
import {AriaAlert, Dialog, FormControl, TextInput, Textarea} from '@primer/react';

/** Returns a reactive refusal reason, or undefined when writing is allowed. */
export function useWriteBlock(repoId: number, action: string, refsOnly: boolean): string | undefined {
  const pool = usePool();
  const session = useSession();
  const r = pool.model('Repository').get(repoId)?.data;
  return writeBlock(r && {archived: r.archived, mirror: r.mirror}, reach(session.data.status.connection) === 'online', action, refsOnly);
}

function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const run = (op: () => Promise<void>, done: () => void) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    op().then(() => {
      setBusy(false);
      done();
    }, (err: unknown) => {
      setBusy(false);
      setError(failureText(err));
    });
  };
  return {busy, error, run};
}

function Problem({children}: {children: ReactNode}) {
  return <p role="alert" className="text-sm text-danger">{children}</p>;
}

/** The problem is the field's description and is announced as it appears or changes, also while typing. */
function NameField({label, placeholder, value, onChange, problem, shown, maxLength, onEnter, inputRef}: {
  label: string; placeholder: string; value: string; onChange: (v: string) => void; problem: string | undefined; shown: boolean; maxLength: number; onEnter: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const bad = shown && problem !== undefined;
  return (
    <FormControl>
      <FormControl.Label>{label}</FormControl.Label>
      <TextInput ref={inputRef} placeholder={placeholder} value={value} autoFocus className="w-full" maxLength={maxLength} spellCheck={false} autoComplete="off" onChange={(e) => {
          onChange(e.target.value);
        }} onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onEnter();
          }
        }}/>
      {bad && <FormControl.Validation variant="error"><AriaAlert as="span">{problem}</AriaAlert></FormControl.Validation>}
    </FormControl>
  );
}

export const NewBranchDialog = observer(function NewBranchDialog({repoId, from, name: initial = '', onClose, onCreated}: {
  repoId: number; from?: RefChoice | undefined; name?: string; onClose: () => void; onCreated?: (name: string) => void;
}) {
  const app = useApp();
  const session = useSession();
  const pool = usePool();
  const refs = refTable(pool, repoId);
  const [name, setName] = useState(initial);
  const [source, setSource] = useState<RefChoice>(from ?? {kind: 'branch', ref: refs.defaultBranch});
  const [asked, setAsked] = useState(false);
  const {busy, error, run} = useRun();
  const block = useWriteBlock(repoId, 'Creating a branch', true);
  const trimmed = name.trim();
  const problem = refNameProblem(trimmed, 'branch', refs) ?? (source.ref ? undefined : 'Choose where the branch starts.');
  const field = useRef<HTMLInputElement>(null);
  const create = () => {
    setAsked(true);
    const repo = repoRef(session, repoId);
    if (problem) field.current?.focus();
    if (problem || block || !repo) return;
    run(() => createBranch(app, repo, createBranchBody(trimmed, source, refs)), () => {
      notify(app, {tone: 'success', title: `Created the branch ${trimmed}`});
      onClose();
      onCreated?.(trimmed);
    });
  };
  return (
    <Dialog title="New branch" width="large" onClose={() => { if (!busy) onClose(); }} footerButtons={[
      {content: 'Cancel', disabled: busy, onClick: onClose},
      {content: busy ? 'Creating…' : 'Create branch', buttonType: 'primary', inactive: Boolean(block) || busy, 'aria-disabled': Boolean(block) || busy, onClick: create},
    ]}>
      <div className="flex flex-col gap-3">
        <NameField label="Branch name" placeholder="feature/my-change" value={name} onChange={setName} problem={problem} shown={asked || trimmed !== ''} maxLength={BRANCH_MAX} onEnter={create} inputRef={field}/>
        <div className="flex flex-wrap items-center gap-2 text-base text-muted">
          <span>From</span>
          <RefPicker repoId={repoId} label="Start from" value={source} onChange={setSource} commits/>
        </div>
        {block && <p className="text-sm text-muted">{block}</p>}
        {error && <Problem>{error}</Problem>}
      </div>
    </Dialog>
  );
});

export const NewTagDialog = observer(function NewTagDialog({repoId, onClose}: {repoId: number; onClose: () => void}) {
  const app = useApp();
  const session = useSession();
  const pool = usePool();
  const refs = refTable(pool, repoId);
  const [name, setName] = useState('');
  const [target, setTarget] = useState<RefChoice>({kind: 'branch', ref: refs.defaultBranch});
  const [message, setMessage] = useState('');
  const [asked, setAsked] = useState(false);
  const {busy, error, run} = useRun();
  const block = useWriteBlock(repoId, 'Creating a tag', true);
  const trimmed = name.trim();
  const problem = refNameProblem(trimmed, 'tag', refs) ?? (target.ref ? undefined : 'Choose the commit to tag.');
  const field = useRef<HTMLInputElement>(null);
  const create = () => {
    setAsked(true);
    const repo = repoRef(session, repoId);
    if (problem) field.current?.focus();
    if (problem || block || !repo) return;
    run(() => createTag(app, repo, createTagBody(trimmed, target, message, refs)), () => {
      notify(app, {tone: 'success', title: `Created the tag ${trimmed}`});
      onClose();
    });
  };
  return (
    <Dialog title="New tag" width="large" onClose={onClose} footerButtons={[
      {content: 'Cancel', disabled: busy, onClick: onClose},
      {content: busy ? 'Creating…' : 'Create tag', buttonType: 'primary', inactive: Boolean(block) || busy, onClick: create},
    ]}>
      <div className="flex flex-col gap-3">
        <NameField label="Tag name" placeholder="v1.0.0" value={name} onChange={setName} problem={problem} shown={asked || trimmed !== ''} maxLength={TAG_MAX} onEnter={create} inputRef={field}/>
        <div className="flex flex-wrap items-center gap-2 text-base text-muted">
          <span>At</span>
          <RefPicker repoId={repoId} label="Tag the commit of" value={target} onChange={setTarget} commits/>
        </div>
        <Textarea aria-label="Message" placeholder="Message (optional: makes an annotated tag)" rows={3} value={message} onChange={(e) => {
          setMessage(e.target.value);
        }} onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            create();
          }
        }} block/>
        {block && <p className="text-sm text-muted">{block}</p>}
        {error && <Problem>{error}</Problem>}
      </div>
    </Dialog>
  );
});

/** `blocked` replaces Delete with a reason; `pending` disables it until checks finish. */
export function ConfirmDelete({title, description, blocked, pending, onDelete, onClose}: {
  title: string; description: ReactNode; blocked?: string | undefined; pending?: string | undefined; onDelete: () => Promise<void>; onClose: () => void;
}) {
  const {busy, error, run} = useRun();
  const remove = () => {
    if (blocked || pending) return;
    run(onDelete, onClose);
  };
  return (
    <Dialog title={title} subtitle={description} width="medium" onClose={onClose} footerButtons={[
      {content: blocked ? 'Close' : 'Cancel', disabled: busy, onClick: onClose},
      ...(!blocked ? [{content: busy ? 'Deleting…' : 'Delete', buttonType: 'danger' as const, autoFocus: true, disabled: busy || Boolean(pending), onClick: remove}] : []),
    ]}>
      {(blocked ?? pending ?? error) && (
        <div className="flex flex-col gap-1">
          {blocked && <p role="alert" className="text-base text-default">{blocked}</p>}
          {!blocked && pending && <p className="text-sm text-muted">{pending}</p>}
          {error && <Problem>{error}</Problem>}
        </div>
      )}
    </Dialog>
  );
}

export const DeleteBranchDialog = observer(function DeleteBranchDialog({repoId, name, openPull, onClose}: {
  repoId: number; name: string; openPull: number | undefined; onClose: () => void;
}) {
  const app = useApp();
  const session = useSession();
  const pool = usePool();
  const def = pool.model('Repository').get(repoId)?.get('default_branch') ?? '';
  const block = useWriteBlock(repoId, 'Deleting a branch', true);
  const repo = repoRef(session, repoId);
  // Protection rules are not synced; a failed lookup leaves enforcement to the write API.
  const prot = useLoad(block || !repo || name === def ? undefined : `protected:${String(repoId)}:${name}`, () => undefined, () => (repo ? branchProtected(app, repo, name) : Promise.resolve(false)));
  const blocked = block ?? branchDeleteBlock(name, def, prot.state === 'ready' ? prot.value : undefined);
  return (
    <ConfirmDelete title={`Delete the branch ${name}?`} blocked={blocked}
      pending={prot.state === 'loading' ? 'Checking whether the branch is protected…' : undefined}
      description={<>The branch is deleted for everyone; its commits stay where other branches have them.{openPull !== undefined && <> Its open pull request #{openPull} is closed.</>}</>}
      onDelete={async () => {
        if (!repo) return;
        await deleteBranch(app, repo, name);
        notify(app, {tone: 'success', title: `Deleted the branch ${name}`});
      }} onClose={onClose}/>
  );
});

/** Delete a release before deleting its tag. */
export const DeleteTagDialog = observer(function DeleteTagDialog({repoId, name, hasRelease, onClose}: {repoId: number; name: string; hasRelease: boolean; onClose: () => void}) {
  const app = useApp();
  const session = useSession();
  const block = useWriteBlock(repoId, 'Deleting a tag', true);
  return (
    <ConfirmDelete title={`Delete the tag ${name}?`} blocked={block ?? tagDeleteBlock(hasRelease)}
      description="The tag is deleted for everyone; the commit it names stays."
      onDelete={async () => {
        const repo = repoRef(session, repoId);
        if (!repo) return;
        await deleteTag(app, repo, name);
        notify(app, {tone: 'success', title: `Deleted the tag ${name}`});
      }} onClose={onClose}/>
  );
});
