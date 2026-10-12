// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {MaintainerEdits} from '../pull/MaintainerEdits.tsx';
import {ConvertToDraft} from '../pull/DraftControl.tsx';
import {draftPrefix, wipPrefixes} from '../pull/draft.ts';
import {reviewerStates} from '../pull/verdicts.ts';
import {Link, useParams} from '@tanstack/react-router';
import {createElement, type ReactNode, type RefObject, useEffect, useRef, useState} from 'react';
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
import {labelColor, LabelGlyph, isMerged, priorityIcon, StateGlyph, stateLook, statusIcon, useLabelView, useOverlay, usePool, UserAvatar, usesStatuses, useUser} from '../issues/cells.tsx';
import {issuePath} from '../issues/edits.ts';
import {fullDate, shortDate} from '../../app/time.ts';
import {scopedValue, terminalStatus} from '../issues/labels.ts';
import {BellIcon, BellSlashIcon, CalendarIcon, CheckIcon, CommentIcon, DotFillIcon, FileDiffIcon, GearIcon, GitPullRequestDraftIcon, KeyIcon, LockIcon, PinIcon, PinSlashIcon, SyncIcon} from '@primer/octicons-react';
import type {Icon as OcticonType} from '@primer/octicons-react';
import {Button, Dialog, FormControl, IconButton, IssueLabelToken, Label, Select, Text} from '@primer/react';
import {RouterLink} from '../../app/routerLinks.tsx';

export const IssueSidebar = observer(function IssueSidebar({issue}: {issue: Entity<'Issue'>}) {
  const session = useSession();
  const write = canWrite(session, issue.get('repo_id'));
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
      {pull && (
        <SidebarSection label="Reviewers">
          <Editable write={write} label="Request reviews" onClick={pick('reviewers')}><ReviewersValue issue={issue} write={write}/></Editable>
          <ConvertToDraft issue={issue}/>
        </SidebarSection>
      )}
      <SidebarSection label="Assignees">
        <Editable write={write} label="Change assignees" shortcut={shortcutHint('issue.assignee')} onClick={pick('assignees')}><AssigneesValue issue={issue}/></Editable>
      </SidebarSection>
      <SidebarSection label="Labels">
        <Editable write={write} label="Change labels" shortcut={shortcutHint('issue.labels')} onClick={pick('labels')}><LabelsValue issue={issue}/></Editable>
      </SidebarSection>
      <ProjectsValue issue={issue} write={write}/>
      <SidebarSection label="Milestone">
        <Editable write={write} label="Set milestone" shortcut={shortcutHint('issue.milestone')} onClick={pick('milestone')}><MilestoneValue issue={issue}/></Editable>
      </SidebarSection>
      <DependenciesValue issue={issue} write={write}/>
      <DueValue issue={issue} write={write}/>
      <SubscribeValue issue={issue}/>
      {pull && <MaintainerEdits issue={issue}/>}
      {write && !isTemp(issue.id) && <PinLockValue issue={issue}/>}
    </div>
  );
});

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
  const merged = pull && isMerged(pool, issue.id);
  const draft = pull && !merged && state === 'open' && draftPrefix(issueTitle(overlay, issue), wipPrefixes(app.config)) !== undefined;
  // Prefer workflow status unless it contradicts the closed state.
  if (status && (state === 'open' || terminalStatus(status.name))) {
    return (
      <>
        <LabelGlyph icon={statusIcon(status.name)} color={status.color}/>
        <span>{scopedValue(status.name)}</span>
        {draft && <Label>Draft</Label>}
      </>
    );
  }
  if (draft) return <><GitPullRequestDraftIcon size={16} className="shrink-0 text-muted"/><span>Draft</span></>;
  // Repositories with workflow labels distinguish an unset status from an "Open" stage.
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

const LabelsValue = observer(function LabelsValue({issue}: {issue: Entity<'Issue'>}) {
  const labels = useLabelView(issue).other;
  const {owner, repo} = useParams({strict: false});
  if (!labels.length) return <span className="text-muted">No labels</span>;
  if (!owner || !repo) return <>{labels.map((l) => <IssueLabelToken key={l.id} text={l.name} fillColor={labelColor(l.color)}/>)}</>;
  return <>{labels.map((l) => (
    <RouterLink key={l.id} to="/$owner/$repo/issues" params={{owner, repo}} search={{labels: String(l.id)}} muted><IssueLabelToken text={l.name} fillColor={labelColor(l.color)}/></RouterLink>
  ))}</>;
});

