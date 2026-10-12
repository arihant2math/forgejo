// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {GitPullRequestClosedIcon, GitPullRequestIcon, IssueClosedIcon, IssueReopenedIcon, SkipIcon} from '@primer/octicons-react';
import {Banner, Button, Heading, TextInput} from '@primer/react';
import {SkeletonText} from '@primer/react/experimental';
import {runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {useEffect, useId, useRef, useState} from 'react';
import {Missing} from '../../app/Missing.tsx';
import {canWrite} from '../../app/access.ts';
import {dismissSeries} from '../../app/notices.ts';
import {reach} from '../../app/online.ts';
import {useShortcut} from '../../app/shortcuts/index.ts';
import {useApp, useSession} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import {uuid} from '../../intents/intents.ts';
import {editing, overrideSeries, overrideWords} from '../../intents/editing.ts';
import {issueBody, issueState, issueTitle} from '../../intents/view.ts';
import {setWorkflowStatus} from '../issues/actions.ts';
import {usePool} from '../../app/store.ts';
import {useUser} from '../issues/cells.tsx';
import {type CloseReason, CloseReasons, closeStatuses} from './CloseControls.tsx';
import {toggleTask} from './Markdown.tsx';
import {type EditBase, NotSynced, Rendered, resolveWith, TextEditor} from './TextEditing.tsx';

/** The description's edit state, shared by its card's menu, its body and the edit shortcut. */
export function useBodyEdit(issue: Entity<'Issue'>) {
  const app = useApp();
  const session = useSession();
  const {data} = session;
  const {overlay} = editing(app);
  const mayEdit = issue.get('poster_id') === session.userId || canWrite(session, issue.get('repo_id'));
  const [edit, setEdit] = useState<EditBase | false>(false);
  const start = () => {
    const b = untracked(() => issueBody(data.pool, overlay, issue.id));
    if (!b || !mayEdit) return;
    setEdit({text: b.text, version: b.local ? -1 : untracked(() => data.pool.model('IssueBody').get(issue.id)?.data.content_version) ?? -1});
  };
  useShortcut('issue.edit', start);
  return {edit, start, stop: () => { setEdit(false); }, mayEdit};
}

export const BodySection = observer(function BodySection({issue, edit, mayEdit, onEditDone, onReopen}: {
  issue: Entity<'Issue'>; edit: EditBase | false; mayEdit: boolean; onEditDone: () => void; onReopen: () => void;
}) {
  const app = useApp();
  const {data} = useSession();
  const {overlay, intents} = editing(app);
  const body = issueBody(data.pool, overlay, issue.id);
  const conflict = intents.conflictOf('issue.body', issue.id);
  const repoId = issue.get('repo_id');
  if (conflict?.conflict) {
    const c = conflict.conflict;
    const mine = conflict.intent.kind === 'issue.body' ? conflict.intent.text : '';
    return (
      <div className="flex flex-col gap-2">
        <Banner variant="warning" title="Your edit conflicts with a newer change"
          primaryAction={<Button size="small" onClick={() => { resolveWith(intents, conflict.id, mine); }}>Keep mine</Button>}
          secondaryAction={<Button size="small" onClick={() => { resolveWith(intents, conflict.id, c.theirs); }}>Use theirs</Button>}
          description="You edited the description while it changed on Forgejo, and both touched the same lines. Edit the merge below (between the markers: yours, then theirs), or keep one side."/>
        <TextEditor key={conflict.id} draftKey={`text:conflict:${conflict.id}`} title="Resolving the description" issueId={issue.id} repoId={repoId}
          initial={c.merged} label="Resolve the description" saveLabel="Save" markers rows={12} onSave={(t) => intents.resolve(conflict.id, t)}/>
      </div>
    );
  }
  if (!body) {
    // Offline, a missing description cannot arrive; avoid an endless placeholder.
    if (reach(data.status.connection) !== 'online') {
      return <Missing what="Its description and comments"/>;
    }
    return (
      <div className="flex flex-col gap-2 py-1" aria-busy>
        <SkeletonText lines={3}/>
      </div>
    );
  }
  if (edit) {
    return (
      <TextEditor draftKey={`text:body:${String(issue.id)}`} title="Editing the description" issueId={issue.id} repoId={repoId}
        initial={edit.text} base={edit} label="Description" saveLabel="Save" rows={12} autoFocus
        onCancel={onEditDone} onReopen={onReopen}
        onSave={(text, base) => {
          const b = base ?? edit;
          intents.submit({kind: 'issue.body', issueId: issue.id, repoId, text, baseText: b.text, baseVersion: b.version});
          onEditDone();
        }}/>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {body.text || body.html ? <Rendered {...body} onTask={mayEdit ? (index, checked) => {
        const b = untracked(() => issueBody(data.pool, overlay, issue.id));
        if (!b) return;
        const text = toggleTask(b.text, index, checked);
        if (text === b.text) return;
        const version = b.local ? -1 : untracked(() => data.pool.model('IssueBody').get(issue.id)?.data.content_version) ?? -1;
        intents.submit({kind: 'issue.body', issueId: issue.id, repoId, text, baseText: b.text, baseVersion: version});
      } : undefined}/> : <p className="text-base text-muted italic">No description provided.</p>}
      {body.local && <NotSynced/>}
    </div>
  );
});

export const CommentComposer = observer(function CommentComposer({issueId, repoId}: {issueId: number; repoId: number}) {
  const app = useApp();
  const session = useSession();
  const me = useUser(session.userId);
  const who = useId();
  const pool = usePool();
  const {intents, overlay} = editing(app);
  const [reason, setReason] = useState<CloseReason>('completed');
  const issue = pool.model('Issue').get(issueId) ?? overlay.createdEntity('Issue', issueId) as Entity<'Issue'> | undefined;
  const state = issue ? issueState(overlay, issue) : 'open';
  const mayChangeState = issue && (issue.get('poster_id') === session.userId || canWrite(session, repoId));
  const reasons = issue && state === 'open' && !issue.get('is_pull') && issueId > 0;
  const notPlanned = reasons ? closeStatuses(pool, repoId).notPlanned : undefined;
  const chosen = notPlanned ? reason : 'completed';
  const noun = issue?.get('is_pull') ? 'pull request' : 'issue';
  return (
    <div className="flex flex-col gap-2 pt-3">
      <span id={who} className="sr-only">Commenting as {me.login}</span>
      <TextEditor describedBy={who} draftKey={`text:new-comment:${String(issueId)}`} title="A new comment" issueId={issueId} repoId={repoId} initial=""
        label="Leave a comment" saveLabel="Comment" rows={4} focusShortcut="issue.comment" quote
        stateAction={mayChangeState ? {
          label: (hasText) => (state === 'closed' ? `Reopen ${hasText ? 'with comment' : noun}` :
            chosen === 'not-planned' && !hasText ? 'Close as not planned' : `Close ${hasText ? 'with comment' : noun}`),
          icon: issue.get('is_pull') ? state === 'closed' ? <GitPullRequestIcon className="text-success"/> : <GitPullRequestClosedIcon className="text-danger"/> :
            state === 'closed' ? <IssueReopenedIcon className="text-success"/> : chosen === 'not-planned' ? <SkipIcon className="text-muted"/> : <IssueClosedIcon className="text-done"/>,
          run: (body) => {
            runInAction(() => {
              if (body.trim()) intents.submit({kind: 'comment.create', issueId, repoId, tempId: uuid(), body});
              if (state === 'open' && chosen === 'not-planned' && notPlanned) setWorkflowStatus(app, [issue], notPlanned);
              else intents.submit({kind: 'issue.state', issueId, repoId, state: state === 'closed' ? 'open' : 'closed', base: state});
            });
            // A reason applies to one close; after a reopen the button starts from "completed" again.
            setReason('completed');
          },
          more: reasons ? (act, anchor) => <CloseReasons issue={issue} act={act} anchor={anchor} reason={chosen} notPlanned={notPlanned !== undefined} onReason={setReason}/> : undefined,
        } : undefined}
        onSave={(body) => {
          runInAction(() => {
            intents.submit({kind: 'comment.create', issueId, repoId, tempId: uuid(), body});
          });
        }}/>
    </div>
  );
});

export const Overrides = observer(function Overrides({issueId}: {issueId: number}) {
  const app = useApp();
  const {intents} = editing(app);
  const mine = intents.overrides.filter((o) => o.issueId === issueId);
  // Dismiss the matching notice to avoid presenting the override twice.
  const ids = mine.map((o) => o.id).join(' ');
  useEffect(() => {
    for (const id of ids.split(' ')) if (id) dismissSeries(app, overrideSeries(id));
  }, [app, ids]);
  if (!mine.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {mine.map((o) => {
        const words = overrideWords(app, o);
        return (
          <Banner key={o.id} title={words.title} description={words.description} variant="info"
            primaryAction={<Button size="small" onClick={() => { intents.undoOverride(o.id); }}>Undo</Button>}
            secondaryAction={<Button variant="invisible" size="small" onClick={() => { intents.dismissOverride(o.id); }}>Dismiss</Button>}/>
        );
      })}
    </div>
  );
});

/** GitHub's issue title: the title with its muted number and an Edit button; editing saves on Enter or Save, never on blur. */
export const TitleSection = observer(function TitleSection({issue}: {issue: Entity<'Issue'>}) {
  const app = useApp();
  const session = useSession();
  const {overlay, intents} = editing(app);
  const [text, setText] = useState<string | undefined>(undefined);
  const editButton = useRef<HTMLButtonElement>(null);
  const title = issueTitle(overlay, issue);
  const number = issue.get('number');
  const mayEdit = issue.get('poster_id') === session.userId || canWrite(session, issue.get('repo_id'));
  const close = () => {
    setText(undefined);
    requestAnimationFrame(() => editButton.current?.focus());
  };
  if (text === undefined) {
    return (
      <div className="flex items-start gap-2">
        <Heading as="h2" variant="large" className="min-w-0 flex-1">
          {title}{number > 0 && <> <span className="font-normal text-muted">#{number}</span></>}
        </Heading>
        {mayEdit && <Button size="small" ref={editButton} aria-label="Edit title" className="mt-1" onClick={() => { setText(title); }}>Edit</Button>}
      </div>
    );
  }
  const t = text.trim();
  const save = () => {
    if (!t) return;
    close();
    if (t !== title) {
      runInAction(() => {
        intents.submit({kind: 'issue.title', issueId: issue.id, repoId: issue.get('repo_id'), title: t, base: title});
      });
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-0 flex-1">
        <TextInput block aria-label="Title" value={text} autoFocus maxLength={255} {...(!t ? {validationStatus: 'error' as const} : {})} onChange={(e) => {
          setText(e.target.value);
        }} onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}/>
      </div>
      <Button size="small" type="button" inactive={!t} onClick={save}>Save</Button>
      <Button variant="invisible" size="small" type="button" onClick={close}>Cancel</Button>
    </div>
  );
});
