// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Banner, FormControl, Dialog as PrimerDialog, Radio, RadioGroup} from '@primer/react';
import {observer} from 'mobx-react-lite';
import {useEffect, useRef, useState} from 'react';
import {useApp, useSession} from '../../app/store.ts';
import {count} from '../../app/words.ts';
import {shortSha} from '../../code/refs.ts';
import {partition, type ReviewDraft, type ReviewEvent, submitReview} from '../../code/review.ts';
import type {Entity} from '../../data/entity.ts';
import {editing, notifyQueued} from '../../intents/editing.ts';
import type {PullRequest} from '../../protocol/types.gen.ts';
import {MarkdownField} from '../editor/Composer.tsx';
import {hasPendingUploads} from '../editor/attachments.ts';

const EVENTS: {event: ReviewEvent; label: string; description: string; own: boolean}[] = [
  {event: 'COMMENT', label: 'Comment', description: 'Submit general feedback without explicit approval.', own: true},
  {event: 'APPROVED', label: 'Approve', description: 'Give feedback and approve merging these changes.', own: false},
  {event: 'REQUEST_CHANGES', label: 'Request changes', description: 'Submit feedback that must be addressed before merging.', own: false},
];

/** Submit drafts as one offline intent pinned to the displayed head. */
export const ReviewDialog = observer(function ReviewDialog({open, onOpenChange, issue, pr, head, drafts, returnFocus}: {
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
      subtitle={`On ${shortSha(head)}${drafts.length ? ` · ${count(drafts.length, 'comment', 'comments')}` : ''}`}
      footerButtons={[{content: 'Cancel', onClick: () => {onOpenChange(false);}}, {content: 'Submit review', buttonType: 'primary', disabled: !ok, onClick: submit}]}>
      <div className="flex flex-col gap-3">
        {stale.length > 0 && (
          <Banner variant="warning" title={`${count(stale.length, 'comment was', 'comments were')} written on an earlier commit`} description={<>
            They are added to the review's text with their file and line, since their lines may have moved.
          </>}/>
        )}
        <MarkdownField repoId={pr.base_repo_id} attachmentIssueId={issue.id} label="Review summary" value={body} onChange={setBody} rows={4} onSubmit={submit} autoFocus/>
        <RadioGroup name="review-event" onChange={(value) => {
          const choice = EVENTS.find((e) => e.event === value);
          if (choice && (!own || choice.own)) setEvent(choice.event);
        }}>
          <RadioGroup.Label visuallyHidden>Review type</RadioGroup.Label>
          {EVENTS.map((choice) => (
            <FormControl key={choice.event} disabled={own && !choice.own}>
              <Radio value={choice.event} checked={event === choice.event}/>
              <FormControl.Label>{choice.label}</FormControl.Label>
              <FormControl.Caption>{own && !choice.own ? 'Pull request authors can’t approve their own pull request.' : choice.description}</FormControl.Caption>
            </FormControl>
          ))}
        </RadioGroup>
        {needsBody && !body.trim() && <span className="text-sm text-muted">{event === 'REQUEST_CHANGES' ? 'Say what to change.' : 'Write a summary or add comments.'}</span>}
      </div>
    </PrimerDialog>
  );
});
