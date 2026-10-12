// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Code views load separately. Reviews and viewed files use offline intents pinned to the displayed head;
// merge, branch updates and auto-merge are online-only and never queued.

import {PageColumn} from '../../app/shell/Frame.tsx';
import {observer} from 'mobx-react-lite';
import {useLocation} from '@tanstack/react-router';
import {Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {canWrite} from '../../app/access.ts';
import {failureText, online, refused} from '../../app/api.ts';
import {uuid} from '../../intents/intents.ts';
import {notify} from '../../app/notices.ts';
import {onlineOnly, reach} from '../../app/online.ts';
import {useHold} from '../../app/repo.ts';
import {shortcutHint, useShortcut} from '../../app/shortcuts/index.ts';
import {useApp, useSession} from '../../app/store.ts';
import {anchor, type Anchor, commentAnchor, lineAnchor, lineKey} from '../../code/anchor.ts';
import {DEL, type DiffFile, filePath} from '../../code/diff.ts';
import {fetchCommits, poolCommits, poolHead, pullOf, type PullCommits} from '../../code/pull.ts';
import {shortSha} from '../../code/refs.ts';
import {partition, type ReviewDraft, reviewDrafts, reviewVerdicts, type ReviewEvent, saveDraft, submitReview} from '../../code/review.ts';
import {type CommitInfo, type CompareInfo, NotCached} from '../../code/source.ts';
import {newestState, viewedAt, viewedMarks} from '../../code/viewed.ts';
import type {Entity} from '../../data/entity.ts';
import {editing, notifyQueued} from '../../intents/session.ts';
import {issueTitle} from '../../intents/view.ts';
import {DraftControl} from './DraftControl.tsx';
import {ConflictHelp} from './ConflictHelp.tsx';
import {draftPrefix, wipPrefixes} from './draft.ts';
import {commitsSince, type DiffRange, lastReviewCommit, rangeCommits} from './range.ts';
import type {Comment, PullRequest} from '../../protocol/types.gen.ts';
import {DiffStat} from '../../code/parts.tsx';
import {MarkdownField, MarkdownPreview} from '../editor/Composer.tsx';
import {hasPendingUploads} from '../editor/attachments.ts';
import {CommentCard as PostedCommentCard} from '../issue/Timeline.tsx';
import {usePool} from '../issues/cells.tsx';
import {agoWords, fullDate} from '../issues/format.ts';
import {runLook, statusLook, statusTime} from '../code/Actions.tsx';
import {RunControls} from '../code/RunControls.tsx';
import {checksOf, cleanDescription, latestStatuses, unfinishedChecks} from './checks.ts';
import {ApprovalPanel, useMergeCheck} from './Approval.tsx';
import {bumpMergeCheck, protectionWhy} from './mergeCheck.ts';
import {mergedMeanwhile} from './merged.ts';
import {deleteBranch} from '../code/refOps.ts';
import {mergeOptions} from './mergeStyles.ts';
import {pullSettingsOf} from '../settings/forms.ts';
import {type DiffExtras, type DiffHandle, DiffView} from '../code/DiffView.tsx';
import {DiffSettings, useDiffSettings} from '../code/DiffSettings.tsx';
import {useDiff} from '../code/History.tsx';
import {Ago, commitRow, Sha} from '../code/bits.tsx';
import {withChecks} from '../code/commitChecks.tsx';
import {useLoad, useSource} from '../code/hooks.ts';
import {CodeLink, useCodeRows} from '../code/nav.tsx';
import {RowList} from '../code/RowList.tsx';
import {Unloaded} from '../code/states.tsx';
import {conversationRoot, ResolveButton, ResolvedFold, useResolver} from './resolve.tsx';
import {ClockIcon, XCircleIcon, CheckIcon, ChevronDownIcon, CheckCircleIcon, EyeIcon, FileDiffIcon, GitMergeIcon, GitPullRequestIcon, CommentIcon, SidebarExpandIcon, SidebarCollapseIcon, PencilIcon, ReplyIcon, TrashIcon, WorkflowIcon} from '@primer/octicons-react';
import {Button as PrimerButton, IconButton, ActionMenu, ActionList, Label, Link as PrimerLink, Dialog as PrimerDialog, Checkbox, FormControl, TextInput, Textarea} from '@primer/react';
import {Banner, BranchName, ButtonGroup, Heading, SegmentedControl, Tooltip} from '@primer/react';
import {Blankslate} from '@primer/react/experimental';
import {RouterLink} from '../../app/routerLinks.tsx';

function CheckMark({tone}: {tone: string}) {
  const color = tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-attention' : 'text-muted';
  const Icon = tone === 'success' ? CheckCircleIcon : tone === 'danger' ? XCircleIcon : ClockIcon;
  return <span className={`flex shrink-0 ${color}`}><Icon size={16}/></span>;
}

export type PullTabName = 'files' | 'commits' | 'checks';

interface TabProps {
  issue: Entity<'Issue'>;
  owner: string;
  repo: string;
}

/** Cache API commit results as offline hints when the pool lacks them. */
function usePullCommits(issue: Entity<'Issue'>): {pr: PullRequest | undefined; commits: PullCommits | undefined; loading: ReturnType<typeof useLoad<PullCommits>>} {
  const pool = usePool();
  const app = useApp();
  const src = useSource();
  const pr = pullOf(pool, issue.id);
  const fromPool = pr ? poolCommits(pool, pr, issue.get('state') === 'open') : undefined;
  const loading = useLoad<PullCommits>(pr && !fromPool ? `prhint:${String(pr.id)}:${pr.merge_base}` : undefined, () => undefined, async () => {
    const c = pr ? await fetchCommits(app, src, pr) : undefined;
    if (!c) throw new NotCached('the head commit is not known on this device');
    return c;
  });
  return {pr, commits: fromPool ?? (loading.state === 'ready' ? loading.value : undefined), loading};
}

export const PullTab = observer(function PullTab({tab, ...props}: TabProps & {tab: PullTabName}) {
  const {pr, commits, loading} = usePullCommits(props.issue);
  if (!pr) return <Blankslate><Blankslate.Visual><GitPullRequestIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Not on this device</Blankslate.Heading><Blankslate.Description>This pull request's details have not arrived yet.</Blankslate.Description></Blankslate>;
  if (!commits) return <Unloaded loaded={loading.state === 'ready' ? {state: 'loading'} : loading} what="This pull request's head"/>;
  switch (tab) {
    case 'files':
      return <FilesTab {...props} pr={pr} commits={commits}/>;
    case 'commits':
      return <CommitsTab {...props} pr={pr} commits={commits}/>;
    case 'checks':
      return <ChecksTab {...props} pr={pr} commits={commits}/>;
  }
});


type Item = {kind: 'comment'; c: Comment; pending: boolean} | {kind: 'draft'; d: ReviewDraft};

const composerKey = (c: Composing) => `${String(c.f)}:${String(c.l)}:${c.key ?? ''}`;

const itemAnchor = (it: Item): Anchor => (it.kind === 'draft' ? it.d.anchor : commentAnchor(it.c));

/** Keep composer text outside virtualized threads so unmounts and head changes cannot lose it. */
interface Composing {
  f: number;
  l: number;
  key?: string | undefined;
  initial: string;
  start?: number;
}

const ALL: DiffRange = {kind: 'all'};

const FilesTab = observer(function FilesTab({issue, owner, repo, pr, commits}: TabProps & {pr: PullRequest; commits: PullCommits}) {
  const {whitespace} = useDiffSettings();
  const pool = usePool();
  const {userId: me} = useSession();
  const [range, setRange] = useState<DiffRange>(ALL);
  const lastReview = lastReviewCommit([...pool.model('Review').by('issue_id', issue.id)].map((r) => r.data), me, commits.head);
  useEffect(() => {
    if (range.kind === 'review' && range.base !== lastReview) setRange(lastReview ? {kind: 'review', base: lastReview} : ALL);
  }, [range, lastReview]);
  const {base, to} = rangeCommits(range, commits);
  const diff = useDiff(pr.base_repo_id, base, to);
  // Retain the displayed diff on head updates to preserve an in-progress review until the replacement arrives.
  const [shown, setShown] = useState<{commits: PullCommits; files: DiffFile[]; whitespace: string; range: DiffRange; base: string; to: string}>();
  if (diff.state === 'ready' && shown?.files !== diff.value) setShown({commits, files: diff.value, whitespace, range, base, to});
  const view = diff.state === 'ready' ? {commits, files: diff.value, range, base, to} : shown;
  const unavailable = diff.state !== 'ready' && (shown?.whitespace !== whitespace || shown.range !== range);
  return <>
    {(!view || unavailable) && <>
      <DiffSettings/>
      <Unloaded loaded={diff.state === 'ready' ? {state: 'loading'} : diff} what="This pull request's changes"/>
      {range.kind !== 'all' && <div className="flex justify-center"><PrimerButton size="small" type="button" onClick={() => {
        setRange(ALL);
      }}>Show all changes</PrimerButton></div>}
    </>}
    {view && <div className={unavailable ? 'hidden' : 'contents'}>
      <ReviewDiff issue={issue} owner={owner} repo={repo} pr={pr} commits={view.commits} files={view.files} range={view.range} base={view.base} to={view.to}
        lastReview={lastReview} onRange={setRange}/>
    </div>}
  </>;
});

/** Viewed state is relative to the displayed head; changed files invalidate older viewed marks. */
function useViewed(issueId: number, pr: PullRequest, head: string, me: number) {
  const pool = usePool();
  const app = useApp();
  const src = useSource();
  const {overlay} = editing(app);
  const state = newestState([...pool.model('ReviewState').by('pull_id', pr.id)].map((e) => e.data), me);
  const stale = state && state.commit_sha !== head ? state.commit_sha : undefined;
  const key = stale ? `viewedchg:${String(pr.base_repo_id)}:${String(pr.id)}:${stale}:${head}` : undefined;
  const changed = useLoad<string[]>(key, () => (key ? src.peek<string[]>(key) : undefined), async () => {
    const v = await online<{files?: Record<string, string>}>(app, {api: 'sync', path: `/issues/${String(issueId)}/viewed?head=${head}`});
    const list = Object.entries(v?.files ?? {}).filter(([, s]) => s === 'has_changed').map(([p]) => p);
    if (key) src.cache.put(key, list);
    return list;
  });
  const changedSet = changed.state === 'ready' ? new Set(changed.value) : undefined;
  return {...viewedAt(state, head, changedSet, overlay.members('ViewedFile', issueId)), changed: changedSet};
}

const ReviewDiff = observer(function ReviewDiff({issue, pr, commits, files, range, base, to, lastReview, onRange}: TabProps & {
  pr: PullRequest; commits: PullCommits; files: DiffFile[];
  range: DiffRange; base: string; to: string;
  lastReview: string | undefined; onRange: (range: DiffRange) => void;
}) {
  const app = useApp();
  const pool = usePool();
  const {data, userId: me} = useSession();
  const {intents, overlay} = editing(app);
  useHold(data, `issue:${String(issue.id)}`);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [aside, setAside] = useState<HTMLElement | null>(null);
  const diffRef = useRef<DiffHandle>(null);
  const hash = useLocation({select: (location) => location.hash});
  const jumped = useRef('');
  const [current, setCurrent] = useState(0);
  const [composing, setComposing] = useState<Composing | undefined>();
  const [reviewing, setReviewing] = useState(false);
  const head = commits.head;
  const kept = useRef(new Map<string, string>());
  const keepText = useCallback((k: string, t: string | undefined) => {
    if (t === undefined) kept.current.delete(k);
    else kept.current.set(k, t);
  }, []);
  const keptText = useCallback((k: string) => kept.current.get(k), []);
  // A head change invalidates line numbers; preserve composer text as a draft on its original head.
  const [toggled, setToggled] = useState<ReadonlyMap<number, boolean>>(() => new Map());
  const [composeHead, setComposeHead] = useState(head);
  const [composeFiles, setComposeFiles] = useState(files);
  if (composeHead !== head || composeFiles !== files) {
    setComposeHead(head);
    setComposeFiles(files);
    setComposing(undefined);
    setToggled(new Map()); // by file index: the new diff's files are others
  }
  const before = useRef<{head: string; files: DiffFile[]; composing: Composing | undefined}>(undefined);
  useEffect(() => {
    const prev = before.current;
    before.current = {head, files, composing};
    if (!prev || (prev.head === head && prev.files === files)) return;
    const c = prev.composing;
    const text = c && kept.current.get(composerKey(c));
    const file = c && prev.files[c.f];
    const a = c && file && lineAnchor(file, c.l, prev.head);
    if (c && a && text?.trim()) saveDraft(intents, {issueId: issue.id, repoId: pr.base_repo_id, number: issue.get('number'), anchor: a, text, key: c.key});
    kept.current.clear(); // by line index: the new head's lines are others
  });

  const comments: Item[] = [];
  for (const e of pool.model('Comment').by('issue_id', issue.id)) {
    const c = e.data;
    if (c.type !== 'code') continue;
    const review = c.review_id ? pool.model('Review').get(c.review_id)?.data : undefined;
    comments.push({kind: 'comment', c, pending: review?.state === 'PENDING'});
  }
  const drafts = reviewDrafts(intents, issue.id);
  const items = [...comments, ...drafts.map((d): Item => ({kind: 'draft', d}))];
  const inReview = drafts.length > 0 || comments.some((it) => it.kind === 'comment' && it.pending && it.c.poster_id === me);
  // Other-head drafts cannot use current line numbers; submit them as quoted file notes.
  const outdated = (it: Item) => it.kind === 'draft' || it.c.invalidated;
  // Narrow ranges have different old sides; commit ranges also have non-head new sides. Show unmappable comments as file notes.
  const atHead = to === head;
  const anchored = range.kind === 'all' ? anchor(files, items, itemAnchor, head, outdated) : anchor(files, items, itemAnchor, '', (it) => {
    const a = itemAnchor(it);
    return !atHead || a.side === 'old' || (a.commit !== head && outdated(it));
  });
  const viewedNow = useViewed(issue.id, pr, head, me);
  // Stable sets prevent rebuilding every diff row.
  const viewedSig = `${viewedNow.commit}|${[...viewedNow.paths].sort().join('\0')}|${[...viewedNow.older].sort().join('\0')}|${[...viewedNow.changed ?? []].join('\0')}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed when the signature changes
  const viewed = useMemo(() => viewedNow, [viewedSig]);

  // Collapse viewed files initially, then preserve explicit user toggles.
  const collapsed = useMemo(() => {
    const s = new Set<number>();
    files.forEach((f, i) => {
      if (toggled.get(i) ?? viewed.paths.has(filePath(f))) s.add(i);
    });
    return s;
  }, [files, toggled, viewed.paths]);

  const setViewed = useCallback((f: number, on: boolean) => {
    const file = files[f];
    if (!file) return;
    const marks = viewedMarks(viewed, head, filePath(file), on, overlay.members('ViewedFile', issue.id));
    intents.submit({kind: 'pr.viewed', issueId: issue.id, repoId: pr.base_repo_id, commitSha: head, files: marks});
    setToggled((t) => new Map(t).set(f, on));
  }, [files, intents, overlay, issue.id, pr.base_repo_id, head, viewed]);

  const startComment = useCallback((f: number, l: number, range?: boolean) => {
    setComposing((c) => ({f, l: range && c?.f === f ? Math.max(c.l, l) : l, start: range && c?.f === f ? Math.min(c.start ?? c.l, l) : l, initial: ''}));
  }, []);
  const closeComposer = useCallback(() => {
    setComposing(undefined);
    requestAnimationFrame(() => diffRef.current?.focus());
  }, []);
  const [listOpen, setListOpen] = useState(() => typeof matchMedia !== 'function' || !matchMedia('(max-width: 767.98px)').matches);
  const indexed = useMemo(() => files.map((f, i) => ({f, i})), [files]);

  const threadKeys = new Set(anchored.lines.keys());
  if (composing) threadKeys.add(lineKey(composing.f, composing.l));
  const threadsSig = [...threadKeys].sort().join(',');
  const notesSig = [...anchored.files.keys()].join(',');
  // Ref-backed threads need a signature change for remote edits or review-state updates.
  const itemsSig = items.map((it) => (it.kind === 'comment' ? `${String(it.c.id)}.${String(it.c.content_version)}.${it.c.updated_at}.${String(it.pending)}.${String(it.c.invalidated)}` : `${it.d.key}.${String(it.d.at)}`)).join(',');
  const anchoredRef = useRef(anchored);
  anchoredRef.current = anchored;

  useEffect(() => {
    if (!scroller || !hash.startsWith('review-thread-') || jumped.current === hash) return;
    const id = Number(hash.slice('review-thread-'.length));
    const entry = [...anchored.lines].find(([, list]) => list.some((it) => it.kind === 'comment' && it.c.id === id));
    if (!entry) return;
    const [f, l] = entry[0].split(':').map(Number);
    if (f === undefined || l === undefined) return;
    if (collapsed.has(f)) {
      setToggled((t) => new Map(t).set(f, false));
      return;
    }
    jumped.current = hash;
    requestAnimationFrame(() => {
      diffRef.current?.toLine(f, l);
      diffRef.current?.focus();
    });
  }, [hash, anchored, collapsed, scroller]);

  const extras: DiffExtras = useMemo(() => ({
    threads: new Set(threadsSig ? threadsSig.split(',') : []),
    notes: new Set(notesSig ? notesSig.split(',').map(Number) : []),
    collapsed,
    thread: (f, l) => <Thread issue={issue} pr={pr} f={f} l={l} file={files[f]} head={head} items={anchoredRef.current.lines.get(lineKey(f, l)) ?? []}
      composing={composing?.f === f && composing.l === l ? composing : undefined} setComposing={setComposing} onDone={closeComposer}
      keepText={keepText} keptText={keptText} reviewing={inReview}/>,
    notesOf: (f) => <FileNotes items={anchoredRef.current.files.get(f) ?? []} repoId={pr.base_repo_id}/>,
    // Removed lines in narrow ranges are not on the merge base, so they cannot anchor new comments.
    onComment: atHead ? startComment : undefined,
    commentable: range.kind === 'all' ? undefined : (f, l) => files[f]?.lines[l]?.k !== DEL,
    fileActions: (f) => {
      const path = files[f] ? filePath(files[f]) : '';
      const on = viewed.paths.has(path);
      return (
        <Tooltip text={viewed.older.has(path) ? 'Viewed at an earlier commit (not known whether it changed since)' : on ? 'Mark as not viewed' : 'Mark as viewed'} keybindingHint={shortcutHint('diff.viewed')}><PrimerButton aria-pressed={on} variant={on ? 'default' : 'invisible'} size="small" leadingVisual={on ? CheckIcon : EyeIcon} type="button" onClick={() => {
            setViewed(f, !on);
          }}>Viewed</PrimerButton></Tooltip>
      );
    },
    onToggle: (f) => {
      setToggled((t) => new Map(t).set(f, !collapsed.has(f)));
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [threadsSig, notesSig, collapsed, composing, files, viewed, head, issue, pr, setViewed, startComment, closeComposer, itemsSig, keepText, keptText, inReview, atHead, range.kind]);

  useShortcut('review.start', () => {
    setReviewing(true);
  });
  useShortcut('diff.viewed', () => {
    const f = diffRef.current?.current() ?? current;
    const file = files[f];
    if (file) setViewed(f, !viewed.paths.has(filePath(file)));
  });

  const counts = useMemo(() => {
    const m = new Map<number, number>();
    for (const [k, list] of anchored.lines) {
      const f = Number(k.slice(0, k.indexOf(':')));
      m.set(f, (m.get(f) ?? 0) + list.length);
    }
    return m;
  }, [anchored]);
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);

  return (
    <div className="flex h-full min-h-0">
      {listOpen && (
        <aside ref={setAside} aria-label="Changed files" className="w-pane shrink-0 overflow-y-auto border-r border-default">
          <div className="flex h-control items-center gap-2 px-3 text-sm text-muted tabular-nums">
            <span>{files.length} {files.length === 1 ? 'file' : 'files'}</span>
            <DiffStat additions={additions} deletions={deletions}/>
            <span className="ml-auto">{viewed.paths.size}/{files.length} viewed</span>
          </div>
          <RowList items={indexed} scroller={aside} label="Changed files" keyOf={({f}) => filePath(f)} cursor={current}
            onCursor={(i) => {
              diffRef.current?.toFile(i);
            }}
            row={({f, i}) => {
              const n = counts.get(i);
              return {
                leading: viewed.paths.has(filePath(f)) ? <CheckCircleIcon size={16}/> : <FileDiffIcon size={16}/>,
                main: <span title={filePath(f)}>{filePath(f)}</span>,
                trailing: n ? <span className="flex items-center gap-1"><CommentIcon size={12} className="shrink-0"/>{n}</span> : undefined,
              };
            }}
            onOpen={({i}) => {
              diffRef.current?.toFile(i);
              diffRef.current?.focus();
            }}/>
        </aside>
      )}
      <div ref={setScroller} className="min-w-0 flex-1 overflow-auto">
        <ReviewBar pr={pr} head={head} drafts={drafts} listOpen={listOpen} open={!pr.merged && issue.get('state') === 'open'}
          range={range} base={base} to={to} lastReview={lastReview} onRange={onRange} onList={() => {
          setListOpen((o) => !o);
        }} onReview={() => {
          setReviewing(true);
        }}/>
        {anchored.elsewhere.length > 0 && <div className="sticky left-0 w-view"><FileNotes items={anchored.elsewhere} title="Comments on files not in this diff" repoId={pr.base_repo_id}/></div>}
        <DiffView key={`${base}:${to}`} ref={diffRef} repoId={pr.base_repo_id} base={base} head={to} files={files} scroller={scroller} extras={extras} onFile={setCurrent} underBar/>
      </div>
      <ReviewDialog returnFocus={() => scroller?.querySelector<HTMLButtonElement>('[data-review-button]') ?? null} open={reviewing} onOpenChange={setReviewing} issue={issue} pr={pr} head={head} drafts={drafts}/>
    </div>
  );
});

const ReviewBar = observer(function ReviewBar({pr, head, drafts, listOpen, onList, onReview, open, range, base, to, lastReview, onRange}: {
  pr: PullRequest; head: string; drafts: ReviewDraft[]; listOpen: boolean; onList: () => void; onReview: () => void; open: boolean;
  range: DiffRange; base: string; to: string; lastReview: string | undefined; onRange: (range: DiffRange) => void;
}) {
  return (
    <div data-sticky-bar className="sticky top-0 left-0 z-sticky flex h-control w-view items-center gap-2 border-b border-muted bg-default px-3 text-sm text-muted">
      <IconButton icon={listOpen ? SidebarExpandIcon : SidebarCollapseIcon} variant="invisible" size="small" aria-label={listOpen ? 'Hide the file list' : 'Show the file list'} type="button" onClick={onList}/>
      <RangeMenu pr={pr} head={head} range={range} base={base} to={to} lastReview={lastReview} onRange={onRange}/>
      {drafts.length > 0 && <Label variant="accent">{drafts.length} pending {drafts.length === 1 ? 'comment' : 'comments'}</Label>}
      <DiffSettings/>
      {open && <span className="ml-auto"><Tooltip text={'Submit a review (works offline: sent when you are back)'} keybindingHint={shortcutHint('review.start')}><PrimerButton variant="primary" size="small" type="button" data-review-button onClick={onReview}>Review</PrimerButton></Tooltip></span>}
    </div>
  );
});

const rangeValue = (r: DiffRange) => (r.kind === 'commit' ? `commit:${r.sha}` : r.kind);

function RangeMenu({pr, head, range, base, to, lastReview, onRange}: {
  pr: PullRequest; head: string; range: DiffRange; base: string; to: string; lastReview: string | undefined; onRange: (range: DiffRange) => void;
}) {
  const [menu, setMenu] = useState(false);
  const label = range.kind === 'all' ? 'All changes' : range.kind === 'review' ? 'Changes since your last review' : 'Changes in one commit';
  return (
    <span className="truncate-button-label min-w-0">
    <ActionMenu open={menu} onOpenChange={setMenu}>
      <ActionMenu.Anchor><PrimerButton block size="small" variant="invisible" className="min-w-0" trailingVisual={ChevronDownIcon} aria-label={`${label}: choose the changes shown`}>
          {label} <span className="text-sm text-muted">{base ? <><Sha sha={base}/> → </> : null}<Sha sha={to}/></span>
        </PrimerButton></ActionMenu.Anchor>
      <ActionMenu.Overlay><ActionList>
        <ActionList.Group selectionVariant="single">
          <ActionList.Item selected={rangeValue(range) === 'all'} onSelect={() => {onRange({kind: 'all'});}}>All changes <span className="text-muted"><Sha sha={pr.merge_base}/> → <Sha sha={head}/></span></ActionList.Item>
          {(lastReview ?? range.kind === 'review') && <ActionList.Item disabled={!lastReview} selected={rangeValue(range) === 'review'} onSelect={() => {if (lastReview) onRange({kind: 'review', base: lastReview});}}>Changes since your last review</ActionList.Item>}
          {menu && <RangeCommits pr={pr} base={pr.merge_base} head={head} lastReview={lastReview} range={range} onRange={onRange}/>}
        </ActionList.Group>
      </ActionList></ActionMenu.Overlay>
    </ActionMenu>
    </span>
  );
}

function RangeCommits({pr, base, head, lastReview, range, onRange}: {pr: PullRequest; base: string; head: string; lastReview: string | undefined; range: DiffRange; onRange: (range: DiffRange) => void}) {
  const src = useSource();
  const key = `compare:${String(pr.base_repo_id)}:${base}:${head}`;
  const info = useLoad(key, () => src.peek<CompareInfo>(key), () => src.compare(pr.base_repo_id, base, head));
  if (info.state !== 'ready') return <ActionList.GroupHeading>{info.state === 'loading' ? 'Loading the commits…' : 'The commits are not available'}</ActionList.GroupHeading>;
  const since = lastReview ? commitsSince(info.value.commits, head, lastReview) : undefined;
  return <>
    {since !== undefined && <ActionList.GroupHeading>{since} {since === 1 ? 'commit' : 'commits'} since your last review</ActionList.GroupHeading>}
    <ActionList.Divider/>
    <ActionList.GroupHeading>One commit</ActionList.GroupHeading>
    {info.value.commits.map((c) => (
      <ActionList.Item key={c.sha} selected={range.kind === 'commit' && range.sha === c.sha} onSelect={() => {onRange({kind: 'commit', sha: c.sha});}}><span className="text-muted"><Sha sha={c.sha}/></span> {c.message.split('\n', 1)[0]}</ActionList.Item>
    ))}
  </>;
}

const Thread = observer(function Thread({issue, pr, f, l, file, head, items, composing, setComposing, onDone, keepText, keptText, reviewing}: {
  issue: Entity<'Issue'>; pr: PullRequest; f: number; l: number; file: DiffFile | undefined; head: string; items: Item[];
  composing: Composing | undefined; setComposing: (c: Composing | undefined) => void; onDone: () => void;
  keepText: (k: string, t: string | undefined) => void; keptText: (k: string) => string | undefined;
  reviewing: boolean;
}) {
  const app = useApp();
  const {intents} = editing(app);
  const [text, setText] = useState(() => (composing ? keptText(composerKey(composing)) ?? composing.initial : ''));
  const [was, setWas] = useState(composing);
  if (was !== composing) {
    setWas(composing);
    setText(composing ? keptText(composerKey(composing)) ?? composing.initial : '');
  }
  const edit = (t: string) => {
    setText(t);
    if (composing) keepText(composerKey(composing), t);
  };
  const replyButton = useRef<HTMLButtonElement>(null);
  const done = () => {
    if (composing) keepText(composerKey(composing), undefined);
    onDone();
    requestAnimationFrame(() => replyButton.current?.focus());
  };
  const save = () => {
    const a = file && lineAnchor(file, l, head);
    if (!a || !text.trim() || hasPendingUploads(text)) return;
    saveDraft(intents, {issueId: issue.id, repoId: pr.base_repo_id, number: issue.get('number'), anchor: a, text, key: composing?.key});
    done();
  };
  const posted = items.some((it) => it.kind === 'comment');
  const pool = usePool();
  const first = items.find((it) => it.kind === 'comment');
  const root = first?.kind === 'comment' ? conversationRoot(pool, first.c) : undefined;
  const resolver = useResolver(root);
  const [shown, setShown] = useState(false);
  const reply = composing !== undefined && composing.key === undefined && posted;
  const replyNow = () => {
    const a = file && lineAnchor(file, l, head);
    if (!a || !text.trim() || hasPendingUploads(text)) return;
    const id = submitReview(intents, {issueId: issue.id, repoId: pr.base_repo_id, head, event: 'COMMENT', body: '', drafts: [{key: `reply:${uuid()}`, anchor: a, text, at: Date.now()}]});
    done();
    notifyQueued(app, id, 'Reply queued');
  };
  if (resolver > 0 && !shown && !composing) {
    return (
      <div className="border-y border-muted bg-inset py-2 pr-4 pl-thread">
        <ResolvedFold resolver={resolver} onShow={() => {
          setShown(true);
        }}/>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 border-y border-muted bg-inset py-3 pr-4 pl-thread">
      {items.map((it) => (it.kind === 'comment' ?
        <CommentCard key={`c${String(it.c.id)}`} c={it.c} pending={it.pending}/> :
        composing?.key === it.d.key ? null : <DraftCard key={it.d.key} d={it.d} repoId={pr.base_repo_id} onEdit={() => {
          setComposing({f, l, key: it.d.key, initial: it.d.text});
        }} onDelete={() => {
          void intents.discardDraft(it.d.key);
        }}/>))}
      {composing && (
        <section aria-label={reply ? 'Reply' : 'New review comment'} className="rounded-md border border-default p-3">
          <MarkdownField repoId={pr.base_repo_id} attachmentIssueId={issue.id} label={reply ? 'Reply' : 'Review comment'} value={text} autoFocus rows={3} onChange={edit} onSubmit={reply ? replyNow : save} onCancel={done}/>
          <div className="flex justify-end gap-2">
            <PrimerButton size="small" type="button" disabled={!file || file.lines[l]?.k === 2} onClick={() => {
              if (!file) return;
              const end = file.lines[l]?.n ?? 0;
              const start = file.lines[composing.start ?? l]?.n ?? end;
              const lines = file.lines.filter((line) => line.k !== 2 && line.n >= start && line.n <= end);
              edit(`${text}${text ? '\n\n' : ''}\`\`\`suggestion${end > start ? ` -${end - start}+0` : ''}\n${lines.map((line) => line.t).join('\n')}\n\`\`\``);
            }}>Suggest change</PrimerButton>
            <PrimerButton variant="invisible" size="small" type="button" onClick={done}>Cancel</PrimerButton>
            {reply && <Tooltip text={'Keep it with your review (sent with Review)'}><PrimerButton size="small" type="button" inactive={!text.trim() || hasPendingUploads(text)} onClick={save}>Add to review</PrimerButton></Tooltip>}
            {!reply && !composing.key && <Tooltip text={'Post it now, on its own (works offline: sent when you are back)'}><PrimerButton size="small" type="button" inactive={!text.trim() || hasPendingUploads(text)} onClick={replyNow}>Add single comment</PrimerButton></Tooltip>}
            {reply ?
              <PrimerButton variant="primary" size="small" type="button" disabled={!text.trim() || hasPendingUploads(text)} onClick={replyNow}>Reply</PrimerButton> :
              <Tooltip text={(composing.key ? undefined : reviewing ? 'Add it to your pending review (sent with Review)' : 'Keep it for a review (sent with Review)') ?? ''} keybindingHint={shortcutHint('submit')}><PrimerButton variant="primary" size="small" type="button" inactive={!text.trim() || hasPendingUploads(text)} onClick={save}>
                {composing.key ? 'Update comment' : reviewing ? 'Add review comment' : 'Start a review'}
              </PrimerButton></Tooltip>}
          </div>
        </section>
      )}
      {!composing && posted && (
        <div className="flex items-center gap-2">
          <PrimerButton variant="invisible" size="small" leadingVisual={ReplyIcon} type="button" ref={replyButton} onClick={() => {
            setComposing({f, l, initial: ''});
          }}>Reply</PrimerButton>
          {root && <ResolveButton root={root} issue={issue}/>}
        </div>
      )}
    </div>
  );
});