const AssigneesValue = observer(function AssigneesValue({issue}: {issue: Entity<'Issue'>}) {
  const ids = issueAssigneeIds(usePool(), useOverlay(), issue.id).sort((a, b) => a - b);
  if (!ids.length) return <span className="text-muted">Unassigned</span>;
  return <span className="flex flex-col gap-1">{ids.map((id) => <Person key={id} id={id}/>)}</span>;
});

/** GitHub's reviewer rows: who, then their state, then Re-request once they have reviewed. */
const ReviewersValue = observer(function ReviewersValue({issue, write}: {issue: Entity<'Issue'>; write: boolean}) {
  const app = useApp();
  const session = useSession();
  const pool = usePool();
  const overlay = useOverlay();
  const requested = viewMembers(pool, overlay, 'ReviewRequest', issue.id);
  const poster = issue.get('poster_id');
  const states = reviewerStates([...pool.model('Review').by('issue_id', issue.id)].map((r) => r.data).filter((r) => r.reviewer_id !== poster));
  const ids = [...new Set([...requested as Set<number>, ...states.keys()])].sort((a, b) => a - b);
  if (!ids.length) return <span className="text-muted">No reviewers</span>;
  const reRequest = !isTemp(issue.id) && issueState(overlay, issue) === 'open' && !isMerged(pool, issue.id) && (write || session.userId === poster);
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      {ids.map((id) => {
        const look = REVIEW_LOOK[requested.has(id) ? 'REQUEST_REVIEW' : states.get(id) ?? ''];
        return (
          <span key={id} className="flex min-w-0 items-center gap-1">
            <span className="min-w-0 flex-1"><Person id={id}/></span>
            {reRequest && !requested.has(id) && <ReRequest id={id} onClick={() => {
              runInAction(() => {
                editing(app).intents.submit({kind: 'issue.reviewer', issueId: issue.id, repoId: issue.get('repo_id'), userId: id, add: true});
              });
            }}/>}
            {look && <span className={clsx('flex shrink-0', look.tone)} title={look.label}>{createElement(look.icon, {size: 16, 'aria-label': look.label})}</span>}
          </span>
        );
      })}
    </span>
  );
});

const REVIEW_LOOK: Partial<Record<string, {icon: OcticonType; label: string; tone: string}>> = {
  APPROVED: {icon: CheckIcon, label: 'Approved', tone: 'text-success'},
  REQUEST_CHANGES: {icon: FileDiffIcon, label: 'Changes requested', tone: 'text-danger'},
  COMMENT: {icon: CommentIcon, label: 'Commented', tone: 'text-muted'},
  REQUEST_REVIEW: {icon: DotFillIcon, label: 'Awaiting review', tone: 'text-attention'},
};

const ReRequest = observer(function ReRequest({id, onClick}: {id: number; onClick: () => void}) {
  const name = useUser(id).name;
  return <IconButton icon={SyncIcon} variant="invisible" size="small" aria-label={`Re-request review from ${name}`} description="Re-request review" type="button" onClick={onClick}/>;
});

const Person = observer(function Person({id}: {id: number}) {
  const u = useUser(id);
  return <span className="flex items-center gap-2"><UserAvatar id={id} size="sm"/><Text size="medium" className="truncate">{u.name}</Text></span>;
});

const MilestoneValue = observer(function MilestoneValue({issue}: {issue: Entity<'Issue'>}) {
  const id = issueMilestone(useOverlay(), issue);
  const m = usePool().model('Milestone').get(id);
  const {owner, repo} = useParams({strict: false});
  if (!id) return <span className="text-muted">No milestone</span>;
  const due = m?.get('due_on');
  const title = m?.get('title') ?? `Milestone ${String(id)}`;
  return (
    <span className="truncate">
      {m && owner && repo ? <Link to="/$owner/$repo/milestone/$index" params={{owner, repo, index: String(id)}} className="text-default hover:text-accent hover:underline">{title}</Link> : title}
      {due && <span className="text-muted"> · due {shortDate(due)}</span>}
    </span>
  );
});

