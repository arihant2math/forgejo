// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What the milestones list and a milestone's page share: its due line, and
// asking before it is deleted.

import {CalendarClock, CircleCheck} from 'lucide-react';
import {useApp} from '../../app/store.ts';
import type {Milestone} from '../../protocol/types.gen.ts';
import {Button, Dialog, Icon} from '../../ui/index.ts';
import {fullDate, shortDate} from '../issues/format.ts';
import {overdue} from './milestones.ts';
import {deleteMilestone, type RepoRef} from './writes.ts';

const line = 'flex items-center gap-1';

/** A milestone's due date, or when it closed: overdue in the danger tone. */
export function DueLine({m}: {m: Milestone}) {
  if (m.state === 'closed') {
    return <span className={`${line} text-fg-muted`}><Icon icon={CircleCheck} size="sm"/>Closed {m.closed_at && <time dateTime={m.closed_at} title={fullDate(m.closed_at)}>{shortDate(m.closed_at)}</time>}</span>;
  }
  if (!m.due_on) return <span className={`${line} text-fg-muted`}><Icon icon={CalendarClock} size="sm"/>No due date</span>;
  const late = overdue(m);
  return (
    <span className={`${line} ${late ? 'text-danger' : 'text-fg-muted'}`}>
      <Icon icon={CalendarClock} size="sm"/>{late ? 'Past due by' : 'Due by'} <time dateTime={m.due_on} title={fullDate(m.due_on)}>{shortDate(m.due_on)}</time>
    </span>
  );
}

/** Its issues and pull requests stay; they lose the milestone. `onDeleted`: right after the deletion is sent. */
export function DeleteMilestoneDialog({repo, milestone, onClose, onDeleted}: {repo: RepoRef; milestone: Milestone; onClose: () => void; onDeleted?: () => void}) {
  const app = useApp();
  return (
    <Dialog open size="sm" title={`Delete the milestone “${milestone.title}”?`} initialFocus="dialog" onOpenChange={(o) => {
      if (!o) onClose();
    }} description="Its issues and pull requests stay; they no longer have a milestone. This cannot be undone; closing it keeps it."
    footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="danger" onClick={() => {
        onClose();
        void deleteMilestone(app, repo, milestone);
        onDeleted?.();
      }}>Delete milestone</Button>
    </>}/>
  );
}
