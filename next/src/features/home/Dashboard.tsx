// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Home's content (its own chunk: the boot route renders the header at once
// and this right after): what is waiting for the viewer, from the pool —
// reviews requested, unread notifications, open issues assigned to them,
// their open pull requests, and issues created on this device that Forgejo
// does not have yet. Each section is a short list of links with a way to
// the full list; empty sections are left out. Only the review requests ask
// the server (they are not synced), as My pull requests does.

import {Command, GitPullRequest, Inbox, Eye, CircleDot, CloudOff, CloudUpload} from 'lucide-react';
import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {useEffect} from 'react';
import {hrefOf, useLinkClick} from '../../app/links.ts';
import {reach} from '../../app/online.ts';
import {LOCAL_PREFS} from '../../app/splash.ts';
import {PageColumn} from '../../app/shell/Frame.tsx';
import {shortcutHint} from '../../app/shortcuts/index.ts';
import {useApp, useSession} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import {editing} from '../../intents/session.ts';
import {issueState, notificationStatus} from '../../intents/view.ts';
import {Button, EmptyState, Icon, ListRow, type LucideIcon, Panel, Shortcut, Skeleton} from '../../ui/index.ts';
import {activityOf} from '../inbox/inbox.ts';
import {AgoCell, PendingCell, RefCell, StateGlyph, StateIcon, stateLook, TitleCell, useOverlay, usePool} from '../issues/cells.tsx';
import {knownSubject, subjectOf, subjectPath} from '../inbox/subject.ts';
import {issuePath} from '../issues/edits.ts';
import type {ListSource} from '../issues/list.ts';
import {useListModel} from '../issues/ListPage.tsx';
import {HomeSkeleton} from './Home.tsx';

/** Rows per section at most (the full list is a click away). */
const ROWS = 6;

const REVIEWS: ListSource = {kind: 'my', pulls: true, type: 'review_requested'};

interface Item {
  /** The issue; undefined for a notification whose issue is not on this device (`note`). */
  issue?: Entity<'Issue'> | undefined;
  note?: Entity<'Notification'> | undefined;
  /** The time shown (activity). */
  at: string;
}

/**
 * Whether this tab has shown Home's content once. Until then (a device's first sync: the workspace and its groups
 * arrive group by group) Home stays on its placeholders and then appears once, complete — not section by
 * section with counts that jump and rows that reorder (QA round 2). A device with data shows it at once.
 */
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

  // Every unread notification (the sidebar's count), those about an issue not on this device too.
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
    {title: 'Unread', icon: Inbox, items: unread, all: '/notifications?filter=unread'},
    {title: 'Assigned to you', icon: CircleDot, items: assigned, all: '/issues?type=assigned'},
    {title: 'Your pull requests', icon: GitPullRequest, items: mine, all: '/pulls?type=created_by'},
  ].filter((x) => x.items.length);
  return (
    <PageColumn>
      {pending.length > 0 && <Section title="Not synced yet" icon={CloudUpload} items={pending}/>}
      {/* Asked once the session holds a token (the server is asked as the signed-in user); its place is kept
          from the first frame, as tall as it was last time (nothing below moves when it arrives). */}
      {auth.status.state === 'ok' ? <ReviewRequests/> : <ReviewPlaceholder rows={lastReviews()}/>}
      {sections.map((x) => <Section key={x.title} {...x}/>)}
      {sections.length || pending.length ? <p className="text-sm text-fg-subtle"><Hints/></p> : <Welcome/>}
    </PageColumn>
  );
});

const byTime = (a: Item, b: Item) => b.at.localeCompare(a.at);
const updated = (issue: Entity<'Issue'>): Item => ({issue, at: issue.get('updated_at')});

const HOME_PREFS = LOCAL_PREFS[3];

/** How many review requests Home showed last time on this device (the placeholder's rows); 0 when unknown. */
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
    // Storage blocked: the next placeholder is one row.
  }
}

/**
 * Review requested while Forgejo is asked: its title and as many placeholder rows as it had last time (at least
 * `min`). Offline (or Forgejo not answering) the list cannot be asked: it says so where it was, rather than being
 * left out silently or waiting on placeholders.
 */