function CardShell({who, when, badge, actions, children}: {who: ReactNode; when?: string | undefined; badge?: ReactNode; actions?: ReactNode; children: ReactNode}) {
  return (
    <section className="rounded-md border border-default p-3">
      <header className="flex items-center gap-2 text-sm">
        {who}
        {when && <span className="text-muted"><Ago at={when}/></span>}
        {badge}
        {actions && <span className="ml-auto flex items-center gap-1">{actions}</span>}
      </header>
      {children}
    </section>
  );
}

const CommentCard = observer(function CommentCard({c, pending}: {c: Comment; pending: boolean}) {
  const entity = usePool().model('Comment').get(c.id);
  return entity ? <PostedCommentCard c={entity} type="code" badge={<>{pending && <Label variant="attention">Pending</Label>}{c.invalidated && <Label>Outdated</Label>}</>}/> : null;
});

function DraftCard({d, repoId, onEdit, onDelete}: {d: ReviewDraft; repoId: number; onEdit?: (() => void) | undefined; onDelete: () => void}) {
  return (
    <CardShell who={<span className="font-medium text-default">Your comment</span>} badge={<Label variant="accent">Draft</Label>}
      actions={<>
        {onEdit && <IconButton icon={PencilIcon} variant="invisible" size="small" aria-label="Edit the comment" type="button" onClick={onEdit}/>}
        <IconButton icon={TrashIcon} variant="invisible" size="small" aria-label="Delete the comment" type="button" onClick={onDelete}/>
      </>}>
      <MarkdownPreview repoId={repoId} text={d.text}/>
    </CardShell>
  );
}

