// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Unsynced edits render as source until Forgejo supplies HTML; drafts persist in IndexedDB.
import {runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactElement, type ReactNode, type RefObject, useEffect, useId, useRef, useState} from 'react';
import {dismissSeries, notify} from '../../app/notices.ts';
import {shortcutHint, type ShortcutId, useShortcut} from '../../app/shortcuts/index.ts';
import {useApp, useSession} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import {uuid} from '../../intents/intents.ts';
import {hasConflictMarkers} from '../../intents/merge3.ts';
import {editing, overrideSeries, overrideWords} from '../../intents/session.ts';
import {commentBody, issueBody, issueState, issueTitle} from '../../intents/view.ts';
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
import {ClockIcon, DuplicateIcon, IssueClosedIcon, IssueReopenedIcon, KebabHorizontalIcon, LinkIcon, PencilIcon, QuoteIcon, SkipIcon, TrashIcon, TriangleDownIcon} from '@primer/octicons-react';
import {ActionList, ActionMenu, Banner, Button, ButtonGroup, Dialog, Heading, IconButton, Label as PrimerLabel, SelectPanel, type SelectPanelItemInput, TextInput, Tooltip} from '@primer/react';
import {SkeletonText} from '@primer/react/experimental';

/** Markdown as it shows: the server's rendering, or the typed source while an edit is not synced. */
export function Rendered({text, html, local, onTask}: {text: string; html: string; local: boolean; onTask?: ((index: number, checked: boolean) => void) | undefined}) {
  if (local) return <div className="markdown-body whitespace-pre-wrap">{text}</div>;
  return html ? <Markdown html={html} onTask={onTask}/> : <p className="text-base text-muted">No text.</p>;
}

function resolveWith(intents: ReturnType<typeof editing>['intents'], id: string, text: string): void {
  void intents.discardDraft(`text:conflict:${id}`);
  intents.resolve(id, text);
}

export function NotSynced() {
  return <PrimerLabel><ClockIcon size={12}/> <span title="Not synced yet: Forgejo renders it once it has it">Not synced</span></PrimerLabel>;
}

/** Edit snapshot; version -1 denotes unsynced text. */
export interface EditBase {
  text: string;
  version: number;
  updated?: string | undefined;
}

interface TextEditorProps {
  draftKey: string;
  title: string;
  issueId: number;
  repoId: number;
  initial: string;
  /** Restored drafts retain the base captured when editing started. */
  base?: EditBase | undefined;
  label: string;
  saveLabel: string;
  onSave: (text: string, base: EditBase | undefined) => void;
  onCancel?: (() => void) | undefined;
  /** Saving is refused while the text still has conflict markers. */
  markers?: boolean | undefined;
  rows?: number;
  autoFocus?: boolean;
  describedBy?: string | undefined;
  /** After Esc/Cancel, the Undo notice reopens the editor (with the text) through this. */
  onReopen?: (() => void) | undefined;
  focusShortcut?: ShortcutId | undefined;
  onTextChange?: (text: string) => void;
  stateAction?: {
    label: (hasText: boolean) => string;
    icon: ReactElement;
    run: (text: string) => void;
    /** The split button's menu, given the action that runs with the editor's text. */
    more?: ((act: (run: (text: string) => void) => void, anchor: RefObject<HTMLButtonElement | null>) => ReactNode) | undefined;
  } | undefined;
  quote?: boolean;
}

const openEditors = new Set<string>();

