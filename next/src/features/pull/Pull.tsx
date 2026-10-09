// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A pull request's code views (PLAN §5.4, §5.5, §5.7), its own chunk:
//
//   Files    the diff (merge base → head, both from the pool when it can),
//            parsed and highlighted in the worker, one virtualized list;
//            review comments anchored by (path, side, line, commit);
//            comments drafted on lines (durable drafts) and the review
//            submitted as one offline intent pinned to the head on screen
//            (R); viewed files as offline intents (V); `[` `]` between files.
//   Commits  the commits of the pull request (API v1 by SHA, cached).
//   Checks   commit statuses and Actions runs of the head (synced).
//   Merge    merge, update branch and auto-merge: online only (disabled
//            offline with the reason), never queued.

import {PageColumn} from '../../app/shell/Frame.tsx';
import {Check, ChevronDown, CircleCheck, Eye, FileDiff, GitMerge, GitPullRequest, MessageSquare, PanelLeftClose, PanelLeftOpen, Pencil, Reply, Trash2, Workflow} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {canWrite} from '../../app/access.ts';
import {online, RequestFailed} from '../../app/api.ts';
import {ClassicLink} from '../../app/ClassicLink.tsx';
import {uuid} from '../../intents/intents.ts';
import {notify} from '../../app/notices.ts';
import {connectivity, onlineOnly} from '../../app/online.ts';
import {useHold} from '../../app/repo.ts';
import {shortcutHint, useShortcut} from '../../app/shortcuts/index.ts';
import {useApp, useSession} from '../../app/store.ts';
import {anchor, type Anchor, commentAnchor, lineAnchor, lineKey} from '../../code/anchor.ts';
import {type DiffFile, filePath} from '../../code/diff.ts';
import {fetchCommits, poolCommits, poolHead, pullOf, type PullCommits} from '../../code/pull.ts';
import {shortSha} from '../../code/refs.ts';
import {partition, type ReviewDraft, reviewDrafts, type ReviewEvent, saveDraft, submitReview} from '../../code/review.ts';
import {type CommitInfo, type CompareInfo, NotCached} from '../../code/source.ts';
import {newestState, viewedAt, viewedMarks} from '../../code/viewed.ts';
import type {Entity} from '../../data/entity.ts';
import {editing} from '../../intents/session.ts';
import type {Comment, PullRequest} from '../../protocol/types.gen.ts';
import {
  Badge, Button, Callout, Card, Checkbox, Dialog, DiffStat, EmptyState, Icon, IconButton, Input, ListRow, Menu, MenuContent, MenuItem, MenuTrigger, ProseSource,
  SectionHeading, SegmentedControl, StatusDot, TextArea, TextLink,
} from '../../ui/index.ts';
import {MarkdownField, MarkdownPreview} from '../editor/Composer.tsx';
import {Markdown} from '../issue/Markdown.tsx';
import {usePool, UserAvatar, UserName} from '../issues/cells.tsx';
import {agoWords, fullDate} from '../issues/format.ts';
import {statusLook, statusTime} from '../code/Actions.tsx';
import {checksOf, cleanDescription} from './checks.ts';
import {type DiffExtras, type DiffHandle, DiffView} from '../code/DiffView.tsx';
import {useDiff} from '../code/History.tsx';
import {Ago, commitRow, Sha} from '../code/bits.tsx';
import {useLoad, useSource} from '../code/hooks.ts';
import {CodeLink, useCodeRows} from '../code/nav.tsx';
import {RowList} from '../code/RowList.tsx';
import {Unloaded} from '../code/states.tsx';

export type PullTabName = 'files' | 'commits' | 'checks';

interface TabProps {
  issue: Entity<'Issue'>;
  owner: string;
  repo: string;
}

/** The pull request's commits: from the pool, else API v1 (kept as a hint for offline). */
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
  if (!pr) return <EmptyState icon={GitPullRequest} title="Not on this device" description="This pull request's details have not arrived yet."/>;
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

// ---- files ----

type Item = {kind: 'comment'; c: Comment; pending: boolean} | {kind: 'draft'; d: ReviewDraft};

/** Identifies a composer (its line, and the draft it edits): where ReviewDiff keeps its text. */
const composerKey = (c: Composing) => `${String(c.f)}:${String(c.l)}:${c.key ?? ''}`;

const itemAnchor = (it: Item): Anchor => (it.kind === 'draft' ? it.d.anchor : commentAnchor(it.c));

/**
 * The open composer: its line, and the draft it edits (or a new one). Its text lives in the thread (typing
 * re-renders that thread only), kept by ReviewDiff too: a thread scrolled out of the virtual list and back,
 * or a new head, does not lose it.
 */
