// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {readJson, STORAGE_PREFIX, writeJson} from '../../app/storage.ts';
import {computed, type IComputedValue, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {useEffect, useMemo} from 'react';
import {sitePath} from '../../app/config.ts';
import {useLinkClick, useSiteLink} from '../../app/links.ts';
import {reach} from '../../app/online.ts';
import {PageColumn} from '../../app/shell/Frame.tsx';
import {shortcutHint} from '../../app/shortcuts/index.ts';
import {type App, useApp, useSession} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import type {Pool} from '../../data/pool.ts';
import type {Overlay} from '../../intents/overlay.ts';
import {issueState, notificationStatus} from '../../intents/view.ts';
import {BorderBox} from '../../components/BorderBox.tsx';
import {IssueReference} from '../../components/IssueReference.tsx';
import {ListRow} from '../../components/ListRow.tsx';
import {useRowKeys} from '../../components/rowKeys.ts';
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
import {CounterLabel, LinkButton} from '@primer/react';
import {Blankslate, KeybindingHint, SkeletonBox} from '@primer/react/experimental';
import {EmptyState} from '../../components/EmptyState.tsx';

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

const sameItems = (a: readonly Item[], b: readonly Item[]) => a.length === b.length && a.every((x, i) => x.issue === b[i]?.issue && x.note === b[i]?.note && x.at === b[i]?.at);

/** Each section is its own cached computed, so a change re-renders only the section it alters. */
class DashboardModel {
  readonly unread: IComputedValue<Item[]>;
  readonly assigned: IComputedValue<Item[]>;
  readonly mine: IComputedValue<Item[]>;
  readonly pending: IComputedValue<Item[]>;
  readonly empty: IComputedValue<boolean>;

  constructor(app: App, me: number, pool: Pool, overlay: Overlay) {
    const issues = pool.model('Issue');
    const open = (i: Entity<'Issue'> | undefined): i is Entity<'Issue'> => i !== undefined && issueState(overlay, i) === 'open';
    this.unread = computed(() => [...pool.model('Notification').all()].filter((n) => notificationStatus(overlay, n) === 'unread')
      .map((n): Item => {
        const issue = issues.get(n.get('issue_id'));
        return {issue, note: n, at: activityOf(n.data, issue?.get('updated_at') ?? knownSubject(app, n.id)?.updated)};
      }).sort(byTime), {equals: sameItems});
    this.assigned = computed(() => [...new Set([...pool.model('IssueAssignee').by('assignee_id', me)].map((a) => a.get('issue_id')))]
      .map((id) => issues.get(id)).filter(open).map(updated).sort(byTime), {equals: sameItems});
    this.mine = computed(() => [...issues.by('poster_id', me)].filter((i) => i.get('is_pull') && open(i)).map(updated).sort(byTime), {equals: sameItems});
    this.pending = computed(() => (overlay.created('Issue') as Entity<'Issue'>[]).map((issue) => ({issue, at: issue.get('created_at')})).sort(byTime), {equals: sameItems});
    this.empty = computed(() => !this.unread.get().length && !this.assigned.get().length && !this.mine.get().length && !this.pending.get().length);
  }
}

export default observer(function Dashboard() {
  const app = useApp();
  const {userId: me, auth, data} = useSession();
  const settled = settledOnce || (data.workspace.current !== undefined && data.status.loading === 0);
  if (settled) settledOnce = true;
  const pool = usePool();
  const overlay = useOverlay();
  const model = useMemo(() => new DashboardModel(app, me, pool, overlay), [app, me, pool, overlay]);
  const keys = useRowKeys();
  if (!settled) return <HomeSkeleton/>;
  return (
    <div className="contents" {...keys}><PageColumn>
      <ListSection title="Not synced yet" icon={UploadIcon} items={model.pending}/>
      {/* Reserve the previous review-list height to avoid shifting sections when the authenticated answer arrives. */}
      {auth.status.state === 'ok' ? <ReviewRequests/> : <ReviewPlaceholder rows={lastReviews()}/>}
      <ListSection title="Unread" icon={InboxIcon} items={model.unread} all="/notifications?filter=unread"/>
      <ListSection title="Assigned to you" icon={IssueOpenedIcon} items={model.assigned} all="/issues?type=assigned"/>
      <ListSection title="Your pull requests" icon={GitPullRequestIcon} items={model.mine} all="/pulls?type=created_by"/>
      <Footer empty={model.empty}/>
      <Feed/>
    </PageColumn></div>
  );
});

const ListSection = observer(function ListSection({items, ...rest}: Omit<SectionProps, 'items'> & {items: IComputedValue<Item[]>}) {
  const list = items.get();
  return list.length ? <Section {...rest} items={list}/> : null;
});

const Footer = observer(function Footer({empty}: {empty: IComputedValue<boolean>}) {
  return empty.get() ? <Welcome/> : <p className="text-sm text-muted"><Hints/></p>;
});

const byTime = (a: Item, b: Item) => b.at.localeCompare(a.at);
const updated = (issue: Entity<'Issue'>): Item => ({issue, at: issue.get('updated_at')});

const HOME_PREFS = `${STORAGE_PREFIX}home`;

function lastReviews(): number {
  const v = readJson(HOME_PREFS);
  const n = v && typeof v === 'object' ? (v as {reviews?: unknown}).reviews : undefined;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), ROWS) : 0;
}

