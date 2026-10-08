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

import {useNavigate} from '@tanstack/react-router';
import {Check, CircleCheck, Eye, FileDiff, GitMerge, GitPullRequest, MessageSquare, Pencil, Trash2, Workflow} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useCallback, useMemo, useRef, useState} from 'react';
import {online, RequestFailed} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {connectivity, onlineOnly} from '../../app/online.ts';
import {useHold} from '../../app/repo.ts';
import {shortcutHint, useShortcut} from '../../app/shortcuts/index.ts';
import {useApp, useSession} from '../../app/store.ts';
import {anchor, type Anchor, commentAnchor, lineAnchor, lineKey} from '../../code/anchor.ts';
import {type DiffFile, filePath} from '../../code/diff.ts';
import {fetchCommits, poolCommits, pullOf, type PullCommits} from '../../code/pull.ts';
import {shortSha} from '../../code/refs.ts';
import {partition, type ReviewDraft, reviewDrafts, type ReviewEvent, saveDraft, submitReview} from '../../code/review.ts';
import {type CompareInfo, NotCached} from '../../code/source.ts';
import {newestState, viewedAt} from '../../code/viewed.ts';
import type {Entity} from '../../data/entity.ts';
import {editing} from '../../intents/session.ts';
import type {Comment, PullRequest} from '../../protocol/types.gen.ts';
import {
  Avatar, Badge, Button, Callout, Dialog, EmptyState, Icon, IconButton, ListRow, Menu, MenuContent, MenuItem, MenuTrigger, ProseSource,
  SectionHeading, StatusDot, TextLink,
} from '../../ui/index.ts';
import {MarkdownField} from '../editor/Composer.tsx';
import {Markdown} from '../issue/Markdown.tsx';
import {usePool, UserAvatar, useUser} from '../issues/cells.tsx';
import {ago, fullDate} from '../issues/format.ts';
import {statusLook} from '../code/Actions.tsx';
import {type DiffExtras, type DiffHandle, DiffView} from '../code/DiffView.tsx';
import {summary, useDiff} from '../code/History.tsx';
import {useLoad, useSource} from '../code/hooks.ts';
import {CodeLink, codeTo} from '../code/nav.tsx';
import {RowList} from '../code/RowList.tsx';
import {Unloaded} from '../code/states.tsx';

export type PullTabName = 'files' | 'commits' | 'checks';

interface TabProps {
  issue: Entity<'Issue'>;
  owner: string;
  repo: string;
}

/** The pull request's commits: from the pool, else API v1 (kept as a hint for offline). */
function usePullCommits(issueId: number): {pr: PullRequest | undefined; commits: PullCommits | undefined; loading: ReturnType<typeof useLoad<PullCommits>>} {
  const pool = usePool();
  const app = useApp();
  const src = useSource();
  const pr = pullOf(pool, issueId);
  const fromPool = pr ? poolCommits(pool, pr) : undefined;
  const loading = useLoad<PullCommits>(pr && !fromPool ? `prhint:${String(pr.id)}:${pr.merge_base}` : undefined, () => undefined, async () => {
    const c = pr ? await fetchCommits(app, src, pr) : undefined;
    if (!c) throw new NotCached('the head commit is not known on this device');
    return c;
  });
  return {pr, commits: fromPool ?? (loading.state === 'ready' ? loading.value : undefined), loading};
}

