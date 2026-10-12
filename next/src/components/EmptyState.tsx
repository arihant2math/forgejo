// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {Icon as OcticonType} from '@primer/octicons-react';
import {Blankslate} from '@primer/react/experimental';
import type {ReactNode} from 'react';

/**
 * GitHub's empty state: an icon, a heading, a description and an action. Spacious on a page; `spacious={false}`
 * inside a box or a dialog.
 */
export function EmptyState({icon: Icon, title, description, action, spacious = true}: {
  icon?: OcticonType | undefined; title: ReactNode; description?: ReactNode; action?: ReactNode; spacious?: boolean;
}) {
  return (
    <Blankslate spacious={spacious}>
      {Icon && <Blankslate.Visual><Icon size={24}/></Blankslate.Visual>}
      <Blankslate.Heading>{title}</Blankslate.Heading>
      {description && <Blankslate.Description>{description}</Blankslate.Description>}
      {action}
    </Blankslate>
  );
}
