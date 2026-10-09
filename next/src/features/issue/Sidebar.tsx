// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The issue's properties (PLAN §7.3, Linear's side panel): status (state +
// status label), priority, labels, assignees, milestone — editable through
// the pickers, the same as S/P/L/A/M — and project, dependencies, due date
// and the pull request's branches. Each value is an observer of what it
// shows.

import {Link} from '@tanstack/react-router';
import {ArrowRight, Bell, BellOff, CalendarClock, CircleCheck, CircleX, Clock, GitBranch, KanbanSquare, Lock, LockOpen, MessageSquare, Pin, PinOff} from 'lucide-react';
import {type ReactNode, useState} from 'react';
import {canWrite} from '../../app/access.ts';
import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {shortcutHint, useShortcut} from '../../app/shortcuts/index.ts';
import {type PickerKind, useApp, useSession} from '../../app/store.ts';
import {isTemp} from '../../intents/intents.ts';
import {editing} from '../../intents/session.ts';
import type {Entity} from '../../data/entity.ts';
import {issueAssigneeIds, issueDeadline, issueLocked, issueMilestone, issuePinned, issueProject, issueState, issueSubscribed, viewMembers} from '../../intents/view.ts';
import {
  Badge, Button, Code, CommandPopover, Dialog, Hint, Icon, Input, LabelChip, LabelIcon, type LucideIcon, Property, PropertyButton, PropertyEmpty, PropertyList,
  PropertyValue, TextLink,
} from '../../ui/index.ts';
import {openPicker} from '../issues/actions.ts';
import {isMerged, priorityIcon, StateGlyph, terminal, stateLook, statusIcon, useLabelView, useOverlay, usePool, UserAvatar, useUser} from '../issues/cells.tsx';
import {issuePath} from '../issues/edits.ts';
import {fullDate, shortDate} from '../issues/format.ts';
import {scopedValue} from '../issues/labels.ts';

export const IssueSidebar = observer(function IssueSidebar({issue}: {issue: Entity<'Issue'>}) {
  const app = useApp();
  const session = useSession();
  // Writers change everything; a reader sees the values (Forgejo would refuse the change).
  const write = canWrite(session, issue.get('repo_id'));
  const pick = (kind: PickerKind) => () => {
    openPicker(app, kind, [issue.id]);
  };
  const pull = issue.get('is_pull');
  return (
    <PropertyList>
      <Property label="Status">
        <Editable write={write} label="Change status" shortcut={shortcutHint('issue.state')} onClick={pick('status')}><StatusValue issue={issue}/></Editable>
      </Property>
      <Property label="Priority">
        <Editable write={write} label="Set priority" shortcut={shortcutHint('issue.priority')} onClick={pick('priority')}><PriorityValue issue={issue}/></Editable>
      </Property>
      <Property label="Labels">
        <Editable write={write} label="Change labels" shortcut={shortcutHint('issue.labels')} onClick={pick('labels')}><LabelsValue issue={issue}/></Editable>
      </Property>
      <Property label="Assignees">
        <Editable write={write} label="Change assignees" shortcut={shortcutHint('issue.assignee')} onClick={pick('assignees')}><AssigneesValue issue={issue}/></Editable>
      </Property>
      {pull && (
        <Property label="Reviewers">
          <Editable write={write} label="Request reviews" onClick={pick('reviewers')}><ReviewersValue issue={issue}/></Editable>
        </Property>
      )}
      <Property label="Milestone">
        <Editable write={write} label="Set milestone" shortcut={shortcutHint('issue.milestone')} onClick={pick('milestone')}><MilestoneValue issue={issue}/></Editable>
      </Property>
      <ProjectsValue issue={issue} write={write}/>
      <DependenciesValue issue={issue} write={write}/>
      <DueValue issue={issue} write={write}/>
      {pull && <BranchesValue issue={issue}/>}
      <SubscribeValue issue={issue}/>
      {write && !isTemp(issue.id) && <PinLockValue issue={issue}/>}
    </PropertyList>
  );
});

/** A property's value: a button opening its editor for writers, plain text for readers. */
function Editable({write, label, shortcut, onClick, children}: {write: boolean; label: string; shortcut?: string | undefined; onClick: () => void; children: ReactNode}) {
  if (!write) return <PropertyValue>{children}</PropertyValue>;
  return <PropertyButton label={label} shortcut={shortcut} onClick={onClick}>{children}</PropertyButton>;
}

