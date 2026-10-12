// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Banner, ConfirmationDialog, Dialog, FormControl, TextInput} from '@primer/react';
import {type ReactNode, useLayoutEffect, useRef, useState} from 'react';

/**
 * A confirmation that can ask to type a name (`confirmText`) before a destructive operation, like GitHub's. Without
 * a name, extra content or a `blocked` reason it is Primer's ConfirmationDialog. It stays open while `busy` (announced
 * as `busyLabel`) and shows `error` under `errorTitle`. The first field, extra content's before the name, has focus.
 */
interface ConfirmByNameProps {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: ReactNode; confirmLabel: string;
  confirmText?: string | undefined; onConfirm: () => void; busy?: boolean; error?: string | undefined; ready?: boolean;
  /** Why it cannot be confirmed now (offline, say): shown in the dialog, with the confirm button disabled. */
  blocked?: string | undefined;
  tone?: 'danger' | 'primary'; busyLabel?: string; errorTitle?: string; children?: ReactNode;
}

export function ConfirmByName(props: ConfirmByNameProps) {
  return props.open ? <OpenConfirmByName {...props}/> : null;
}

function OpenConfirmByName({onOpenChange, title, description, confirmLabel, confirmText, onConfirm, busy = false, error, ready = true, blocked, tone = 'danger',
  busyLabel = 'Working…', errorTitle = 'The operation failed', children}: ConfirmByNameProps) {
  const [typed, setTyped] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLElement>(null);
  // Runs before the dialog's focus trap, which reads the ref in a passive effect.
  useLayoutEffect(() => {
    first.current = body.current?.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, select') ?? null;
  }, []);
  const close = () => { if (!busy) { setTyped(''); onOpenChange(false); } };
  const allowed = !busy && ready && !blocked && (!confirmText || typed === confirmText);
  const content = <div ref={body} className="flex flex-col gap-4">
    <p>{description}</p>
    {blocked && <Banner variant="warning" title={blocked}/>}
    {children}
    {confirmText && <FormControl><FormControl.Label>Type {confirmText} to confirm</FormControl.Label>
      <TextInput block value={typed} autoComplete="off" spellCheck={false} readOnly={busy} onChange={(event) => { setTyped(event.target.value); }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (allowed) onConfirm();
        }}/>
    </FormControl>}
    {error && <Banner variant="critical" title={errorTitle} description={error}/>}
  </div>;
  if (!confirmText && !children && !blocked) return <ConfirmationDialog title={title} confirmButtonContent={confirmLabel} confirmButtonType={tone} confirmButtonLoading={busy} onClose={(gesture) => {
    if (gesture === 'confirm') { if (allowed) onConfirm(); } else close();
  }}>{content}</ConfirmationDialog>;
  // Loading rather than disabled while busy, so a confirm button that has focus keeps it.
  return <Dialog title={title} onClose={close} width="large" initialFocusRef={first} footerButtons={[
    {content: 'Cancel', onClick: close, disabled: busy},
    {content: confirmLabel, buttonType: tone, disabled: !busy && !allowed, loading: busy, loadingAnnouncement: busyLabel, onClick: () => { if (allowed) onConfirm(); }},
  ]}>{content}</Dialog>;
}
