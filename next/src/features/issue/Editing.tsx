// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Text edits of an issue, online or offline (PLAN §5.4): the description,
// new comments, comment edits and deletes. Each save is an intent: it shows
// at once (the typed markdown, marked as not synced, until the server's
// rendering arrives) and is sent when the leader tab can. A conflicting
// edit is resolved here, in the editor: the 3-way merge with markers, or
// either side whole. While typing, the text is kept in IndexedDB (drafts),
// so a reload or a crash never loses it. The field is the CodeMirror
// composer with Forgejo's preview (editor/Composer.tsx).

import {MoreHorizontal, Pencil, Trash2} from 'lucide-react';
import {runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type RefObject, useEffect, useId, useRef, useState} from 'react';
import {notify} from '../../app/notices.ts';
import {shortcutHint, type ShortcutId, useShortcut} from '../../app/shortcuts/index.ts';
import {useApp, useSession} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import {uuid} from '../../intents/intents.ts';
import {hasConflictMarkers} from '../../intents/merge3.ts';
import {editing} from '../../intents/session.ts';
import {commentBody, issueBody, issueTitle} from '../../intents/view.ts';
import {
  Button, Callout, Dialog, EditableHeading, IconButton, Menu, MenuContent, MenuItem, MenuTrigger, PendingBadge, ProseSource, SkeletonText, TitleInput,
} from '../../ui/index.ts';
import {Missing} from '../../app/Missing.tsx';
import {reach} from '../../app/online.ts';
import {canWrite} from '../../app/access.ts';
import {MarkdownField} from '../editor/Composer.tsx';
import {useUser} from '../issues/cells.tsx';
import {Markdown, toggleTask} from './Markdown.tsx';

/** Markdown as it shows: the server's rendering, or the typed source while an edit is not synced. */
export function Rendered({text, html, local, onTask}: {text: string; html: string; local: boolean; onTask?: ((index: number, checked: boolean) => void) | undefined}) {
  if (local) return <ProseSource text={text}/>;
  return html ? <Markdown html={html} onTask={onTask}/> : <p className="text-base text-fg-subtle">No text.</p>;
}

/** Resolves a conflict with one side whole (the merge being typed in the editor is dropped with it). */
function resolveWith(intents: ReturnType<typeof editing>['intents'], id: string, text: string): void {
  void intents.discardDraft(`text:conflict:${id}`);
  intents.resolve(id, text);
}

/** Marks text that Forgejo does not have yet. */
export function NotSynced() {
  return <PendingBadge label="Not synced yet: Forgejo renders it once it has it">Not synced</PendingBadge>;
}

/** What an edit is based on: the text the user started from, its content_version (-1: an unsynced edit's text) and updated_at. */
export interface EditBase {
  text: string;
  version: number;
  updated?: string | undefined;
}

interface TextEditorProps {
  /** Where the text being typed is kept (drafts): `text:<what>:<id>`. */
  draftKey: string;
  title: string;
  issueId: number;
  repoId: number;
  initial: string;
  /** The base of the edit, taken when editing starts (kept with the draft: a restored draft keeps its own). */
  base?: EditBase | undefined;
  label: string;
  saveLabel: string;
  onSave: (text: string, base: EditBase | undefined) => void;
  onCancel?: (() => void) | undefined;
  /** Saving is refused while the text still has conflict markers. */
  markers?: boolean | undefined;
  rows?: number;
  autoFocus?: boolean;
  /** An element describing the editor (who comments). */
  describedBy?: string | undefined;
  /** After Esc/Cancel, the Undo notice reopens the editor (with the text) through this. */
  onReopen?: (() => void) | undefined;
  /** A shortcut that focuses the editor (R: the comment box). */
  focusShortcut?: ShortcutId | undefined;
}

/** A markdown text area that keeps what is typed (drafts) and saves with ⌘↵. */
/** The draft keys of the editors open on this page. */
const openEditors = new Set<string>();

