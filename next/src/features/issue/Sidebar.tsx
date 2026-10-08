// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The issue's properties (PLAN §7.3, Linear's side panel): status (state +
// status label), priority, labels, assignees, milestone — editable through
// the pickers, the same as S/P/L/A/M — and project, dependencies, due date
// and the pull request's branches. Each value is an observer of what it
// shows.

import {Link} from '@tanstack/react-router';
import {Bell, BellOff, CalendarClock, GitBranch} from 'lucide-react';
import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {shortcutHint, useShortcut} from '../../app/shortcuts/index.ts';
import {type PickerKind, useApp, useSession} from '../../app/store.ts';
import {isTemp} from '../../intents/intents.ts';
import {editing} from '../../intents/session.ts';
import type {Entity} from '../../data/entity.ts';
import {issueAssigneeIds, issueDeadline, issueMilestone, issueState, issueSubscribed} from '../../intents/view.ts';
import {Code, Icon, LabelChip, LabelIcon, Property, PropertyButton, PropertyEmpty, PropertyList, PropertyValue, TextLink} from '../../ui/index.ts';
import {openPicker} from '../issues/actions.ts';
import {isMerged, priorityIcon, StateGlyph, terminal, stateLook, statusIcon, useLabelView, useOverlay, usePool, UserAvatar, useUser} from '../issues/cells.tsx';
import {issuePath} from '../issues/edits.ts';
import {fullDate, shortDate} from '../issues/format.ts';
import {scopedValue} from '../issues/labels.ts';

export const IssueSidebar = observer(function IssueSidebar({issue}: {issue: Entity<'Issue'>}) {
  const app = useApp();
  const pick = (kind: PickerKind) => () => {
    openPicker(app, kind, [issue.id]);
  };
  return (
    <PropertyList>
      <Property label="Status">
        <PropertyButton label="Change status" shortcut={shortcutHint('issue.state')} onClick={pick('status')}><StatusValue issue={issue}/></PropertyButton>
      </Property>
      <Property label="Priority">
        <PropertyButton label="Set priority" shortcut={shortcutHint('issue.priority')} onClick={pick('priority')}><PriorityValue issue={issue}/></PropertyButton>
      </Property>
      <Property label="Labels">
        <PropertyButton label="Change labels" shortcut={shortcutHint('issue.labels')} onClick={pick('labels')}><LabelsValue issue={issue}/></PropertyButton>
      </Property>
      <Property label="Assignees">
        <PropertyButton label="Change assignees" shortcut={shortcutHint('issue.assignee')} onClick={pick('assignees')}><AssigneesValue issue={issue}/></PropertyButton>
      </Property>
      <Property label="Milestone">
        <PropertyButton label="Set milestone" shortcut={shortcutHint('issue.milestone')} onClick={pick('milestone')}><MilestoneValue issue={issue}/></PropertyButton>
      </Property>
      <ProjectsValue issue={issue}/>
      <DependenciesValue issue={issue}/>
      <DueValue issue={issue}/>
      {issue.get('is_pull') && <BranchesValue issue={issue}/>}
      <SubscribeValue issue={issue}/>
    </PropertyList>
  );
});

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
  return <><StateGlyph look={look}/><span>{look.label}</span>{status && <span className="truncate text-fg-subtle">({scopedValue(status.name)})</span>}</>;
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

/** The projects the issue is on (Project when held, else what the owner shares: ProjectRef, B6) and its column. */
const ProjectsValue = observer(function ProjectsValue({issue}: {issue: Entity<'Issue'>}) {
  const pool = usePool();
  const cards = [...pool.model('ProjectIssue').by('issue_id', issue.id)];
  if (!cards.length) return null;
  return (
    <Property label="Project">
      <PropertyValue>
        {cards.map((c) => {
          const pid = c.get('project_id');
          const title = pool.model('Project').get(pid)?.get('title') ?? pool.model('ProjectRef').get(pid)?.get('title') ?? `Project ${String(pid)}`;
          const column = pool.model('ProjectColumn').get(c.get('column_id'))?.get('title');
          // The board opens from here (the triage path: issue → its board).
          return <span key={c.id} className="truncate"><TextLink><Link to="/-/next/projects/$id" params={{id: String(pid)}}>{title}</Link></TextLink>{column && <span className="text-fg-subtle"> · {column}</span>}</span>;
        })}
      </PropertyValue>
    </Property>
  );
});

/** Blocked by / blocks (IssueDependency, the lazy tier). */
const DependenciesValue = observer(function DependenciesValue({issue}: {issue: Entity<'Issue'>}) {
  const pool = usePool();
  const blockedBy = [...pool.model('IssueDependency').by('issue_id', issue.id)].map((d) => d.get('dependency_id'));
  const blocks = [...pool.model('IssueDependency').by('dependency_id', issue.id)].map((d) => d.get('issue_id'));
  return (
    <>
      {blockedBy.length > 0 && <Property label="Blocked by"><IssueLinks ids={blockedBy} repoId={issue.get('repo_id')}/></Property>}
      {blocks.length > 0 && <Property label="Blocks"><IssueLinks ids={blocks} repoId={issue.get('repo_id')}/></Property>}
    </>
  );
});

function IssueLinks({ids, repoId}: {ids: number[]; repoId: number}) {
  return <PropertyValue>{ids.map((id) => <IssueLink key={id} id={id} repoId={repoId}/>)}</PropertyValue>;
}

const IssueLink = observer(function IssueLink({id, repoId}: {id: number; repoId: number}) {
  const app = useApp();
  const pool = usePool();
  const i = pool.model('Issue').get(id);
  if (!i) return <span className="text-fg-subtle">An issue not on this device</span>;
  const repo = pool.model('Repository').get(i.get('repo_id'));
  const ref = `${i.get('repo_id') === repoId ? '' : repo?.get('full_name') ?? ''}#${String(i.get('number'))}`;
  const path = issuePath(app, i);
  const text = <><span className="text-fg-subtle tabular-nums">{ref}</span> {i.get('title')}</>;
  return path ? <TextLink><Link to={path}>{text}</Link></TextLink> : <span className="truncate">{text}</span>;
});

const DueValue = observer(function DueValue({issue}: {issue: Entity<'Issue'>}) {
  const due = issueDeadline(useOverlay(), issue);
  const open = issueState(useOverlay(), issue) === 'open';
  if (!due) return null;
  const late = open && Date.parse(due) < Date.now();
  return (
    <Property label="Due date">
      <PropertyValue tone={late ? 'danger' : 'default'} title={fullDate(due)}>
        <span className="flex items-center gap-2"><Icon icon={CalendarClock}/>{shortDate(due)}{late && ' · overdue'}</span>
      </PropertyValue>
    </Property>
  );
});

const BranchesValue = observer(function BranchesValue({issue}: {issue: Entity<'Issue'>}) {
  const pr = [...usePool().model('PullRequest').by('issue_id', issue.id)][0];
  if (!pr) return null;
  return (
    <Property label="Branches">
      <PropertyValue tone="muted">
        <span className="flex min-w-0 items-center gap-1 text-sm">
          <Icon icon={GitBranch} size="sm"/>
          <Code>{pr.get('head_branch')}</Code>→<Code>{pr.get('base_branch')}</Code>
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