export const PullTab = observer(function PullTab({tab, ...props}: TabProps & {tab: PullTabName}) {
  const {pr, commits, loading} = usePullCommits(props.issue.id);
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

const itemAnchor = (it: Item): Anchor => (it.kind === 'draft' ? it.d.anchor : commentAnchor(it.c));

interface Composing {
  f: number;
  l: number;
  /** Editing a draft (its key), or a new one. */
  key?: string | undefined;
  text: string;
}

const FilesTab = observer(function FilesTab({issue, owner, repo, pr, commits}: TabProps & {pr: PullRequest; commits: PullCommits}) {
  const diff = useDiff(pr.base_repo_id, commits.base, commits.head);
  if (diff.state !== 'ready') return <Unloaded loaded={diff} what="This pull request's changes"/>;
  return <ReviewDiff issue={issue} owner={owner} repo={repo} pr={pr} commits={commits} files={diff.value}/>;
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
  return viewedAt(state, head, changed.state === 'ready' ? new Set(changed.value) : undefined, overlay.members('ViewedFile', issueId));
}

const ReviewDiff = observer(function ReviewDiff({issue, pr, commits, files}: TabProps & {pr: PullRequest; commits: PullCommits; files: DiffFile[]}) {
  const app = useApp();
  const pool = usePool();
  const {data, userId: me} = useSession();
  const {intents} = editing(app);
  // Comments are in the issue's group (and pending ones in the viewer's): hold it while the diff is open.
  useHold(data, `issue:${String(issue.id)}`);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [aside, setAside] = useState<HTMLElement | null>(null);
  const diffRef = useRef<DiffHandle>(null);
  const [current, setCurrent] = useState(0);
  const [composing, setComposing] = useState<Composing | undefined>();
  const [reviewing, setReviewing] = useState(false);
  const head = commits.head;

  const comments: Item[] = [];
  for (const e of pool.model('Comment').by('issue_id', issue.id)) {
    const c = e.data;
    if (c.type !== 'code') continue;
    const review = c.review_id ? pool.model('Review').get(c.review_id)?.data : undefined;
    comments.push({kind: 'comment', c, pending: review?.state === 'PENDING'});
  }
  const drafts = reviewDrafts(intents, issue.id);
  const items = [...comments, ...drafts.map((d): Item => ({kind: 'draft', d}))];
  const anchored = anchor(files, items, itemAnchor, head, (it) => it.kind === 'comment' && it.c.invalidated);
  const viewed = useViewed(issue.id, pr, head, me);

  // Viewed files start collapsed; the user's toggles win afterwards.
  const [toggled, setToggled] = useState<ReadonlyMap<number, boolean>>(() => new Map());
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
    intents.submit({kind: 'pr.viewed', issueId: issue.id, repoId: pr.base_repo_id, commitSha: head, files: {[filePath(file)]: on}});
    setToggled((t) => new Map(t).set(f, on));
  }, [files, intents, issue.id, pr.base_repo_id, head]);

  const startComment = useCallback((f: number, l: number) => {
    setComposing({f, l, text: ''});
  }, []);

  const threadKeys = new Set(anchored.lines.keys());
  if (composing) threadKeys.add(lineKey(composing.f, composing.l));
  const threadsSig = [...threadKeys].sort().join(',');
  const notesSig = [...anchored.files.keys()].join(',');
  const anchoredRef = useRef(anchored);
  anchoredRef.current = anchored;

  const extras: DiffExtras = useMemo(() => ({
    threads: new Set(threadsSig ? threadsSig.split(',') : []),
    notes: new Set(notesSig ? notesSig.split(',').map(Number) : []),
    collapsed,
    thread: (f, l) => <Thread issue={issue} pr={pr} f={f} l={l} file={files[f]} head={head} items={anchoredRef.current.lines.get(lineKey(f, l)) ?? []}
      composing={composing?.f === f && composing.l === l ? composing : undefined} setComposing={setComposing}/>,
    notesOf: (f) => <FileNotes items={anchoredRef.current.files.get(f) ?? []}/>,
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
  }), [threadsSig, notesSig, collapsed, composing, files, viewed, head, issue, pr, setViewed, startComment, drafts.length, comments.length]);

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
      <aside ref={setAside} aria-label="Changed files" className="w-pane shrink-0 overflow-y-auto border-r border-border">
        <div className="flex h-control items-center gap-2 px-3 text-sm text-fg-subtle tabular-nums">
          <span>{files.length} {files.length === 1 ? 'file' : 'files'}</span>
          <span className="text-success">+{additions}</span><span className="text-danger">−{deletions}</span>
          <span className="ml-auto">{viewed.paths.size}/{files.length} viewed</span>
        </div>
        <RowList items={files} scroller={aside} label="Changed files" keyOf={(f) => filePath(f)}
          row={(f) => {
            const i = files.indexOf(f);
            const n = counts.get(i);
            return {
              leading: <span className={i === current ? 'text-accent-fg' : undefined}><Icon icon={viewed.paths.has(filePath(f)) ? CircleCheck : FileDiff} size="sm"/></span>,
              main: <span title={filePath(f)} className={i === current ? 'font-medium' : undefined}>{filePath(f)}</span>,
              trailing: n ? <span className="flex items-center gap-1"><Icon icon={MessageSquare} size="sm"/>{n}</span> : undefined,
            };
          }}
          onOpen={(f) => {
            diffRef.current?.toFile(files.indexOf(f));
          }}/>
      </aside>
      <div ref={setScroller} className="min-w-0 flex-1 overflow-auto">
        <ReviewBar pr={pr} head={head} drafts={drafts} onReview={() => {
          setReviewing(true);
        }}/>
        {anchored.elsewhere.length > 0 && <FileNotes items={anchored.elsewhere} title="Comments on files not in this diff"/>}
        <DiffView ref={diffRef} repoId={pr.base_repo_id} base={commits.base} head={head} files={files} scroller={scroller} extras={extras} onFile={setCurrent}/>
      </div>
      <ReviewDialog open={reviewing} onOpenChange={setReviewing} issue={issue} pr={pr} head={head} drafts={drafts}/>
    </div>
  );
});