const FileNotes = observer(function FileNotes({items, title, repoId}: {items: Item[]; title?: string; repoId: number}) {
  const app = useApp();
  const {intents} = editing(app);
  return (
    <div className="flex flex-col gap-2 border-b border-muted bg-inset px-4 py-3">
      <Heading as="h3" variant="small">{title ?? 'Comments not on the lines shown'}</Heading>
      {items.map((it) => {
        const a = itemAnchor(it);
        return (
          <div key={it.kind === 'comment' ? `c${String(it.c.id)}` : it.d.key} className="flex flex-col gap-1">
            <span className="font-mono text-code text-muted">{a.path}:{a.line} ({a.side === 'old' ? 'old' : 'new'}, {shortSha(a.commit)})</span>
            {it.kind === 'comment' ? <CommentCard c={it.c} pending={it.pending}/> : <DraftCard d={it.d} repoId={repoId} onDelete={() => {
              void intents.discardDraft(it.d.key);
            }}/>}
          </div>
        );
      })}
    </div>
  );
});

const EVENTS: {event: ReviewEvent; label: string; own: boolean}[] = [
  {event: 'COMMENT', label: 'Comment', own: true},
  {event: 'APPROVED', label: 'Approve', own: false},
  {event: 'REQUEST_CHANGES', label: 'Request changes', own: false},
];