export const TextEditor = observer(function TextEditor({draftKey, title, issueId, repoId, initial, base: base0, label, saveLabel, onSave, onCancel, markers, rows, autoFocus, describedBy, onReopen, focusShortcut, onTextChange, stateAction, quote}: TextEditorProps) {
  const app = useApp();
  const {intents} = editing(app);
  const [restored] = useState(() => untracked(() => intents.drafts.get(draftKey)));
  const [text, setText] = useState(restored?.text ?? initial);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [base, setBase] = useState(restored?.base ?? base0);
  /** Late IndexedDB drafts must not overwrite text already restored or typed. */
  const touched = useRef(restored !== undefined);
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
  /** Flush the debounced draft on unmount to avoid losing text. */
  const pending = useRef<(() => void) | undefined>(undefined);
  /** Saved or cancelled: an autosave still in flight must not bring the draft back. */
  const done = useRef(false);
  const [insertion, setInsertion] = useState<{text: string}>();
  const stateButton = useRef<HTMLButtonElement>(null);
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
  const saveUnavailable = blocked || hasPendingUploads(text) || !text.trim() || (!dirty && !markers);
  const saveHint = blocked ? 'Remove the conflict markers to save.' : hasPendingUploads(text) ? 'Wait for attachments to finish uploading.' :
    !text.trim() ? 'Enter text to save.' : !dirty && !markers ? 'Make a change to save.' : `${saveLabel} (works offline)`;
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
    if (saveUnavailable) return;
    forget();
    onSave(text, base);
    if (!onCancel) setText('');
  };
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
      const kept = {key: draftKey, kind: 'text' as const, title, issueId, repoId, text, at: Date.now(), ...(base ? {base} : {})};
      void intents.discardDraft(draftKey);
      notify(app, {tone: 'neutral', title: 'Edit discarded', action: {label: 'Undo', run: () => {
        // Keep Undo from overwriting an editor reopened in the meantime.
        if (openEditors.has(draftKey)) {
          void intents.restoreDraft({...kept, key: `${draftKey}:undo:${String(kept.at)}`}).then(() => {
            notify(app, {tone: 'neutral', title: 'Kept in Unsynced changes', description: 'The editor is open again: your discarded text is in the drafts there.'});
          });
        } else void intents.restoreDraft(kept).then(() => onReopen?.());
      }}});
    } else forget();
    onCancel?.();
  };
  // Handle submit locally because multiple editors can be open at once.
  return (
    <div className="flex flex-col gap-2" onKeyDownCapture={(e) => {
      if (stateAction && e.key === 'Enter' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        act(stateAction.run);
      }
    }}>
      {confirmCancel && <Dialog title="Discard this edit?" subtitle="Your changes can be restored with Undo." width="medium"
        onClose={() => { setConfirmCancel(false); }} footerButtons={[
          {content: 'Keep editing', onClick: () => { setConfirmCancel(false); }},
          {content: 'Discard', buttonType: 'danger', onClick: () => { setConfirmCancel(false); cancel(); }},
        ]}/>}
      <MarkdownField insertion={insertion} repoId={repoId} attachmentIssueId={issueId} label={label} describedBy={describedBy} value={text} rows={rows ?? 6} autoFocus={autoFocus} invalid={blocked}
        onChange={change} onSubmit={save} onCancel={onCancel ? () => {
          if (dirty) setConfirmCancel(true);
          else cancel();
        } : undefined} focusShortcut={focusShortcut}/>
      <div className="flex items-center justify-end gap-2">
        {blocked && <span className="mr-auto text-sm text-attention">Remove the conflict markers to save.</span>}
        {onCancel && <Button variant="invisible" size="small" type="button" onClick={cancel}>Cancel</Button>}
        {stateAction && (() => {
          const button = <Button size="small" type="button" ref={stateButton} leadingVisual={() => stateAction.icon} disabled={hasPendingUploads(text)} onClick={() => {
            act(stateAction.run);
          }}>{stateAction.label(Boolean(text.trim()))}</Button>;
          return stateAction.more ? <ButtonGroup>{button}{stateAction.more(act, stateButton)}</ButtonGroup> : button;
        })()}
        <Tooltip text={saveHint} keybindingHint={shortcutHint('submit')}><Button variant="primary" size="small" type="button" inactive={saveUnavailable} aria-disabled={saveUnavailable} onClick={save}>{saveLabel}</Button></Tooltip>
      </div>
    </div>
  );
});

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

