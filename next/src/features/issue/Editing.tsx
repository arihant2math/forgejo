// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Text edits of an issue, online or offline (PLAN §5.4): the description,
// new comments, comment edits and deletes. Each save is an intent: it shows
// at once (the typed markdown, marked as not synced, until the server's
// rendering arrives) and is sent when the leader tab can. A conflicting
// edit is resolved here, in the editor: the 3-way merge with markers, or
// either side whole. While typing, the text is kept in IndexedDB (drafts),
// so a reload or a crash never loses it. F6 replaces the plain text area
// with the CodeMirror composer; these components keep the intent plumbing.

import {CloudUpload, MoreHorizontal, Pencil, Trash2} from 'lucide-react';
import {runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type KeyboardEvent, useEffect, useRef, useState} from 'react';
import {shortcutHint, useShortcut} from '../../app/shortcuts/index.ts';
import {useApp, useSession} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import {uuid} from '../../intents/intents.ts';
import {hasConflictMarkers} from '../../intents/merge3.ts';
import {editing} from '../../intents/session.ts';
import {commentBody, issueBody} from '../../intents/view.ts';
import {Badge, Button, Callout, Hint, Icon, IconButton, Menu, MenuContent, MenuItem, MenuTrigger, ProseSource, Skeleton, TextArea} from '../../ui/index.ts';
import {useUser} from '../issues/cells.tsx';
import {Markdown} from './Markdown.tsx';

/** Markdown as it shows: the server's rendering, or the typed source while an edit is not synced. */
export function Rendered({text, html, local}: {text: string; html: string; local: boolean}) {
  if (local) return <ProseSource text={text}/>;
  return html ? <Markdown html={html}/> : <p className="text-base text-fg-subtle">No text.</p>;
}

/** Marks text that Forgejo does not have yet. */
export function NotSynced() {
  return (
    <Hint label="Not synced yet: Forgejo renders it once it has it">
      <Badge><Icon icon={CloudUpload} size="sm"/>Not synced</Badge>
    </Hint>
  );
}

interface TextEditorProps {
  /** Where the text being typed is kept (drafts): `text:<what>:<id>`. */
  draftKey: string;
  title: string;
  issueId: number;
  repoId: number;
  initial: string;
  label: string;
  saveLabel: string;
  onSave: (text: string) => void;
  onCancel?: (() => void) | undefined;
  /** Saving is refused while the text still has conflict markers. */
  markers?: boolean | undefined;
  rows?: number;
  autoFocus?: boolean;
}

/** A markdown text area that keeps what is typed (drafts) and saves with ⌘↵. */
export const TextEditor = observer(function TextEditor({draftKey, title, issueId, repoId, initial, label, saveLabel, onSave, onCancel, markers, rows, autoFocus}: TextEditorProps) {
  const app = useApp();
  const {intents} = editing(app);
  const [text, setText] = useState(() => untracked(() => intents.drafts.get(draftKey)?.text) ?? initial);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dirty = text !== initial;
  const blocked = markers === true && hasConflictMarkers(text);
  useEffect(() => () => {
    clearTimeout(timer.current);
  }, []);
  const change = (t: string) => {
    setText(t);
    clearTimeout(timer.current);
    // Kept while typing (never lost to a reload or a crash); forgotten once saved or cancelled.
    timer.current = setTimeout(() => {
      if (t === initial) void intents.discardDraft(draftKey);
      else void intents.keepText({key: draftKey, title, issueId, repoId, text: t});
    }, 400);
  };
  const forget = () => {
    clearTimeout(timer.current);
    if (intents.drafts.has(draftKey)) void intents.discardDraft(draftKey);
  };
  const save = () => {
    if (blocked || (!dirty && !markers) || !text.trim()) return;
    forget();
    onSave(text);
    if (!onCancel) setText('');
  };
  const cancel = () => {
    forget();
    onCancel?.();
  };
  useShortcut('submit', save, dirty);
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      cancel();
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <TextArea aria-label={label} placeholder={label} value={text} rows={rows ?? 6} autoFocus={autoFocus} invalid={blocked}
        onChange={(e) => {
          change(e.target.value);
        }} onKeyDown={onKeyDown}/>
      <div className="flex items-center justify-end gap-2">
        {blocked && <span className="mr-auto text-sm text-warning">Remove the conflict markers to save.</span>}
        {onCancel && <Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button>}
        <Button size="sm" variant="primary" shortcut={shortcutHint('submit')} tooltip={`${saveLabel} (works offline)`} disabled={blocked || !text.trim() || (!dirty && !markers)} onClick={save}>{saveLabel}</Button>
      </div>
    </div>
  );
});

