// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {useState} from 'react';
import {Button, Dialog, TextInput, Textarea} from '@primer/react';

export interface CommitFields {
  message: string;
  description: string;
  newBranch?: string;
  openPull: boolean;
}

/**
 * Shared by browser file operations; the caller owns validation and the write. `pullInto`: where the pull request of a
 * new branch is opened, when that is not this repository's `branch` (a fork's: its upstream, `owner/repo:branch`).
 */
export function CommitDialog({branch, defaultMessage, protectedBranch, busy, error, blocked, branchProblem, onClose, onCommit, allowPull = true, pullInto}: {
  branch: string; defaultMessage: string; protectedBranch: boolean; busy: boolean; error: string;
  blocked: string | undefined; branchProblem: (name: string) => string | undefined;
  onClose: () => void; onCommit: (fields: CommitFields) => void; allowPull?: boolean; pullInto?: string | undefined;
}) {
  const [message, setMessage] = useState(defaultMessage);
  const [description, setDescription] = useState('');
  const [newBranch, setNewBranch] = useState(protectedBranch);
  const [name, setName] = useState(() => `edit-${Date.now().toString(36)}`);
  const [pull, setPull] = useState(true);
  const useNew = protectedBranch || newBranch;
  const why = blocked ?? (!message.trim() ? 'Add a commit message.' : useNew ? branchProblem(name.trim()) : undefined);
  return <Dialog title="Commit changes" width="large" onClose={() => { const open = false; if (!open && !busy) onClose(); }} renderFooter={() => <Dialog.Footer>{<>
    <Button variant="invisible" type="button" disabled={busy} onClick={onClose}>Cancel</Button>
    <Button type="button" disabled={busy || Boolean(why)} onClick={() => {onCommit({message, description, ...(useNew ? {newBranch: name.trim()} : {}), openPull: useNew && pull && allowPull});}}>{busy ? 'Committing…' : 'Commit changes'}</Button>
  </>}</Dialog.Footer>}>
    <div className="flex flex-col gap-3">
      <TextInput aria-label="Commit message" value={message} onChange={(e) => {setMessage(e.target.value);}}/>
      <Textarea aria-label="Commit description" value={description} onChange={(e) => {setDescription(e.target.value);}} block rows={6}/>
      {protectedBranch && <p className="text-sm text-muted">This branch is protected. Commit to a new branch and propose a pull request.</p>}
      {!protectedBranch && <label><input type="radio" checked={!useNew} onChange={() => {setNewBranch(false);}}/> Commit directly to {branch}</label>}
      <label><input type="radio" checked={useNew} onChange={() => {setNewBranch(true);}}/> Create a new branch</label>
      {useNew && <><TextInput aria-label="New branch name" value={name} onChange={(e) => {setName(e.target.value);}}/>{allowPull ? <label><input type="checkbox" checked={pull} onChange={(e) => {setPull(e.target.checked);}}/> {pullInto ? `Open a pull request into ${pullInto}` : 'Open a pull request'}</label> : <p className="text-sm text-muted">The first commit establishes the branch. A pull request needs an existing base branch.</p>}</>}
      {why && <p className="text-sm text-muted">{why}</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  </Dialog>;
}