function rememberReviews(n: number): void {
  writeJson(HOME_PREFS, {reviews: Math.min(n, ROWS)});
}

/** Show offline status instead of an endless placeholder when review requests cannot load. */
const ReviewPlaceholder = observer(function ReviewPlaceholder({rows, min = 0}: {rows: number; min?: number}) {
  const {data} = useSession();
  if (reach(data.status.connection) !== 'online') {
    return rows ? (
      <BorderBox label="Review requested" title={<><EyeIcon size={16}/>Review requested</>}>
        <ListRow role="presentation" leading={<CloudOfflineIcon size={16}/>}><span className="text-muted">Review requests load when you are online.</span></ListRow>
      </BorderBox>
    ) : null;
  }
  rows = Math.max(rows, min);
  if (!rows) return null;
  return (
    <BorderBox label="Review requested" title={<><EyeIcon size={16}/>Review requested</>}>
      {Array.from({length: rows}, (_, i) => (
        <ListRow key={i} role="presentation" leading={<SkeletonBox className="size-4"/>} trailing={<SkeletonBox className="h-3 w-12"/>}><SkeletonBox className="h-3 w-64"/></ListRow>
      ))}
    </BorderBox>
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
  const href = all && sitePath(app.config, all);
  return (
    <BorderBox label={title}
      title={<><SectionIcon size={16}/>{title}<CounterLabel>{items.length}</CounterLabel></>}
      actions={href && <LinkButton variant="invisible" size="small" href={href} onClick={(e) => click(e, href)}>View all</LinkButton>}>
      {items.slice(0, ROWS).map((x) => (x.issue ?
        <Row key={x.issue.id} issue={x.issue} at={x.at}/> :
        x.note && <NoteRow key={`n${String(x.note.id)}`} note={x.note} at={x.at}/>))}
    </BorderBox>
  );
}

const Row = observer(function Row({issue, at}: {issue: Entity<'Issue'>; at: string}) {
  const app = useApp();
  const pool = usePool();
  const link = useSiteLink();
  const path = issuePath(app, issue);
  const repo = pool.model('Repository').get(issue.get('repo_id'))?.get('full_name') ?? '';
  return (
    <ListRow {...(path ? link(sitePath(app.config, path)) : {})} leading={<StateIcon issue={issue}/>} trailing={<>
      <PendingCell issueId={issue.id}/>
      <IssueReference repo={repo} number={issue.id > 0 ? issue.get('number') : undefined}/>
      <AgoCell at={at}/>
    </>}>
      <TitleCell issue={issue}/>
    </ListRow>
  );
});

const NoteRow = observer(function NoteRow({note, at}: {note: Entity<'Notification'>; at: string}) {
  const app = useApp();
  const link = useSiteLink();
  const s = subjectOf(app, note.data);
  return (
    <ListRow {...(s ? link(sitePath(app.config, subjectPath(s))) : {})} leading={s ? <StateGlyph look={stateLook(s.state === 'open' ? 'open' : 'closed', s.pull, s.state === 'merged')}/> : <InboxIcon size={16} className="shrink-0"/>} trailing={<>
      {s && <IssueReference repo={`${s.owner}/${s.repo}`} number={s.number}/>}
      <AgoCell at={at}/>
    </>}>
      {s ? s.title : <SkeletonBox className="h-3 w-64"/>}
    </ListRow>
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
    <EmptyState icon={CommandPaletteIcon} title={config.app_name} description={<Hints/>} action={<Blankslate.PrimaryAction type="button" onClick={() => {
      runInAction(() => {
        ui.paletteOpen = true;
      });
    }}>Open the command menu</Blankslate.PrimaryAction>}/>
  );
}
