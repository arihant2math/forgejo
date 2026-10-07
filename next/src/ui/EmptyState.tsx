// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {ReactNode} from 'react';
import {Icon, type LucideIcon} from './Icon.tsx';

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  /** Usually one Button. */
  action?: ReactNode;
}

export function EmptyState({icon, title, description, action}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-8 py-16 text-center">
      {icon && <Icon icon={icon} size="lg" className="text-fg-subtle"/>}
      <p className="text-md font-medium text-fg">{title}</p>
      {description && <p className="max-w-sm text-base text-fg-muted">{description}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}
