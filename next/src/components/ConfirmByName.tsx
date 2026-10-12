// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Banner, ConfirmationDialog, Dialog, FormControl, TextInput} from '@primer/react';
import {type ReactNode, useRef, useState} from 'react';

/**
 * A confirmation that can ask to type a name (`confirmText`) before a destructive operation, like GitHub's. Without
 * a name or extra content it is Primer's ConfirmationDialog. It stays open while `busy` (labelled `busyLabel`) and shows
 * `error` under `errorTitle`.
 */
interface ConfirmByNameProps {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: ReactNode; confirmLabel: string;
  confirmText?: string | undefined; onConfirm: () => void; busy?: boolean; error?: string | undefined; ready?: boolean;
  tone?: 'danger' | 'primary'; busyLabel?: string; errorTitle?: string; children?: ReactNode;
}

export function ConfirmByName(props: ConfirmByNameProps) {
  return props.open ? <OpenConfirmByName {...props}/> : null;
}

function OpenConfirmByName({onOpenChange, title, description, confirmLabel, confirmText, onConfirm, busy = false, error, ready = true, tone = 'danger',
  busyLabel = 'Working…', errorTitle = 'The operation failed', children}: ConfirmByNameProps) {
  const [typed, setTyped] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const close = () => { if (!busy) { setTyped(''); onOpenChange(false); } };
  const allowed = !busy && ready && (!confirmText || typed === confirmText);
  const content = <div className="flex flex-col gap-4">
    <p>{description}</p>
    {children}
    {confirmText && <FormControl><FormControl.Label>Type {confirmText} to confirm</FormControl.Label>
      <TextInput ref={field} block value={typed} autoComplete="off" spellCheck={false} disabled={busy} onChange={(event) => { setTyped(event.target.value); }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (allowed) onConfirm();
        }}/>
    </FormControl>}
    {error && <Banner variant="critical" title={errorTitle} description={error}/>}
  </div>;
  if (!confirmText && !children) return <ConfirmationDialog title={title} confirmButtonContent={confirmLabel} confirmButtonType={tone} confirmButtonLoading={busy} onClose={(gesture) => {
    if (gesture === 'confirm') { if (allowed) onConfirm(); } else close();
  }}>{content}</ConfirmationDialog>;
  return <Dialog title={title} onClose={close} width="large" initialFocusRef={field} footerButtons={[
    {content: 'Cancel', onClick: close, disabled: busy},
    {content: busy ? busyLabel : confirmLabel, buttonType: tone, disabled: !allowed, onClick: onConfirm},
  ]}>{content}</Dialog>;
}
