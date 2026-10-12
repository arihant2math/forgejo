// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {KebabHorizontalIcon, LinkIcon, PencilIcon, QuoteIcon, TrashIcon} from '@primer/octicons-react';
import {ActionList, ActionMenu, Banner, Button, ConfirmationDialog, IconButton} from '@primer/react';
import {runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type RefObject, useEffect, useRef, useState} from 'react';
import {canWrite} from '../../app/access.ts';
import {notify} from '../../app/notices.ts';
import {useApp, useSession} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import {uuid} from '../../intents/intents.ts';
import {editing} from '../../intents/editing.ts';
import {commentBody} from '../../intents/view.ts';
import {type EditBase, NotSynced, Rendered, resolveWith, TextEditor} from './TextEditing.tsx';

/** A comment's menu, in GitHub's order: Copy link and Quote reply, then Edit, then Delete. */
export function CardMenu({triggerRef, label, issueId, link, quote, onEdit, onDelete}: {
  triggerRef: RefObject<HTMLButtonElement | null>; label: string; issueId: number;
  /** Points the page's address at this card; none: no Copy link (an issue created offline has no address yet). */
  link?: ((url: URL) => void) | undefined;
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
    <ActionMenu open={open} onOpenChange={setMenuOpen} anchorRef={triggerRef}>
      <ActionMenu.Anchor><IconButton icon={KebabHorizontalIcon} variant="invisible" size="small" aria-label={label} type="button"/></ActionMenu.Anchor>
      <ActionMenu.Overlay align="end"><ActionList>
        {link && <ActionList.Item onSelect={() => {
          const url = new URL(window.location.href);
          url.search = '';
          url.hash = '';
          link(url);
          void navigator.clipboard.writeText(url.href).catch(() => notify(app, {tone: 'warning', title: 'Could not copy the link'}));
        }}><ActionList.LeadingVisual><LinkIcon/></ActionList.LeadingVisual>Copy link</ActionList.Item>}
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
    {confirming && <ConfirmationDialog title="Delete this comment?" confirmButtonContent="Delete" confirmButtonType="danger" onClose={(gesture) => {
      if (gesture === 'confirm') {
        remove();
        return;
      }
      setConfirming(false);
      requestAnimationFrame(() => { triggerRef.current?.focus(); });
    }}>It is removed for everyone. This cannot be undone.</ConfirmationDialog>}
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