const StatusValue = observer(function StatusValue({issue}: {issue: Entity<'Issue'>}) {
  const pool = usePool();
  const state = issueState(useOverlay(), issue);
  const pull = issue.get('is_pull');
  const look = stateLook(state, pull, pull && isMerged(pool, issue.id));
  const {status} = useLabelView(issue);
  // One status: the workflow label while open (or when it says the work ended); Forgejo's state otherwise,
  // with the label it was left at (a closed issue still labelled "In progress").
  if (status && (state === 'open' || terminal(status.name))) {
    return (
      <>
        <LabelIcon icon={statusIcon(status.name)} color={status.color}/>
        <span>{scopedValue(status.name)}</span>
      </>
    );
  }
  // Merged says it all (a workflow label left at "In Review" is not news then).
  const merged = pull && isMerged(pool, issue.id);
  return <><StateGlyph look={look}/><span>{look.label}</span>{status && !merged && <span className="truncate text-fg-subtle">({scopedValue(status.name)})</span>}</>;
});

const PriorityValue = observer(function PriorityValue({issue}: {issue: Entity<'Issue'>}) {
  const p = useLabelView(issue).priority;
  if (!p) return <PropertyEmpty>No priority</PropertyEmpty>;
  return <><LabelIcon icon={priorityIcon(p.name)} color={p.color}/><span>{scopedValue(p.name)}</span></>;
});

const LabelsValue = observer(function LabelsValue({issue}: {issue: Entity<'Issue'>}) {
  const labels = useLabelView(issue).other;
  if (!labels.length) return <PropertyEmpty>No labels</PropertyEmpty>;
  return <>{labels.map((l) => <LabelChip key={l.id} name={l.name} color={l.color}/>)}</>;
});

const AssigneesValue = observer(function AssigneesValue({issue}: {issue: Entity<'Issue'>}) {
  const ids = issueAssigneeIds(usePool(), useOverlay(), issue.id).sort((a, b) => a - b);
  if (!ids.length) return <PropertyEmpty>Unassigned</PropertyEmpty>;
  return <span className="flex flex-col gap-1">{ids.map((id) => <Person key={id} id={id}/>)}</span>;
});

/** Requested reviewers and those who reviewed, with their verdict (the latest review of each). */
const ReviewersValue = observer(function ReviewersValue({issue}: {issue: Entity<'Issue'>}) {
  const pool = usePool();
  const requested = viewMembers(pool, useOverlay(), 'ReviewRequest', issue.id);
  const verdicts = new Map<number, {state: string; at: string}>();
  for (const r of pool.model('Review').by('issue_id', issue.id)) {
    const d = r.data;
    if (!d.reviewer_id || d.state === 'PENDING' || d.state === 'REQUEST_REVIEW' || d.dismissed) continue;
    const prev = verdicts.get(d.reviewer_id);
    if (!prev || prev.at < d.created_at) verdicts.set(d.reviewer_id, {state: d.state, at: d.created_at});
  }
  const ids = [...new Set([...requested as Set<number>, ...verdicts.keys()])].sort((a, b) => a - b);
  if (!ids.length) return <PropertyEmpty>No reviewers</PropertyEmpty>;
  return (
    <span className="flex flex-col gap-1">
      {ids.map((id) => {
        const v = verdicts.get(id);
        const look = requested.has(id) ? REVIEW_LOOK.REQUEST_REVIEW : v ? REVIEW_LOOK[v.state] : undefined;
        return (
          <span key={id} className="flex min-w-0 items-center gap-2">
            <Person id={id}/>
            {look && <Hint label={look.label}><Icon icon={look.icon} size="sm" className={REVIEW_TONE[look.tone]}/></Hint>}
          </span>
        );
      })}
    </span>
  );
});

const REVIEW_TONE = {APPROVED: 'text-success', REQUEST_CHANGES: 'text-danger', COMMENT: 'text-fg-subtle', REQUEST_REVIEW: 'text-warning'} as const;

const REVIEW_LOOK: Record<string, {icon: LucideIcon; label: string; tone: keyof typeof REVIEW_TONE} | undefined> = {
  APPROVED: {icon: CircleCheck, label: 'Approved', tone: 'APPROVED'},
  REQUEST_CHANGES: {icon: CircleX, label: 'Changes requested', tone: 'REQUEST_CHANGES'},
  COMMENT: {icon: MessageSquare, label: 'Commented', tone: 'COMMENT'},
  REQUEST_REVIEW: {icon: Clock, label: 'Review requested', tone: 'REQUEST_REVIEW'},
};

