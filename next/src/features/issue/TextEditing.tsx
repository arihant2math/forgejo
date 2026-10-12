// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {ClockIcon} from '@primer/octicons-react';
import {Button, ButtonGroup, ConfirmationDialog, Label as PrimerLabel, Tooltip} from '@primer/react';
import {untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactElement, type ReactNode, type RefObject, useEffect, useRef, useState} from 'react';
import {notify} from '../../app/notices.ts';
import {shortcutHint, type ShortcutId} from '../../app/shortcuts/index.ts';
import {useApp} from '../../app/store.ts';
import {hasConflictMarkers} from '../../intents/merge3.ts';
import {editing} from '../../intents/session.ts';
import {MarkdownField} from '../editor/Composer.tsx';
import {hasPendingUploads} from '../editor/attachments.ts';
import {Markdown} from './Markdown.tsx';

/** Markdown as it shows: the server's rendering, or the typed source while an edit is not synced. */
export function Rendered({text, html, local, onTask}: {text: string; html: string; local: boolean; onTask?: ((index: number, checked: boolean) => void) | undefined}) {
  if (local) return <div className="markdown-body whitespace-pre-wrap">{text}</div>;
  return html ? <Markdown html={html} onTask={onTask}/> : <p className="text-base text-muted">No text.</p>;
}

export function resolveWith(intents: ReturnType<typeof editing>['intents'], id: string, text: string): void {
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
      {confirmCancel && <ConfirmationDialog title="Discard this edit?" cancelButtonContent="Keep editing" confirmButtonContent="Discard" confirmButtonType="danger"
        onClose={(gesture) => {
          setConfirmCancel(false);
          if (gesture === 'confirm') cancel();
        }}>Your changes can be restored with Undo.</ConfirmationDialog>}
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
