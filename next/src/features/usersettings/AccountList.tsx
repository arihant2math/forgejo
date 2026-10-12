// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {ReactNode} from 'react';
import {BorderBox} from '../../components/BorderBox.tsx';
import {ResourceRow} from '../../components/ResourceRow.tsx';

export function AccountList({title, children}: {title: string; children: ReactNode}) {
  return <BorderBox title={title} headingLevel={3}><ul>{children}</ul></BorderBox>;
}

export function AccountRow({leading, trailing, children}: {leading?: ReactNode; trailing?: ReactNode; children: ReactNode}) {
  return <ResourceRow leading={leading} actions={trailing}>{children}</ResourceRow>;
}
