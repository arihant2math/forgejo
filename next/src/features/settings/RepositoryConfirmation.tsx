// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Banner, ConfirmationDialog, Dialog, FormControl, TextInput} from '@primer/react';
import {type ReactNode, useId, useState} from 'react';

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
