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
import {runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, type RefObject, useEffect, useId, useRef, useState} from 'react';
import {dismissSeries, notify} from '../../app/notices.ts';
import {shortcutHint, type ShortcutId, useShortcut} from '../../app/shortcuts/index.ts';
import {useApp, useSession} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import {uuid} from '../../intents/intents.ts';
import {hasConflictMarkers} from '../../intents/merge3.ts';
import {editing, overrideSeries, overrideWords} from '../../intents/session.ts';
import {commentBody, issueBody, issueState, issueTitle} from '../../intents/view.ts';
import {
  Callout, CommandPick, CommandPopover, Dialog, EditableHeading, matchOptions, Menu, MenuContent, MenuItem, MenuTrigger, PendingBadge,
  type PickOption, ProseSource, TitleInput,
} from '../../ui/index.ts';
import {Missing} from '../../app/Missing.tsx';
import {reach} from '../../app/online.ts';
import {canWrite} from '../../app/access.ts';
import {MarkdownField} from '../editor/Composer.tsx';
import {hasPendingUploads} from '../editor/attachments.ts';
import {usePool, useUser} from '../issues/cells.tsx';
import {changeState, setWorkflowStatus} from '../issues/actions.ts';
import {repoLabels} from '../issues/candidates.ts';
import {kindRank, labelKind, scopedValue, statusStage} from '../issues/labels.ts';
import type {Label} from '../../protocol/types.gen.ts';
import {Markdown, toggleTask} from './Markdown.tsx';
import {ChevronDownIcon, SkipIcon, CopyIcon, LinkIcon, KebabHorizontalIcon, PencilIcon, QuoteIcon, TrashIcon} from '@primer/octicons-react';
import {Button, IconButton, Dialog as PrimerDialog} from '@primer/react';
import {OptionalTooltip} from '../../app/OptionalTooltip.tsx';
import {SkeletonText} from '@primer/react/experimental';

/** Markdown as it shows: the server's rendering, or the typed source while an edit is not synced. */
export function Rendered({text, html, local, onTask}: {text: string; html: string; local: boolean; onTask?: ((index: number, checked: boolean) => void) | undefined}) {
  if (local) return <ProseSource text={text}/>;
  return html ? <Markdown html={html} onTask={onTask}/> : <p className="text-base text-muted">No text.</p>;
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
  onTextChange?: (text: string) => void;
  stateAction?: {
    label: (hasText: boolean) => string;
    run: (text: string) => void;
    /** More ways to change the state beside the button (close reasons): `act` runs one with the text, as the button does. */
    more?: ((act: (run: (text: string) => void) => void) => ReactNode) | undefined;
  } | undefined;
  quote?: boolean;
}

/** A markdown text area that keeps what is typed (drafts) and saves with ⌘↵. */
/** The draft keys of the editors open on this page. */
const openEditors = new Set<string>();

