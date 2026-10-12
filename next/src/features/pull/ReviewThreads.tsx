// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {FileDiffIcon, PencilIcon, ReplyIcon, TrashIcon} from '@primer/octicons-react';
import {Heading, IconButton, Label, Button as PrimerButton, Tooltip} from '@primer/react';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useRef, useState} from 'react';
import {shortcutHint} from '../../app/shortcuts/index.ts';
import {useApp} from '../../app/store.ts';
import {lineAnchor} from '../../code/anchor.ts';
import {DEL, type DiffFile} from '../../code/diff.ts';
import {shortSha} from '../../code/refs.ts';
import {type ReviewDraft, saveDraft, submitReview} from '../../code/review.ts';
import {BoxHeader} from '../../components/BorderBox.tsx';
import {TimeAgo} from '../../components/TimeAgo.tsx';
import type {Entity} from '../../data/entity.ts';
import {uuid} from '../../intents/intents.ts';
import {editing, notifyQueued} from '../../intents/editing.ts';
import type {Comment, PullRequest} from '../../protocol/types.gen.ts';
import {type EditorTool, MarkdownField, MarkdownPreview} from '../editor/Composer.tsx';
import {hasPendingUploads} from '../editor/attachments.ts';
import {CommentCard as PostedCommentCard} from '../issue/TimelineParts.tsx';
import {usePool} from '../../app/store.ts';
import {conversationRoot, ResolveButton, ResolvedFold, useResolver} from './resolve.tsx';
import {composerKey, type Composing, type Item, itemAnchor} from './reviewTypes.ts';

export const Thread = observer(function Thread({issue, pr, f, l, file, head, items, composing, setComposing, onDone, keepText, keptText, reviewing}: {
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
          <MarkdownField repoId={pr.base_repo_id} attachmentIssueId={issue.id} label={reply ? 'Reply' : 'Review comment'} value={text} autoFocus rows={3} onChange={edit} onSubmit={reply ? replyNow : save} onCancel={done}
            tools={file && file.lines[l]?.k !== DEL ? [suggestionTool(file, composing.start ?? l, l)] : undefined}/>
          <div className="flex justify-end gap-2">
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

/** GitHub's suggestion button: the selected new-side lines as a suggestion block, at the caret. */
function suggestionTool(file: DiffFile, first: number, last: number): EditorTool {
  return {id: 'suggestion', icon: FileDiffIcon, label: 'Add a suggestion', edit: (doc, from, to) => {
    const end = file.lines[last]?.n ?? 0;
    const start = file.lines[first]?.n ?? end;
    const body = file.lines.filter((line) => line.k !== DEL && line.n >= start && line.n <= end).map((line) => line.t).join('\n');
    const lead = from > 0 && doc[from - 1] !== '\n' ? '\n' : '';
    const open = `${lead}\`\`\`suggestion${end > start ? ` -${String(end - start)}+0` : ''}\n`;
    const trail = to < doc.length && doc[to] !== '\n' ? '\n' : '';
    return {from, to, insert: `${open}${body}\n\`\`\`${trail}`, anchor: from + open.length, head: from + open.length + body.length};
  }};
}

function CardShell({who, when, badge, actions, children}: {who: ReactNode; when?: string | undefined; badge?: ReactNode; actions?: ReactNode; children: ReactNode}) {
  return (
    <article className="flex min-w-0 flex-col rounded-md border border-default bg-default text-base text-default">
      <BoxHeader actions={actions}>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1">
          {who}
          {when && <span className="text-muted"><TimeAgo at={when}/></span>}
          {badge}
        </span>
      </BoxHeader>
      <div className="p-4">{children}</div>
    </article>
  );
}

const CommentCard = observer(function CommentCard({c, pending}: {c: Comment; pending: boolean}) {
  const entity = usePool().model('Comment').get(c.id);
  return entity ? <PostedCommentCard c={entity} type="code" nested badge={<>{pending && <Label variant="attention">Pending</Label>}{c.invalidated && <Label>Outdated</Label>}</>}/> : null;
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

export const FileNotes = observer(function FileNotes({items, title, repoId}: {items: Item[]; title?: string; repoId: number}) {
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