const ProjectsValue = observer(function ProjectsValue({issue, write}: {issue: Entity<'Issue'>; write: boolean}) {
  const pool = usePool();
  const overlay = useOverlay();
  const {project: pid, column: cid} = issueProject(pool, overlay, issue.id);
  const project = pid ? pool.model('Project').get(pid) : undefined;
  const title = pid ? project?.get('title') ?? pool.model('ProjectRef').get(pid)?.get('title') ?? `Project ${String(pid)}` : undefined;
  const column = pool.model('ProjectColumn').get(cid)?.get('title');
  // Let the link truncate itself so its focus outline is not clipped.
  const value = title === undefined ? <span className="text-muted">No project</span> : (
    <span className="flex min-w-0 items-center gap-1">
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

/** Outgoing dependencies live in other issues' lazy groups, so fetch what this issue blocks separately. */
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

/** inline links wrap within a sentence; cross-repository references include the repository name. */
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
      <Button block size="small" leadingVisual={on ? BellSlashIcon : BellIcon} onClick={toggle}>{on ? 'Unsubscribe' : 'Subscribe'}</Button>
      <p className="mt-2 text-sm text-muted">{on ? 'You’re receiving notifications because you’re subscribed to this thread.' : 'You’re not receiving notifications from this thread.'}</p>
    </SidebarSection>
  );
});

/** Forgejo's default lock reasons (setting.Repository.Issue.LockReasons; API v1 refuses any other). */
const LOCK_REASONS = ['Too heated', 'Off-topic', 'Resolved', 'Spam'];

/** Forgejo requires repository admin access to pin, but only write access to lock. */
const PinLockValue = observer(function PinLockValue({issue}: {issue: Entity<'Issue'>}) {
  const app = useApp();
  const session = useSession();
  const overlay = useOverlay();
  const [locking, setLocking] = useState(false);
  const mayPin = repoAccess(session, issue.get('repo_id')) === 'admin';
  const pinned = issuePinned(overlay, issue);
  const locked = issueLocked(overlay, issue);
  const noun = issue.get('is_pull') ? 'pull request' : 'issue';
  const lockButton = useRef<HTMLButtonElement>(null);
  const submit = (patch: {kind: 'issue.pin'; pinned: boolean} | {kind: 'issue.lock'; locked: boolean; reason: string}) => {
    runInAction(() => {
      editing(app).intents.submit({...patch, issueId: issue.id, repoId: issue.get('repo_id')});
    });
  };
  return (
    <div className="flex flex-col items-start">
      <Button variant="invisible" size="small" leadingVisual={locked ? KeyIcon : LockIcon} ref={lockButton} onClick={() => { setLocking(true); }}>
        {locked ? 'Unlock conversation' : 'Lock conversation'}
      </Button>
      {mayPin && <Button variant="invisible" size="small" leadingVisual={pinned ? PinSlashIcon : PinIcon} onClick={() => {
        submit({kind: 'issue.pin', pinned: !pinned});
      }}>{pinned ? `Unpin ${noun}` : `Pin ${noun}`}</Button>}
      {locking && <LockDialog noun={noun} locked={locked} returnFocusRef={lockButton} onClose={() => { setLocking(false); }} onConfirm={(reason) => {
        setLocking(false);
        submit({kind: 'issue.lock', locked: !locked, reason});
      }}/>}
    </div>
  );
});

function LockDialog({noun, locked, returnFocusRef, onClose, onConfirm}: {
  noun: string; locked: boolean; returnFocusRef: RefObject<HTMLButtonElement | null>; onClose: () => void; onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const title = `${locked ? 'Unlock' : 'Lock'} conversation on this ${noun}`;
  return (
    <Dialog title={title} width="medium" returnFocusRef={returnFocusRef} onClose={onClose} footerButtons={[
      {content: 'Cancel', onClick: onClose},
      {content: title, buttonType: 'primary', inactive: !locked && !reason, onClick: () => {
        if (locked || reason) onConfirm(locked ? '' : reason);
      }},
    ]}>
      <div className="flex flex-col gap-4 text-base">
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {locked ? <>
            <li>Everyone will be able to comment on this {noun} once more.</li>
            <li>You can always lock this {noun} again in the future.</li>
          </> : <>
            <li>Other users <strong>can’t add new comments</strong> to this {noun}.</li>
            <li>You and other collaborators <strong>with access</strong> to this repository can still leave comments that others can see.</li>
            <li>You can always unlock this {noun} again in the future.</li>
          </>}
        </ul>
        {!locked && <FormControl required>
          <FormControl.Label>Reason</FormControl.Label>
          <Select value={reason} onChange={(e) => { setReason(e.target.value); }}>
            <Select.Option value="" disabled>Choose a reason</Select.Option>
            {LOCK_REASONS.map((r) => <Select.Option key={r} value={r}>{r}</Select.Option>)}
          </Select>
          <FormControl.Caption>Others see the reason in the conversation.</FormControl.Caption>
        </FormControl>}
      </div>
    </Dialog>
  );
}