/** Above the diff: the head on screen, the drafts, and the review button. */
const ReviewBar = observer(function ReviewBar({pr, head, drafts, onReview}: {pr: PullRequest; head: string; drafts: ReviewDraft[]; onReview: () => void}) {
  return (
    <div className="flex h-control items-center gap-3 border-b border-border-subtle px-4 text-sm text-fg-muted">
      <span>Changes from <span className="font-mono">{shortSha(pr.merge_base)}</span> to <span className="font-mono">{shortSha(head)}</span></span>
      {drafts.length > 0 && <Badge tone="accent">{drafts.length} pending {drafts.length === 1 ? 'comment' : 'comments'}</Badge>}
      <span className="ml-auto"><Button size="sm" variant="primary" shortcut={shortcutHint('review.start')} tooltip="Submit a review (works offline: sent when you are back)" onClick={onReview}>Review</Button></span>
    </div>
  );
});

/** A line's thread: comments (posted, pending in Forgejo, drafted here) and the composer. */
const Thread = observer(function Thread({issue, pr, f, l, file, head, items, composing, setComposing}: {
  issue: Entity<'Issue'>; pr: PullRequest; f: number; l: number; file: DiffFile | undefined; head: string; items: Item[];
  composing: Composing | undefined; setComposing: (c: Composing | undefined) => void;
}) {
  const app = useApp();
  const {intents} = editing(app);
  const save = () => {
    const a = file && lineAnchor(file, l, head);
    if (!a || !composing?.text.trim()) return;
    saveDraft(intents, {issueId: issue.id, repoId: pr.base_repo_id, number: issue.get('number'), anchor: a, text: composing.text, key: composing.key});
    setComposing(undefined);
  };
  return (
    <div className="flex flex-col gap-2 border-y border-border-subtle bg-canvas px-4 py-3 pl-28">
      {items.map((it) => (it.kind === 'comment' ?
        <CommentCard key={`c${String(it.c.id)}`} c={it.c} pending={it.pending}/> :
        composing?.key === it.d.key ? null : <DraftCard key={it.d.key} d={it.d} onEdit={() => {
          setComposing({f, l, key: it.d.key, text: it.d.text});
        }} onDelete={() => {
          void intents.discardDraft(it.d.key);
        }}/>))}
      {composing && (
        <div className="flex max-w-lg flex-col gap-2 rounded-md border border-border bg-surface p-2">
          <MarkdownField repoId={pr.base_repo_id} label="Review comment" value={composing.text} autoFocus rows={3}
            onChange={(text) => {
              setComposing({...composing, text});
            }}
            onSubmit={save}
            onCancel={() => {
              setComposing(undefined);
            }}/>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => {
              setComposing(undefined);
            }}>Cancel</Button>
            <Button size="sm" variant="primary" shortcut={shortcutHint('submit')} disabled={!composing.text.trim()} onClick={save}>{composing.key ? 'Update comment' : 'Add review comment'}</Button>
          </div>
        </div>
      )}
    </div>
  );
});

