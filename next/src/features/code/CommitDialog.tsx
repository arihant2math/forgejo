// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {useState} from 'react';
import {BranchName, Checkbox, Dialog, FormControl, Radio, RadioGroup, TextInput, Textarea} from '@primer/react';

export interface CommitFields {
  message: string;
  description: string;
  newBranch?: string;
  openPull: boolean;
}

/** The caller owns validation and the online write; drafts stay in the caller. */
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
  const commit = () => {
    if (busy || why) return;
    onCommit({message, description, ...(useNew ? {newBranch: name.trim()} : {}), openPull: useNew && pull && allowPull});
  };
  return <Dialog title="Commit changes" width="large" onClose={() => { if (!busy) onClose(); }} footerButtons={[
    {content: 'Cancel', disabled: busy, onClick: onClose},
    {content: busy ? 'Committing…' : 'Commit changes', buttonType: 'primary', disabled: busy || Boolean(why), onClick: commit},
  ]}>
    <div className="flex flex-col gap-3">
      <FormControl><FormControl.Label>Commit message</FormControl.Label><TextInput block value={message} onChange={(event) => { setMessage(event.target.value); }}/></FormControl>
      <FormControl><FormControl.Label>Commit description</FormControl.Label><Textarea value={description} onChange={(event) => { setDescription(event.target.value); }} block rows={6}/></FormControl>
      {protectedBranch && <p className="text-sm text-muted">This branch is protected. Commit to a new branch and propose a pull request.</p>}
      <RadioGroup name="commit-target" onChange={(value) => { setNewBranch(value === 'new'); }}>
        <RadioGroup.Label>Commit to</RadioGroup.Label>
        {!protectedBranch && <FormControl><Radio value="direct" checked={!useNew}/><FormControl.Label>Commit directly to <BranchName as="span">{branch}</BranchName></FormControl.Label></FormControl>}
        <FormControl><Radio value="new" checked={useNew}/><FormControl.Label>Create a new branch</FormControl.Label></FormControl>
      </RadioGroup>
      {useNew && <>
        <FormControl><FormControl.Label>New branch name</FormControl.Label><TextInput block value={name} onChange={(event) => { setName(event.target.value); }}/></FormControl>
        {allowPull ? <FormControl><Checkbox checked={pull} onChange={(event) => { setPull(event.target.checked); }}/><FormControl.Label>{pullInto ? `Open a pull request into ${pullInto}` : 'Open a pull request'}</FormControl.Label></FormControl> : <p className="text-sm text-muted">The first commit establishes the branch. A pull request needs an existing base branch.</p>}
      </>}
      {why && <p className="text-sm text-muted">{why}</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  </Dialog>;
}
