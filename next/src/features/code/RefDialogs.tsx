// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The dialogs of the branches and tags views (writers, online): a new branch
// (a name and where it starts: a branch, a tag or a commit), a new tag (a
// name, its commit, a message for an annotated tag), and the confirmations of
// deleting a branch (after asking Forgejo whether it is protected), a tag
// or a release. Each waits for the pool to show its change (refOps.ts)
// before it closes; Forgejo's refusal stays in the dialog, in its words.

import {observer} from 'mobx-react-lite';
import {type ReactNode, useState} from 'react';
import {failureText} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {reach} from '../../app/online.ts';
import {useApp, useSession} from '../../app/store.ts';
import {Button, Dialog, Input, TextArea} from '../../ui/index.ts';
import {usePool} from '../issues/cells.tsx';
import {refTable, useLoad} from './hooks.ts';
import {branchProtected, createBranch, createTag, deleteBranch, deleteTag, repoRef} from './refOps.ts';
import {RefPicker} from './RefMenu.tsx';
import {BRANCH_MAX, branchDeleteBlock, createBranchBody, createTagBody, type RefChoice, refNameProblem, TAG_MAX, tagDeleteBlock, writeBlock} from './refWrite.ts';

/** Why the viewer cannot do `action` in the repository now (archived, a mirror's refs, offline), or undefined. Observes. */
export function useWriteBlock(repoId: number, action: string, refsOnly: boolean): string | undefined {
  const pool = usePool();
  const session = useSession();
  const r = pool.model('Repository').get(repoId)?.data;
  return writeBlock(r && {archived: r.archived, mirror: r.mirror}, reach(session.data.status.connection) === 'online', action, refsOnly);
}

/** A write's state in a dialog: running, and Forgejo's refusal. */
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

function Problem({id, children}: {id: string; children: ReactNode}) {
  return <p id={id} role="alert" className="text-sm text-danger">{children}</p>;
}

/** A name field: Enter submits, the problem shown below once something was typed or Create was asked. */
function NameField({label, placeholder, value, onChange, problem, shown, maxLength, onEnter}: {
  label: string; placeholder: string; value: string; onChange: (v: string) => void; problem: string | undefined; shown: boolean; maxLength: number; onEnter: () => void;
}) {
  const bad = shown && problem !== undefined;
  return (
    <div className="flex flex-col gap-1">
      <Input aria-label={label} placeholder={placeholder} value={value} autoFocus className="w-full" maxLength={maxLength} invalid={bad}
        aria-describedby={bad ? 'ref-name-problem' : undefined} spellCheck={false} autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onEnter();
          }
        }}/>
      {bad && <Problem id="ref-name-problem">{problem}</Problem>}
    </div>
  );
}

/** A new branch: its name, and where it starts (`from`: the default branch unless given). */
export const NewBranchDialog = observer(function NewBranchDialog({repoId, from, onClose}: {repoId: number; from?: RefChoice | undefined; onClose: () => void}) {
  const app = useApp();
  const session = useSession();
  const pool = usePool();
  const refs = refTable(pool, repoId);
  const [name, setName] = useState('');
  const [source, setSource] = useState<RefChoice>(from ?? {kind: 'branch', ref: refs.defaultBranch});
  const [asked, setAsked] = useState(false);
  const {busy, error, run} = useRun();
  const block = useWriteBlock(repoId, 'Creating a branch', true);
  const trimmed = name.trim();
  const problem = refNameProblem(trimmed, 'branch', refs) ?? (source.ref ? undefined : 'Choose where the branch starts.');
  const create = () => {
    setAsked(true);
    const repo = repoRef(session, repoId);
    if (problem || block || !repo) return;
    run(() => createBranch(app, repo, createBranchBody(trimmed, source, refs)), () => {
      notify(app, {tone: 'success', title: `Created the branch ${trimmed}`});
      onClose();
    });
  };
  return (
    <Dialog open size="md" title="New branch" onOpenChange={(o) => {
      if (!o) onClose();
    }} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" aria-disabled={Boolean(block) || busy} tooltip={block} onClick={create}>{busy ? 'Creating…' : 'Create branch'}</Button>
    </>}>
      <div className="flex flex-col gap-3">
        <NameField label="Branch name" placeholder="feature/my-change" value={name} onChange={setName} problem={problem} shown={asked || trimmed !== ''} maxLength={BRANCH_MAX} onEnter={create}/>
        <div className="flex flex-wrap items-center gap-2 text-base text-fg-muted">
          <span>From</span>
          <RefPicker repoId={repoId} label="Start from" value={source} onChange={setSource} commits/>
        </div>
        {block && <p className="text-sm text-fg-subtle">{block}</p>}
        {error && <Problem id="ref-write-error">{error}</Problem>}
      </div>
    </Dialog>
  );
});