const Person = observer(function Person({id}: {id: number}) {
  const u = useUser(id);
  return <span className="flex items-center gap-2"><UserAvatar id={id}/><span className="truncate">{u.name}</span></span>;
});

const MilestoneValue = observer(function MilestoneValue({issue}: {issue: Entity<'Issue'>}) {
  const id = issueMilestone(useOverlay(), issue);
  const m = usePool().model('Milestone').get(id);
  if (!id) return <PropertyEmpty>No milestone</PropertyEmpty>;
  const due = m?.get('due_on');
  return <span className="truncate">{m?.get('title') ?? `Milestone ${String(id)}`}{due && <span className="text-fg-subtle"> · due {shortDate(due)}</span>}</span>;
});

/**
 * The project the issue is on (Project when held, else what the owner shares: ProjectRef, B6) and its column; writers
 * put it on a board of its repository or owner, or take it off (issue.project: offline-capable).
 */
const ProjectsValue = observer(function ProjectsValue({issue, write}: {issue: Entity<'Issue'>; write: boolean}) {
  const app = useApp();
  const pool = usePool();
  const overlay = useOverlay();
  const {project: pid, column: cid} = issueProject(pool, overlay, issue.id);
  const project = pid ? pool.model('Project').get(pid) : undefined;
  const title = pid ? project?.get('title') ?? pool.model('ProjectRef').get(pid)?.get('title') ?? `Project ${String(pid)}` : undefined;
  const column = pool.model('ProjectColumn').get(cid)?.get('title');
  // The board opens from here (the triage path: issue → its board) when it is on this device; the link truncates
  // itself (no clipping parent: its focus outline stays whole).
  const value = title === undefined ? <PropertyEmpty>No project</PropertyEmpty> : (
    <span className="flex min-w-0 items-center gap-1">
      {project ? <TextLink><Link to="/-/next/projects/$id" params={{id: String(pid)}}>{title}</Link></TextLink> : <span className="truncate">{title}</span>}
      {column && <span className="shrink-0 text-fg-subtle">· {column}</span>}
    </span>
  );
  if (!write || isTemp(issue.id)) return <Property label="Project"><PropertyValue>{value}</PropertyValue></Property>;
  const repo = pool.model('Repository').get(issue.get('repo_id'))?.data;
  // The boards it can go on: its repository's and its owner's (Forgejo's rule), open ones.
  const boards = [...pool.model('Project').all()].map((e) => e.data)
    .filter((p) => !p.closed && (p.repo_id === issue.get('repo_id') || (p.repo_id === 0 && p.owner_id === repo?.owner_id)))
    .sort((a, b) => a.title.localeCompare(b.title));
  const set = (projectId: number) => {
    if (projectId === pid) return;
    runInAction(() => {
      editing(app).intents.submit({kind: 'issue.project', issueId: issue.id, repoId: issue.get('repo_id'), projectId, columnId: 0, base: pid});
    });
  };
  return (
    <Property label="Project">
      <CommandPopover label="Project" placeholder="Put it on a board…" empty="No open board of this repository or its owner is on this device."
        options={[
          ...(pid ? [{value: 'none', label: 'No project', checked: false, onSelect: () => {
            set(0);
          }}] : []),
          ...boards.map((b) => ({value: String(b.id), label: b.title, icon: KanbanSquare, checked: b.id === pid, onSelect: () => {
            set(b.id);
          }})),
        ]}
        trigger={<PropertyButton label="Put it on a board">{value}</PropertyButton>}/>
    </Property>
  );
});

/** Blocked by / blocks (IssueDependency, the lazy tier). */
const DependenciesValue = observer(function DependenciesValue({issue, write}: {issue: Entity<'Issue'>; write: boolean}) {
  const app = useApp();
  const pool = usePool();
  const blockedBy = [...viewMembers(pool, useOverlay(), 'IssueDependency', issue.id)] as number[];
  const blocks = [...pool.model('IssueDependency').by('dependency_id', issue.id)].map((d) => d.get('issue_id'));
  const edit = write && !isTemp(issue.id);
  return (
    <>
      <Property label="Blocked by">
        {blockedBy.length ? <IssueLinks ids={blockedBy} repoId={issue.get('repo_id')}/> : !edit && <PropertyValue><PropertyEmpty>Nothing</PropertyEmpty></PropertyValue>}
        {edit && (
          <PropertyButton label="Change what blocks this" onClick={() => {
            openPicker(app, 'dependency', [issue.id]);
          }}>{blockedBy.length ? <span className="text-sm text-fg-subtle">Change…</span> : <PropertyEmpty>Nothing</PropertyEmpty>}</PropertyButton>
        )}
      </Property>
      {blocks.length > 0 && <Property label="Blocks"><IssueLinks ids={blocks} repoId={issue.get('repo_id')}/></Property>}
    </>
  );
});

