// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {RepoRef} from '../../app/paths.ts';
import {useApp} from '../../app/store.ts';
import type {Milestone} from '../../protocol/types.gen.ts';
import {fullDate, shortDate} from '../issues/format.ts';
import {overdue} from './milestones.ts';
import {deleteMilestone} from './writes.ts';
import {CalendarIcon, CheckCircleIcon} from '@primer/octicons-react';
import {Dialog} from '@primer/react';

const line = 'flex items-center gap-1';

export function DueLine({m}: {m: Milestone}) {
  if (m.state === 'closed') {
    return <span className={`${line} text-muted`}><CheckCircleIcon size={12} className="shrink-0"/>Closed {m.closed_at && <time dateTime={m.closed_at} title={fullDate(m.closed_at)}>{shortDate(m.closed_at)}</time>}</span>;
  }
  if (!m.due_on) return <span className={`${line} text-muted`}><CalendarIcon size={12} className="shrink-0"/>No due date</span>;
  const late = overdue(m);
  return (
    <span className={`${line} ${late ? 'text-danger' : 'text-muted'}`}>
      <CalendarIcon size={12} className="shrink-0"/>{late ? 'Past due by' : 'Due by'} <time dateTime={m.due_on} title={fullDate(m.due_on)}>{shortDate(m.due_on)}</time>
    </span>
  );
}

/** onDeleted runs after sending deletion, before server confirmation. */
export function DeleteMilestoneDialog({repo, milestone, onClose, onDeleted}: {repo: RepoRef; milestone: Milestone; onClose: () => void; onDeleted?: () => void}) {
  const app = useApp();
  return (
    <Dialog title={`Delete the milestone “${milestone.title}”?`} subtitle="Its issues and pull requests stay; they no longer have a milestone. This cannot be undone; closing it keeps it." width="medium" onClose={onClose} footerButtons={[
      {content: 'Cancel', onClick: onClose},
      {content: 'Delete milestone', buttonType: 'danger', onClick: () => {
        onClose(); void deleteMilestone(app, repo, milestone); onDeleted?.();
      }},
    ]}></Dialog>
  );
}