function CardShell({who, when, badge, actions, children}: {who: ReactNode; when?: string | undefined; badge?: ReactNode; actions?: ReactNode; children: ReactNode}) {
  return (
    <article className="flex max-w-lg flex-col gap-1.5 rounded-md border border-border bg-surface p-3">
      <header className="flex items-center gap-2 text-sm">
        {who}
        {when && <time dateTime={when} title={fullDate(when)} className="text-fg-subtle">{ago(when)}</time>}
        {badge}
        {actions && <span className="ml-auto flex items-center gap-1">{actions}</span>}
      </header>
      {children}
    </article>
  );
}

const CommentCard = observer(function CommentCard({c, pending}: {c: Comment; pending: boolean}) {
  const u = useUser(c.poster_id);
  return (
    <CardShell who={<><UserAvatar id={c.poster_id}/><span className="font-medium text-fg">{c.poster_id ? u.name : c.original_author || 'Someone'}</span></>} when={c.created_at}
      badge={<>{pending && <Badge tone="warning">Pending</Badge>}{c.invalidated && <Badge>Outdated</Badge>}</>}>
      {c.body_html ? <Markdown html={c.body_html}/> : <ProseSource text={c.body}/>}
    </CardShell>
  );
});

function DraftCard({d, onEdit, onDelete}: {d: ReviewDraft; onEdit: () => void; onDelete: () => void}) {
  return (
    <CardShell who={<span className="font-medium text-fg">Your comment</span>} badge={<Badge tone="accent">Draft</Badge>}
      actions={<>
        <IconButton size="sm" icon={Pencil} label="Edit the comment" onClick={onEdit}/>
        <IconButton size="sm" icon={Trash2} label="Delete the comment" onClick={onDelete}/>
      </>}>
      <ProseSource text={d.text}/>
    </CardShell>
  );
}

/** Comments of a file that are not on a line shown (outdated, outside the hunks), or on files not in the diff. */
function FileNotes({items, title}: {items: Item[]; title?: string}) {
  return (
    <div className="flex flex-col gap-2 border-b border-border-subtle bg-canvas px-4 py-3">
      <SectionHeading>{title ?? 'Comments not on the lines shown'}</SectionHeading>
      {items.map((it) => {
        const a = itemAnchor(it);
        return (
          <div key={it.kind === 'comment' ? `c${String(it.c.id)}` : it.d.key} className="flex flex-col gap-1">
            <span className="font-mono text-code text-fg-muted">{a.path}:{a.line} ({a.side === 'old' ? 'old' : 'new'}, {shortSha(a.commit)})</span>
            {it.kind === 'comment' ? <CommentCard c={it.c} pending={it.pending}/> : <DraftCard d={it.d} onEdit={() => undefined} onDelete={() => undefined}/>}
          </div>
        );
      })}
    </div>
  );
}

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
        <div role="radiogroup" aria-label="Review" className="flex gap-1">
          {EVENTS.map((e) => (
            <Button key={e.event} size="sm" pressed={event === e.event} disabled={own && !e.own} role="radio" aria-checked={event === e.event}
              tooltip={own && !e.own ? 'Not on your own pull request' : undefined} onClick={() => {
                setEvent(e.event);
              }}>{e.label}</Button>
          ))}
        </div>
      </div>
    </Dialog>
  );
});