function IssueLinks({ids, repoId}: {ids: number[]; repoId: number}) {
  return <PropertyValue>{ids.map((id) => <IssueLink key={id} id={id} repoId={repoId}/>)}</PropertyValue>;
}

/**
 * An issue reference ("#12 Title", with the repository's name when it is another one than `repoId`'s), a
 * link to it; the sidebar's dependencies and the timeline's events show issues the same way (`inline`:
 * inside a sentence, wrapping with it).
 */
export const IssueLink = observer(function IssueLink({id, repoId, missing = 'An issue not on this device', inline = false}: {
  id: number; repoId: number; missing?: string; inline?: boolean;
}) {
  const app = useApp();
  const pool = usePool();
  const i = pool.model('Issue').get(id);
  if (!i) return <span className="text-fg-subtle">{missing}</span>;
  const repo = pool.model('Repository').get(i.get('repo_id'));
  const ref = `${i.get('repo_id') === repoId ? '' : repo?.get('full_name') ?? ''}#${String(i.get('number'))}`;
  const path = issuePath(app, i);
  const text = <><span className="text-fg-subtle tabular-nums">{ref}</span> {i.get('title')}</>;
  if (!path) return <span className={inline ? undefined : 'truncate'}>{text}</span>;
  return <TextLink wrap={inline}><Link to={path}>{text}</Link></TextLink>;
});

const DueValue = observer(function DueValue({issue, write}: {issue: Entity<'Issue'>; write: boolean}) {
  const app = useApp();
  const due = issueDeadline(useOverlay(), issue);
  const open = issueState(useOverlay(), issue) === 'open';
  const [dialog, setDialog] = useState(false);
  const late = Boolean(due) && open && Date.parse(due ?? '') < Date.now();
  const value = due ?
    <span className={late ? 'flex items-center gap-2 text-danger' : 'flex items-center gap-2'} title={fullDate(due)}><Icon icon={CalendarClock}/>{shortDate(due)}{late && ' · overdue'}</span> :
    <PropertyEmpty>No due date</PropertyEmpty>;
  return (
    <Property label="Due date">
      {write && !isTemp(issue.id) ? <PropertyButton label="Set the due date" onClick={() => {
        setDialog(true);
      }}>{value}</PropertyButton> : <PropertyValue>{value}</PropertyValue>}
      {dialog && <DueDialog initial={due?.slice(0, 10) ?? ''} onClose={() => {
        setDialog(false);
      }} onSave={(next) => {
        runInAction(() => {
          editing(app).intents.submit({kind: 'issue.deadline', issueId: issue.id, repoId: issue.get('repo_id'), due: next, base: due?.slice(0, 10) ?? null});
        });
      }}/>}
    </Property>
  );
});

/** The due date's editor: a date, or none. */
function DueDialog({initial, onClose, onSave}: {initial: string; onClose: () => void; onSave: (due: string | null) => void}) {
  const [value, setValue] = useState(initial);
  const save = (v: string | null) => {
    onClose();
    if ((v ?? '') !== initial) onSave(v);
  };
  return (
    <Dialog open size="sm" title="Due date" onOpenChange={(o) => {
      if (!o) onClose();
    }} footer={<>
      {initial && <Button variant="ghost" onClick={() => {
        save(null);
      }}>Remove</Button>}
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!/^\d{4}-\d{2}-\d{2}$/.test(value)} onClick={() => {
        save(value);
      }}>Save</Button>
    </>}>
      <Input type="date" aria-label="Due date" value={value} autoFocus className="w-full" onChange={(e) => {
        setValue(e.target.value);
      }} onKeyDown={(e) => {
        if (e.key === 'Enter' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
          e.preventDefault();
          save(value);
        }
      }}/>
    </Dialog>
  );
}

