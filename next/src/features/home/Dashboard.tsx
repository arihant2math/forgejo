// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {useEffect} from 'react';
import {hrefOf, useLinkClick} from '../../app/links.ts';
import {reach} from '../../app/online.ts';
import {LOCAL_PREFS} from '../../app/splash.ts';
import {DashboardKeys} from './DashboardKeys.tsx';
import {PageColumn} from '../../app/shell/Frame.tsx';
import {shortcutHint} from '../../app/shortcuts/index.ts';
import {useApp, useSession} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import {editing} from '../../intents/session.ts';
import {issueState, notificationStatus} from '../../intents/view.ts';
import {DenseRow} from './DenseRow.tsx';
import {IssueReference as RefCell} from './IssueReference.tsx';
import {DashboardSection} from './DashboardSection.tsx';
import {activityOf} from '../inbox/inbox.ts';
import {AgoCell, PendingCell, StateGlyph, StateIcon, stateLook, TitleCell, useOverlay, usePool} from '../issues/cells.tsx';
import {knownSubject, subjectOf, subjectPath} from '../inbox/subject.ts';
import {issuePath} from '../issues/edits.ts';
import type {ListSource} from '../issues/list.ts';
import {useListModel} from '../issues/ListPage.tsx';
import {HomeSkeleton} from './Home.tsx';
import Feed from './Feed.tsx';
import {CommandPaletteIcon, GitPullRequestIcon, InboxIcon, EyeIcon, IssueOpenedIcon, CloudOfflineIcon, UploadIcon} from '@primer/octicons-react';
import type {Icon as OcticonType} from '@primer/octicons-react';
import {Button, CounterLabel, LinkButton} from '@primer/react';
import {Tooltip} from '@primer/react';
import {KeybindingHint, SkeletonBox, Blankslate} from '@primer/react/experimental';

const ROWS = 6;

const REVIEWS: ListSource = {kind: 'my', pulls: true, type: 'review_requested'};

interface Item {
  /** Undefined when a notification's issue is absent locally. */
  issue?: Entity<'Issue'> | undefined;
  note?: Entity<'Notification'> | undefined;
  at: string;
}

/** Wait for initial sync to settle so sections and counts do not jump as groups arrive. */
let settledOnce = false;

export default observer(function Dashboard() {
  const app = useApp();
  const {userId: me, auth, data} = useSession();
  const settled = settledOnce || (data.workspace.current !== undefined && data.status.loading === 0);
  if (settled) settledOnce = true;
  const pool = usePool();
  const overlay = useOverlay();
  const open = (i: Entity<'Issue'> | undefined): i is Entity<'Issue'> => i !== undefined && issueState(overlay, i) === 'open';
  const issues = pool.model('Issue');

  const unread = [...pool.model('Notification').all()].filter((n) => notificationStatus(overlay, n) === 'unread')
    .map((n): Item => {
      const issue = issues.get(n.get('issue_id'));
      return {issue, note: n, at: activityOf(n.data, issue?.get('updated_at') ?? knownSubject(app, n.id)?.updated)};
    }).sort(byTime);
  const assigned = [...new Set([...pool.model('IssueAssignee').by('assignee_id', me)].map((a) => a.get('issue_id')))]
    .map((id) => issues.get(id)).filter(open).map(updated).sort(byTime);
  const mine = [...issues.by('poster_id', me)].filter((i) => i.get('is_pull') && open(i)).map(updated).sort(byTime);
  const pending = (editing(app).overlay.created('Issue') as Entity<'Issue'>[]).map((issue) => ({issue, at: issue.get('created_at')})).sort(byTime);

  if (!settled) return <HomeSkeleton/>;
  const sections: SectionProps[] = [
    {title: 'Unread', icon: InboxIcon, items: unread, all: '/notifications?filter=unread'},
    {title: 'Assigned to you', icon: IssueOpenedIcon, items: assigned, all: '/issues?type=assigned'},
    {title: 'Your pull requests', icon: GitPullRequestIcon, items: mine, all: '/pulls?type=created_by'},
  ].filter((x) => x.items.length);
  return (
    <DashboardKeys><PageColumn>
      {pending.length > 0 && <Section title="Not synced yet" icon={UploadIcon} items={pending}/>}
      {/* Reserve the previous review-list height to avoid shifting sections when the authenticated answer arrives. */}
      {auth.status.state === 'ok' ? <ReviewRequests/> : <ReviewPlaceholder rows={lastReviews()}/>}
      {sections.map((x) => <Section key={x.title} {...x}/>)}
      {sections.length || pending.length ? <p className="text-sm text-muted"><Hints/></p> : <Welcome/>}
      <Feed/>
    </PageColumn></DashboardKeys>
  );
});

const byTime = (a: Item, b: Item) => b.at.localeCompare(a.at);
const updated = (issue: Entity<'Issue'>): Item => ({issue, at: issue.get('updated_at')});

const HOME_PREFS = LOCAL_PREFS[3];

function lastReviews(): number {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(HOME_PREFS) ?? '{}');
    const n = v && typeof v === 'object' ? (v as {reviews?: unknown}).reviews : undefined;
    return typeof n === 'number' && n > 0 ? Math.min(Math.round(n), ROWS) : 0;
  } catch {
    return 0;
  }
}

function rememberReviews(n: number): void {
  try {
    localStorage.setItem(HOME_PREFS, JSON.stringify({reviews: Math.min(n, ROWS)}));
  } catch {
    // Blocked storage must not interrupt dashboard rendering.
  }
}