/** The description: shown (server HTML, or the source of an unsynced edit), edited, or its conflict resolved. */
export const BodySection = observer(function BodySection({issue}: {issue: Entity<'Issue'>}) {
  const app = useApp();
  const {data} = useSession();
  const {overlay, intents} = editing(app);
  const [edit, setEdit] = useState(false);
  const body = issueBody(data.pool, overlay, issue.id);
  const conflict = intents.conflictOf('issue.body', issue.id);
  useShortcut('issue.edit', () => {
    if (body) setEdit(true);
  });
  const repoId = issue.get('repo_id');
  if (conflict?.conflict) {
    const c = conflict.conflict;
    const mine = conflict.intent.kind === 'issue.body' ? conflict.intent.text : '';
    return (
      <div className="flex flex-col gap-2">
        <Callout tone="warning" title="Your edit conflicts with a newer change" actions={<>
          <Button size="sm" onClick={() => intents.resolve(conflict.id, mine)}>Keep mine</Button>
          <Button size="sm" onClick={() => intents.resolve(conflict.id, c.theirs)}>Use theirs</Button>
        </>}>
          You edited the description while it changed on Forgejo, and both touched the same lines.
          Edit the merge below (between the markers: yours, then theirs), or keep one side.
        </Callout>
        <TextEditor key={conflict.id} draftKey={`text:conflict:${conflict.id}`} title="Resolving the description" issueId={issue.id} repoId={repoId}
          initial={c.merged} label="Resolve the description" saveLabel="Save" markers rows={12} onSave={(t) => intents.resolve(conflict.id, t)}/>
      </div>
    );
  }
  if (!body) {
    return (
      <div className="flex flex-col gap-2 py-1" aria-busy>
        <Skeleton className="h-3 w-full"/>
        <Skeleton className="h-3 w-full"/>
        <Skeleton className="h-3 w-2/3"/>
      </div>
    );
  }
  if (edit) {
    return (
      <TextEditor draftKey={`text:body:${String(issue.id)}`} title="Editing the description" issueId={issue.id} repoId={repoId}
        initial={body.text} label="Description" saveLabel="Save" rows={12} autoFocus
        onCancel={() => {
          setEdit(false);
        }}
        onSave={(text) => {
          // The base is what the user edited: the server's text and version, or (-1) an unsynced edit's text.
          const version = body.local ? -1 : untracked(() => data.pool.model('IssueBody').get(issue.id)?.data.content_version) ?? -1;
          intents.submit({kind: 'issue.body', issueId: issue.id, repoId, text, baseText: body.text, baseVersion: version});
          setEdit(false);
        }}/>
    );
  }
  return (
    <div className="group flex flex-col gap-1">
      <div className="flex min-h-control-sm items-center justify-end gap-2">
        {body.local && <NotSynced/>}
        <IconButton size="sm" icon={Pencil} label="Edit the description" shortcut={shortcutHint('issue.edit')} onClick={() => {
          setEdit(true);
        }}/>
      </div>
      {body.text || body.html ? <Rendered {...body}/> : <p className="text-base text-fg-subtle">No description.</p>}
    </div>
  );
});