interface Composing {
  f: number;
  l: number;
  key?: string | undefined;
  initial: string;
}

const FilesTab = observer(function FilesTab({issue, owner, repo, pr, commits}: TabProps & {pr: PullRequest; commits: PullCommits}) {
  const diff = useDiff(pr.base_repo_id, commits.base, commits.head);
  // A new head (a push) keeps the diff on screen until the new one is here (or for good offline): the
  // review in progress — an open composer, the submit dialog — is not unmounted under the user.
  const [shown, setShown] = useState<{commits: PullCommits; files: DiffFile[]}>();
  if (diff.state === 'ready' && shown?.files !== diff.value) setShown({commits, files: diff.value});
  const view = diff.state === 'ready' ? {commits, files: diff.value} : shown;
  if (!view) return <Unloaded loaded={diff.state === 'ready' ? {state: 'loading'} : diff} what="This pull request's changes"/>;
  return <ReviewDiff issue={issue} owner={owner} repo={repo} pr={pr} commits={view.commits} files={view.files}/>;
});

/** The viewer's viewed files at the head on screen (newest state; B9 `?head=` for files changed since an older one). */
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

const ReviewDiff = observer(function ReviewDiff({issue, pr, commits, files}: TabProps & {pr: PullRequest; commits: PullCommits; files: DiffFile[]}) {
  const app = useApp();
  const pool = usePool();
  const {data, userId: me} = useSession();
  const {intents, overlay} = editing(app);
  // Comments are in the issue's group (and pending ones in the viewer's): hold it while the diff is open.
  useHold(data, `issue:${String(issue.id)}`);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [aside, setAside] = useState<HTMLElement | null>(null);
  const diffRef = useRef<DiffHandle>(null);
  const [current, setCurrent] = useState(0);
  const [composing, setComposing] = useState<Composing | undefined>();
  const [reviewing, setReviewing] = useState(false);
  const head = commits.head;
  // The open composer's text by composer (see Composing).
  const kept = useRef(new Map<string, string>());
  const keepText = useCallback((k: string, t: string | undefined) => {
    if (t === undefined) kept.current.delete(k);
    else kept.current.set(k, t);
  }, []);
  const keptText = useCallback((k: string) => kept.current.get(k), []);
  // A new head: the line numbers of the open composer may name other lines now. Its text becomes a draft on
  // the head it was written on (shown with the file's notes, quoted into the review: code/review.ts).
  // Viewed files start collapsed (below); the user's toggles win afterwards.
  const [toggled, setToggled] = useState<ReadonlyMap<number, boolean>>(() => new Map());
  const [composeHead, setComposeHead] = useState(head);
  if (composeHead !== head) {
    setComposeHead(head);
    setComposing(undefined);
    setToggled(new Map()); // by file index: the new diff's files are others
  }
  const before = useRef<{head: string; files: DiffFile[]; composing: Composing | undefined}>(undefined);
  useEffect(() => {
    const prev = before.current;
    before.current = {head, files, composing};
    if (!prev || prev.head === head) return;
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
  // Drafts written on another head cannot be placed by line number (lines may have moved): with the file's
  // notes, like outdated comments (submitting quotes them in the review's body: code/review.ts).
  const anchored = anchor(files, items, itemAnchor, head, (it) => it.kind === 'draft' || it.c.invalidated);
  const viewedNow = useViewed(issue.id, pr, head, me);
  // Stable while the sets' contents are (a new Set each render would rebuild every diff row).
  const viewedSig = `${viewedNow.commit}|${[...viewedNow.paths].sort().join('\0')}|${[...viewedNow.older].sort().join('\0')}|${[...viewedNow.changed ?? []].join('\0')}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed when the signature changes
  const viewed = useMemo(() => viewedNow, [viewedSig]);

  // Viewed files start collapsed; the user's toggles win afterwards.
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

  const startComment = useCallback((f: number, l: number) => {
    setComposing({f, l, initial: ''});
  }, []);
  /** The composer closed: back to the diff's line cursor (focus never falls to the page). */
  const closeComposer = useCallback(() => {
    setComposing(undefined);
    requestAnimationFrame(() => diffRef.current?.focus());
  }, []);
  // The file list beside the diff on a wide screen; on a narrow one it opens on demand (the diff needs the width).
  const [listOpen, setListOpen] = useState(() => typeof matchMedia !== 'function' || !matchMedia('(max-width: 767.98px)').matches);
  const indexed = useMemo(() => files.map((f, i) => ({f, i})), [files]);

  const threadKeys = new Set(anchored.lines.keys());
  if (composing) threadKeys.add(lineKey(composing.f, composing.l));
  const threadsSig = [...threadKeys].sort().join(',');
  const notesSig = [...anchored.files.keys()].join(',');
  // What the threads show (read through the ref): an edited comment, a review leaving PENDING, a draft edited
  // in another tab re-render them.
  const itemsSig = items.map((it) => (it.kind === 'comment' ? `${String(it.c.id)}.${String(it.c.content_version)}.${it.c.updated_at}.${String(it.pending)}.${String(it.c.invalidated)}` : `${it.d.key}.${String(it.d.at)}`)).join(',');
  const anchoredRef = useRef(anchored);
  anchoredRef.current = anchored;

  const extras: DiffExtras = useMemo(() => ({
    threads: new Set(threadsSig ? threadsSig.split(',') : []),
    notes: new Set(notesSig ? notesSig.split(',').map(Number) : []),
    collapsed,
    thread: (f, l) => <Thread issue={issue} pr={pr} f={f} l={l} file={files[f]} head={head} items={anchoredRef.current.lines.get(lineKey(f, l)) ?? []}
      composing={composing?.f === f && composing.l === l ? composing : undefined} setComposing={setComposing} onDone={closeComposer}
      keepText={keepText} keptText={keptText}/>,
    notesOf: (f) => <FileNotes items={anchoredRef.current.files.get(f) ?? []} repoId={pr.base_repo_id}/>,
    onComment: startComment,
    fileActions: (f) => {
      const path = files[f] ? filePath(files[f]) : '';
      const on = viewed.paths.has(path);
      return (
        <Button size="sm" pressed={on} icon={on ? Check : Eye} shortcut={shortcutHint('diff.viewed')}
          tooltip={viewed.older.has(path) ? 'Viewed at an earlier commit (not known whether it changed since)' : on ? 'Mark as not viewed' : 'Mark as viewed'}
          onClick={() => {
            setViewed(f, !on);
          }}>Viewed</Button>
      );
    },
    onToggle: (f) => {
      setToggled((t) => new Map(t).set(f, !collapsed.has(f)));
    },
  // The items are read through the ref; what changes rows is in the signatures.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [threadsSig, notesSig, collapsed, composing, files, viewed, head, issue, pr, setViewed, startComment, closeComposer, itemsSig, keepText, keptText]);

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
        <aside ref={setAside} aria-label="Changed files" className="w-pane shrink-0 overflow-y-auto border-r border-border">
          <div className="flex h-control items-center gap-2 px-3 text-sm text-fg-subtle tabular-nums">
            <span>{files.length} {files.length === 1 ? 'file' : 'files'}</span>
            <DiffStat additions={additions} deletions={deletions}/>
            <span className="ml-auto">{viewed.paths.size}/{files.length} viewed</span>
          </div>
          {/* One cursor with the diff: the file in view; J/K or ↑/↓ here (and [ ] in the diff) move both. */}
          <RowList items={indexed} scroller={aside} label="Changed files" keyOf={({f}) => filePath(f)} cursor={current}
            onCursor={(i) => {
              diffRef.current?.toFile(i);
            }}
            row={({f, i}) => {
              const n = counts.get(i);
              return {
                leading: <Icon icon={viewed.paths.has(filePath(f)) ? CircleCheck : FileDiff} size="sm"/>,
                main: <span title={filePath(f)}>{filePath(f)}</span>,
                trailing: n ? <span className="flex items-center gap-1"><Icon icon={MessageSquare} size="sm"/>{n}</span> : undefined,
              };
            }}
            onOpen={({i}) => {
              diffRef.current?.toFile(i);
              diffRef.current?.focus();
            }}/>
        </aside>
      )}
      <div ref={setScroller} className="min-w-0 flex-1 overflow-auto">
        <ReviewBar pr={pr} head={head} drafts={drafts} listOpen={listOpen} open={!pr.merged && issue.get('state') === 'open'} onList={() => {
          setListOpen((o) => !o);
        }} onReview={() => {
          setReviewing(true);
        }}/>
        {anchored.elsewhere.length > 0 && <div className="sticky left-0 w-view"><FileNotes items={anchored.elsewhere} title="Comments on files not in this diff" repoId={pr.base_repo_id}/></div>}
        <DiffView key={`${commits.base}:${head}`} ref={diffRef} repoId={pr.base_repo_id} base={commits.base} head={head} files={files} scroller={scroller} extras={extras} onFile={setCurrent}/>
      </div>
      <ReviewDialog open={reviewing} onOpenChange={setReviewing} issue={issue} pr={pr} head={head} drafts={drafts}/>
    </div>
  );
});

/** Above the diff: the head on screen, the drafts, and the review button. */
const ReviewBar = observer(function ReviewBar({pr, head, drafts, listOpen, onList, onReview, open}: {pr: PullRequest; head: string; drafts: ReviewDraft[]; listOpen: boolean; onList: () => void; onReview: () => void; open: boolean}) {
  return (
    // Sticky: the pending count and Review stay in reach anywhere in a long diff.
    <div className="sticky top-0 left-0 z-sticky flex h-control w-view items-center gap-2 border-b border-border-subtle bg-surface px-3 text-sm text-fg-muted">
      <IconButton size="sm" icon={listOpen ? PanelLeftClose : PanelLeftOpen} label={listOpen ? 'Hide the file list' : 'Show the file list'} onClick={onList}/>
      <span className="min-w-0 truncate">Changes from <Sha sha={pr.merge_base}/> to <Sha sha={head}/></span>
      {drafts.length > 0 && <Badge tone="accent">{drafts.length} pending {drafts.length === 1 ? 'comment' : 'comments'}</Badge>}
      {/* A merged or closed pull request takes no review. */}
      {open && <span className="ml-auto"><Button size="sm" variant="primary" shortcut={shortcutHint('review.start')} tooltip="Submit a review (works offline: sent when you are back)" onClick={onReview}>Review</Button></span>}
    </div>
  );
});

/** A line's thread: comments (posted, pending in Forgejo, drafted here) and the composer. */
const Thread = observer(function Thread({issue, pr, f, l, file, head, items, composing, setComposing, onDone, keepText, keptText}: {
  issue: Entity<'Issue'>; pr: PullRequest; f: number; l: number; file: DiffFile | undefined; head: string; items: Item[];
  composing: Composing | undefined; setComposing: (c: Composing | undefined) => void; onDone: () => void;
  keepText: (k: string, t: string | undefined) => void; keptText: (k: string) => string | undefined;
}) {
  const app = useApp();
  const {intents} = editing(app);
  // The text kept for this composer (it was scrolled out of the list and back), else what it edits.
  const [text, setText] = useState(() => (composing ? keptText(composerKey(composing)) ?? composing.initial : ''));
  const [was, setWas] = useState(composing);
  // Another composer opened on this line (a draft to edit): its text.
  if (was !== composing) {
    setWas(composing);
    setText(composing ? keptText(composerKey(composing)) ?? composing.initial : '');
  }
  const edit = (t: string) => {
    setText(t);
    if (composing) keepText(composerKey(composing), t);
  };
  const done = () => {
    if (composing) keepText(composerKey(composing), undefined);
    onDone();
  };
  const save = () => {
    const a = file && lineAnchor(file, l, head);
    if (!a || !text.trim()) return;
    saveDraft(intents, {issueId: issue.id, repoId: pr.base_repo_id, number: issue.get('number'), anchor: a, text, key: composing?.key});
    done();
  };
  // A thread with posted comments: answer it at once (a one-comment review, as Forgejo's "Reply" does), or resolve it
  // (no API resolves a conversation: the classic page of the files does).
  const posted = items.some((it) => it.kind === 'comment');
  const reply = composing !== undefined && composing.key === undefined && posted;
  const replyNow = () => {
    const a = file && lineAnchor(file, l, head);
    if (!a || !text.trim()) return;
    submitReview(intents, {issueId: issue.id, repoId: pr.base_repo_id, head, event: 'COMMENT', body: '', drafts: [{key: `reply:${uuid()}`, anchor: a, text, at: Date.now()}]});
    done();
    if (!connectivity.online) notify(app, {tone: 'neutral', title: 'Reply queued', description: 'It is sent when you are back online.'});
  };
  const repo = usePool().model('Repository').get(pr.base_repo_id)?.data;
  return (
    <div className="flex flex-col gap-2 border-y border-border-subtle bg-canvas py-3 pr-4 pl-thread">
      {items.map((it) => (it.kind === 'comment' ?
        <CommentCard key={`c${String(it.c.id)}`} c={it.c} pending={it.pending}/> :
        composing?.key === it.d.key ? null : <DraftCard key={it.d.key} d={it.d} repoId={pr.base_repo_id} onEdit={() => {
          setComposing({f, l, key: it.d.key, initial: it.d.text});
        }} onDelete={() => {
          void intents.discardDraft(it.d.key);
        }}/>))}
      {composing && (
        <Card label={reply ? 'Reply' : 'New review comment'}>
          <MarkdownField repoId={pr.base_repo_id} label={reply ? 'Reply' : 'Review comment'} value={text} autoFocus rows={3} onChange={edit} onSubmit={reply ? replyNow : save} onCancel={done}/>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={done}>Cancel</Button>
            {reply && <Button size="sm" disabled={!text.trim()} tooltip="Keep it with your review (sent with Review)" onClick={save}>Add to review</Button>}
            {reply ?
              <Button size="sm" variant="primary" shortcut={shortcutHint('submit')} disabled={!text.trim()} onClick={replyNow}>Reply</Button> :
              <Button size="sm" variant="primary" shortcut={shortcutHint('submit')} disabled={!text.trim()} onClick={save}>{composing.key ? 'Update comment' : 'Add review comment'}</Button>}
          </div>
        </Card>
      )}
      {!composing && posted && (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" icon={Reply} onClick={() => {
            setComposing({f, l, initial: ''});
          }}>Reply</Button>
          {repo && <ClassicLink size="sm" to={`/${encodeURIComponent(repo.owner_name)}/${encodeURIComponent(repo.name)}/pulls/${String(issue.get('number'))}/files`}>Resolve</ClassicLink>}
        </div>
      )}
    </div>
  );
});

function CardShell({who, when, badge, actions, children}: {who: ReactNode; when?: string | undefined; badge?: ReactNode; actions?: ReactNode; children: ReactNode}) {
  return (
    <Card as="article">
      <header className="flex items-center gap-2 text-sm">
        {who}
        {when && <span className="text-fg-subtle"><Ago at={when}/></span>}
        {badge}
        {actions && <span className="ml-auto flex items-center gap-1">{actions}</span>}
      </header>
      {children}
    </Card>
  );
}

const CommentCard = observer(function CommentCard({c, pending}: {c: Comment; pending: boolean}) {
  return (
    <CardShell who={<><UserAvatar id={c.poster_id}/><UserName id={c.poster_id} fallback={c.original_author || 'Someone'}/></>} when={c.created_at}
      badge={<>{pending && <Badge tone="warning">Pending</Badge>}{c.invalidated && <Badge>Outdated</Badge>}</>}>
      {c.body_html ? <Markdown html={c.body_html}/> : <ProseSource text={c.body}/>}
    </CardShell>
  );
});

function DraftCard({d, repoId, onEdit, onDelete}: {d: ReviewDraft; repoId: number; onEdit?: (() => void) | undefined; onDelete: () => void}) {
  return (
    <CardShell who={<span className="font-medium text-fg">Your comment</span>} badge={<Badge tone="accent">Draft</Badge>}
      actions={<>
        {onEdit && <IconButton size="sm" icon={Pencil} label="Edit the comment" onClick={onEdit}/>}
        <IconButton size="sm" icon={Trash2} label="Delete the comment" onClick={onDelete}/>
      </>}>
      {/* Rendered as it will be posted (Forgejo's rendering online; the text as written offline). */}
      <MarkdownPreview repoId={repoId} text={d.text}/>
    </CardShell>
  );
}

/** Comments of a file that are not on a line shown (outdated, outside the hunks), or on files not in the diff. */
const FileNotes = observer(function FileNotes({items, title, repoId}: {items: Item[]; title?: string; repoId: number}) {
  const app = useApp();
  const {intents} = editing(app);
  return (
    <div className="flex flex-col gap-2 border-b border-border-subtle bg-canvas px-4 py-3">
      <SectionHeading>{title ?? 'Comments not on the lines shown'}</SectionHeading>
      {items.map((it) => {
        const a = itemAnchor(it);
        return (
          <div key={it.kind === 'comment' ? `c${String(it.c.id)}` : it.d.key} className="flex flex-col gap-1">
            <span className="font-mono text-code text-fg-muted">{a.path}:{a.line} ({a.side === 'old' ? 'old' : 'new'}, {shortSha(a.commit)})</span>
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

/** Submit the review: one offline intent pinned to the head on screen, carrying the drafts. */
const ReviewDialog = observer(function ReviewDialog({open, onOpenChange, issue, pr, head, drafts}: {
  open: boolean; onOpenChange: (open: boolean) => void; issue: Entity<'Issue'>; pr: PullRequest; head: string; drafts: ReviewDraft[];
}) {
  const app = useApp();
  const {userId} = useSession();
  const {intents} = editing(app);
  const [body, setBody] = useState('');
  const [event, setEvent] = useState<ReviewEvent>('COMMENT');
  const own = issue.get('poster_id') === userId;
  const {stale} = partition(drafts, head);
  const needsBody = event === 'REQUEST_CHANGES' || (event === 'COMMENT' && !drafts.length);
  const ok = !needsBody || body.trim() !== '';
  const submit = () => {
    if (!ok) return;
    submitReview(intents, {issueId: issue.id, repoId: pr.base_repo_id, head, event, body, drafts});
    setBody('');
    onOpenChange(false);
    if (!connectivity.online) notify(app, {tone: 'neutral', title: 'Review queued', description: 'It is sent when you are back online.'});
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="md" title="Submit review"
      description={`On ${shortSha(head)}${drafts.length ? ` · ${String(drafts.length)} ${drafts.length === 1 ? 'comment' : 'comments'}` : ''}`}
      footer={<>
        <Button variant="ghost" onClick={() => {
          onOpenChange(false);
        }}>Cancel</Button>
        <Button variant="primary" disabled={!ok} shortcut={shortcutHint('submit')} onClick={submit}>Submit review</Button>
      </>}>
      <div className="flex flex-col gap-3">
        {stale.length > 0 && (
          <Callout tone="warning" title={`${String(stale.length)} ${stale.length === 1 ? 'comment was' : 'comments were'} written on an earlier commit`}>
            They are added to the review's text with their file and line, since their lines may have moved.
          </Callout>
        )}
        <MarkdownField repoId={pr.base_repo_id} label="Review summary" value={body} onChange={setBody} rows={4} onSubmit={submit} autoFocus/>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl label="Verdict" value={event} onChange={setEvent} options={EVENTS.map((e) => ({value: e.event, label: e.label, disabled: own && !e.own}))}/>
          {own && <span className="text-sm text-fg-subtle">Your own pull request: comment only.</span>}
          {needsBody && !body.trim() && <span className="text-sm text-fg-subtle">{event === 'REQUEST_CHANGES' ? 'Say what to change.' : 'Write a summary or add comments.'}</span>}
        </div>
      </div>
    </Dialog>
  );
});

// ---- commits ----

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
          row={commitRow}
          onOpen={rows.onOpen} linkOf={rows.linkOf}/>}
    </div>
  );
});

// ---- checks ----

const ChecksTab = observer(function ChecksTab({owner, repo, pr, commits}: TabProps & {pr: PullRequest; commits: PullCommits}) {
  const pool = usePool();
  const {statuses, runs} = checksOf(pool, pr, commits.head);
  if (!statuses.length && !runs.length) return <EmptyState icon={Workflow} title="No checks" description={`Nothing reported for ${shortSha(commits.head)} on this device.`}/>;
  return (
    <PageColumn>
      {runs.length > 0 && (
        <section aria-label="Workflow runs" className="flex flex-col">
          <SectionHeading>Workflow runs</SectionHeading>
          {runs.map((r) => <RunRow key={r.id} owner={owner} repo={repo} runId={r.id} runNumber={r.data.run_number}/>)}
        </section>
      )}
      {statuses.length > 0 && (
        <section aria-label="Statuses" className="flex flex-col">
          <SectionHeading>Statuses</SectionHeading>
          {statuses.map((s) => {
            const look = statusLook(s.get('state') === 'error' ? 'failure' : s.get('state') === 'pending' ? 'waiting' : s.get('state'));
            const url = s.get('target_url');
            const description = cleanDescription(s.get('description'));
            return (
              <ListRow key={s.id} role="presentation" leading={<StatusDot tone={look.tone}/>} trailing={look.text}>
                {/^https?:\/\//.test(url) ? <TextLink><a href={url} target="_blank" rel="noopener noreferrer">{s.get('context')}</a></TextLink> : s.get('context')}
                {description && <span className="text-fg-subtle"> {description}</span>}
              </ListRow>
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
      {jobs.map((j, i) => {
        const look = statusLook(j.get('status'));
        return (
          <CodeLink key={j.id} owner={owner} repo={repo} to={`actions/runs/${String(runNumber)}/jobs/${String(i)}`}>
            <ListRow role="presentation" leading={<StatusDot tone={look.tone}/>} trailing={statusTime(look.text, j.get('started'), j.get('stopped'))}>
              {run.get('workflow_id')} / {j.get('name')}
            </ListRow>
          </CodeLink>
        );
      })}
    </>
  );
});

// ---- merge ----

const STYLES = [['merge', 'Create a merge commit'], ['rebase', 'Rebase'], ['rebase-merge', 'Rebase and merge commit'], ['squash', 'Squash'], ['fast-forward-only', 'Fast-forward only']] as const;

/** Merge, update branch, auto-merge (PLAN §5.4: online only, never queued; disabled offline with the reason). Writers only. */
export const MergeBox = observer(function MergeBox({issue}: {issue: Entity<'Issue'>}) {
  const app = useApp();
  const session = useSession();
  const pool = usePool();
  const pr = pullOf(pool, issue.id);
  const [busy, setBusy] = useState(false);
  const [style, setStyle] = useState<MergeStyle | undefined>(undefined);
  if (!pr) return null;
  const repo = pool.model('Repository').get(pr.base_repo_id)?.data;
  const auto = [...pool.model('AutoMerge').by('pull_id', pr.id)][0];
  const isOnline = connectivity.online;
  const closed = issue.get('state') === 'closed';
  const write = canWrite(session, pr.base_repo_id);
  const path = repo ? `/repos/${encodeURIComponent(repo.owner_name)}/${encodeURIComponent(repo.name)}/pulls/${String(pr.number)}` : '';
  /** An online action: what it did (said when it succeeds), what failed (said with the server's reason). */
  const run = (words: {done: string; failed: string}, req: Parameters<typeof online>[1]) => {
    setBusy(true);
    online(app, req).then(() => {
      notify(app, {tone: 'success', title: words.done});
    }, (err: unknown) => {
      notify(app, {tone: 'danger', title: words.failed, description: err instanceof RequestFailed ? err.message : String(err)});
    }).finally(() => {
      setBusy(false);
    });
  };
  const offlineWhy = (action: string) => (isOnline ? undefined : onlineOnly(action));
  // The head on screen: Forgejo refuses the merge if a push landed since (nothing unseen is merged).
  const headSeen = poolHead(pool, pr);
  const seen = headSeen ? {head_commit_id: headSeen} : {};
  const sum = headSeen ? checksOf(pool, pr, headSeen) : undefined;
  const checks = sum?.summary ?? 'none';
  // Checks still running (the merge dialog says how many; merging waits for them by default).
  const unfinished = sum ? [...sum.statuses.map((x) => x.get('state')), ...sum.runs.map((r) => r.data.status)].filter((st) => PENDING_CHECKS.has(st)).length : 0;
  const behind = pr.commits_behind > 0 ? ` · ${String(pr.commits_behind)} behind ${pr.base_branch}` : '';
  let state: ReactNode;
  if (pr.merged) {
    state = (
      <>
        <Icon icon={GitMerge} className="text-done"/> Merged{pr.merged_at ? <> <time dateTime={pr.merged_at} title={fullDate(pr.merged_at)}>{agoWords(pr.merged_at)}</time></> : ''}
        {pr.merge_commit_sha && repo && <> as <TextLink><CodeLink owner={repo.owner_name} repo={repo.name} to={`commit/${pr.merge_commit_sha}`}><Sha sha={pr.merge_commit_sha}/></CodeLink></TextLink></>}
      </>
    );
  } else if (closed) state = 'Closed without merging';
  else if (pr.status === 'conflict') state = <><StatusDot tone="danger"/> Conflicts: {pr.conflicted_files.join(', ') || 'resolve them first'}</>;
  else if (pr.status === 'checking') state = <><StatusDot tone="warning"/> Checking whether it can be merged…</>;
  else if (checks === 'pending') state = <><StatusDot tone="warning"/> Checks are not done yet{behind}</>;
  else if (checks === 'failure') state = <><StatusDot tone="danger"/> Some checks failed{behind}</>;
  else state = <><StatusDot tone="success"/> {checks === 'success' ? 'Checks passed · can be merged' : 'Can be merged'}{behind}</>;
  return (
    <div className="mt-4"><Card as="section" label="Merge">
      <p className="flex flex-wrap items-center gap-2 text-base text-fg">{state}</p>
      {auto && !pr.merged && <p className="text-sm text-fg-muted">Merges automatically when the checks succeed ({auto.data.merge_style}).</p>}
      {!pr.merged && !closed && path && write && (
        <div className="flex flex-wrap items-center gap-2">
          <Menu>
            <MenuTrigger asChild>
              {/* With checks running or failing, merging now is not the default (Merge when checks succeed is). */}
              <Button variant={checks === 'failure' || checks === 'pending' ? 'secondary' : 'primary'} icon={GitMerge} disabled={!isOnline || busy || pr.status === 'conflict'}
                tooltip={offlineWhy('Merging') ?? (checks === 'pending' ? 'Merge now, before the checks finish' : undefined)}>
                {checks === 'pending' ? 'Merge now…' : 'Merge…'}<Icon icon={ChevronDown} size="sm"/>
              </Button>
            </MenuTrigger>
            <MenuContent>
              {STYLES.map(([s, label]) => (
                <MenuItem key={s} onSelect={() => {
                  setStyle(s);
                }}>{label}…</MenuItem>
              ))}
            </MenuContent>
          </Menu>
          {auto ?
            <Button disabled={!isOnline || busy} tooltip={offlineWhy('Canceling the auto-merge')} onClick={() => {
              run({done: 'Auto-merge canceled', failed: 'Canceling the auto-merge failed'}, {method: 'DELETE', api: 'v1', path: `${path}/merge`});
            }}>Cancel auto-merge</Button> :
            checks === 'pending' && <Button variant="primary" icon={GitMerge} disabled={!isOnline || busy} tooltip={offlineWhy('Scheduling the merge') ?? 'Merge when all checks succeed'} onClick={() => {
              run({done: `Merges into ${pr.base_branch} when the checks succeed`, failed: 'Scheduling the merge failed'},
                {method: 'POST', api: 'v1', path: `${path}/merge`, body: {Do: 'merge', merge_when_checks_succeed: true, ...seen}});
            }}>Merge when checks succeed</Button>}
          {pr.commits_behind > 0 && (
            <Button disabled={!isOnline || busy} tooltip={offlineWhy('Updating the branch') ?? `Merge ${pr.base_branch} into this branch`} onClick={() => {
              run({done: `Updated with ${pr.base_branch}`, failed: 'Updating the branch failed'}, {method: 'POST', api: 'v1', path: `${path}/update?style=merge`});
            }}>Update branch</Button>
          )}
          {!isOnline && <span className="text-sm text-fg-subtle">{onlineOnly('Merging')}</span>}
          {isOnline && pr.status === 'conflict' && <span className="text-sm text-fg-subtle">Resolve the conflicts to merge.</span>}
        </div>
      )}
      {style && (
        <MergeDialog pr={pr} title={issue.get('title')} style={style} checks={checks} unfinished={unfinished} onClose={() => {
          setStyle(undefined);
        }} onMerge={(body) => {
          setStyle(undefined);
          run({done: `Merged into ${pr.base_branch}`, failed: 'Merging failed'}, {method: 'POST', api: 'v1', path: `${path}/merge`, body: {Do: style, ...body, ...seen}, timeout: 60_000});
        }}/>
      )}
    </Card></div>
  );
});

type MergeStyle = typeof STYLES[number][0];

/** Check states that are not finished (checks.ts sums them as pending). */
const PENDING_CHECKS = new Set(['pending', 'waiting', 'running', 'blocked']);

/** Merging is not undone: the commit message and whether the branch goes, confirmed first. */
function MergeDialog({pr, title, style, checks, unfinished, onClose, onMerge}: {
  pr: PullRequest; title: string; style: MergeStyle; checks: string; unfinished: number; onClose: () => void; onMerge: (body: Record<string, unknown>) => void;
}) {
  const label = STYLES.find(([s]) => s === style)?.[1] ?? style;
  const commit = style === 'merge' || style === 'squash' || style === 'rebase-merge';
  const [head, setHead] = useState(style === 'squash' ? `${title} (#${String(pr.number)})` : `Merge pull request '${title}' (#${String(pr.number)}) from ${pr.head_branch} into ${pr.base_branch}`);
  const [message, setMessage] = useState('');
  const [drop, setDrop] = useState(false);
  const merge = () => {
    onMerge({...(commit ? {MergeTitleField: head, MergeMessageField: message} : {}), delete_branch_after_merge: drop});
  };
  return (
    <Dialog open size="md" title={label} description={`Into ${pr.base_branch}, from ${pr.head_branch}. This cannot be undone.`} onOpenChange={(o) => {
      if (!o) onClose();
    }} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" icon={GitMerge} onClick={merge}>Merge</Button>
    </>}>
      <div className="flex flex-col gap-3">
        {checks === 'pending' && (
          <Callout tone="warning" title={`${String(unfinished)} ${unfinished === 1 ? 'check has' : 'checks have'} not finished`}>
            Merging now does not wait for {unfinished === 1 ? 'it' : 'them'}. “Merge when checks succeed” waits.
          </Callout>
        )}
        {checks === 'failure' && <Callout tone="danger" title="Some checks failed">Merging now merges changes whose checks did not pass.</Callout>}
        {commit && <Input aria-label="Commit title" value={head} className="w-full" onChange={(e) => {
          setHead(e.target.value);
        }}/>}
        {commit && <TextArea aria-label="Commit message" placeholder="Commit message (optional)" rows={4} value={message} onChange={(e) => {
          setMessage(e.target.value);
        }}/>}
        {pr.head_repo_id === pr.base_repo_id && <Checkbox label={`Delete the branch ${pr.head_branch} afterwards`} checked={drop} onChange={setDrop}/>}
      </div>
    </Dialog>
  );
}
