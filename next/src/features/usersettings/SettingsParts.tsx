// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {ConfirmationDialog, Link as PrimerLink, ToggleSwitch} from '@primer/react';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useId} from 'react';
import {failureText} from '../../app/api.ts';
import {classicHref} from '../../app/classic.ts';
import {notify} from '../../app/notices.ts';
import type {Resource} from '../../app/resource.ts';
import {useApp} from '../../app/store.ts';
import {
patchSettings
} from './data.ts';
import {SettingRow} from './form.tsx';
import {
scopeRefused,type SettingsPatch,
type UserSettings
} from './payload.ts';

export function failure(err: unknown): string {
  if (scopeRefused(err)) return 'Forgejo Next may not change your account with this sign-in. Sign out and in again, or change it in the classic UI.';
  return failureText(err);
}

export const Toggle = observer(function Toggle({res, settings, field, label, hint, offline}: {
  res: Resource<UserSettings>; settings: UserSettings; field: 'hide_email' | 'hide_pronouns' | 'hide_activity' | 'enable_repo_unit_hints'; label: string; hint: string;
  offline: string | undefined;
}) {
  const change = useChange(res);
  const id = useId();
  return (
    <SettingRow id={id} title={label} description={hint}>
      <ToggleSwitch size="small" aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} checked={settings[field]} disabled={Boolean(offline)}
 onChange={(on) => { change({[field]: on}, label); }}/>
    </SettingRow>
  );
});

export function useChange(res: Resource<UserSettings>): (patch: SettingsPatch, what: string) => void {
  const app = useApp();
  return (patch, what) => {
    patchSettings(app, res, patch, true).catch((err: unknown) => {
      notify(app, {tone: 'danger', title: `${what}: not saved`, description: failure(err)});
    });
  };
}

export function TextClassic({to, children}: {to: string; children: ReactNode}) {
  const app = useApp();
  return <PrimerLink href={classicHref(app, to)} data-classic="">{children}</PrimerLink>;
}

export function Confirm({title, description, action, onConfirm, onClose}: {title: string; description: ReactNode; action: string; onConfirm: () => void; onClose: () => void}) {
  return (
    <ConfirmationDialog title={title} confirmButtonContent={action} confirmButtonType="danger" onClose={(gesture) => {
      onClose();
      if (gesture === 'confirm') onConfirm();
    }}>{description}</ConfirmationDialog>
  );
}
