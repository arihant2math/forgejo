// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {CheckCircleIcon, CheckIcon, ChevronDownIcon, CommentIcon, EyeIcon, FileDiffIcon, SidebarCollapseIcon, SidebarExpandIcon} from '@primer/octicons-react';
import {ActionList, ActionMenu, IconButton, Button as PrimerButton, Tooltip} from '@primer/react';
import {useLocation} from '@tanstack/react-router';
import {type IObservableValue, observable, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type RefObject, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {online} from '../../app/api.ts';
import {useHold} from '../../app/repo.ts';
import {shortcutHint, useShortcut} from '../../app/shortcuts/index.ts';
import {useApp, useSession} from '../../app/store.ts';
import {count, noun} from '../../app/words.ts';
import {anchor, lineAnchor, lineKey} from '../../code/anchor.ts';
import {DEL, type DiffFile, filePath} from '../../code/diff.ts';
import {DiffStat} from '../../code/parts.tsx';
import type {PullCommits} from '../../code/pull.ts';
import {type ReviewDraft, reviewDrafts, saveDraft} from '../../code/review.ts';
import type {CompareInfo} from '../../code/source.ts';
import {newestState, viewedAt, viewedMarks} from '../../code/viewed.ts';
import {Sha, summary} from '../../components/Sha.tsx';
import {issueGroup} from '../../data/models.ts';
import {editing} from '../../intents/session.ts';
import type {PullRequest} from '../../protocol/types.gen.ts';
import {DiffSettings, useDiffSettings} from '../code/DiffSettings.tsx';
import {type DiffExtras, type DiffHandle, DiffView} from '../code/DiffView.tsx';
import {useDiff} from '../code/History.tsx';
import {RowList} from '../code/RowList.tsx';
import {useLoad, useSource} from '../code/hooks.ts';
import {Unloaded} from '../code/states.tsx';
import {usePool} from '../issues/cells.tsx';
import {ReviewDialog} from './ReviewDialog.tsx';
import {FileNotes, Thread} from './ReviewThreads.tsx';
import {commitsSince, type DiffRange, lastReviewCommit, rangeCommits} from './range.ts';
import {composerKey, type Composing, type Item, itemAnchor} from './reviewTypes.ts';
import type {TabProps} from './types.ts';

const ALL: DiffRange = {kind: 'all'};

export const FilesTab = observer(function FilesTab({issue, owner, repo, pr, commits}: TabProps & {pr: PullRequest; commits: PullCommits}) {
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
  useHold(data, issueGroup(issue.id));
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [aside, setAside] = useState<HTMLElement | null>(null);
  const diffRef = useRef<DiffHandle>(null);
  const hash = useLocation({select: (location) => location.hash});
  const jumped = useRef('');
  // The file at the top changes while scrolling; only the file list observes it, so the review does not re-render.
  const [current] = useState(() => observable.box(0));
  const onFile = useCallback((i: number) => {
    runInAction(() => {
      current.set(i);
    });
  }, [current]);
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
  // Ref-backed threads need a signature change for remote edits or review-state updates.
  const itemsSig = items.map((it) => (it.kind === 'comment' ? `${String(it.c.id)}.${String(it.c.content_version)}.${it.c.updated_at}.${String(it.pending)}.${String(it.c.invalidated)}` : `${it.d.key}.${String(it.d.at)}`)).join(',');
  const anchored = useMemo(() => (range.kind === 'all' ? anchor(files, items, itemAnchor, head, outdated) : anchor(files, items, itemAnchor, '', (it) => {
    const a = itemAnchor(it);
    return !atHead || a.side === 'old' || (a.commit !== head && outdated(it));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- items are rebuilt every render; their signature says when they changed
  })), [files, itemsSig, head, range.kind, atHead]);
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
    const f = diffRef.current?.current() ?? current.get();
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
            <span>{count(files.length, 'file', 'files')}</span>
            <DiffStat additions={additions} deletions={deletions}/>
          </div>
          <ChangedFiles items={indexed} scroller={aside} current={current} viewed={viewed.paths} counts={counts} diff={diffRef}/>
        </aside>
      )}
      <div ref={setScroller} className="min-w-0 flex-1 overflow-auto">
        <ReviewBar pr={pr} head={head} drafts={drafts} viewed={viewed.paths.size} files={files.length} listOpen={listOpen} open={!pr.merged && issue.get('state') === 'open'}
          range={range} base={base} to={to} lastReview={lastReview} onRange={onRange} onList={() => {
          setListOpen((o) => !o);
        }} onReview={() => {
          setReviewing(true);
        }}/>
        {anchored.elsewhere.length > 0 && <div className="sticky left-0 w-view"><FileNotes items={anchored.elsewhere} title="Comments on files not in this diff" repoId={pr.base_repo_id}/></div>}
        <DiffView key={`${base}:${to}`} ref={diffRef} repoId={pr.base_repo_id} base={base} head={to} files={files} scroller={scroller} extras={extras} onFile={onFile} underBar/>
      </div>
      <ReviewDialog returnFocus={() => scroller?.querySelector<HTMLButtonElement>('[data-review-button]') ?? null} open={reviewing} onOpenChange={setReviewing} issue={issue} pr={pr} head={head} drafts={drafts}/>
    </div>
  );
});

