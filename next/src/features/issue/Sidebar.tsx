// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The issue's properties (PLAN §7.3, GitHub's sidebar): status (state +
// status label), priority, labels, assignees, milestone — editable through
// the pickers, the same as S/P/L/A/M — and project, dependencies, due date
// and the pull request's branches. Each value is an observer of what it
// shows.

import {MaintainerEdits} from '../pull/MaintainerEdits.tsx';
import {draftPrefix, wipPrefixes} from '../pull/draft.ts';
import {reviewVerdicts} from '../../code/review.ts';
import {Link, useParams} from '@tanstack/react-router';
import {createElement, type ReactNode, useEffect, useRef, useState} from 'react';
import {canWrite, repoAccess} from '../../app/access.ts';
import {observable, runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {shortcutHint, useShortcut} from '../../app/shortcuts/index.ts';
import {type App, type PickerKind, useApp, useSession} from '../../app/store.ts';
import {online} from '../../app/api.ts';
import {isTemp} from '../../intents/intents.ts';
import {editing} from '../../intents/session.ts';
import type {Entity} from '../../data/entity.ts';
import {issueAssigneeIds, issueDeadline, issueLocked, issueTitle, issueMilestone, issuePinned, issueProject, issueState, issueSubscribed, viewMembers} from '../../intents/view.ts';
import {clsx} from 'clsx';
import {PickerPopover} from '../issues/Picker.tsx';
import {labelColor, LabelGlyph, isMerged, priorityIcon, StateGlyph, terminal, stateLook, statusIcon, useLabelView, useOverlay, usePool, UserAvatar, usesStatuses, useUser} from '../issues/cells.tsx';
import {issuePath} from '../issues/edits.ts';
import {fullDate, shortDate} from '../issues/format.ts';
import {scopedValue} from '../issues/labels.ts';
import {ArrowRightIcon, BellIcon, BellSlashIcon, CalendarIcon, CheckCircleIcon, ClockIcon, FileDiffIcon, GitBranchIcon, GitPullRequestDraftIcon, LockIcon, UnlockIcon, CommentIcon, PinIcon, PinSlashIcon, UndoIcon, GearIcon} from '@primer/octicons-react';
import type {Icon as OcticonType} from '@primer/octicons-react';
import {Button, IconButton, IssueLabelToken, Label, SelectPanel, type SelectPanelItemInput, Text, Tooltip} from '@primer/react';
import {RouterLink} from '../../app/routerLinks.tsx';

export const IssueSidebar = observer(function IssueSidebar({issue}: {issue: Entity<'Issue'>}) {
  const session = useSession();
  // Writers change everything; a reader sees the values (Forgejo would refuse the change).
  const write = canWrite(session, issue.get('repo_id'));
  // A click opens the picker under the property (its key opens the same list as a command menu).
  const pick = (kind: PickerKind) => ({kind, issueIds: [issue.id]});
  const pull = issue.get('is_pull');
  return (
    <div className="flex flex-col gap-4">
      <SidebarSection label="Status">
        <Editable write={write} label="Change status" shortcut={shortcutHint('issue.state')} onClick={pick('status')}><StatusValue issue={issue}/></Editable>
      </SidebarSection>
      <SidebarSection label="Priority">
        <Editable write={write} label="Set priority" shortcut={shortcutHint('issue.priority')} onClick={pick('priority')}><PriorityValue issue={issue}/></Editable>
      </SidebarSection>
      <SidebarSection label="Labels">
        <Editable write={write} label="Change labels" shortcut={shortcutHint('issue.labels')} onClick={pick('labels')}><LabelsValue issue={issue} link={!write}/></Editable>
      </SidebarSection>
      <SidebarSection label="Assignees">
        <Editable write={write} label="Change assignees" shortcut={shortcutHint('issue.assignee')} onClick={pick('assignees')}><AssigneesValue issue={issue}/></Editable>
      </SidebarSection>
      {pull && (
        <SidebarSection label="Reviewers">
          <Editable write={write} label="Request reviews" onClick={pick('reviewers')}><ReviewersValue issue={issue}/></Editable>
          <ReRequestReviews issue={issue} write={write}/>
        </SidebarSection>
      )}
      <SidebarSection label="Milestone">
        <Editable write={write} label="Set milestone" shortcut={shortcutHint('issue.milestone')} onClick={pick('milestone')}><MilestoneValue issue={issue} link={!write}/></Editable>
      </SidebarSection>
      <ProjectsValue issue={issue} write={write}/>
      <DependenciesValue issue={issue} write={write}/>
      <DueValue issue={issue} write={write}/>
      {pull && <BranchesValue issue={issue}/>}
      {pull && <MaintainerEdits issue={issue}/>}
      <SubscribeValue issue={issue}/>
      {write && !isTemp(issue.id) && <PinLockValue issue={issue}/>}
    </div>
  );
});

/** Each sidebar field is a heading and its value, separated like GitHub's issue sidebar. */
function SidebarSection({label, children}: {label: string; children: ReactNode}) {
  return <section className="relative border-b border-muted pb-4 text-base">
    <div className="mb-2 flex min-h-7 items-center pr-8 text-muted"><Text as="h3" size="medium" weight="semibold">{label}</Text></div>
    {children}
  </section>;
}

/** The shared issue picker owns selection and offline intents; the value never nests links in a button. */
function SidebarPicker({kind, issueIds, label, shortcut, children}: {
  kind: PickerKind; issueIds: readonly number[]; label: string; shortcut?: string | undefined; children: ReactNode;
}) {
  return <div className="flex items-center gap-2">
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
    <div className="absolute top-0 right-0"><PickerPopover kind={kind} issueIds={issueIds} trigger={
      <IconButton icon={GearIcon} variant="invisible" size="small" aria-label={label} description={label} {...(shortcut ? {keybindingHint: shortcut} : {})}/>
    }/></div>
  </div>;
}

function Editable({write, label, shortcut, onClick, children}: {
  write: boolean; label: string; shortcut?: string | undefined; onClick: {kind: PickerKind; issueIds: readonly number[]}; children: ReactNode;
}) {
  if (!write) return <div className="flex flex-wrap items-center gap-2">{children}</div>;
  return <SidebarPicker kind={onClick.kind} issueIds={onClick.issueIds} label={label} shortcut={shortcut}>{children}</SidebarPicker>;
}

const StatusValue = observer(function StatusValue({issue}: {issue: Entity<'Issue'>}) {
  const pool = usePool();
  const app = useApp();
  const overlay = useOverlay();
  const state = issueState(overlay, issue);
  const pull = issue.get('is_pull');
  const look = stateLook(state, pull, pull && isMerged(pool, issue.id));
  const {status} = useLabelView(issue);
  // Merged says it all (a workflow label left at "In Review" is not news then).
  const merged = pull && isMerged(pool, issue.id);
  // An open draft pull request says so (as its row in the list does), not just "Open".
  const draft = pull && !merged && state === 'open' && draftPrefix(issueTitle(overlay, issue), wipPrefixes(app.config)) !== undefined;
  // One status: the workflow label while open (or when it says the work ended); Forgejo's state otherwise,
  // with the label it was left at (a closed issue still labelled "In progress").
  if (status && (state === 'open' || terminal(status.name))) {
    return (
      <>
        <LabelGlyph icon={statusIcon(status.name)} color={status.color}/>
        <span>{scopedValue(status.name)}</span>
        {draft && <Label>Draft</Label>}
      </>
    );
  }
  if (draft) return <><GitPullRequestDraftIcon size={16} className="shrink-0 text-muted"/><span>Draft</span></>;
  // Open without a status label in a repository that has them: no status yet ("No priority" alike), not a stage
  // called "Open" (QA #192).
  const none = !status && !pull && state === 'open' && usesStatuses(pool, issue.get('repo_id'));
  return (
    <>
      <StateGlyph look={look}/><span>{look.label}</span>
      {status && !merged && <span className="truncate text-muted">({scopedValue(status.name)})</span>}
      {none && <span className="truncate text-muted">· No status</span>}
    </>
  );
});

const PriorityValue = observer(function PriorityValue({issue}: {issue: Entity<'Issue'>}) {
  const p = useLabelView(issue).priority;
  if (!p) return <span className="text-muted">No priority</span>;
  return <><LabelGlyph icon={priorityIcon(p.name)} color={p.color}/><span>{scopedValue(p.name)}</span></>;
});

/** A reader's labels open the issues with that label (GitHub's); a writer's open the picker (the property's button). */
const LabelsValue = observer(function LabelsValue({issue, link}: {issue: Entity<'Issue'>; link: boolean}) {
  const labels = useLabelView(issue).other;
  const {owner, repo} = useParams({strict: false});
  if (!labels.length) return <span className="text-muted">No labels</span>;
  if (!link || !owner || !repo) return <>{labels.map((l) => <IssueLabelToken key={l.id} text={l.name} fillColor={labelColor(l.color)}/>)}</>;
  return <>{labels.map((l) => (
    <RouterLink key={l.id} to="/$owner/$repo/issues" params={{owner, repo}} search={{labels: String(l.id)}} muted><IssueLabelToken text={l.name} fillColor={labelColor(l.color)}/></RouterLink>
  ))}</>;
});

const AssigneesValue = observer(function AssigneesValue({issue}: {issue: Entity<'Issue'>}) {
  const ids = issueAssigneeIds(usePool(), useOverlay(), issue.id).sort((a, b) => a - b);
  if (!ids.length) return <span className="text-muted">Unassigned</span>;
  return <span className="flex flex-col gap-1">{ids.map((id) => <Person key={id} id={id}/>)}</span>;
});

/** Requested reviewers and those who reviewed, with their verdict (the latest review of each). */
const ReviewersValue = observer(function ReviewersValue({issue}: {issue: Entity<'Issue'>}) {
  const pool = usePool();
  const requested = viewMembers(pool, useOverlay(), 'ReviewRequest', issue.id);
  const verdicts = reviewVerdicts([...pool.model('Review').by('issue_id', issue.id)].map((r) => r.data));
  const ids = [...new Set([...requested as Set<number>, ...verdicts.keys()])].sort((a, b) => a - b);
  if (!ids.length) return <span className="text-muted">No reviewers</span>;
  return (
    <span className="flex flex-col gap-1">
      {ids.map((id) => {
        const v = verdicts.get(id);
        const look = requested.has(id) ? REVIEW_LOOK.REQUEST_REVIEW : v ? REVIEW_LOOK[v.state] : undefined;
        // The verdict in words too: an icon alone (a red mark) read as a remove button.
        return (
          <span key={id} className="flex min-w-0 flex-wrap items-center gap-x-2">
            <Person id={id}/>
            {look && <span className={clsx('flex items-center gap-1 text-sm', REVIEW_TONE[look.tone])}>{createElement(look.icon, {size: 12})}{look.label}</span>}
          </span>
        );
      })}
    </span>
  );
});

const REVIEW_TONE = {APPROVED: 'text-success', REQUEST_CHANGES: 'text-danger', COMMENT: 'text-muted', REQUEST_REVIEW: 'text-attention'} as const;

const REVIEW_LOOK: Record<string, {icon: OcticonType; label: string; tone: keyof typeof REVIEW_TONE} | undefined> = {
  APPROVED: {icon: CheckCircleIcon, label: 'Approved', tone: 'APPROVED'},
  REQUEST_CHANGES: {icon: FileDiffIcon, label: 'Changes requested', tone: 'REQUEST_CHANGES'},
  COMMENT: {icon: CommentIcon, label: 'Commented', tone: 'COMMENT'},
  REQUEST_REVIEW: {icon: ClockIcon, label: 'Review requested', tone: 'REQUEST_REVIEW'},
};

/**
 * Asking someone who already reviewed to review again (GitHub's re-request): one button per reviewer with a verdict
 * and no open request, for those Forgejo lets (writers; the pull request's author, for someone who reviewed it).
 */
const ReRequestReviews = observer(function ReRequestReviews({issue, write}: {issue: Entity<'Issue'>; write: boolean}) {
  const app = useApp();
  const session = useSession();
  const pool = usePool();
  const overlay = useOverlay();
  const requested = viewMembers(pool, overlay, 'ReviewRequest', issue.id);
  const verdicts = reviewVerdicts([...pool.model('Review').by('issue_id', issue.id)].map((r) => r.data));
  const poster = issue.get('poster_id');
  if (isTemp(issue.id) || issueState(overlay, issue) !== 'open' || isMerged(pool, issue.id) || (!write && session.userId !== poster)) return null;
  const ids = [...verdicts.keys()].filter((id) => !requested.has(id) && id !== poster).sort((a, b) => a - b);
  if (!ids.length) return null;
  return (
    <span className="flex flex-col items-start px-1">
      {ids.map((id) => <ReRequestButton key={id} id={id} onClick={() => {
        runInAction(() => {
          editing(app).intents.submit({kind: 'issue.reviewer', issueId: issue.id, repoId: issue.get('repo_id'), userId: id, add: true});
        });
      }}/>)}
    </span>
  );
});

const ReRequestButton = observer(function ReRequestButton({id, onClick}: {id: number; onClick: () => void}) {
  const name = useUser(id).name;
  return (
    <Tooltip text={`Ask ${name} to review again`}><Button variant="invisible" size="small" leadingVisual={UndoIcon} type="button" aria-label={`Re-request review from ${name}`} onClick={onClick}>
      <span className="truncate">Re-request {name}</span>
    </Button></Tooltip>
  );
});

/** Reference treatment for named users in rows: a 20px avatar and a 14px name. */
const Person = observer(function Person({id}: {id: number}) {
  const u = useUser(id);
  return <span className="flex items-center gap-2"><UserAvatar id={id} size="sm"/><Text size="medium" className="truncate">{u.name}</Text></span>;
});

/** A reader's milestone opens its page; a writer's opens the picker (the property's button). */
const MilestoneValue = observer(function MilestoneValue({issue, link}: {issue: Entity<'Issue'>; link: boolean}) {
  const id = issueMilestone(useOverlay(), issue);
  const m = usePool().model('Milestone').get(id);
  const {owner, repo} = useParams({strict: false});
  if (!id) return <span className="text-muted">No milestone</span>;
  const due = m?.get('due_on');
  const title = m?.get('title') ?? `Milestone ${String(id)}`;
  return (
    <span className="truncate">
      {link && m && owner && repo ? <Link to="/$owner/$repo/milestone/$index" params={{owner, repo, index: String(id)}} className="text-default hover:text-accent hover:underline">{title}</Link> : title}
      {due && <span className="text-muted"> · due {shortDate(due)}</span>}
    </span>
  );
});

/**
 * The project the issue is on (Project when held, else what the owner shares: ProjectRef, B6) and its column; writers
 * put it on a board of its repository or owner, or take it off (issue.project: offline-capable).
 */
const ProjectsValue = observer(function ProjectsValue({issue, write}: {issue: Entity<'Issue'>; write: boolean}) {
  const pool = usePool();
  const overlay = useOverlay();
  const {project: pid, column: cid} = issueProject(pool, overlay, issue.id);
  const project = pid ? pool.model('Project').get(pid) : undefined;
  const title = pid ? project?.get('title') ?? pool.model('ProjectRef').get(pid)?.get('title') ?? `Project ${String(pid)}` : undefined;
  const column = pool.model('ProjectColumn').get(cid)?.get('title');
  // The board opens from here (the triage path: issue → its board) when it is on this device; the link truncates
  // itself (no clipping parent: its focus outline stays whole).
  const value = title === undefined ? <span className="text-muted">No project</span> : (
    <span className="flex min-w-0 items-center gap-1">
      {/* Also a board known by its reference only (a user's or an organization's): the board page loads it. The
          card of this issue gets the cursor there. */}
      {project ?? pool.model('ProjectRef').get(pid) ?
        <Link to="/-/next/projects/$id" params={{id: String(pid)}} search={{card: issue.id}} className="min-w-0 truncate text-default hover:text-accent hover:underline">{title}</Link> :
        <span className="truncate">{title}</span>}
      {column && <span className="shrink-0 text-muted">· {column}</span>}
    </span>
  );
  if (!write || isTemp(issue.id)) return <SidebarSection label="Project"><div className="flex flex-wrap items-center gap-2">{value}</div></SidebarSection>;
  return (
    <SidebarSection label="Project">
      <SidebarPicker kind="project" issueIds={[issue.id]} label="Put it on a board">{value}</SidebarPicker>
    </SidebarSection>
  );
});

/**
 * What an issue blocks, as Forgejo says (online, once per page): the dependencies naming it as the blocker live in
 * the blocked issues' groups, which are on this device only when those issues were opened.
 */
export const blocking = observable.map<number, readonly number[]>({}, {deep: false});

function useBlocks(app: App, issue: Entity<'Issue'>): void {
  const id = issue.id;
  useEffect(() => {
    if (id <= 0) return undefined;
    const repo = untracked(() => app.session?.data.pool.model('Repository').get(issue.data.repo_id)?.data);
    if (!repo) return undefined;
    const ctrl = new AbortController();
    void online<{id?: unknown}[]>(app, {
      api: 'v1', signal: ctrl.signal,
      path: `/repos/${encodeURIComponent(repo.owner_name)}/${encodeURIComponent(repo.name)}/issues/${String(issue.data.number)}/blocks?limit=50`,
    }).then((list) => {
      const ids = (list ?? []).map((x) => x.id).filter((x): x is number => typeof x === 'number');
      runInAction(() => {
        blocking.set(id, ids);
      });
    }).catch(() => undefined);
    return () => {
      ctrl.abort();
    };
  }, [app, id, issue]);
}

/** Blocked by / blocks (IssueDependency, the lazy tier; what it blocks also from Forgejo). */
const DependenciesValue = observer(function DependenciesValue({issue, write}: {issue: Entity<'Issue'>; write: boolean}) {
  const app = useApp();
  const pool = usePool();
  useBlocks(app, issue);
  const blockedBy = [...viewMembers(pool, useOverlay(), 'IssueDependency', issue.id)] as number[];
  const blocks = [...new Set([...[...pool.model('IssueDependency').by('dependency_id', issue.id)].map((d) => d.get('issue_id')), ...blocking.get(issue.id) ?? []])];
  const edit = write && !isTemp(issue.id);
  return (
    <>
      <SidebarSection label="Blocked by">
        {blockedBy.length ? <IssueLinks ids={blockedBy} repoId={issue.get('repo_id')}/> : !edit && <div className="flex flex-wrap items-center gap-2"><span className="text-muted">Nothing</span></div>}
        {edit && (
          <SidebarPicker kind="dependency" issueIds={[issue.id]} label="Change what blocks this">{!blockedBy.length && <span className="text-muted">Nothing</span>}</SidebarPicker>
        )}
      </SidebarSection>
      {blocks.length > 0 && <SidebarSection label="Blocks"><IssueLinks ids={blocks} repoId={issue.get('repo_id')}/></SidebarSection>}
    </>
  );
});

function IssueLinks({ids, repoId}: {ids: number[]; repoId: number}) {
  return <div className="flex flex-wrap items-center gap-2">{ids.map((id) => <IssueLink key={id} id={id} repoId={repoId}/>)}</div>;
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
  if (!i) return <span className="text-muted">{missing}</span>;
  const repo = pool.model('Repository').get(i.get('repo_id'));
  const ref = `${i.get('repo_id') === repoId ? '' : repo?.get('full_name') ?? ''}#${String(i.get('number'))}`;
  const path = issuePath(app, i);
  const text = <><span className="text-muted tabular-nums">{ref}</span> {i.get('title')}</>;
  if (!path) return <span className={inline ? undefined : 'truncate'}>{text}</span>;
  return <Link to={path} className={clsx('text-default hover:text-accent hover:underline', !inline && 'min-w-0 truncate')}>{text}</Link>;
});

