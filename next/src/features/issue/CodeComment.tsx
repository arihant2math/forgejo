// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {
ReplyIcon
} from '@primer/octicons-react';
import {Button, Label} from '@primer/react';
import {observer} from 'mobx-react-lite';
import {useMemo, useRef, useState} from 'react';
import {RouterLink} from '../../app/routerLinks.tsx';
import {useApp} from '../../app/store.ts';
import {DiffSnippet} from '../../code/DiffSnippet.tsx';
import {commentAnchor} from '../../code/anchor.ts';
import {hunkFile} from '../../code/hunk.ts';
import {submitReview} from '../../code/review.ts';
import type {Entity} from '../../data/entity.ts';
import {uuid} from '../../intents/intents.ts';
import {editing} from '../../intents/session.ts';
import {MarkdownField} from '../editor/Composer.tsx';
import {hasPendingUploads} from '../editor/attachments.ts';
import {usePool} from '../issues/cells.tsx';
import {conversationReplies, conversationRoot, ResolveButton, ResolvedFold, useResolver} from '../pull/resolve.tsx';
import {CommentCard, Who} from './TimelineParts.tsx';

const SNIPPET_LINES = 4;

export const CodeComment = observer(function CodeComment({c}: {c: Entity<'Comment'>}) {
  const app = useApp();
  const pool = usePool();
  const [replying, setReplying] = useState(false);
  const replyButton = useRef<HTMLButtonElement>(null);
  const closeReply = () => {
    setReplying(false);
    requestAnimationFrame(() => replyButton.current?.focus());
  };
  const [text, setText] = useState('');
  const root = conversationRoot(pool, c.data);
  const resolver = useResolver(root);
  const [shown, setShown] = useState(false);
  const issueEntity = pool.model('Issue').get(c.get('issue_id'));
  const issue = pool.model('Issue').get(c.get('issue_id'))?.data;
  const repo = issue ? pool.model('Repository').get(issue.repo_id)?.data : undefined;
  const files = issue && repo ? `/${encodeURIComponent(repo.owner_name)}/${encodeURIComponent(repo.name)}/pulls/${String(issue.number)}` : undefined;
  const path = c.get('path');
  const patch = c.get('diff_hunk');
  const hunk = useMemo(() => hunkFile(path, patch, SNIPPET_LINES), [path, patch]);
  const replies = conversationReplies(pool, c);
  const reply = () => {
    if (!issue || !text.trim() || hasPendingUploads(text)) return;
    submitReview(editing(app).intents, {
      issueId: issue.id, repoId: issue.repo_id, head: c.get('commit_id'), event: 'COMMENT', body: '',
      drafts: [{key: `reply:${uuid()}`, anchor: commentAnchor(c.data), text, at: Date.now()}],
    });
    setText('');
    closeReply();
  };
  if (resolver > 0 && !shown && !replying) {
    return (
      <div className="flex flex-col gap-1 rounded-md border border-default p-3">
        <span className="text-sm text-muted"><code>{c.get('path')}</code> line {Math.abs(c.get('line'))}</span>
        <ResolvedFold resolver={resolver} onShow={() => {
          setShown(true);
        }}/>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 rounded-md border border-default p-3">
      <span className="text-sm text-muted">
        <Who id={c.get('poster_id')} fallback={c.get('original_author')}/> on{' '}
        {files ? <RouterLink to={files} search={{tab: 'files'}} hash={`review-thread-${String(c.id)}`} muted className="min-w-0 truncate"><code>{c.get('path')}</code>line {Math.abs(c.get('line'))}</RouterLink> :
          <><code>{c.get('path')}</code> line {Math.abs(c.get('line'))}</>}
        {c.get('invalidated') && <> · <Label>Outdated</Label></>}
      </span>
      {hunk.lines.length > 0 && <DiffSnippet file={hunk}/>}
      <CommentCard c={c} type="code" nested/>
      {replies.map((r) => <CommentCard key={r.id} c={r} type="code" nested/>)}
      {issue && !c.get('invalidated') && (replying ?
        <div className="flex flex-col gap-2">
          <MarkdownField repoId={issue.repo_id} attachmentIssueId={issue.id} label="Reply" value={text} rows={2} autoFocus onChange={setText} onSubmit={reply} onCancel={() => {
            closeReply();
          }}/>
          <div className="flex justify-end gap-2">
            <Button variant="invisible" size="small" type="button" onClick={() => {
              closeReply();
            }}>Cancel</Button>
            <Button variant="primary" size="small" type="button" disabled={!text.trim() || hasPendingUploads(text)} onClick={reply}>Reply</Button>
          </div>
        </div> :
        <div className="flex items-center gap-2">
          <Button variant="invisible" size="small" leadingVisual={ReplyIcon} type="button" ref={replyButton} onClick={() => {
            setReplying(true);
          }}>Reply</Button>
          {root && issueEntity && <ResolveButton root={root} issue={issueEntity}/>}
        </div>)}
    </div>
  );
});
