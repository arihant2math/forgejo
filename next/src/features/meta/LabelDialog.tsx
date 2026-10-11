// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A label's form (new, edit) and the confirmation of a deletion. Saving
// closes the dialog at once: the change shows on the page while it is sent
// (writes.ts), and is rolled back with a notice if Forgejo refuses it.

import {type SyntheticEvent, useId, useState} from 'react';
import {observer} from 'mobx-react-lite';
import {connectivity, onlineOnly} from '../../app/online.ts';
import {useApp} from '../../app/store.ts';
import type {Label} from '../../protocol/types.gen.ts';
import {ColorPicker, LabelPill} from '../../ui/index.ts';
import {exclusiveScope} from '../issues/labels.ts';
import {DESCRIPTION_MAX, draftOf, LABEL_PRESETS, type LabelDraft, labelEdit, labelProblems, labelValid, NAME_MAX, nextPreset, normalizeColor} from './labels.ts';
import {createLabel, deleteLabel, editLabel, type RepoRef} from './writes.ts';
import {Button, Checkbox, FormControl, Dialog, TextInput} from '@primer/react';
import {OptionalTooltip} from '../../app/OptionalTooltip.tsx';

/** The pill a draft makes (the form's preview), and a label's own: an exclusive scoped label shows its scope. */
export function DraftPill({name, color, exclusive}: {name: string; color: string; exclusive: boolean}) {
  const scope = exclusiveScope({name, exclusive});
  return <LabelPill name={name} color={normalizeColor(color) ?? color} scope={scope || undefined}/>;
}

/** New (no `label`) or edit. `count`: the repository's labels, for the new one's colour. */
export const LabelDialog = observer(function LabelDialog({repo, label, count, onClose, onSave}: {repo: RepoRef; label?: Label | undefined; count: number; onClose: () => void; onSave?: (draft: LabelDraft) => Promise<boolean>}) {
  const app = useApp();
  const [d, setD] = useState<LabelDraft>(() => (label ? draftOf(label) : {name: '', description: '', color: nextPreset(count), exclusive: false, archived: false}));
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
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
    if (saving || !connectivity.online) return;
    if (onSave) {
      setSaving(true);
      void onSave(d).then((ok) => {
        setSaving(false);
        if (ok) onClose();
      });
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
    <Dialog title={label ? 'Edit label' : 'New label'} width="large" onClose={() => { const o = false; if (!o) onClose(); }} renderFooter={() => <Dialog.Footer>{<>
      <Button variant="invisible" type="button" onClick={onClose}>Cancel</Button>
      <OptionalTooltip text={!connectivity.online ? onlineOnly('Saving a label') : undefined}><Button variant="primary" type="button" disabled={saving || !connectivity.online} onClick={() => {
        save();
      }}>{label ? 'Save' : 'Create label'}</Button></OptionalTooltip>
    </>}</Dialog.Footer>}>
      <form className="flex flex-col gap-3" onSubmit={save}>
        <div className="flex min-h-control items-center"><DraftPill name={d.name.trim() || 'Label preview'} color={d.color} exclusive={d.exclusive}/></div>
        <FormControl id={`${id}-name`}><FormControl.Label>Name</FormControl.Label>
          <TextInput id={`${id}-name`} value={d.name} autoFocus maxLength={NAME_MAX} placeholder="bug, kind/feature, …" className="w-full" aria-describedby={`${id}-name-e`} onChange={(e) => {
              set({name: e.target.value});
            }} {...(tried && Boolean(problems.name) ? {validationStatus: 'error' as const} : {})}/>
        {(tried ? problems.name : undefined) && <FormControl.Validation variant="error">{tried ? problems.name : undefined}</FormControl.Validation>}</FormControl>
        <FormControl id={`${id}-desc`}><FormControl.Label>Description</FormControl.Label>
          <TextInput id={`${id}-desc`} value={d.description} maxLength={DESCRIPTION_MAX} placeholder="What it is for (optional)" className="w-full" aria-describedby={`${id}-desc-e`} onChange={(e) => {
              set({description: e.target.value});
            }}/>
        {problems.description && <FormControl.Validation variant="error">{problems.description}</FormControl.Validation>}</FormControl>
        <FormControl id={`${id}-color`}><FormControl.Label>Colour</FormControl.Label>
          <ColorPicker id={`${id}-color`} label="Colour" value={d.color} presets={LABEL_PRESETS} invalid={tried && Boolean(problems.color)} onChange={(color) => {
            set({color});
          }}/>
        {(tried ? problems.color : undefined) && <FormControl.Validation variant="error">{tried ? problems.color : undefined}</FormControl.Validation>}</FormControl>
        <div className="flex flex-col gap-1">
          <FormControl><Checkbox checked={d.exclusive} onChange={(event) => { const exclusive = event.target.checked; set({exclusive}); }}/><FormControl.Label>Exclusive within its scope</FormControl.Label></FormControl>
          <p className="text-sm text-muted">
            {d.exclusive && problems.exclusive ? problems.exclusive :
              'An issue can have one label of a scope (the name up to its last “/”): adding another removes the one it has. Status and priority are such scopes.'}
          </p>
        </div>
        {label && <FormControl><Checkbox checked={d.archived} onChange={(event) => { const archived = event.target.checked; set({archived}); }}/><FormControl.Label>Archived (kept on its issues, no longer offered)</FormControl.Label></FormControl>}
        {/* Enter in a field saves. */}
        <button type="submit" hidden/>
      </form>
    </Dialog>
  );
});

/** Asks before a label is deleted (it leaves every issue and pull request that has it). */
export function DeleteLabelDialog({repo, label, open, onClose}: {repo: RepoRef; label: Label; open: number; onClose: () => void}) {
  const app = useApp();
  return (
    <Dialog title={`Delete the label “${label.name}”?`} subtitle={`It is removed from every issue and pull request that has it${open ? ` (${String(open)} open)` : ''}. This cannot be undone; archiving keeps it on them.`} width="medium" onClose={() => { const o = false; if (!o) onClose(); }} renderFooter={() => <Dialog.Footer>{<>
      <Button variant="invisible" type="button" onClick={onClose}>Cancel</Button>
      <Button variant="danger" type="button" onClick={() => {
        onClose();
        void deleteLabel(app, repo, label);
      }}>Delete label</Button>
    </>}</Dialog.Footer>}></Dialog>
  );
}