const DueValue = observer(function DueValue({issue, write}: {issue: Entity<'Issue'>; write: boolean}) {
  const due = issueDeadline(useOverlay(), issue);
  const open = issueState(useOverlay(), issue) === 'open';
  const late = Boolean(due) && open && Date.parse(due ?? '') < Date.now();
  const value = due ?
    <span className={late ? 'flex items-center gap-2 text-danger' : 'flex items-center gap-2'} title={fullDate(due)}><CalendarIcon size={16} className="shrink-0"/>{shortDate(due)}{late && ' · overdue'}</span> :
    <span className="text-muted">No due date</span>;
  return (
    <SidebarSection label="Due date">
      {write && !isTemp(issue.id) ?
        <SidebarPicker kind="due" issueIds={[issue.id]} label="Set the due date">{value}</SidebarPicker> :
        <div className="flex flex-wrap items-center gap-2">{value}</div>}
    </SidebarSection>
  );
});

const BranchesValue = observer(function BranchesValue({issue}: {issue: Entity<'Issue'>}) {
  const pool = usePool();
  const pr = [...pool.model('PullRequest').by('issue_id', issue.id)][0];
  if (!pr) return null;
  // The head branch deleted (after a merge, or by hand): said, not shown as if it were there. Only when the
  // head repository's branches are on this device (a fork's may not be).
  const branches = [...pool.model('Branch').by('repo_id', pr.get('head_repo_id'))].map((b) => b.data);
  const head = branches.find((b) => b.name === pr.get('head_branch'));
  const deleted = branches.length > 0 && (head === undefined || head.is_deleted);
  // From a fork: its owner names the head ("frank:docs"), as Forgejo writes it (a fork's runs may wait for approval).
  const fork = pr.get('head_repo_id') !== pr.get('base_repo_id');
  const headOwner = fork ? pool.model('Repository').get(pr.get('head_repo_id'))?.get('owner_name') : undefined;
  const headName = headOwner ? `${headOwner}:${pr.get('head_branch')}` : pr.get('head_branch');
  return (
    <SidebarSection label="Branches">
      <div className="flex flex-col gap-1 text-muted">
        {/* Head, then base, one per line: long names truncate inside the pane (the full name on hover). */}
        <span className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="flex min-w-0 items-center gap-1" title={deleted ? `${headName} (deleted)` : headName}>
            <GitBranchIcon size={12} className="shrink-0"/>
            <span className={deleted ? 'min-w-0 truncate line-through' : 'min-w-0 truncate'}><code>{headName}</code></span>
            {fork && <Label>Fork</Label>}
            {deleted && <Label>Deleted</Label>}
          </span>
          <span className="flex min-w-0 items-center gap-1" title={pr.get('base_branch')}><ArrowRightIcon size={12} className="shrink-0"/><span className="min-w-0 truncate"><code>{pr.get('base_branch')}</code></span></span>
        </span>
      </div>
    </SidebarSection>
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
    <SidebarSection label="Notifications">
      <Button variant="invisible" size="small" leadingVisual={on ? BellIcon : BellSlashIcon} aria-label={on ? 'Unsubscribe' : 'Subscribe'} onClick={toggle}>
        <span>{on ? 'Subscribed' : 'Not subscribed'}</span>
      </Button>
    </SidebarSection>
  );
});