export const TextEditor = observer(function TextEditor({draftKey, title, issueId, repoId, initial, base: base0, label, saveLabel, onSave, onCancel, markers, rows, autoFocus, describedBy, onReopen, focusShortcut, onTextChange, stateAction, quote}: TextEditorProps) {
  const app = useApp();
  const {intents} = editing(app);
  const [restored] = useState(() => untracked(() => intents.drafts.get(draftKey)));
  const [text, setText] = useState(restored?.text ?? initial);
  const [confirmCancel, setConfirmCancel] = useState(false);
  // The base the user started from: the restored draft's, else the one when the editor opened.
  const [base, setBase] = useState(restored?.base ?? base0);
  /** Opened on a kept draft, or typed in since: a draft read later never replaces that text. */
  const touched = useRef(restored !== undefined);
  // The drafts are read from IndexedDB at boot, and a page can open before that is done (QA #193: an offline reload
  // showed an empty comment box, and typing then overwrote the kept text): one arriving while nothing was typed yet
  // is what the editor shows.
  const late = touched.current ? undefined : intents.drafts.get(draftKey);
  useEffect(() => {
    if (late?.kind !== 'text' || late.text === undefined || touched.current) return;
    touched.current = true;
    setText(late.text);
    if (late.base) setBase(late.base);
    onTextChange?.(late.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the kept draft arrives
  }, [late]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** The keep that the debounce has not run yet (run at once when the editor goes: leaving the page loses nothing). */
  const pending = useRef<(() => void) | undefined>(undefined);
  /** Saved or cancelled: an autosave still in flight must not bring the draft back. */
  const done = useRef(false);
  const [insertion, setInsertion] = useState<{text: string}>();
  useEffect(() => {
    if (!quote) return;
    const insert = (event: Event) => {
      const detail = (event as CustomEvent<{issueId: number; text: string}>).detail;
      if (detail.issueId === issueId) setInsertion({text: `\n${detail.text.split('\n').map((line) => `> ${line}`).join('\n')}\n\n`});
    };
    window.addEventListener('forgejo:quote', insert);
    return () => { window.removeEventListener('forgejo:quote', insert); };
  }, [quote, issueId]);
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
    touched.current = true;
    setText(t);
    onTextChange?.(t);
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
    if (blocked || hasPendingUploads(text) || (!dirty && !markers) || !text.trim()) return;
    forget();
    onSave(text, base);
    if (!onCancel) setText('');
  };
  /** Changes the state with the text (posted with it): the editor empties, as after saving. */
  const act = (run: (text: string) => void) => {
    if (hasPendingUploads(text)) return;
    forget();
    run(text);
    change('');
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
    <div className="flex flex-col gap-2" onKeyDownCapture={(e) => {
      if (stateAction && e.key === 'Enter' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        act(stateAction.run);
      }
    }}>
      {confirmCancel && <PrimerDialog title="Discard this edit?" subtitle="Your changes can be restored with Undo." width="medium" onClose={() => { setConfirmCancel(false); }} renderFooter={() => <PrimerDialog.Footer>{<>
        <Button variant="invisible" type="button" onClick={() => { setConfirmCancel(false); }}>Keep editing</Button>
        <Button variant="danger" type="button" onClick={() => {
          setConfirmCancel(false);
          cancel();
        }}>Discard</Button>
      </>}</PrimerDialog.Footer>}></PrimerDialog>}
      <MarkdownField insertion={insertion} repoId={repoId} attachmentIssueId={issueId} label={label} describedBy={describedBy} value={text} rows={rows ?? 6} autoFocus={autoFocus} invalid={blocked}
        onChange={change} onSubmit={save} onCancel={onCancel ? () => {
          if (dirty) setConfirmCancel(true);
          else cancel();
        } : undefined} focusShortcut={focusShortcut}/>
      <div className="flex items-center justify-end gap-2">
        {blocked && <span className="mr-auto text-sm text-attention">Remove the conflict markers to save.</span>}
        {onCancel && <Button variant="invisible" size="small" type="button" onClick={cancel}>Cancel</Button>}
        {stateAction && <span className="flex items-center gap-1">
          <Button size="small" type="button" disabled={hasPendingUploads(text)} onClick={() => {
            act(stateAction.run);
          }}>{stateAction.label(Boolean(text.trim()))}</Button>
          {stateAction.more?.(act)}
        </span>}
        <OptionalTooltip text={`${saveLabel} (works offline)`} keybindingHint={shortcutHint('submit')}><Button variant="primary" size="small" type="button" disabled={blocked || hasPendingUploads(text) || !text.trim() || (!dirty && !markers)} onClick={save}>{saveLabel}</Button></OptionalTooltip>
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
          <Button size="small" type="button" onClick={() => { resolveWith(intents, conflict.id, mine); }}>Keep mine</Button>
          <Button size="small" type="button" onClick={() => { resolveWith(intents, conflict.id, c.theirs); }}>Use theirs</Button>
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
        <SkeletonText lines={3}/>
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
        } : undefined}/> : <p className="text-base text-muted">No description.</p>}
        {body.local && <NotSynced/>}
      </div>
      {mayEdit && <IconButton icon={PencilIcon} variant="invisible" size="small" aria-label="Edit the description" keybindingHint={shortcutHint('issue.edit')} type="button" ref={editButton} onClick={start}/>}
    </div>
  );
});