export const TextEditor = observer(function TextEditor({draftKey, title, issueId, repoId, initial, base: base0, label, saveLabel, onSave, onCancel, markers, rows, autoFocus, describedBy, onReopen, focusShortcut}: TextEditorProps) {
  const app = useApp();
  const {intents} = editing(app);
  const [restored] = useState(() => untracked(() => intents.drafts.get(draftKey)));
  const [text, setText] = useState(restored?.text ?? initial);
  // The base the user started from: the restored draft's, else the one when the editor opened.
  const [base] = useState(restored?.base ?? base0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** The keep that the debounce has not run yet (run at once when the editor goes: leaving the page loses nothing). */
  const pending = useRef<(() => void) | undefined>(undefined);
  /** Saved or cancelled: an autosave still in flight must not bring the draft back. */
  const done = useRef(false);
  const dirty = text !== initial;
  const blocked = markers === true && hasConflictMarkers(text);
  useEffect(() => {
    openEditors.add(draftKey);
    return () => {
      openEditors.delete(draftKey);
      clearTimeout(timer.current);
      const keep = pending.current;
      pending.current = undefined;
      if (keep && !done.current) keep();
    };
  }, [draftKey]);
  const change = (t: string) => {
    setText(t);
    done.current = false;
    clearTimeout(timer.current);
    // Kept while typing (never lost to a reload or a crash); forgotten once saved or cancelled.
    const keep = () => {
      pending.current = undefined;
      if (t === initial) void intents.discardDraft(draftKey);
      else {
        void intents.keepText({key: draftKey, title, issueId, repoId, text: t, ...(base ? {base} : {})}).then(() => {
          if (done.current) void intents.discardDraft(draftKey);
        });
      }
    };
    pending.current = keep;
    timer.current = setTimeout(keep, 400);
  };
  const forget = () => {
    done.current = true;
    pending.current = undefined;
    clearTimeout(timer.current);
    void intents.discardDraft(draftKey);
  };
  const save = () => {
    if (blocked || (!dirty && !markers) || !text.trim()) return;
    forget();
    onSave(text, base);
    if (!onCancel) setText('');
  };
  const cancel = () => {
    done.current = true;
    pending.current = undefined;
    clearTimeout(timer.current);
    if (dirty) {
      // Never dropped silently: the text can come back (and the editor reopens with it).
      const kept = {key: draftKey, kind: 'text' as const, title, issueId, repoId, text, at: Date.now(), ...(base ? {base} : {})};
      void intents.discardDraft(draftKey);
      notify(app, {tone: 'neutral', title: 'Edit discarded', action: {label: 'Undo', run: () => {
        // Opened again meanwhile: its text is not overwritten; the discarded one goes to the Unsynced drafts.
        if (openEditors.has(draftKey)) {
          void intents.restoreDraft({...kept, key: `${draftKey}:undo:${String(kept.at)}`}).then(() => {
            notify(app, {tone: 'neutral', title: 'Kept in Unsynced changes', description: 'The editor is open again: your discarded text is in the drafts there.'});
          });
        } else void intents.restoreDraft(kept).then(() => onReopen?.());
      }}});
    } else forget();
    onCancel?.();
  };
  // ⌘↵ saves the editor that has the focus (handled by the editor, not by the global shortcut table: several
  // editors can be open at once); Esc cancels.
  return (
    <div className="flex flex-col gap-2">
      <MarkdownField repoId={repoId} label={label} describedBy={describedBy} value={text} rows={rows ?? 6} autoFocus={autoFocus} invalid={blocked}
        onChange={change} onSubmit={save} onCancel={onCancel ? cancel : undefined} focusShortcut={focusShortcut}/>
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
  const session = useSession();
  const {data} = session;
  // Forgejo: the poster, or a writer of the repository.
  const mayEdit = issue.get('poster_id') === session.userId || canWrite(session, issue.get('repo_id'));
  const {overlay, intents} = editing(app);
  /** Editing, from this base (taken when the editor opens). */
  const [edit, setEdit] = useState<EditBase | false>(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    // Back to the control that opened the editor.
    if (!edit && refocus.current) editButton.current?.focus();
    refocus.current = false;
  }, [edit]);
  const close = () => {
    refocus.current = true;
    setEdit(false);
  };
  const body = issueBody(data.pool, overlay, issue.id);
  const conflict = intents.conflictOf('issue.body', issue.id);
  const start = () => {
    const b = untracked(() => issueBody(data.pool, overlay, issue.id));
    if (!b || !mayEdit) return;
    // The server's text and version, or (-1) the text of an edit not synced yet.
    setEdit({text: b.text, version: b.local ? -1 : untracked(() => data.pool.model('IssueBody').get(issue.id)?.data.content_version) ?? -1});
  };
  useShortcut('issue.edit', start);
  const repoId = issue.get('repo_id');
  if (conflict?.conflict) {
    const c = conflict.conflict;
    const mine = conflict.intent.kind === 'issue.body' ? conflict.intent.text : '';
    return (
      <div className="flex flex-col gap-2">
        <Callout tone="warning" title="Your edit conflicts with a newer change" actions={<>
          <Button size="sm" onClick={() => { resolveWith(intents, conflict.id, mine); }}>Keep mine</Button>
          <Button size="sm" onClick={() => { resolveWith(intents, conflict.id, c.theirs); }}>Use theirs</Button>
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
    // Offline, an issue never opened on this device has no description here (and nothing more can arrive):
    // say so, as the code views do, instead of a placeholder that never resolves.
    if (reach(data.status.connection) !== 'online') {
      // With what is on this device (the sentence ends "open one of these:").
      return <Missing what="Its description and comments"/>;
    }
    return (
      <div className="flex flex-col gap-2 py-1" aria-busy>
        <SkeletonText/>
      </div>
    );
  }
  if (edit) {
    return (
      <TextEditor draftKey={`text:body:${String(issue.id)}`} title="Editing the description" issueId={issue.id} repoId={repoId}
        initial={edit.text} base={edit} label="Description" saveLabel="Save" rows={12} autoFocus
        onCancel={close} onReopen={start}
        onSave={(text, base) => {
          // Based on what the user started from (3-way merged if it moved meanwhile).
          const b = base ?? edit;
          intents.submit({kind: 'issue.body', issueId: issue.id, repoId, text, baseText: b.text, baseVersion: b.version});
          close();
        }}/>
    );
  }
  return (
    <div className="flex items-start gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {body.text || body.html ? <Rendered {...body} onTask={mayEdit ? (index, checked) => {
          // Ticking a task edits the description (an offline-capable edit, like the editor's).
          const b = untracked(() => issueBody(data.pool, overlay, issue.id));
          if (!b) return;
          const text = toggleTask(b.text, index, checked);
          if (text === b.text) return;
          const version = b.local ? -1 : untracked(() => data.pool.model('IssueBody').get(issue.id)?.data.content_version) ?? -1;
          intents.submit({kind: 'issue.body', issueId: issue.id, repoId, text, baseText: b.text, baseVersion: version});
        } : undefined}/> : <p className="text-base text-fg-subtle">No description.</p>}
        {body.local && <NotSynced/>}
      </div>
      {mayEdit && <IconButton ref={editButton} size="sm" icon={Pencil} label="Edit the description" shortcut={shortcutHint('issue.edit')} onClick={start}/>}
    </div>
  );
});