/** Submit drafts as one offline intent pinned to the displayed head. */
const ReviewDialog = observer(function ReviewDialog({open, onOpenChange, issue, pr, head, drafts, returnFocus}: {
  returnFocus: () => HTMLElement | null; open: boolean; onOpenChange: (open: boolean) => void; issue: Entity<'Issue'>; pr: PullRequest; head: string; drafts: ReviewDraft[];
}) {
  const app = useApp();
  const {userId} = useSession();
  const {intents} = editing(app);
  const [body, setBody] = useState('');
  const [event, setEvent] = useState<ReviewEvent>('COMMENT');
  const own = issue.get('poster_id') === userId;
  const {stale} = partition(drafts, head);
  const needsBody = event === 'REQUEST_CHANGES' || (event === 'COMMENT' && !drafts.length);
  const returnFocusRef = useRef<HTMLElement>(null);
  useEffect(() => {if (open) returnFocusRef.current = returnFocus();}, [open, returnFocus]);
  const ok = !hasPendingUploads(body) && (!needsBody || body.trim() !== '');
  const submit = () => {
    if (!ok) return;
    const id = submitReview(intents, {issueId: issue.id, repoId: pr.base_repo_id, head, event, body, drafts});
    setBody('');
    onOpenChange(false);
    notifyQueued(app, id, 'Review queued');
  };
  return (
    open && <PrimerDialog returnFocusRef={returnFocusRef} onClose={() => {onOpenChange(false);}} width="large" title="Submit review"
      subtitle={`On ${shortSha(head)}${drafts.length ? ` · ${String(drafts.length)} ${drafts.length === 1 ? 'comment' : 'comments'}` : ''}`}
      footerButtons={[{content: 'Cancel', onClick: () => {onOpenChange(false);}}, {content: 'Submit review', buttonType: 'primary', disabled: !ok, onClick: submit}]}>
      <div className="flex flex-col gap-3">
        {stale.length > 0 && (
          <Banner variant="warning" title={`${String(stale.length)} ${stale.length === 1 ? 'comment was' : 'comments were'} written on an earlier commit`} description={<>
            They are added to the review's text with their file and line, since their lines may have moved.
          </>}/>
        )}
        <MarkdownField repoId={pr.base_repo_id} attachmentIssueId={issue.id} label="Review summary" value={body} onChange={setBody} rows={4} onSubmit={submit} autoFocus/>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl aria-label="Verdict" onChange={(index) => {const choice = EVENTS[index ?? 0]; if (choice && (!own || choice.own)) setEvent(choice.event);}}>{EVENTS.map((choice) => <SegmentedControl.Button key={choice.event} selected={event === choice.event} disabled={own && !choice.own}>{choice.label}</SegmentedControl.Button>)}</SegmentedControl>
          {own && <span className="text-sm text-muted">Your own pull request: comment only.</span>}
          {needsBody && !body.trim() && <span className="text-sm text-muted">{event === 'REQUEST_CHANGES' ? 'Say what to change.' : 'Write a summary or add comments.'}</span>}
        </div>
      </div>
    </PrimerDialog>
  );
});