/** A new tag: its name, its commit (a branch's head, another tag's, or a commit), and a message (annotated). */
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
  const create = () => {
    setAsked(true);
    const repo = repoRef(session, repoId);
    if (problem || block || !repo) return;
    run(() => createTag(app, repo, createTagBody(trimmed, target, message, refs)), () => {
      notify(app, {tone: 'success', title: `Created the tag ${trimmed}`});
      onClose();
    });
  };
  return (
    <Dialog open size="md" title="New tag" onOpenChange={(o) => {
      if (!o) onClose();
    }} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" aria-disabled={Boolean(block) || busy} tooltip={block} onClick={create}>{busy ? 'Creating…' : 'Create tag'}</Button>
    </>}>
      <div className="flex flex-col gap-3">
        <NameField label="Tag name" placeholder="v1.0.0" value={name} onChange={setName} problem={problem} shown={asked || trimmed !== ''} maxLength={TAG_MAX} onEnter={create}/>
        <div className="flex flex-wrap items-center gap-2 text-base text-fg-muted">
          <span>At</span>
          <RefPicker repoId={repoId} label="Tag the commit of" value={target} onChange={setTarget} commits/>
        </div>
        <TextArea aria-label="Message" placeholder="Message (optional: makes an annotated tag)" rows={3} value={message} onChange={(e) => {
          setMessage(e.target.value);
        }} onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            create();
          }
        }}/>
        {block && <p className="text-sm text-fg-subtle">{block}</p>}
        {error && <Problem id="ref-write-error">{error}</Problem>}
      </div>
    </Dialog>
  );
});

/**
 * Asks before something is deleted for everyone. `blocked`: why it cannot be (shown instead of Delete);
 * `pending`: a check still running (Delete waits for it).
 */
export function ConfirmDelete({title, description, blocked, pending, onDelete, onClose}: {
  title: string; description: ReactNode; blocked?: string | undefined; pending?: string | undefined; onDelete: () => Promise<void>; onClose: () => void;
}) {
  const {busy, error, run} = useRun();
  const remove = () => {
    if (blocked || pending) return;
    run(onDelete, onClose);
  };
  return (
    <Dialog open size="sm" title={title} description={description} initialFocus={blocked ? 'dialog' : 'first'} onOpenChange={(o) => {
      if (!o) onClose();
    }} footer={<>
      <Button variant="ghost" onClick={onClose}>{blocked ? 'Close' : 'Cancel'}</Button>
      {!blocked && <Button variant="danger" autoFocus aria-disabled={busy || Boolean(pending)} onClick={remove}>{busy ? 'Deleting…' : 'Delete'}</Button>}
    </>}>
      {(blocked ?? pending ?? error) && (
        <div className="flex flex-col gap-1">
          {blocked && <p role="alert" className="text-base text-fg">{blocked}</p>}
          {!blocked && pending && <p className="text-sm text-fg-subtle">{pending}</p>}
          {error && <Problem id="ref-write-error">{error}</Problem>}
        </div>
      )}
    </Dialog>
  );
}

/** Deletes a branch: never the default one, nor one Forgejo protects (asked when the dialog opens). */
export const DeleteBranchDialog = observer(function DeleteBranchDialog({repoId, name, openPull, onClose}: {
  repoId: number; name: string; openPull: number | undefined; onClose: () => void;
}) {
  const app = useApp();
  const session = useSession();
  const pool = usePool();
  const def = pool.model('Repository').get(repoId)?.get('default_branch') ?? '';
  const block = useWriteBlock(repoId, 'Deleting a branch', true);
  const repo = repoRef(session, repoId);
  // Protection rules are not synced: Forgejo says (online; a failed check leaves it to Forgejo's answer).
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

/** Deletes a tag without a release (a release's tag goes after its release). */
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
