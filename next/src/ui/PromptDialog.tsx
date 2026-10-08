// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {type ReactNode, useState} from 'react';
import {Button} from './Button.tsx';
import {Dialog} from './Dialog.tsx';
import {Input} from './Input.tsx';

export interface PromptDialogProps {
  title: string;
  description?: ReactNode;
  /** The field's accessible name (and placeholder). */
  label: string;
  initial?: string | undefined;
  saveLabel?: string | undefined;
  maxLength?: number | undefined;
  /** Called with the trimmed, non-empty text (only when it changed from `initial`). */
  onSave: (text: string) => void;
  onClose: () => void;
}

/** A small dialog that asks for one name (rename a column, name a view): Enter saves, Esc cancels. */
export function PromptDialog({title, description, label, initial = '', saveLabel = 'Save', maxLength = 100, onSave, onClose}: PromptDialogProps) {
  const [text, setText] = useState(initial);
  const save = () => {
    const t = text.trim();
    if (!t) return;
    onClose();
    if (t !== initial) onSave(t);
  };
  return (
    <Dialog open size="sm" title={title} description={description} onOpenChange={(o) => {
      if (!o) onClose();
    }} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!text.trim()} onClick={save}>{saveLabel}</Button>
    </>}>
      <Input aria-label={label} placeholder={label} value={text} autoFocus className="w-full" maxLength={maxLength} onChange={(e) => {
        setText(e.target.value);
      }} onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          save();
        }
      }}/>
    </Dialog>
  );
}