/** Forgejo's default lock reasons (setting.Repository.Issue.LockReasons; API v1 refuses any other). */
const LOCK_REASONS = ['Too heated', 'Off-topic', 'Resolved', 'Spam'];

/**
 * Pinning (to the repository's issue list) and locking the conversation: writers lock; only the repository's
 * administrators pin (API v1 /pin is reqAdmin: a writer's pin is refused), so a writer sees the value, and why.
 */
const PinLockValue = observer(function PinLockValue({issue}: {issue: Entity<'Issue'>}) {
  const app = useApp();
  const session = useSession();
  const overlay = useOverlay();
  const mayPin = repoAccess(session, issue.get('repo_id')) === 'admin';
  const pinned = issuePinned(overlay, issue);
  const locked = issueLocked(overlay, issue);
  const submit = (patch: {kind: 'issue.pin'; pinned: boolean} | {kind: 'issue.lock'; locked: boolean; reason: string}) => {
    runInAction(() => {
      editing(app).intents.submit({...patch, issueId: issue.id, repoId: issue.get('repo_id')});
    });
  };
  return (
    <>
      <SidebarSection label="Pinned">
        {mayPin ?
          <Button variant="invisible" size="small" leadingVisual={pinned ? PinIcon : PinSlashIcon} aria-label={pinned ? 'Unpin' : 'Pin to the list'} onClick={() => {
            submit({kind: 'issue.pin', pinned: !pinned});
          }}><span>{pinned ? 'Pinned' : 'Not pinned'}</span></Button> :
          <div className="flex flex-col gap-1 text-muted">
            <span className="flex items-center gap-1">{createElement(pinned ? PinIcon : PinSlashIcon, {size: 16})}<span>{pinned ? 'Pinned' : 'Not pinned'}</span></span>
            <span className="text-sm text-muted">Only repository administrators can pin issues.</span>
          </div>}
      </SidebarSection>
      <SidebarSection label="Conversation">
        <ConversationLock locked={locked} submit={submit}/>
      </SidebarSection>
    </>
  );
});