// ---- commits ----

const CommitsTab = observer(function CommitsTab({owner, repo, pr, commits}: TabProps & {pr: PullRequest; commits: PullCommits}) {
  const src = useSource();
  const navigate = useNavigate();
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const key = `compare:${String(pr.base_repo_id)}:${commits.base}:${commits.head}`;
  const info = useLoad(key, () => src.peek<CompareInfo>(key), () => src.compare(pr.base_repo_id, commits.base, commits.head));
  return (
    <div ref={setScroller} className="h-full overflow-y-auto">
      {info.state !== 'ready' ? <Unloaded loaded={info} what="These commits"/> :
        <RowList items={info.value.commits} scroller={scroller} label="Commits" keyOf={(c) => c.sha}
          row={(c) => ({
            leading: <Avatar name={c.authorName} size="sm"/>,
            main: summary(c.message),
            trailing: <><span className="font-mono">{shortSha(c.sha)}</span><time dateTime={c.date} title={fullDate(c.date)}>{ago(c.date)}</time></>,
          })}
          onOpen={(c) => {
            // A fork's commits are in the base repository too (refs/pull/N/head).
            void navigate(codeTo(owner, repo, `commit/${c.sha}`));
          }}/>}
    </div>
  );
});

// ---- checks ----

const ChecksTab = observer(function ChecksTab({owner, repo, pr, commits}: TabProps & {pr: PullRequest; commits: PullCommits}) {
  const pool = usePool();
  // The latest status per context (Forgejo keeps every report).
  const latest = new Map<string, Entity<'CommitStatus'>>();
  for (const s of pool.model('CommitStatus').by('sha', commits.head)) {
    if (s.get('repo_id') !== pr.base_repo_id && s.get('repo_id') !== pr.head_repo_id) continue;
    const prev = latest.get(s.get('context'));
    if (!prev || s.get('index') > prev.get('index')) latest.set(s.get('context'), s);
  }
  const runs = [...pool.model('ActionRun').by('repo_id', pr.base_repo_id)].filter((r) => r.data.commit_sha === commits.head).sort((a, b) => b.data.id - a.data.id);
  if (!latest.size && !runs.length) return <EmptyState icon={Workflow} title="No checks" description={`Nothing reported for ${shortSha(commits.head)} on this device.`}/>;
  return (
    <div className="flex max-w-lg flex-col gap-4 px-8 py-6">
      {latest.size > 0 && (
        <section aria-label="Statuses" className="flex flex-col">
          <SectionHeading>Statuses</SectionHeading>
          {[...latest.values()].map((s) => {
            const look = statusLook(s.get('state') === 'error' ? 'failure' : s.get('state') === 'pending' ? 'waiting' : s.get('state'));
            const url = s.get('target_url');
            return (
              <ListRow key={s.id} role="presentation" leading={<StatusDot tone={look.tone}/>} trailing={look.text}>
                {/^https?:\/\//.test(url) ? <TextLink><a href={url} target="_blank" rel="noopener noreferrer">{s.get('context')}</a></TextLink> : s.get('context')}
                {s.get('description') && <span className="text-fg-subtle"> {s.get('description')}</span>}
              </ListRow>
            );
          })}
        </section>
      )}
      {runs.length > 0 && (
        <section aria-label="Workflow runs" className="flex flex-col">
          <SectionHeading>Workflow runs</SectionHeading>
          {runs.map((r) => <RunRow key={r.id} owner={owner} repo={repo} runId={r.id} runNumber={r.data.run_number}/>)}
        </section>
      )}
    </div>
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
            <ListRow role="presentation" leading={<StatusDot tone={look.tone}/>} trailing={look.text}>
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

/** Merge, update branch, auto-merge (PLAN §5.4: online only, never queued; disabled offline with the reason). */
export const MergeBox = observer(function MergeBox({issue}: {issue: Entity<'Issue'>}) {
  const app = useApp();
  const pool = usePool();
  const pr = pullOf(pool, issue.id);
  const [busy, setBusy] = useState(false);
  if (!pr) return null;
  const repo = pool.model('Repository').get(pr.base_repo_id)?.data;
  const auto = [...pool.model('AutoMerge').by('pull_id', pr.id)][0];
  const isOnline = connectivity.online;
  const closed = issue.get('state') === 'closed';
  const path = repo ? `/repos/${encodeURIComponent(repo.owner_name)}/${encodeURIComponent(repo.name)}/pulls/${String(pr.number)}` : '';
  const run = (what: string, req: Parameters<typeof online>[1]) => {
    setBusy(true);
    online(app, req).then(() => {
      notify(app, {tone: 'success', title: `${what}: done`});
    }, (err: unknown) => {
      notify(app, {tone: 'danger', title: `${what} failed`, description: err instanceof RequestFailed ? err.message : String(err)});
    }).finally(() => {
      setBusy(false);
    });
  };
  const offlineWhy = (action: string) => (isOnline ? undefined : onlineOnly(action));
  let state: ReactNode;
  if (pr.merged) state = <><Icon icon={GitMerge} className="text-done"/> Merged{pr.merged_at ? ` ${ago(pr.merged_at)}` : ''}</>;
  else if (closed) state = 'Closed without merging';
  else if (pr.status === 'conflict') state = <><StatusDot tone="danger"/> Conflicts: {pr.conflicted_files.join(', ') || 'resolve them first'}</>;
  else if (pr.status === 'checking') state = <><StatusDot tone="warning"/> Checking whether it can be merged…</>;
  else state = <><StatusDot tone="success"/> Can be merged{pr.commits_behind > 0 ? ` · ${String(pr.commits_behind)} behind ${pr.base_branch}` : ''}</>;
  return (
    <section aria-label="Merge" className="mt-4 flex flex-col gap-2 rounded-md border border-border p-3">
      <p className="flex items-center gap-2 text-base text-fg">{state}</p>
      {auto && !pr.merged && <p className="text-sm text-fg-muted">Merges automatically when the checks succeed ({auto.data.merge_style}).</p>}
      {!pr.merged && !closed && path && (
        <div className="flex flex-wrap items-center gap-2">
          <Menu>
            <MenuTrigger asChild>
              <Button variant="primary" icon={GitMerge} disabled={!isOnline || busy || pr.status === 'conflict'} tooltip={offlineWhy('Merging')}>Merge</Button>
            </MenuTrigger>
            <MenuContent>
              {STYLES.map(([style, label]) => (
                <MenuItem key={style} onSelect={() => {
                  run('Merge', {method: 'POST', api: 'v1', path: `${path}/merge`, body: {Do: style}, timeout: 60_000});
                }}>{label}</MenuItem>
              ))}
            </MenuContent>
          </Menu>
          {auto ?
            <Button disabled={!isOnline || busy} tooltip={offlineWhy('Canceling the auto-merge')} onClick={() => {
              run('Cancel auto-merge', {method: 'DELETE', api: 'v1', path: `${path}/merge`});
            }}>Cancel auto-merge</Button> :
            <Button disabled={!isOnline || busy} tooltip={offlineWhy('Scheduling the merge') ?? 'Merge when all checks succeed'} onClick={() => {
              run('Auto-merge', {method: 'POST', api: 'v1', path: `${path}/merge`, body: {Do: 'merge', merge_when_checks_succeed: true}});
            }}>Merge when checks succeed</Button>}
          {pr.commits_behind > 0 && (
            <Button disabled={!isOnline || busy} tooltip={offlineWhy('Updating the branch') ?? `Merge ${pr.base_branch} into this branch`} onClick={() => {
              run('Update branch', {method: 'POST', api: 'v1', path: `${path}/update?style=merge`});
            }}>Update branch</Button>
          )}
          {!isOnline && <span className="text-sm text-fg-subtle">{onlineOnly('Merging')}</span>}
        </div>
      )}
    </section>
  );
});
