// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A label's form (new, edit) and the confirmation of a deletion. Saving
// closes the dialog at once: the change shows on the page while it is sent
// (writes.ts), and is rolled back with a notice if Forgejo refuses it.

import {type SyntheticEvent, useId, useState} from 'react';
import {useApp} from '../../app/store.ts';
import type {Label} from '../../protocol/types.gen.ts';
import {Button, Checkbox, ColorPicker, Dialog, Field, Input, LabelPill} from '../../ui/index.ts';
import {exclusiveScope} from '../issues/labels.ts';
import {DESCRIPTION_MAX, draftOf, LABEL_PRESETS, type LabelDraft, labelEdit, labelProblems, labelValid, NAME_MAX, nextPreset, normalizeColor} from './labels.ts';
import {createLabel, deleteLabel, editLabel, type RepoRef} from './writes.ts';

/** The pill a draft makes (the form's preview), and a label's own: an exclusive scoped label shows its scope. */
export function DraftPill({name, color, exclusive}: {name: string; color: string; exclusive: boolean}) {
  const scope = exclusiveScope({name, exclusive});
  return <LabelPill name={name} color={normalizeColor(color) ?? color} scope={scope || undefined}/>;
}

/** New (no `label`) or edit. `count`: the repository's labels, for the new one's colour. */
export function LabelDialog({repo, label, count, onClose}: {repo: RepoRef; label?: Label | undefined; count: number; onClose: () => void}) {
  const app = useApp();
  const [d, setD] = useState<LabelDraft>(() => (label ? draftOf(label) : {name: '', description: '', color: nextPreset(count), exclusive: false, archived: false}));
  const [tried, setTried] = useState(false);
  const id = useId();
  const problems = labelProblems(d);
  const set = (patch: Partial<LabelDraft>) => {
    setD((x) => ({...x, ...patch}));
  };
  const save = (e?: SyntheticEvent) => {
    e?.preventDefault();
    if (!labelValid(d)) {
      setTried(true);
      return;
    }
    onClose();
    if (!label) {
      void createLabel(app, repo, d);
      return;
    }
    const change = labelEdit(label, d);
    if (change) void editLabel(app, repo, label, change);
  };
  return (
    <Dialog open title={label ? 'Edit label' : 'New label'} onOpenChange={(o) => {
      if (!o) onClose();
    }} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" onClick={() => {
        save();
      }}>{label ? 'Save' : 'Create label'}</Button>
    </>}>
      <form className="flex flex-col gap-3" onSubmit={save}>
        <div className="flex min-h-control items-center"><DraftPill name={d.name.trim() || 'Label preview'} color={d.color} exclusive={d.exclusive}/></div>
        <Field label="Name" htmlFor={`${id}-name`} error={tried ? problems.name : undefined} errorId={`${id}-name-e`}>
          <Input id={`${id}-name`} value={d.name} autoFocus maxLength={NAME_MAX} placeholder="bug, kind/feature, …" className="w-full" invalid={tried && Boolean(problems.name)}
            aria-describedby={`${id}-name-e`} onChange={(e) => {
              set({name: e.target.value});
            }}/>
        </Field>
        <Field label="Description" htmlFor={`${id}-desc`} error={problems.description} errorId={`${id}-desc-e`}>
          <Input id={`${id}-desc`} value={d.description} maxLength={DESCRIPTION_MAX} placeholder="What it is for (optional)" className="w-full" aria-describedby={`${id}-desc-e`}
            onChange={(e) => {
              set({description: e.target.value});
            }}/>
        </Field>
        <Field label="Colour" htmlFor={`${id}-color`} error={tried ? problems.color : undefined} errorId={`${id}-color-e`}>
          <ColorPicker id={`${id}-color`} label="Colour" value={d.color} presets={LABEL_PRESETS} invalid={tried && Boolean(problems.color)} onChange={(color) => {
            set({color});
          }}/>
        </Field>
        <div className="flex flex-col gap-1">
          <Checkbox label="Exclusive within its scope" checked={d.exclusive} onChange={(exclusive) => {
            set({exclusive});
          }}/>
          <p className="text-sm text-fg-muted">
            {d.exclusive && problems.exclusive ? problems.exclusive :
              'An issue can have one label of a scope (the name up to its last “/”): adding another removes the one it has. Status and priority are such scopes.'}
          </p>
        </div>
        {label && <Checkbox label="Archived (kept on its issues, no longer offered)" checked={d.archived} onChange={(archived) => {
          set({archived});
        }}/>}
        {/* Enter in a field saves. */}
        <button type="submit" hidden/>
      </form>
    </Dialog>
  );
}

/** Asks before a label is deleted (it leaves every issue and pull request that has it). */
export function DeleteLabelDialog({repo, label, open, onClose}: {repo: RepoRef; label: Label; open: number; onClose: () => void}) {
  const app = useApp();
  return (
    <Dialog open size="sm" title={`Delete the label “${label.name}”?`} initialFocus="dialog" onOpenChange={(o) => {
      if (!o) onClose();
    }} description={`It is removed from every issue and pull request that has it${open ? ` (${String(open)} open)` : ''}. This cannot be undone; archiving keeps it on them.`}
    footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="danger" onClick={() => {
        onClose();
        void deleteLabel(app, repo, label);
      }}>Delete label</Button>
    </>}/>
  );
}
