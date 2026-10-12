// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {RelativeTime} from '@primer/react';
import {ago, fullDate} from '../app/time.ts';

type Props =
  /** "5 minutes ago", "on Oct 3": GitHub's relative-time element, which refreshes itself and titles itself with the full date. */
  | {at: string; variant: 'words'}
  /** "5m", "3d", "Oct 3": cached text for dense and virtualized rows, which does not refresh. `label` prefixes the title. */
  | {at: string; variant?: 'compact'; label?: string | undefined; className?: string | undefined};

export function TimeAgo(props: Props) {
  if (props.variant === 'words') return <RelativeTime datetime={props.at}/>;
  const {at, label, className} = props;
  const full = fullDate(at);
  return <time dateTime={at} title={label ? `${label} ${full}` : full} className={className}>{ago(at)}</time>;
}