/** A comment's menu, in GitHub's order: Copy link and Quote reply, then Edit, then Delete. */
export function CardMenu({triggerRef, label, issueId, link, quote, onEdit, onDelete}: {
  triggerRef: RefObject<HTMLButtonElement | null>; label: string; issueId: number;
  /** Points the page's address at this card. */
  link: (url: URL) => void;
  quote: () => string;
  onEdit?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
}) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const selection = useRef('');
  const setMenuOpen = (next: boolean) => {
    if (next) {
      const selected = window.getSelection();
      const card = triggerRef.current?.closest('article');
      selection.current = selected?.anchorNode && card?.contains(selected.anchorNode) ? selected.toString() : '';
    }
    setOpen(next);
  };
  return (
    <ActionMenu open={open} onOpenChange={setMenuOpen}>
      <ActionMenu.Anchor><IconButton icon={KebabHorizontalIcon} variant="invisible" size="small" aria-label={label} type="button" ref={triggerRef}/></ActionMenu.Anchor>
      <ActionMenu.Overlay align="end"><ActionList>
        <ActionList.Item onSelect={() => {
          const url = new URL(window.location.href);
          url.search = '';
          url.hash = '';
          link(url);
          void navigator.clipboard.writeText(url.href).catch(() => notify(app, {tone: 'warning', title: 'Could not copy the link'}));
        }}><ActionList.LeadingVisual><LinkIcon/></ActionList.LeadingVisual>Copy link</ActionList.Item>
        <ActionList.Item onSelect={() => {
          setOpen(false);
          const text = selection.current || quote();
          requestAnimationFrame(() => {
            window.dispatchEvent(new CustomEvent('forgejo:quote', {detail: {issueId, text}}));
          });
        }}><ActionList.LeadingVisual><QuoteIcon/></ActionList.LeadingVisual>Quote reply</ActionList.Item>
        {onEdit && <>
          <ActionList.Divider/>
          <ActionList.Item onSelect={() => {
            setOpen(false);
            onEdit();
            const card = triggerRef.current?.closest('article');
            requestAnimationFrame(() => { card?.querySelector<HTMLElement>('.cm-content, textarea')?.focus(); });
          }}><ActionList.LeadingVisual><PencilIcon/></ActionList.LeadingVisual>Edit</ActionList.Item>
        </>}
        {onDelete && <>
          <ActionList.Divider/>
          <ActionList.Item variant="danger" onSelect={() => {
            setOpen(false);
            onDelete();
          }}><ActionList.LeadingVisual><TrashIcon/></ActionList.LeadingVisual>Delete…</ActionList.Item>
        </>}
      </ActionList></ActionMenu.Overlay>
    </ActionMenu>
  );
}

export const CommentActions = observer(function CommentActions({c, onEdit, triggerRef}: {c: Entity<'Comment'>; onEdit: () => void; triggerRef: RefObject<HTMLButtonElement | null>}) {
  const app = useApp();
  const session = useSession();
  const {intents} = editing(app);
  const [confirming, setConfirming] = useState(false);
  const fallback = useRef<HTMLElement | null>(null);
  const mayEdit = c.get('poster_id') === session.userId || canWrite(session, repoOf(app, c.get('issue_id')));
  const remove = () => {
    setConfirming(false);
    const {issue_id: issueId} = untracked(() => c.data);
    intents.submit({kind: 'comment.delete', issueId, repoId: repoOf(app, issueId), commentId: c.id});
    requestAnimationFrame(() => { fallback.current?.focus(); });
  };
  return <>
    {confirming && <Dialog title="Delete this comment?" subtitle="It is removed for everyone. This cannot be undone." width="small"
      returnFocusRef={triggerRef} onClose={() => { setConfirming(false); }} footerButtons={[
        {content: 'Cancel', onClick: () => { setConfirming(false); }},
        {content: 'Delete', buttonType: 'danger', onClick: remove},
      ]}/>}
    <CardMenu triggerRef={triggerRef} label="Comment actions" issueId={c.get('issue_id')}
      link={(url) => {
        if (c.get('type') === 'code') {
          url.searchParams.set('tab', 'files');
          url.hash = `review-thread-${String(c.id)}`;
        } else url.hash = `comment-${String(c.id)}`;
      }}
      quote={() => commentBody(editing(app).overlay, c).text}
      onEdit={mayEdit ? onEdit : undefined}
      onDelete={mayEdit && c.get('type') !== 'review' ? () => {
        fallback.current = triggerRef.current?.closest('main')?.querySelector<HTMLElement>('button[aria-label="Add a reaction"]') ?? null;
        setConfirming(true);
      } : undefined}/>
  </>;
});