/** A comment's body, its actions (edit, delete: the viewer's own) and its edit conflict. */
export const CommentBody = observer(function CommentBody({c}: {c: Entity<'Comment'>}) {
  const app = useApp();
  const {userId, data} = useSession();
  const {overlay, intents} = editing(app);
  const [edit, setEdit] = useState(false);
  const b = commentBody(overlay, c);
  const conflict = intents.conflictOf('comment.edit', c.id);
  const issueId = c.get('issue_id');
  const repoId = untracked(() => data.pool.model('Issue').get(issueId)?.data.repo_id ?? 0);
  if (b.deleted) return null;
  if (conflict?.conflict && conflict.intent.kind === 'comment.edit') {
    const cf = conflict.conflict;
    const mine = conflict.intent.text;
    return (
      <div className="flex flex-col gap-2">
        <Callout tone="warning" title="This comment changed while you edited it" actions={<>
          <Button size="sm" onClick={() => intents.resolve(conflict.id, mine)}>Keep mine</Button>
          <Button size="sm" onClick={() => intents.resolve(conflict.id, cf.theirs)}>Use theirs</Button>
        </>}>Edit the merge below, or keep one side.</Callout>
        <TextEditor key={conflict.id} draftKey={`text:conflict:${conflict.id}`} title="Resolving a comment" issueId={issueId} repoId={repoId}
          initial={cf.merged} label="Resolve the comment" saveLabel="Save" markers onSave={(t) => intents.resolve(conflict.id, t)}/>
      </div>
    );
  }
  if (edit) {
    return (
      <TextEditor draftKey={`text:comment:${String(c.id)}`} title="Editing a comment" issueId={issueId} repoId={repoId} initial={b.text}
        label="Comment" saveLabel="Save" autoFocus onCancel={() => {
          setEdit(false);
        }}
        onSave={(text) => {
          const d = untracked(() => c.data);
          intents.submit({kind: 'comment.edit', issueId, repoId, commentId: c.id, text, baseText: b.text, baseVersion: b.local ? -1 : d.content_version, baseUpdated: d.updated_at});
          setEdit(false);
        }}/>
    );
  }
  const mine = c.get('poster_id') === userId;
  return (
    <div className="flex flex-col gap-1">
      <Rendered {...b}/>
      {(b.local || mine) && (
        <div className="flex items-center gap-2">
          {b.local && <NotSynced/>}
          {mine && (
            <Menu>
              <MenuTrigger asChild><IconButton size="sm" icon={MoreHorizontal} label="Comment actions"/></MenuTrigger>
              <MenuContent align="start">
                <MenuItem icon={Pencil} onSelect={() => {
                  setEdit(true);
                }}>Edit</MenuItem>
                <MenuItem icon={Trash2} danger onSelect={() => {
                  intents.submit({kind: 'comment.delete', issueId, repoId, commentId: c.id});
                }}>Delete</MenuItem>
              </MenuContent>
            </Menu>
          )}
        </div>
      )}
    </div>
  );
});

/** The new-comment box at the end of the timeline. */
export function CommentComposer({issueId, repoId}: {issueId: number; repoId: number}) {
  const app = useApp();
  const me = useUser(useSession().userId);
  const {intents} = editing(app);
  return (
    <div className="flex flex-col gap-2 pt-3">
      <span className="sr-only">Commenting as {me.login}</span>
      <TextEditor draftKey={`text:new-comment:${String(issueId)}`} title="A new comment" issueId={issueId} repoId={repoId} initial=""
        label="Leave a comment" saveLabel="Comment" rows={4}
        onSave={(body) => {
          runInAction(() => {
            intents.submit({kind: 'comment.create', issueId, repoId, tempId: uuid(), body});
          });
        }}/>
    </div>
  );
}

/** Changes of yours that overrode someone's newer value (last writer wins), with one-click undo. */
export const Overrides = observer(function Overrides({issueId}: {issueId: number}) {
  const app = useApp();
  const {data} = useSession();
  const {intents} = editing(app);
  const mine = intents.overrides.filter((o) => o.issueId === issueId);
  if (!mine.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {mine.map((o) => {
        const who = o.who ? untracked(() => data.pool.model('User').get(o.who)?.data.login) : undefined;
        return (
          <Callout key={o.id} title={`You overrode ${who ? `@${who}’s` : 'a newer'} change to the ${o.field}`} actions={<>
            <Button size="sm" onClick={() => {
              intents.undoOverride(o.id);
            }}>Undo</Button>
            <Button size="sm" variant="ghost" onClick={() => {
              intents.dismissOverride(o.id);
            }}>Dismiss</Button>
          </>}>It changed on Forgejo while you were offline; your change was applied last.</Callout>
        );
      })}
    </div>
  );
});