/** The viewer's own comment's actions (in its card's header): edit, delete. */
export function CommentActions({c, onEdit, triggerRef}: {c: Entity<'Comment'>; onEdit: () => void; triggerRef: RefObject<HTMLButtonElement | null>}) {
  const app = useApp();
  const {userId} = useSession();
  const {intents} = editing(app);
  /** Edit was chosen: the editor that opens keeps the focus. */
  const chose = useRef(false);
  const [confirming, setConfirming] = useState(false);
  if (untracked(() => c.data.poster_id) !== userId) return null;
  const remove = () => {
    setConfirming(false);
    const {issue_id: issueId} = untracked(() => c.data);
    intents.submit({kind: 'comment.delete', issueId, repoId: repoOf(app, issueId), commentId: c.id});
  };
  return (
    <>
    {confirming && (
      <Dialog open size="sm" title="Delete this comment?" description="It is removed for everyone. This cannot be undone." onOpenChange={(o) => {
        if (!o) setConfirming(false);
      }} footer={<>
        <Button variant="ghost" onClick={() => {
          setConfirming(false);
        }}>Cancel</Button>
        <Button variant="danger" autoFocus onClick={remove}>Delete</Button>
      </>}/>
    )}
    <Menu>
      <MenuTrigger asChild><IconButton ref={triggerRef} size="sm" icon={MoreHorizontal} label="Comment actions" className="ml-auto"/></MenuTrigger>
      {/* After Edit the editor takes the focus once the menu is gone (while the menu is open its focus trap keeps the
          focus, and Radix would return it to the trigger); otherwise the trigger has it. */}
      <MenuContent align="end" onCloseAutoFocus={(e) => {
        if (chose.current) {
          e.preventDefault();
          const card = triggerRef.current?.closest('article');
          requestAnimationFrame(() => {
            card?.querySelector<HTMLElement>('.cm-content, textarea')?.focus();
          });
        }
        chose.current = false;
      }}>
        <MenuItem icon={Pencil} onSelect={() => {
          chose.current = true;
          onEdit();
        }}>Edit</MenuItem>
        <MenuItem icon={Trash2} danger onSelect={() => {
          setConfirming(true);
        }}>Delete…</MenuItem>
      </MenuContent>
    </Menu>
    </>
  );
}

/** The repository of an issue (one created offline included). */
function repoOf(app: ReturnType<typeof useApp>, issueId: number): number {
  const pool = app.session?.data.pool;
  return untracked(() => pool?.model('Issue').get(issueId)?.data.repo_id ?? (editing(app).overlay.createdEntity('Issue', issueId) as Entity<'Issue'> | undefined)?.data.repo_id ?? 0);
}