/** A lock reason is selected deliberately; unlocking also confirms who can comment. */
function ConversationLock({locked, submit}: {locked: boolean; submit: (patch: {kind: 'issue.lock'; locked: boolean; reason: string}) => void}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const items = locked ? [{id: 'unlock', text: 'Unlock: everyone who can read it may comment again', leadingVisual: UnlockIcon}] :
    LOCK_REASONS.map((reason) => ({id: reason, text: reason}));
  return <SelectPanel title={locked ? 'Unlock the conversation' : 'Lock the conversation'} open={open} onOpenChange={setOpen}
    placeholderText={locked ? 'Unlock it?' : 'Why lock it?'} filterValue={filter} onFilterChange={setFilter}
    items={items.filter((item) => item.text.toLowerCase().includes(filter.toLowerCase()))} selected={undefined}
    onSelectedChange={(item: SelectPanelItemInput | undefined) => {
      if (!item) return;
      submit({kind: 'issue.lock', locked: !locked, reason: locked ? '' : String(item.id)});
      setOpen(false);
    }}
    anchorRef={anchorRef} renderAnchor={({id, onClick, onKeyDown, "aria-expanded": expanded, "aria-haspopup": hasPopup}) => <Button ref={anchorRef} id={id} onClick={onClick} onKeyDown={onKeyDown} aria-expanded={expanded} aria-haspopup={hasPopup} variant="invisible" size="small" leadingVisual={locked ? LockIcon : UnlockIcon}
      aria-label={locked ? 'Unlock the conversation' : 'Lock the conversation (only collaborators can comment)'}>{locked ? 'Locked' : 'Open to comments'}</Button>}/>;
}