/** Comment actions: anyone may quote; authors and repository writers may moderate. */
export const CommentActions = observer(function CommentActions({c, onEdit, triggerRef}: {c: Entity<'Comment'>; onEdit: () => void; triggerRef: RefObject<HTMLButtonElement | null>}) {
  const app = useApp();
  const session = useSession();
  const {userId} = session;
  const {intents} = editing(app);
  /** Edit was chosen: the editor that opens keeps the focus. */
  const chose = useRef(false);
  const quoted = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const fallback = useRef<HTMLElement | null>(null);
  const mayEdit = c.get('poster_id') === userId || canWrite(session, repoOf(app, c.get('issue_id')));
  const selection = useRef('');
  const remove = () => {
    setConfirming(false);
    const {issue_id: issueId} = untracked(() => c.data);
    intents.submit({kind: 'comment.delete', issueId, repoId: repoOf(app, issueId), commentId: c.id});
  };
  return (
    <>
    {confirming && (
      <Dialog open size="sm" returnFocus={() => triggerRef.current?.isConnected ? triggerRef.current : fallback.current} title="Delete this comment?" description="It is removed for everyone. This cannot be undone." onOpenChange={(o) => {
        if (!o) setConfirming(false);
      }} footer={<>
        <Button variant="invisible" type="button" onClick={() => {
          setConfirming(false);
        }}>Cancel</Button>
        <Button variant="danger" type="button" onClick={remove}>Delete</Button>
      </>}/>
    )}
    <Menu onOpenChange={(open) => {
      if (!open) return;
      const selected = window.getSelection();
      const card = triggerRef.current?.closest('article');
      selection.current = selected?.anchorNode && card?.contains(selected.anchorNode) ? selected.toString() : '';
    }}>
      <MenuTrigger asChild><IconButton icon={KebabHorizontalIcon} variant="invisible" size="small" aria-label="Comment actions" type="button" ref={triggerRef} className="ml-auto"/></MenuTrigger>
      {/* After Edit the editor takes the focus once the menu is gone (while the menu is open its focus trap keeps the
          focus, and Radix would return it to the trigger); otherwise the trigger has it. */}
      <MenuContent align="end" onCloseAutoFocus={(e) => {
        if (quoted.current) e.preventDefault();
        quoted.current = false;
        if (chose.current) {
          e.preventDefault();
          const card = triggerRef.current?.closest('article');
          requestAnimationFrame(() => {
            card?.querySelector<HTMLElement>('.cm-content, textarea')?.focus();
          });
        }
        chose.current = false;
      }}>
        <MenuItem icon={QuoteIcon} onSelect={() => {
          quoted.current = true;
          window.dispatchEvent(new CustomEvent('forgejo:quote', {detail: {issueId: c.get('issue_id'), text: selection.current || commentBody(editing(app).overlay, c).text}}));
        }}>Quote reply</MenuItem>
        {mayEdit && <MenuItem icon={PencilIcon} onSelect={() => {
          chose.current = true;
          onEdit();
        }}>Edit</MenuItem>}
        {mayEdit && c.get('type') !== 'review' && <MenuItem icon={TrashIcon} danger onSelect={() => {
          fallback.current = triggerRef.current?.closest('main')?.querySelector<HTMLElement>('button[aria-label="Add a reaction"]') ?? null;
          setConfirming(true);
        }}>Delete…</MenuItem>}
        <MenuItem icon={LinkIcon} onSelect={() => {
          const url = new URL(window.location.href);
          if (c.get('type') === 'code') {
            url.searchParams.set('tab', 'files');
            url.hash = `review-thread-${String(c.id)}`;
          } else url.hash = `comment-${String(c.id)}`;
          void navigator.clipboard.writeText(url.href).catch(() => notify(app, {tone: 'warning', title: 'Could not copy the link'}));
        }}>Copy link</MenuItem>
      </MenuContent>
    </Menu>
    </>
  );
});

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
  const [selected, setSelected] = useState('');
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
          <Button size="small" type="button" onClick={() => { resolveWith(intents, conflict.id, mine); }}>Keep mine</Button>
          <Button size="small" type="button" onClick={() => { resolveWith(intents, conflict.id, cf.theirs); }}>Use theirs</Button>
        </>}>Edit the merge below, or keep one side.</Callout>
        <TextEditor key={conflict.id} draftKey={`text:conflict:${conflict.id}`} title="Resolving a comment" issueId={issueId} repoId={repoId}
          initial={cf.merged} label="Resolve the comment" saveLabel="Save" markers onSave={(t) => intents.resolve(conflict.id, t)}/>
      </div>
    );
  }
  if (edit) return <CommentEditor c={c} issueId={issueId} repoId={repoId} onDone={onEditDone} onReopen={onReopen}/>;
  return (
    <div className="flex flex-col gap-1" onMouseUp={(e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const selection = window.getSelection();
      setSelected(selection?.anchorNode && e.currentTarget.contains(selection.anchorNode) ? selection.toString() : '');
    }}>
      <Rendered {...b}/>
      {selected && <Button variant="invisible" size="small" type="button" onClick={() => {
        window.dispatchEvent(new CustomEvent('forgejo:quote', {detail: {issueId, text: selected}}));
        setSelected('');
      }}>Quote reply</Button>}
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
  const draftKey = `text:comment:${String(c.id)}`;
  const latestText = useRef(untracked(() => intents.drafts.get(draftKey))?.text ?? base.text);
  // Deleted on Forgejo while it was being edited: the editor goes with the comment, but the text is kept (the
  // editor's draft) and said, with a way to post it (QA verify3: it vanished without a word).
  useEffect(() => () => {
    setTimeout(() => {
      if (untracked(() => app.session?.data.pool.model('Comment').get(c.id))) return;
      const text = latestText.current;
      if (!text.trim() || text === base.text) return;
      notify(app, {tone: 'warning', title: 'The comment you were editing was deleted', description: 'Someone deleted it on Forgejo. Your text is kept.', sticky: true,
        action: {label: 'Post it as a new comment', run: () => {
          runInAction(() => {
            intents.submit({kind: 'comment.create', issueId, repoId, tempId: uuid(), body: text});
          });
          void intents.discardDraft(draftKey);
        }}});
    }, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when the editor goes
  }, []);
  return (
    <TextEditor draftKey={draftKey} title="Editing a comment" issueId={issueId} repoId={repoId} initial={base.text} base={base}
      label="Comment" saveLabel="Save" autoFocus onCancel={onDone} onReopen={onReopen}
      onTextChange={(text) => { latestText.current = text; }}
      onSave={(text, b0) => {
        const b = b0 ?? base;
        intents.submit({kind: 'comment.edit', issueId, repoId, commentId: c.id, text, baseText: b.text, baseVersion: b.version, baseUpdated: b.updated ?? ''});
        onDone();
      }}/>
  );
}

/** The new-comment box at the end of the timeline. */
export const CommentComposer = observer(function CommentComposer({issueId, repoId}: {issueId: number; repoId: number}) {
  const app = useApp();
  const session = useSession();
  const me = useUser(session.userId);
  const who = useId();
  const {intents, overlay} = editing(app);
  const issue = session.data.pool.model('Issue').get(issueId) ?? overlay.createdEntity('Issue', issueId) as Entity<'Issue'> | undefined;
  const state = issue ? issueState(overlay, issue) : 'open';
  const mayChangeState = issue && (issue.get('poster_id') === session.userId || canWrite(session, repoId));
  return (
    <div className="flex flex-col gap-2 pt-3">
      <span id={who} className="sr-only">Commenting as {me.login}</span>
      <TextEditor describedBy={who} draftKey={`text:new-comment:${String(issueId)}`} title="A new comment" issueId={issueId} repoId={repoId} initial=""
        label="Leave a comment" saveLabel="Comment" rows={4} focusShortcut="issue.comment" quote
        stateAction={mayChangeState ? {
          label: (hasText) => `${state === 'closed' ? 'Reopen' : 'Close'} ${hasText ? 'with comment' : issue.get('is_pull') ? 'pull request' : 'issue'}`,
          run: (body) => {
            runInAction(() => {
              if (body.trim()) intents.submit({kind: 'comment.create', issueId, repoId, tempId: uuid(), body});
              intents.submit({kind: 'issue.state', issueId, repoId, state: state === 'closed' ? 'open' : 'closed', base: state});
            });
          },
          // An open issue closes with a reason too: not planned, or a duplicate of another issue.
          more: state === 'open' && !issue.get('is_pull') && issueId > 0 ? (act) => <CloseReasons issue={issue} act={act}/> : undefined,
        } : undefined}
        onSave={(body) => {
          runInAction(() => {
            intents.submit({kind: 'comment.create', issueId, repoId, tempId: uuid(), body});
          });
        }}/>
    </div>
  );
});

/** The words of a duplicate's comment (GitHub's): Forgejo links it both ways, and the timeline reads the close as one. */
export function duplicateComment(number: number, text: string): string {
  return `Duplicate of #${String(number)}${text.trim() ? `\n\n${text}` : ''}`;
}

/** How many issues the duplicate list shows (type to find others). */
const DUPLICATE_CHOICES = 30;

/**
 * Closing with a reason (Forgejo has no close reason of its own): "Not planned" sets the repository's canceled
 * workflow status (status/Canceled, Won't fix, …: a done or canceled status closes the issue), offered only when
 * the repository has one; "Duplicate of #N" posts that comment (a cross-reference #N shows too) and closes, with the
 * repository's duplicate status when it has one. The typed comment is posted with either.
 */
const CloseReasons = observer(function CloseReasons({issue, act}: {issue: Entity<'Issue'>; act: (run: (text: string) => void) => void}) {
  const app = useApp();
  return (
    <CommandPopover label="Close with a reason" placeholder="Not planned, or duplicate of… (number or title)" width="md" options={[]}
      trigger={<OptionalTooltip text={'Close as not planned or as a duplicate'}><Button size="small" type="button" aria-label="Close with a reason"><ChevronDownIcon size={12} className="shrink-0"/></Button></OptionalTooltip>}
      render={(onClose) => <CloseReasonPick issue={issue} onClose={onClose} choose={(reason) => {
        act((text) => {
          const {issueId, repoId} = {issueId: issue.id, repoId: issue.get('repo_id')};
          runInAction(() => {
            const body = reason.duplicateOf ? duplicateComment(reason.duplicateOf, text) : text;
            if (body.trim()) editing(app).intents.submit({kind: 'comment.create', issueId, repoId, tempId: uuid(), body});
            if (reason.status) setWorkflowStatus(app, [issue], reason.status);
            else changeState(app, [issue], 'closed');
          });
        });
      }}/>}/>
  );
});

const CloseReasonPick = observer(function CloseReasonPick({issue, onClose, choose}: {
  issue: Entity<'Issue'>; onClose: () => void; choose: (reason: {status?: Label | undefined; duplicateOf?: number}) => void;
}) {
  const pool = usePool();
  const [query, setQuery] = useState('');
  const repoId = issue.get('repo_id');
  const canceled = repoLabels(pool, repoId).filter((l) => labelKind(l) === 'status' && statusStage(scopedValue(l.name)) === 'canceled')
    .sort((a, b) => kindRank('status', a.name) - kindRank('status', b.name));
  const duplicateStatus = canceled.find((l) => /^duplicate/i.test(scopedValue(l.name)));
  const notPlanned = canceled.find((l) => l !== duplicateStatus);
  const others = [...pool.model('Issue').by('repo_id', repoId)].map((e) => e.data)
    .filter((i) => i.id !== issue.id && !i.is_pull && i.number > 0)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const options: PickOption[] = [];
  if (notPlanned) {
    options.push(...matchOptions([{value: 'not-planned', label: 'Not planned', words: `${scopedValue(notPlanned.name)} wontfix canceled`, group: 'Close as',
      icon: SkipIcon, meta: `status: ${scopedValue(notPlanned.name)}`, onSelect: () => {
        choose({status: notPlanned});
      }}], query));
  }
  const q = query.trim().replace(/^#/, '');
  const exact = /^[1-9]\d{0,15}$/.test(q) ? Number(q) : undefined;
  // A number not on this device is still a reference Forgejo resolves (an older closed issue).
  if (exact !== undefined && exact !== issue.get('number') && !others.some((i) => i.number === exact)) {
    options.push({value: `number-${String(exact)}`, label: `#${String(exact)}`, group: 'Duplicate of', icon: CopyIcon, onSelect: () => {
      choose({status: duplicateStatus, duplicateOf: exact});
    }});
  }
  options.push(...matchOptions(others.map((i) => ({value: `issue-${String(i.id)}`, label: `#${String(i.number)} ${i.title}`, group: 'Duplicate of',
    icon: CopyIcon, meta: i.state === 'closed' ? 'closed' : undefined, onSelect: () => {
      choose({status: duplicateStatus, duplicateOf: i.number});
    }})), q).slice(0, DUPLICATE_CHOICES));
  return <CommandPick label="Close with a reason" placeholder="Not planned, or duplicate of… (number or title)" options={options} filtered query={query} onQueryChange={setQuery}
    empty="No issue matches. Type its number." onClose={onClose}/>;
});

/** Changes of yours that overrode someone's newer value (last writer wins), with one-click undo. */
export const Overrides = observer(function Overrides({issueId}: {issueId: number}) {
  const app = useApp();
  const {intents} = editing(app);
  const mine = intents.overrides.filter((o) => o.issueId === issueId);
  // Said here: the notice of the same override goes (one message, one wording).
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
          <Callout key={o.id} title={words.title} actions={<>
            <Button size="small" type="button" onClick={() => {
              intents.undoOverride(o.id);
            }}>Undo</Button>
            <Button variant="invisible" size="small" type="button" onClick={() => {
              intents.dismissOverride(o.id);
            }}>Dismiss</Button>
          </>}>{words.description}</Callout>
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
    if (!mayEdit) return <h2 className="text-xl font-semibold text-default">{title}</h2>;
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