function repoOf(app: ReturnType<typeof useApp>, issueId: number): number {
  const pool = app.session?.data.pool;
  return untracked(() => pool?.model('Issue').get(issueId)?.data.repo_id ?? (editing(app).overlay.createdEntity('Issue', issueId) as Entity<'Issue'> | undefined)?.data.repo_id ?? 0);
}

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
        <Banner variant="warning" title="This comment changed while you edited it" description="Edit the merge below, or keep one side."
          primaryAction={<Button size="small" onClick={() => { resolveWith(intents, conflict.id, mine); }}>Keep mine</Button>}
          secondaryAction={<Button size="small" onClick={() => { resolveWith(intents, conflict.id, cf.theirs); }}>Use theirs</Button>}/>
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

function CommentEditor({c, issueId, repoId, onDone, onReopen}: {c: Entity<'Comment'>; issueId: number; repoId: number; onDone: () => void; onReopen: () => void}) {
  const app = useApp();
  const {overlay, intents} = editing(app);
  const [base] = useState<EditBase>(() => untracked(() => {
    const b = commentBody(overlay, c);
    return {text: b.text, version: b.local ? -1 : c.data.content_version, updated: c.data.updated_at};
  }));
  const draftKey = `text:comment:${String(c.id)}`;
  const latestText = useRef(untracked(() => intents.drafts.get(draftKey))?.text ?? base.text);
  // Preserve the draft if the comment is deleted remotely while being edited.
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

type CloseReason = 'completed' | 'not-planned';

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
            chosen === 'not-planned' ? 'Close as not planned' : `Close ${hasText ? 'with comment' : noun}`),
          icon: state === 'closed' ? <IssueReopenedIcon className="text-success"/> : chosen === 'not-planned' ? <SkipIcon className="text-muted"/> : <IssueClosedIcon className="text-done"/>,
          run: (body) => {
            runInAction(() => {
              if (body.trim()) intents.submit({kind: 'comment.create', issueId, repoId, tempId: uuid(), body});
              if (state === 'open' && chosen === 'not-planned' && notPlanned) setWorkflowStatus(app, [issue], notPlanned);
              else intents.submit({kind: 'issue.state', issueId, repoId, state: state === 'closed' ? 'open' : 'closed', base: state});
            });
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

/** Forgejo recognizes this convention as a bidirectional duplicate reference. */
export function duplicateComment(number: number, text: string): string {
  return `Duplicate of #${String(number)}${text.trim() ? `\n\n${text}` : ''}`;
}

const DUPLICATE_CHOICES = 30;

/** Forgejo has no native close reason: not planned is the repository's canceled workflow status. */
function closeStatuses(pool: ReturnType<typeof usePool>, repoId: number): {notPlanned: Label | undefined; duplicate: Label | undefined} {
  const canceled = repoLabels(pool, repoId).filter((l) => labelKind(l) === 'status' && statusStage(scopedValue(l.name)) === 'canceled')
    .sort((a, b) => kindRank('status', a.name) - kindRank('status', b.name));
  const duplicate = canceled.find((l) => /^duplicate/i.test(scopedValue(l.name)));
  return {notPlanned: canceled.find((l) => l !== duplicate), duplicate};
}

/** GitHub's close menu: the reason renames the close button; a duplicate is closed once its original is picked. */
const CloseReasons = observer(function CloseReasons({issue, act, anchor, reason, notPlanned, onReason}: {
  issue: Entity<'Issue'>; act: (run: (text: string) => void) => void; anchor: RefObject<HTMLButtonElement | null>;
  reason: CloseReason; notPlanned: boolean; onReason: (reason: CloseReason) => void;
}) {
  const [picking, setPicking] = useState(false);
  return <>
    <ActionMenu>
      <ActionMenu.Anchor><IconButton icon={TriangleDownIcon} size="small" aria-label="Choose a close reason"/></ActionMenu.Anchor>
      <ActionMenu.Overlay width="medium"><ActionList selectionVariant="single">
        <ActionList.Item selected={reason === 'completed'} onSelect={() => { onReason('completed'); }}>
          <ActionList.LeadingVisual><IssueClosedIcon className="text-done"/></ActionList.LeadingVisual>Close as completed
          <ActionList.Description variant="block">Done, closed, fixed, resolved</ActionList.Description>
        </ActionList.Item>
        {notPlanned && <ActionList.Item selected={reason === 'not-planned'} onSelect={() => { onReason('not-planned'); }}>
          <ActionList.LeadingVisual><SkipIcon/></ActionList.LeadingVisual>Close as not planned
          <ActionList.Description variant="block">Won’t fix, can’t repro, stale</ActionList.Description>
        </ActionList.Item>}
        <ActionList.Item selected={false} onSelect={() => { setPicking(true); }}>
          <ActionList.LeadingVisual><DuplicateIcon/></ActionList.LeadingVisual>Close as duplicate
          <ActionList.Description variant="block">Duplicate of another issue</ActionList.Description>
        </ActionList.Item>
      </ActionList></ActionMenu.Overlay>
    </ActionMenu>
    {picking && <DuplicatePicker issue={issue} anchor={anchor} act={act} onClose={() => { setPicking(false); }}/>}
  </>;
});

const DuplicatePicker = observer(function DuplicatePicker({issue, anchor, act, onClose}: {
  issue: Entity<'Issue'>; anchor: RefObject<HTMLButtonElement | null>; act: (run: (text: string) => void) => void; onClose: () => void;
}) {
  const app = useApp();
  const pool = usePool();
  const [query, setQuery] = useState('');
  const repoId = issue.get('repo_id');
  const {duplicate} = closeStatuses(pool, repoId);
  const others = [...pool.model('Issue').by('repo_id', repoId)].map((e) => e.data)
    .filter((i) => i.id !== issue.id && !i.is_pull && i.number > 0)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const q = query.trim().replace(/^#/, '').toLowerCase();
  const exact = /^[1-9]\d{0,15}$/.test(q) ? Number(q) : undefined;
  const items: (SelectPanelItemInput & {id: string; number: number})[] = [];
  if (exact !== undefined && exact !== issue.get('number') && !others.some((i) => i.number === exact)) items.push({id: `number-${String(exact)}`, text: `#${String(exact)}`, number: exact});
  items.push(...others.filter((i) => !q || `#${String(i.number)} ${i.title}`.toLowerCase().includes(q)).slice(0, DUPLICATE_CHOICES)
    .map((i) => ({id: `issue-${String(i.id)}`, text: `#${String(i.number)} ${i.title}`, number: i.number})));
  return <SelectPanel title="Close as duplicate of" open onOpenChange={(open) => { if (!open) onClose(); }} selected={undefined} loading={false}
    placeholderText="Duplicate of… (number or title)" filterValue={query} onFilterChange={setQuery} items={items}
    {...(items.length === 0 ? {message: {variant: 'empty' as const, title: 'No issue matches', body: 'Type its number.'}} : {})}
    anchorRef={anchor} renderAnchor={null}
    onSelectedChange={(item: SelectPanelItemInput | undefined) => {
      const original = items.find((option) => option.id === item?.id);
      if (!original) return;
      onClose();
      act((text) => {
        runInAction(() => {
          editing(app).intents.submit({kind: 'comment.create', issueId: issue.id, repoId, tempId: uuid(), body: duplicateComment(original.number, text)});
          if (duplicate) setWorkflowStatus(app, [issue], duplicate);
          else changeState(app, [issue], 'closed');
        });
      });
    }}/>;
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