const ChangedFiles = observer(function ChangedFiles({items, scroller, current, viewed, counts, diff}: {
  items: {f: DiffFile; i: number}[]; scroller: HTMLElement | null; current: IObservableValue<number>; viewed: ReadonlySet<string>;
  counts: ReadonlyMap<number, number>; diff: RefObject<DiffHandle | null>;
}) {
  return (
    <RowList items={items} scroller={scroller} label="Changed files" keyOf={({f}) => filePath(f)} cursor={current.get()}
      onCursor={(i) => {
        diff.current?.toFile(i);
      }}
      row={({f, i}) => {
        const n = counts.get(i);
        return {
          leading: viewed.has(filePath(f)) ? <CheckCircleIcon size={16}/> : <FileDiffIcon size={16}/>,
          main: <span title={filePath(f)}>{filePath(f)}</span>,
          trailing: n ? <span className="flex items-center gap-1"><CommentIcon size={12} className="shrink-0"/>{n}</span> : undefined,
        };
      }}
      onOpen={({i}) => {
        diff.current?.toFile(i);
        diff.current?.focus();
      }}/>
  );
});

const ReviewBar = observer(function ReviewBar({pr, head, drafts, viewed, files, listOpen, onList, onReview, open, range, base, to, lastReview, onRange}: {
  pr: PullRequest; head: string; drafts: ReviewDraft[]; viewed: number; files: number; listOpen: boolean; onList: () => void; onReview: () => void; open: boolean;
  range: DiffRange; base: string; to: string; lastReview: string | undefined; onRange: (range: DiffRange) => void;
}) {
  return (
    <div data-sticky-bar className="sticky top-0 left-0 z-sticky flex h-control w-view items-center gap-2 border-b border-muted bg-default px-3 text-sm text-muted">
      <IconButton icon={listOpen ? SidebarExpandIcon : SidebarCollapseIcon} variant="invisible" size="small" aria-label={listOpen ? 'Hide the file list' : 'Show the file list'} type="button" onClick={onList}/>
      <RangeMenu pr={pr} head={head} range={range} base={base} to={to} lastReview={lastReview} onRange={onRange}/>
      <span className="ml-auto shrink-0 tabular-nums">{viewed} / {files} files viewed</span>
      <DiffSettings/>
      {open && <Tooltip text={'Submit a review (works offline: sent when you are back)'} keybindingHint={shortcutHint('review.start')}>
        <PrimerButton variant="primary" size="small" type="button" data-review-button {...drafts.length ? {count: drafts.length} : {}}
          aria-label={drafts.length ? `Submit review (${String(drafts.length)} pending ${noun(drafts.length, 'comment', 'comments')})` : 'Submit review'} onClick={onReview}>Submit review</PrimerButton>
      </Tooltip>}
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
    {since !== undefined && <ActionList.GroupHeading>{count(since, 'commit', 'commits')} since your last review</ActionList.GroupHeading>}
    <ActionList.Divider/>
    <ActionList.GroupHeading>One commit</ActionList.GroupHeading>
    {info.value.commits.map((c) => (
      <ActionList.Item key={c.sha} selected={range.kind === 'commit' && range.sha === c.sha} onSelect={() => {onRange({kind: 'commit', sha: c.sha});}}><span className="text-muted"><Sha sha={c.sha}/></span> {summary(c.message)}</ActionList.Item>
    ))}
  </>;
}