const ReviewPlaceholder = observer(function ReviewPlaceholder({rows, min = 0}: {rows: number; min?: number}) {
  const {data} = useSession();
  if (reach(data.status.connection) !== 'online') {
    return rows ? (
      <Panel label="Review requested" title={<><Icon icon={Eye} size="sm"/><span className="text-fg">Review requested</span></>}>
        <ListRow role="presentation" leading={<Icon icon={CloudOff} size="sm"/>}><span className="text-fg-muted">Review requests load when you are online.</span></ListRow>
      </Panel>
    ) : null;
  }
  rows = Math.max(rows, min);
  if (!rows) return null;
  return (
    <Panel label="Review requested" title={<><Icon icon={Eye} size="sm"/><span className="text-fg">Review requested</span></>}>
      {Array.from({length: rows}, (_, i) => (
        <ListRow key={i} role="presentation" leading={<Skeleton className="size-4"/>} trailing={<Skeleton className="h-3 w-12"/>}><Skeleton className="h-3 w-64"/></ListRow>
      ))}
    </Panel>
  );
});

/** Review requests are not synced: the same live list as My pull requests > Review requested (the server names them). */
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
  // Its place is kept while the server is asked: the sections below do not move when it arrives.
  if (!answered && !items.length) return <ReviewPlaceholder rows={lastReviews()} min={1}/>;
  if (!items.length) return null;
  return <Section title="Review requested" icon={Eye} items={items} all="/pulls?type=review_requested"/>;
});

interface SectionProps {
  title: string;
  icon: LucideIcon;
  items: Item[];
  /** The full list. */
  all?: string | undefined;
}

function Section({title, icon, items, all}: SectionProps) {
  const app = useApp();
  const click = useLinkClick();
  const href = all && hrefOf(app, all);
  return (
    <Panel label={title}
      title={<><Icon icon={icon} size="sm"/><span className="text-fg">{title}</span><span className="tabular-nums">{items.length}</span></>}
      actions={href && <Button size="sm" variant="ghost" asChild><a href={href} onClick={(e) => click(e, href)}>View all</a></Button>}>
      {items.slice(0, ROWS).map((x) => (x.issue ?
        <Row key={x.issue.id} issue={x.issue} at={x.at}/> :
        x.note && <NoteRow key={`n${String(x.note.id)}`} note={x.note} at={x.at}/>))}
    </Panel>
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
    <ListRow role={undefined} href={href} onClick={(e) => {
      if (href) click(e, href);
    }} leading={<StateIcon issue={issue}/>} trailing={<>
      <PendingCell issueId={issue.id}/>
      <RefCell repo={repo} number={issue.id > 0 ? issue.get('number') : undefined}/>
      <AgoCell at={at}/>
    </>}>
      <TitleCell issue={issue}/>
    </ListRow>
  );
});

/** An unread notification whose issue is not on this device: what the server says it is (inbox/subject.ts). */
const NoteRow = observer(function NoteRow({note, at}: {note: Entity<'Notification'>; at: string}) {
  const app = useApp();
  const click = useLinkClick();
  const s = subjectOf(app, note.data);
  const href = s && hrefOf(app, subjectPath(s));
  return (
    <ListRow role={undefined} href={href} onClick={(e) => {
      if (href) click(e, href);
    }} leading={s ? <StateGlyph look={stateLook(s.state === 'open' ? 'open' : 'closed', s.pull, s.state === 'merged')}/> : <Icon icon={Inbox}/>} trailing={<>
      {s && <RefCell repo={`${s.owner}/${s.repo}`} number={s.number}/>}
      <AgoCell at={at}/>
    </>}>
      {/* Its subject is asked of the server (once): a placeholder line meanwhile, never a row without a title. */}
      {s ? s.title : <Skeleton className="h-3 w-64"/>}
    </ListRow>
  );
});

/** The ways to get anywhere from the keyboard. */
function Hints() {
  return (
    <>
      Jump anywhere with <Shortcut keys={shortcutHint('palette.open')}/>. <Shortcut keys={shortcutHint('go.issues')}/> opens your
      issues, <Shortcut keys={shortcutHint('go.pulls')}/> your pull requests, <Shortcut keys={shortcutHint('go.inbox')}/> the inbox,{' '}
      <Shortcut keys={shortcutHint('go.board')}/> your board; <Shortcut keys={shortcutHint('create')}/> creates an issue.
    </>
  );
}

/** Nothing waiting: a calm starting point. */
function Welcome() {
  const {ui, config} = useApp();
  return (
    <EmptyState icon={Command} title={config.app_name} description={<Hints/>}
      action={
        <Button variant="primary" shortcut={shortcutHint('palette.open')} tooltip="Search repositories, issues and commands" onClick={() => {
          runInAction(() => {
            ui.paletteOpen = true;
          });
        }}>Open the command menu</Button>
      }/>
  );
}
