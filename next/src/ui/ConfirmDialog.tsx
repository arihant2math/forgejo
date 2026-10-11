// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {type ReactNode, useState} from 'react';
import {Button} from './Button.tsx';
import {Callout} from './Callout.tsx';
import {Dialog} from './Dialog.tsx';
import {Input} from './Input.tsx';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  /** `danger`: a destructive action (red button). */
  tone?: 'primary' | 'danger' | undefined;
  /**
   * The text to type before the action is offered (a repository's name, before deleting it): GitHub's
   * guard against deleting the wrong thing.
   */
  confirmText?: string | undefined;
  /** The request is running: the buttons wait. */
  busy?: boolean | undefined;
  /** Why the last attempt failed (the server's answer). */
  error?: string | undefined;
  /** Whether the other fields (children) allow confirming. */
  ready?: boolean | undefined;
  onConfirm: () => void;
  /** More fields (a transfer's new owner), above the typed confirmation. */
  children?: ReactNode;
}

/** A dialog that asks before an action that is hard to undo; Enter in the typed confirmation confirms. */
export function ConfirmDialog({open, onOpenChange, title, description, confirmLabel, tone = 'danger', confirmText, busy, error, ready = true, onConfirm, children}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const can = ready && !busy && (confirmText === undefined || typed === confirmText);
  const confirm = () => {
    if (can) onConfirm();
  };
  return (
    <Dialog open={open} onOpenChange={(o) => {
      if (!o) setTyped('');
      onOpenChange(o);
    }} title={title} description={description} footer={<>
      <Button variant="ghost" disabled={busy} onClick={() => {
        setTyped('');
        onOpenChange(false);
      }}>Cancel</Button>
      <Button variant={tone} disabled={!can} onClick={confirm}>{confirmLabel}</Button>
    </>}>
      {(children !== undefined || confirmText !== undefined || error) && (
        <div className="flex flex-col gap-3">
          {children}
          {confirmText !== undefined && (
            <label className="flex flex-col gap-1 text-base text-fg">
              <span>Type <strong className="font-mono text-code">{confirmText}</strong> to confirm.</span>
              <Input className="w-full" value={typed} autoComplete="off" spellCheck={false} onChange={(e) => {
                setTyped(e.target.value);
              }} onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  confirm();
                }
              }}/>
            </label>
          )}
          {error && <Callout tone="danger" title="Not done">{error}</Callout>}
        </div>
      )}
    </Dialog>
  );
}
