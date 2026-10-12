// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Banner, ConfirmationDialog, Dialog, FormControl, TextInput} from '@primer/react';
import {type ReactNode, useId, useState} from 'react';
import {online} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {useApp} from '../../app/store.ts';
import {useReach} from '../../app/online.ts';
import {problemOf} from './problems.ts';
import type {Resource} from '../../app/resource.ts';

/** Extra-input operations require a matching repository name before confirmation. */
interface RepositoryConfirmationProps {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: ReactNode; confirmLabel: string;
  confirmText?: string | undefined; onConfirm: () => void; busy?: boolean; error?: string | undefined; ready?: boolean;
  tone?: 'danger' | 'primary'; children?: ReactNode;
}

export function RepositoryConfirmation(props: RepositoryConfirmationProps) {
  return props.open ? <OpenRepositoryConfirmation {...props}/> : null;
}

function OpenRepositoryConfirmation({onOpenChange, title, description, confirmLabel, confirmText, onConfirm, busy = false, error, ready = true, tone = 'danger', children}: RepositoryConfirmationProps) {
  const id = useId();
  const [typed, setTyped] = useState('');
  const close = () => { if (!busy) { setTyped(''); onOpenChange(false); } };
  const content = <div className="flex flex-col gap-4">
    <p>{description}</p>
    {children}
    {confirmText && <FormControl id={id}><FormControl.Label>Type {confirmText} to confirm</FormControl.Label>
      <TextInput block value={typed} autoComplete="off" spellCheck={false} onChange={(event) => { setTyped(event.target.value); }}/>
    </FormControl>}
    {error && <Banner variant="critical" title="The operation failed" description={error}/>}
  </div>;
  if (!confirmText && !children) return <ConfirmationDialog title={title} confirmButtonContent={confirmLabel} confirmButtonType={tone} confirmButtonLoading={busy} onClose={(gesture) => {
    if (gesture === 'confirm') { if (!busy && ready) onConfirm(); } else close();
  }}>{content}</ConfirmationDialog>;
  return <Dialog title={title} onClose={close} width="large" footerButtons={[
    {content: 'Cancel', onClick: close, disabled: busy},
    {content: busy ? 'Working…' : confirmLabel, buttonType: tone, disabled: busy || !ready || Boolean(confirmText && typed !== confirmText), onClick: onConfirm},
  ]}>{content}</Dialog>;
}

/**
 * A confirmed API v1 DELETE of one item of a settings list: `ask(item)` opens the confirmation, and a success
 * drops the item from `res` and says `done(item)`; a failure stays in the dialog.
 */
export function useRemoval<T>(res: Resource<T[]>, {path, same, done}: {path: (item: T) => string; same: (a: T, b: T) => boolean; done: (item: T) => string}) {
  const app = useApp();
  const offline = useReach() !== 'online';
  const [target, setTarget] = useState<T | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const remove = async (item: T) => {
    if (busy || offline) return;
    setBusy(true);
    setError(undefined);
    try {
      await online(app, {method: 'DELETE', api: 'v1', path: path(item)});
      res.update((list) => (list ?? []).filter((x) => !same(x, item)));
      setTarget(undefined);
      notify(app, {tone: 'success', title: done(item)});
    } catch (err) {
      setError(problemOf(err).message);
    } finally {
      setBusy(false);
    }
  };
  return {
    target,
    ask: (item: T) => {
      setError(undefined);
      setTarget(item);
    },
    dialog: {
      open: target !== undefined, busy, error,
      onOpenChange: (open: boolean) => { if (!open && !busy) setTarget(undefined); },
      onConfirm: () => { if (target !== undefined) void remove(target); },
    },
  };
}