/** A comment's body (the unsynced text, or the server's rendering), its editor, its edit conflict. */
export const CommentBody = observer(function CommentBody({c, edit, onEditDone, onReopen}: {c: Entity<'Comment'>; edit: boolean; onEditDone: () => void; onReopen: () => void}) {
  const app = useApp();
  const {overlay, intents} = editing(app);
  const b = commentBody(overlay, c);
  const conflict = intents.conflictOf('comment.edit', c.id);
  const issueId = c.get('issue_id');
  const repoId = repoOf(app, issueId);
  if (b.deleted) return null;
  if (conflict?.conflict && conflict.intent.kind === 'comment.edit') {
    const cf = conflict.conflict;
    const mine = conflict.intent.text;
    return (
      <div className="flex flex-col gap-2">
        <Callout tone="warning" title="This comment changed while you edited it" actions={<>
          <Button size="sm" onClick={() => { resolveWith(intents, conflict.id, mine); }}>Keep mine</Button>
          <Button size="sm" onClick={() => { resolveWith(intents, conflict.id, cf.theirs); }}>Use theirs</Button>
        </>}>Edit the merge below, or keep one side.</Callout>
        <TextEditor key={conflict.id} draftKey={`text:conflict:${conflict.id}`} title="Resolving a comment" issueId={issueId} repoId={repoId}
          initial={cf.merged} label="Resolve the comment" saveLabel="Save" markers onSave={(t) => intents.resolve(conflict.id, t)}/>
      </div>
    );
  }
  if (edit) return <CommentEditor c={c} issueId={issueId} repoId={repoId} onDone={onEditDone} onReopen={onReopen}/>;
  return (
    <div className="flex flex-col gap-1">
      <Rendered {...b}/>
      {b.local && <NotSynced/>}
    </div>
  );
});

/** A comment's editor: its base (text, version, updated_at) is taken when it opens. */
function CommentEditor({c, issueId, repoId, onDone, onReopen}: {c: Entity<'Comment'>; issueId: number; repoId: number; onDone: () => void; onReopen: () => void}) {
  const app = useApp();
  const {overlay, intents} = editing(app);
  const [base] = useState<EditBase>(() => untracked(() => {
    const b = commentBody(overlay, c);
    return {text: b.text, version: b.local ? -1 : c.data.content_version, updated: c.data.updated_at};
  }));
  return (
    <TextEditor draftKey={`text:comment:${String(c.id)}`} title="Editing a comment" issueId={issueId} repoId={repoId} initial={base.text} base={base}
      label="Comment" saveLabel="Save" autoFocus onCancel={onDone} onReopen={onReopen}
      onSave={(text, b0) => {
        const b = b0 ?? base;
        intents.submit({kind: 'comment.edit', issueId, repoId, commentId: c.id, text, baseText: b.text, baseVersion: b.version, baseUpdated: b.updated ?? ''});
        onDone();
      }}/>
  );
}

/** The new-comment box at the end of the timeline. */
export function CommentComposer({issueId, repoId}: {issueId: number; repoId: number}) {
  const app = useApp();
  const me = useUser(useSession().userId);
  const who = useId();
  const {intents} = editing(app);
  return (
    <div className="flex flex-col gap-2 pt-3">
      <span id={who} className="sr-only">Commenting as {me.login}</span>
      <TextEditor describedBy={who} draftKey={`text:new-comment:${String(issueId)}`} title="A new comment" issueId={issueId} repoId={repoId} initial=""
        label="Leave a comment" saveLabel="Comment" rows={4} focusShortcut="issue.comment"
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

/** The issue's title, renamed in place (click it): Enter or leaving the field saves, Esc cancels. Poster or writers only. */
export const TitleSection = observer(function TitleSection({issue}: {issue: Entity<'Issue'>}) {
  const app = useApp();
  const session = useSession();
  const {overlay, intents} = editing(app);
  const [text, setText] = useState<string | undefined>(undefined);
  const title = issueTitle(overlay, issue);
  const mayEdit = issue.get('poster_id') === session.userId || canWrite(session, issue.get('repo_id'));
  if (text === undefined) {
    if (!mayEdit) return <h2 className="text-xl font-semibold text-fg">{title}</h2>;
    return <EditableHeading label="Rename" onEdit={() => {
      setText(title);
    }}>{title}</EditableHeading>;
  }
  const save = () => {
    const t = text.trim();
    setText(undefined);
    if (t && t !== title) {
      runInAction(() => {
        intents.submit({kind: 'issue.title', issueId: issue.id, repoId: issue.get('repo_id'), title: t, base: title});
      });
    }
  };
  return (
    <TitleInput aria-label="Title" value={text} autoFocus maxLength={255} invalid={!text.trim()} onBlur={save} onChange={(e) => {
      setText(e.target.value);
    }} onKeyDown={(e) => {
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setText(undefined);
      }
    }}/>
  );
});