const BranchesValue = observer(function BranchesValue({issue}: {issue: Entity<'Issue'>}) {
  const pool = usePool();
  const pr = [...pool.model('PullRequest').by('issue_id', issue.id)][0];
  if (!pr) return null;
  // The head branch deleted (after a merge, or by hand): said, not shown as if it were there. Only when the
  // head repository's branches are on this device (a fork's may not be).
  const branches = [...pool.model('Branch').by('repo_id', pr.get('head_repo_id'))].map((b) => b.data);
  const head = branches.find((b) => b.name === pr.get('head_branch'));
  const deleted = branches.length > 0 && (head === undefined || head.is_deleted);
  return (
    <Property label="Branches">
      <PropertyValue tone="muted">
        {/* Head, then base, one per line: long names truncate inside the pane (the full name on hover). */}
        <span className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="flex min-w-0 items-center gap-1" title={deleted ? `${pr.get('head_branch')} (deleted)` : pr.get('head_branch')}>
            <Icon icon={GitBranch} size="sm"/>
            <span className={deleted ? 'min-w-0 truncate line-through' : 'min-w-0 truncate'}><Code>{pr.get('head_branch')}</Code></span>
            {deleted && <Badge>Deleted</Badge>}
          </span>
          <span className="flex min-w-0 items-center gap-1" title={pr.get('base_branch')}><Icon icon={ArrowRight} size="sm"/><span className="min-w-0 truncate"><Code>{pr.get('base_branch')}</Code></span></span>
        </span>
      </PropertyValue>
    </Property>
  );
});

/** Subscribing (Shift+S): an offline-capable intent; the state as Forgejo decides it (issueSubscribed). */
const SubscribeValue = observer(function SubscribeValue({issue}: {issue: Entity<'Issue'>}) {
  const app = useApp();
  const {userId} = useSession();
  const on = issueSubscribed(usePool(), useOverlay(), issue, userId);
  const toggle = () => {
    if (isTemp(issue.id)) return;
    runInAction(() => {
      editing(app).intents.submit({kind: 'issue.subscribe', issueId: issue.id, repoId: issue.get('repo_id'), userId, add: !on});
    });
  };
  useShortcut('issue.subscribe', toggle);
  return (
    <Property label="Notifications">
      <PropertyButton label={on ? 'Unsubscribe' : 'Subscribe'} shortcut={shortcutHint('issue.subscribe')} onClick={toggle}>
        <Icon icon={on ? Bell : BellOff}/><span>{on ? 'Subscribed' : 'Not subscribed'}</span>
      </PropertyButton>
    </Property>
  );
});

/** Forgejo's default lock reasons (setting.Repository.Issue.LockReasons; API v1 refuses any other). */
const LOCK_REASONS = ['Too heated', 'Off-topic', 'Resolved', 'Spam'];

/** Pinning (to the repository's issue list) and locking the conversation: writers only. */
const PinLockValue = observer(function PinLockValue({issue}: {issue: Entity<'Issue'>}) {
  const app = useApp();
  const overlay = useOverlay();
  const pinned = issuePinned(overlay, issue);
  const locked = issueLocked(overlay, issue);
  const submit = (patch: {kind: 'issue.pin'; pinned: boolean} | {kind: 'issue.lock'; locked: boolean; reason: string}) => {
    runInAction(() => {
      editing(app).intents.submit({...patch, issueId: issue.id, repoId: issue.get('repo_id')});
    });
  };
  return (
    <>
      <Property label="Pinned">
        <PropertyButton label={pinned ? 'Unpin' : 'Pin to the list'} onClick={() => {
          submit({kind: 'issue.pin', pinned: !pinned});
        }}><Icon icon={pinned ? Pin : PinOff}/><span>{pinned ? 'Pinned' : 'Not pinned'}</span></PropertyButton>
      </Property>
      <Property label="Conversation">
        {locked ?
          <PropertyButton label="Unlock the conversation" onClick={() => {
            submit({kind: 'issue.lock', locked: false, reason: ''});
          }}><Icon icon={Lock}/><span>Locked</span></PropertyButton> :
          // Forgejo asks why (its lock reasons, [repository.issue] LOCK_REASONS by default).
          <CommandPopover label="Lock the conversation" placeholder="Why lock it?"
            options={LOCK_REASONS.map((reason) => ({value: reason, label: reason, onSelect: () => {
              submit({kind: 'issue.lock', locked: true, reason});
            }}))}
            trigger={<PropertyButton label="Lock the conversation (only collaborators can comment)"><Icon icon={LockOpen}/><span>Open to comments</span></PropertyButton>}/>}
      </Property>
    </>
  );
});