const CommitsTab = observer(function CommitsTab({owner, repo, pr, commits}: TabProps & {pr: PullRequest; commits: PullCommits}) {
  const rows = useCodeRows<CommitInfo>(owner, repo, (c) => `commit/${c.sha}`);
  const src = useSource();
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const key = `compare:${String(pr.base_repo_id)}:${commits.base}:${commits.head}`;
  const info = useLoad(key, () => src.peek<CompareInfo>(key), () => src.compare(pr.base_repo_id, commits.base, commits.head));
  return (
    <div ref={setScroller} className="h-full overflow-y-auto">
      {info.state !== 'ready' ? <Unloaded loaded={info} what="These commits"/> :
        <RowList items={info.value.commits} scroller={scroller} label="Commits" keyOf={(c) => c.sha}
          row={withChecks(commitRow, owner, repo, pr)}
          onOpen={rows.onOpen} linkOf={rows.linkOf}/>}
    </div>
  );
});


const ChecksTab = observer(function ChecksTab({issue, owner, repo, pr, commits}: TabProps & {pr: PullRequest; commits: PullCommits}) {
  const pool = usePool();
  const {statuses, runs, awaitingApproval} = checksOf(pool, pr, commits.head);
  const check = useMergeCheck(awaitingApproval > 0 ? issue : undefined, pr);
  if (!statuses.length && !runs.length) return <Blankslate><Blankslate.Visual><WorkflowIcon size={24}/></Blankslate.Visual><Blankslate.Heading>No checks</Blankslate.Heading><Blankslate.Description>{`Nothing reported for ${shortSha(commits.head)} on this device.`}</Blankslate.Description></Blankslate>;
  return (
    <PageColumn wide>
      {awaitingApproval > 0 && <ApprovalPanel issueId={issue.id} actions={check.state === 'ready' ? check.value.actions ?? undefined : undefined} waiting/>}
      {runs.length > 0 && (
        <section aria-label="Workflow runs" className="flex flex-col">
          <Heading as="h3" variant="small">Workflow runs</Heading>
          {runs.map((r) => <RunRow key={r.id} owner={owner} repo={repo} runId={r.id} runNumber={r.data.run_number}/>)}
        </section>
      )}
      {statuses.length > 0 && (
        <section aria-label="Statuses" className="flex flex-col">
          <Heading as="h3" variant="small">Statuses</Heading>
          {statuses.map((s) => {
            const look = statusLook(s.get('state') === 'error' ? 'failure' : s.get('state') === 'pending' ? 'waiting' : s.get('state'));
            const url = s.get('target_url');
            const description = cleanDescription(s.get('description'));
            return (
              <div key={s.id} className="flex items-center gap-2 border-b border-muted px-3 py-2"><CheckMark tone={look.tone}/><span className="min-w-0 flex-1">
                {/^https?:\/\//.test(url) ? <PrimerLink href={url} target="_blank" rel="noopener noreferrer" muted className="min-w-0 truncate">{s.get('context')}</PrimerLink> : s.get('context')}
                {description && <span className="text-muted"> {description}</span>}
              </span><span className="text-muted">{look.text}</span></div>
            );
          })}
        </section>
      )}
    </PageColumn>
  );
});

const RunRow = observer(function RunRow({owner, repo, runId, runNumber}: {owner: string; repo: string; runId: number; runNumber: number}) {
  const pool = usePool();
  const run = pool.model('ActionRun').get(runId);
  const jobs = [...pool.model('ActionRunJob').by('run_id', runId)].sort((a, b) => a.id - b.id);
  if (!run) return null;
  return (
    <>
      <RunControls owner={owner} repo={repo} run={run.data} jobs={jobs.map((j) => j.data)}/>
      {jobs.map((j, i) => {
        const look = runLook(run.data, j.get('status'));
        return (
          <div key={j.id} className="flex items-center gap-1 pr-2">
          <CodeLink className="min-w-0 flex-1" owner={owner} repo={repo} to={`actions/runs/${String(runNumber)}/jobs/${String(i)}`}>
            <div className="flex items-center gap-2 border-b border-muted px-3 py-2"><CheckMark tone={look.tone}/><span className="min-w-0 flex-1">
              {run.get('workflow_id')} / {j.get('name')}
            </span><span className="text-muted">{statusTime(look.text, j.get('started'), j.get('stopped'))}</span></div>
          </CodeLink>
          <RunControls owner={owner} repo={repo} run={run.data} jobs={jobs.map((item) => item.data)} job={j.data}/>
          </div>
        );
      })}
    </>
  );
});


const STYLES = [['merge', 'Create a merge commit'], ['rebase', 'Rebase'], ['rebase-merge', 'Rebase and merge commit'], ['squash', 'Squash'], ['fast-forward-only', 'Fast-forward only']] as const;

/** Merge actions are online-only, never queued, and require write access. */
export const MergeBox = observer(function MergeBox({issue}: {issue: Entity<'Issue'>}) {
  const app = useApp();
  const session = useSession();
  const pool = usePool();
  const pr = pullOf(pool, issue.id);
  const [busy, setBusy] = useState(false);
  const [rebaseConfirm, setRebaseConfirm] = useState(false);
  const [style, setStyle] = useState<MergeStyle | undefined>(undefined);
  const repository = pr ? pool.model('Repository').get(pr.base_repo_id)?.data : undefined;
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  // Protection rules are admin-only in API v1; use Forgejo's viewer-specific verdict.
  const eligibility = useMergeCheck(issue, pr);
  if (!pr) return null;
  const repo = repository;
  const config = [...pool.model('RepoUnit').by('repo_id', pr.base_repo_id)].find((u) => u.get('type') === 'pulls')?.data.config;
  const options = mergeOptions(config ?? {});
  const deleteDefault = pullSettingsOf(config ?? {}).deleteBranch;
  const primary = config ? options.primary : undefined;
  const auto = [...pool.model('AutoMerge').by('pull_id', pr.id)][0];
  // Treat stalled connections as offline to avoid requests hanging until their deadline.
  const isOnline = reach(session.data.status.connection) === 'online';
  const closed = issue.get('state') === 'closed';
  const write = canWrite(session, pr.base_repo_id);
  const path = repo ? `/repos/${encodeURIComponent(repo.owner_name)}/${encodeURIComponent(repo.name)}/pulls/${String(pr.number)}` : '';
  const run = (words: {done: string; failed: string; merging?: boolean}, req: Parameters<typeof online>[1]) => {
    setBusy(true);
    online(app, req).then(() => {
      notify(app, {tone: 'success', title: words.done});
    }, async (err: unknown) => {
      // A concurrent merge is success, not an error; sync will update the page.
      const merged = words.merging ? await mergedMeanwhile(app, err, path, () => pullOf(pool, issue.id)?.merged === true) : undefined;
      if (merged) {
        notify(app, {tone: 'neutral', title: 'Already merged', description: `${merged.by ?? 'Someone'} merged this pull request before your merge went through.`});
        bumpMergeCheck(issue.id);
        return;
      }
      // Do not offer retries for deterministic server refusals (4xx).
      notify(app, {tone: 'danger', title: words.failed, description: failureText(err), ...refused(err) ? {} : {action: {label: 'Retry', run: () => {
        run(words, req);
      }}}});
    }).finally(() => {
      setBusy(false);
    });
  };
  const offlineWhy = (action: string) => (isOnline ? undefined : onlineOnly(action));
  // Send the displayed head so Forgejo rejects merges of unseen pushes.
  const headSeen = poolHead(pool, pr);
  const seen = headSeen ? {head_commit_id: headSeen} : {};
  const sum = headSeen ? checksOf(pool, pr, headSeen) : undefined;
  const checks = sum?.summary ?? 'none';
  const unfinished = sum ? unfinishedChecks(pool, sum) : 0;
  const latest = reviewVerdicts([...pool.model('Review').by('issue_id', issue.id)].map((r) => r.data));
  const changesRequested = [...latest.values()].some((r) => r.state === 'REQUEST_CHANGES');
  const behind = pr.commits_behind > 0 ? ` · ${String(pr.commits_behind)} behind ${pr.base_branch}` : '';
  // A merge-based branch update has the same conflicts as merging the pull request.
  const conflict = pr.status === 'conflict';
  const conflictWhy = conflict ? `It conflicts with ${pr.base_branch}: resolve the conflicts in the branch first.` : undefined;
  const check = eligibility.state === 'ready' ? eligibility.value : undefined;
  const draft = draftPrefix(issueTitle(editing(app).overlay, issue), wipPrefixes(app.config)) !== undefined;
  const statuses = headSeen ? latestStatuses(pool, pr, headSeen).map((st) => ({context: st.get('context'), state: st.get('state')})) : [];
  const mergeWhy = (draft ? 'Draft pull requests cannot be merged. Mark this ready for review first.' : undefined) ?? conflictWhy ??
    protectionWhy(check, pr.base_branch, statuses) ??
    (check?.mergeable === false ? 'Forgejo says this pull request cannot be merged yet. Check the branch protection rules.' : undefined);
  const waitingApproval = (sum?.awaitingApproval ?? 0) > 0 || check?.actions?.need_approval === true;
  const checksTab = repo ? <RouterLink to="/$owner/$repo/pulls/$index" params={{owner: repo.owner_name, repo: repo.name, index: String(pr.number)}} search={{tab: 'checks'}} muted className="min-w-0 truncate">View checks</RouterLink> : null;
  const checksWords = checks === 'failure' ? 'Some checks failed' : waitingApproval ? 'Checks are waiting for a maintainer’s approval' : checks === 'pending' ? 'Checks are not done yet' : 'Checks passed';
  const checksTone = checks === 'failure' ? 'danger' : checks === 'pending' ? 'warning' : 'success';
  // A branch that may go once the work is in (merged, or closed): the classic page's "Delete branch".
  const headRef = check?.head_repo ? check.head_repo.split('/') : [];
  const removeHeadBranch = () => {
    if (!isOnline || busy || headRef.length !== 2) return;
    setDeleteConfirm(false);
    setBusy(true);
    deleteBranch(app, {id: pr.head_repo_id, owner: headRef[0] ?? '', name: headRef[1] ?? ''}, pr.head_branch).then(() => {
      notify(app, {tone: 'success', title: `Deleted ${pr.head_branch}`});
      bumpMergeCheck(issue.id);
    }, (err: unknown) => {
      notify(app, {tone: 'danger', title: 'Deleting the branch failed', description: failureText(err)});
    }).finally(() => {setBusy(false);});
  };
  const rebaseHead = () => {
    if (!isOnline || busy || conflict || !config || !options.rebaseUpdate) return;
    setRebaseConfirm(false);
    run({done: `Rebased onto ${pr.base_branch}`, failed: 'Updating the branch failed'}, {method: 'POST', api: 'v1', path: `${path}/update?style=rebase`});
  };
  const deletable = check ? check.branch_deletable : pr.head_repo_id === pr.base_repo_id;
  let state: ReactNode;
  if (pr.merged) {
    state = (
      <>
        <GitMergeIcon size={16} className="shrink-0 text-done"/> Merged{pr.merged_at ? <> <time className="text-sm font-normal text-muted" dateTime={pr.merged_at} title={fullDate(pr.merged_at)}>{agoWords(pr.merged_at)}</time></> : ''}
        {pr.merge_commit_sha && repo && <span className="text-sm font-normal text-muted">as <PrimerLink as={CodeLink} owner={repo.owner_name} repo={repo.name} to={`commit/${pr.merge_commit_sha}`}><Sha sha={pr.merge_commit_sha}/></PrimerLink></span>}
      </>
    );
  } else if (closed) state = 'Closed without merging';
  else if (conflict) state = <><CheckMark tone="danger"/> Conflicts with {pr.base_branch}{pr.conflicted_files.length ? <>: {pr.conflicted_files.map((f, i) => <Fragment key={f}>{i > 0 && ', '}<code>{f}</code></Fragment>)}</> : ''}</>;
  else if (pr.status === 'checking') state = <><CheckMark tone="warning"/> Checking whether it can be merged…</>;
  else if (mergeWhy) state = <><CheckMark tone="warning"/> {mergeWhy}</>;
  else if (checks === 'pending') state = <><CheckMark tone="warning"/> {checksWords}{behind}</>;
  else if (checks === 'failure') state = <><CheckMark tone="danger"/> Some checks failed{behind}</>;
  else state = <><CheckMark tone="success"/> {checks === 'success' ? 'Checks passed · can be merged' : 'Can be merged'}{behind}</>;
  // The checks are said even when something else is the headline (a draft, a conflict, a protection rule): an
  // author waiting on CI sees what it said where they land.
  const checksLine = !pr.merged && !closed && checks !== 'none' && (mergeWhy !== undefined || conflict || pr.status === 'checking');
  return (
    <div className="mt-4"><section aria-label="Merge" className="overflow-hidden rounded-md border border-default bg-default text-base">
      <div className="flex min-h-10 flex-wrap items-center gap-2 border-b border-default bg-muted px-4 py-2 font-semibold text-default">{state}</div>
      <div className="flex flex-col gap-2 px-4 py-3">
      {checksLine && <p className="flex flex-wrap items-center gap-2 text-default"><CheckMark tone={checksTone}/> {checksWords}{checks === 'pending' && !waitingApproval && unfinished ? ` (${String(unfinished)} running)` : ''} {checksTab}</p>}
      {!checksLine && !pr.merged && !closed && (checks === 'failure' || waitingApproval) && <p>{checksTab}</p>}
      {!pr.merged && !closed && waitingApproval && <ApprovalPanel issueId={issue.id} actions={check?.actions ?? undefined} waiting={(sum?.awaitingApproval ?? 0) > 0}/>}
      {!pr.merged && !closed && !waitingApproval && check?.actions?.poster_trust === 'explicitly' && <ApprovalPanel issueId={issue.id} actions={check.actions} waiting={false}/>}
      {(pr.merged || closed) && check?.branch_deletable && headRef.length === 2 && (
        <p className="flex flex-wrap items-center gap-2 text-muted">
          The branch <BranchName as="span">{pr.head_branch}</BranchName> can be deleted{pr.merged ? ': its work is merged' : ''}.
          <Tooltip text={(offlineWhy('Deleting the branch')) ?? ''}><PrimerButton size="small" leadingVisual={TrashIcon} type="button" inactive={!isOnline || busy} onClick={() => {
            setDeleteConfirm(true);
          }}>Delete branch</PrimerButton></Tooltip>
        </p>
      )}
      {deleteConfirm && headRef.length === 2 && <PrimerDialog title="Delete branch" subtitle={`Delete ${pr.head_branch} from ${check?.head_repo ?? ''}? Its commits stay in this pull request.`} width="large" onClose={() => {setDeleteConfirm(false);}}
        footerButtons={[{content: 'Cancel', onClick: () => {setDeleteConfirm(false);}}, {content: 'Delete branch', buttonType: 'danger', leadingVisual: TrashIcon, inactive: !isOnline || busy, onClick: removeHeadBranch}]}>
        {!isOnline && <p className="text-muted">{onlineOnly('Deleting the branch')}</p>}
      </PrimerDialog>}
      {!pr.merged && !closed && <DraftControl issue={issue}/>}
      {!pr.merged && !closed && changesRequested && <p className="text-danger">Changes requested</p>}
      {auto && !pr.merged && <p className="text-sm text-muted">Merges automatically when the checks succeed ({auto.data.merge_style}).</p>}
      {!pr.merged && !closed && path && write && (
        <div className="flex flex-wrap items-center gap-2">
          <ButtonGroup>
          <Tooltip text={offlineWhy('Merging') ?? mergeWhy ?? 'Merge changes'}><PrimerButton size="small" variant={changesRequested || checks === 'failure' || checks === 'pending' ? 'default' : 'primary'} leadingVisual={GitMergeIcon} inactive={!isOnline || busy || !!mergeWhy || !primary}
            onClick={() => {
              if (primary) setStyle(primary.style as MergeStyle);
            }}>{primary?.label ?? 'Merge'}…</PrimerButton></Tooltip>
          <ActionMenu>
            <ActionMenu.Anchor><IconButton size="small" icon={ChevronDownIcon} variant={changesRequested || checks === 'failure' || checks === 'pending' ? 'default' : 'primary'} disabled={!isOnline || busy || !!mergeWhy || !primary}
                aria-label="Choose merge method" description={offlineWhy('Merging') ?? mergeWhy ?? 'Choose merge method'}/></ActionMenu.Anchor>
            <ActionMenu.Overlay><ActionList>
              {options.styles.map(({style: s, label}) => (
                <ActionList.Item key={s} onSelect={() => {
                  setStyle(s as MergeStyle);
                }}>{label}…</ActionList.Item>
              ))}
            </ActionList></ActionMenu.Overlay>
          </ActionMenu>
          </ButtonGroup>
          {auto ?
            <Tooltip text={(offlineWhy('Canceling the auto-merge')) ?? ''}><PrimerButton size="small" type="button" inactive={!isOnline || busy} onClick={() => {
              run({done: 'Auto-merge canceled', failed: 'Canceling the auto-merge failed'}, {method: 'DELETE', api: 'v1', path: `${path}/merge`});
            }}>Cancel auto-merge</PrimerButton></Tooltip> :
            checks === 'pending' && primary && <Tooltip text={offlineWhy('Scheduling the merge') ?? mergeWhy ?? 'Merge when all checks succeed'}><PrimerButton size="small" variant={changesRequested ? 'default' : 'primary'} leadingVisual={GitMergeIcon} type="button" inactive={!isOnline || busy || !!mergeWhy} onClick={() => {
              run({done: `Merges into ${pr.base_branch} when the checks succeed`, failed: 'Scheduling the merge failed', merging: true},
                {method: 'POST', api: 'v1', path: `${path}/merge`, body: {Do: primary.style, merge_when_checks_succeed: true, delete_branch_after_merge: deletable && deleteDefault, ...seen}});
            }}>Merge when checks succeed</PrimerButton></Tooltip>}
          {pr.commits_behind > 0 && <ButtonGroup>
            <Tooltip text={offlineWhy('Updating the branch') ?? conflictWhy ?? `Merge ${pr.base_branch} into this branch`}><PrimerButton size="small" type="button" inactive={!isOnline || busy || conflict} onClick={() => {
              run({done: `Updated with ${pr.base_branch}`, failed: 'Updating the branch failed'}, {method: 'POST', api: 'v1', path: `${path}/update?style=merge`});
            }}>Update branch</PrimerButton></Tooltip>
          {config && <ActionMenu>
            <ActionMenu.Anchor><IconButton size="small" icon={ChevronDownIcon} aria-label="Choose branch update method" disabled={!isOnline || busy || conflict} description={offlineWhy('Updating the branch') ?? conflictWhy ?? 'Choose branch update method'}/></ActionMenu.Anchor>
            <ActionMenu.Overlay><ActionList>
              <ActionList.Item onSelect={() => {
                run({done: `Updated with ${pr.base_branch}`, failed: 'Updating the branch failed'}, {method: 'POST', api: 'v1', path: `${path}/update?style=merge`});
              }}>Update with merge commit</ActionList.Item>
              {options.rebaseUpdate && <ActionList.Item onSelect={() => {
                setRebaseConfirm(true);
              }}>Update with rebase</ActionList.Item>}
            </ActionList></ActionMenu.Overlay>
          </ActionMenu>}
          </ButtonGroup>}
          {!isOnline && <span className="text-sm text-muted">{onlineOnly('Merging')}</span>}
          {isOnline && conflictWhy && <span className="text-sm text-muted">{conflictWhy}</span>}
        </div>
      )}
      {!pr.merged && !closed && conflict && repo && <ConflictHelp pr={pr} headRepo={[check?.head_repo, pool.model('Repository').get(pr.head_repo_id)?.get('full_name')].find((n) => !!n)}
        pullPath={`/${encodeURIComponent(repo.owner_name)}/${encodeURIComponent(repo.name)}/pulls/${String(pr.number)}`}
        canPush={pr.head_repo_id === pr.base_repo_id ? write : issue.get('poster_id') === session.userId || (pr.allow_maintainer_edit && write)}/>}
      {rebaseConfirm && <PrimerDialog title="Update with rebase" subtitle={`Replay this branch onto ${pr.base_branch}. This rewrites commits and force-pushes the head branch.`} width="large" onClose={() => {setRebaseConfirm(false);}}
        footerButtons={[{content: 'Cancel', onClick: () => {setRebaseConfirm(false);}}, {content: 'Rebase and force-push', buttonType: 'primary', inactive: !isOnline || busy || conflict || !config || !options.rebaseUpdate, onClick: rebaseHead}]}>
        {(offlineWhy('Updating the branch') ?? conflictWhy) && <p className="text-muted">{offlineWhy('Updating the branch') ?? conflictWhy}</p>}
      </PrimerDialog>}
      {style && (
        <MergeDialog reason={offlineWhy('Merging') ?? mergeWhy ?? (!options.styles.some((m) => m.style === style) ? 'This merge method is no longer allowed.' : undefined)} pr={pr} title={issue.get('title')} style={style} checks={checks} unfinished={unfinished} deletable={deletable} deleteDefault={deleteDefault} onClose={() => {
          setStyle(undefined);
        }} onMerge={(body) => {
          setStyle(undefined);
          run({done: `Merged into ${pr.base_branch}`, failed: 'Merging failed', merging: true}, {method: 'POST', api: 'v1', path: `${path}/merge`, body: {Do: style, ...body, ...seen}, timeout: 60_000});
        }}/>
      )}
      </div>
    </section></div>
  );
});

type MergeStyle = typeof STYLES[number][0];

/** Merging is not undone: the commit message and whether the branch goes, confirmed first. */
function MergeDialog({pr, title, style, checks, unfinished, deletable, deleteDefault, onClose, onMerge, reason}: {
  reason: string | undefined; pr: PullRequest; title: string; style: MergeStyle; checks: string; unfinished: number; deletable: boolean; deleteDefault: boolean;
  onClose: () => void; onMerge: (body: Record<string, unknown>) => void;
}) {
  const label = STYLES.find(([s]) => s === style)?.[1] ?? style;
  const commit = style === 'merge' || style === 'squash' || style === 'rebase-merge';
  const [head, setHead] = useState(style === 'squash' ? `${title} (#${String(pr.number)})` : `Merge pull request '${title}' (#${String(pr.number)}) from ${pr.head_branch} into ${pr.base_branch}`);
  const [message, setMessage] = useState('');
  const [drop, setDrop] = useState(deletable && deleteDefault);
  const merge = () => {
    onMerge({...(commit ? {MergeTitleField: head, MergeMessageField: message} : {}), delete_branch_after_merge: deletable && drop});
  };
  return (
    <PrimerDialog title={label} subtitle={`Into ${pr.base_branch}, from ${pr.head_branch}. This cannot be undone.`} width="large" onClose={onClose} footerButtons={[{content: 'Cancel', onClick: onClose}, {content: 'Merge', buttonType: 'primary', inactive: !!reason, leadingVisual: GitMergeIcon, onClick: merge}]}>
      <div className="flex flex-col gap-4">
        {reason && <Banner variant="warning" title={reason}/>}
        {checks === 'pending' && (
          <Banner variant="warning" title={`${String(unfinished)} ${unfinished === 1 ? 'check has' : 'checks have'} not finished`} description={<>
            Merging now does not wait for {unfinished === 1 ? 'it' : 'them'}. “Merge when checks succeed” waits.
          </>}/>
        )}
        {checks === 'failure' && <Banner variant="critical" title="Some checks failed" description={<>Merging now merges changes whose checks did not pass.</>}/>}
        {commit && <TextInput aria-label="Commit title" value={head} className="w-full" onChange={(e) => {
          setHead(e.target.value);
        }}/>}
        {commit && <Textarea aria-label="Commit message" placeholder="Commit message (optional)" rows={4} value={message} onChange={(e) => {
          setMessage(e.target.value);
        }} block/>}
        {deletable && <FormControl><Checkbox checked={drop} onChange={(event) => { setDrop(event.target.checked); }}/><FormControl.Label>{`Delete the branch ${pr.head_branch} afterwards`}</FormControl.Label></FormControl>}
      </div>
    </PrimerDialog>
  );
}