/** Show offline status instead of an endless placeholder when review requests cannot load. */
const ReviewPlaceholder = observer(function ReviewPlaceholder({rows, min = 0}: {rows: number; min?: number}) {
  const {data} = useSession();
  if (reach(data.status.connection) !== 'online') {
    return rows ? (
      <DashboardSection label="Review requested" title={<><EyeIcon size={16}/><span className="text-default">Review requested</span></>}>
        <DenseRow role="presentation" leading={<CloudOfflineIcon size={16}/>}><span className="text-muted">Review requests load when you are online.</span></DenseRow>
      </DashboardSection>
    ) : null;
  }
  rows = Math.max(rows, min);
  if (!rows) return null;
  return (
    <DashboardSection label="Review requested" title={<><EyeIcon size={16}/><span className="text-default">Review requested</span></>}>
      {Array.from({length: rows}, (_, i) => (
        <DenseRow key={i} role="presentation" leading={<SkeletonBox className="size-4"/>} trailing={<SkeletonBox className="h-3 w-12"/>}><SkeletonBox className="h-3 w-64"/></DenseRow>
      ))}
    </DashboardSection>
  );
});

/** Review requests are not synced and require the server list. */
const ReviewRequests = observer(function ReviewRequests() {
  const pool = usePool();
  const overlay = useOverlay();
  const list = useListModel(REVIEWS, {}, 'none');
  const items = list.result.get().ids.map((id) => pool.model('Issue').get(id))
    .filter((i): i is Entity<'Issue'> => i !== undefined && issueState(overlay, i) === 'open').map(updated).sort(byTime);
  const answered = list.serverAnswered;
  useEffect(() => {
    if (answered) rememberReviews(items.length);
  }, [answered, items.length]);
  if (!answered && !items.length) return <ReviewPlaceholder rows={lastReviews()} min={1}/>;
  if (!items.length) return null;
  return <Section title="Review requested" icon={EyeIcon} items={items} all="/pulls?type=review_requested"/>;
});

interface SectionProps {
  title: string;
  icon: OcticonType;
  items: Item[];
  all?: string | undefined;
}

function Section({title, icon: SectionIcon, items, all}: SectionProps) {
  const app = useApp();
  const click = useLinkClick();
  const href = all && hrefOf(app, all);
  return (
    <DashboardSection label={title}
      title={<><SectionIcon size={16}/><span className="text-default">{title}</span><CounterLabel>{items.length}</CounterLabel></>}
      actions={href && <LinkButton variant="invisible" size="small" href={href} onClick={(e) => click(e, href)}>View all</LinkButton>}>
      {items.slice(0, ROWS).map((x) => (x.issue ?
        <Row key={x.issue.id} issue={x.issue} at={x.at}/> :
        x.note && <NoteRow key={`n${String(x.note.id)}`} note={x.note} at={x.at}/>))}
    </DashboardSection>
  );
}

const Row = observer(function Row({issue, at}: {issue: Entity<'Issue'>; at: string}) {
  const app = useApp();
  const pool = usePool();
  const click = useLinkClick();
  const path = issuePath(app, issue);
  const href = path && hrefOf(app, path);
  const repo = pool.model('Repository').get(issue.get('repo_id'))?.get('full_name') ?? '';
  return (
    <DenseRow role={undefined} href={href} onClick={(e) => {
      if (href) click(e, href);
    }} leading={<StateIcon issue={issue}/>} trailing={<>
      <PendingCell issueId={issue.id}/>
      <RefCell repo={repo} number={issue.id > 0 ? issue.get('number') : undefined}/>
      <AgoCell at={at}/>
    </>}>
      <TitleCell issue={issue}/>
    </DenseRow>
  );
});

const NoteRow = observer(function NoteRow({note, at}: {note: Entity<'Notification'>; at: string}) {
  const app = useApp();
  const click = useLinkClick();
  const s = subjectOf(app, note.data);
  const href = s && hrefOf(app, subjectPath(s));
  return (
    <DenseRow role={undefined} href={href} onClick={(e) => {
      if (href) click(e, href);
    }} leading={s ? <StateGlyph look={stateLook(s.state === 'open' ? 'open' : 'closed', s.pull, s.state === 'merged')}/> : <InboxIcon size={16} className="shrink-0"/>} trailing={<>
      {s && <RefCell repo={`${s.owner}/${s.repo}`} number={s.number}/>}
      <AgoCell at={at}/>
    </>}>
      {s ? s.title : <SkeletonBox className="h-3 w-64"/>}
    </DenseRow>
  );
});

function Hints() {
  return (
    <>
      Jump anywhere with <KeybindingHint keys={shortcutHint('palette.open')}/>. <KeybindingHint keys={shortcutHint('go.issues')}/> opens your
      issues, <KeybindingHint keys={shortcutHint('go.pulls')}/> your pull requests, <KeybindingHint keys={shortcutHint('go.inbox')}/> the inbox,{' '}
      <KeybindingHint keys={shortcutHint('go.board')}/> your board; <KeybindingHint keys={shortcutHint('create')}/> creates an issue.
    </>
  );
}

function Welcome() {
  const {ui, config} = useApp();
  return (
    <Blankslate spacious><Blankslate.Visual><CommandPaletteIcon size={24}/></Blankslate.Visual><Blankslate.Heading>{config.app_name}</Blankslate.Heading><Blankslate.Description>{<Hints/>}</Blankslate.Description>{<Tooltip text={'Search repositories, issues and commands'} keybindingHint={shortcutHint('palette.open')}><Button variant="primary" type="button" onClick={() => {
          runInAction(() => {
            ui.paletteOpen = true;
          });
        }}>Open the command menu</Button></Tooltip>}</Blankslate>
  );
}
