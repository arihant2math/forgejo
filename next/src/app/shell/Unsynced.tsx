// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The "Unsynced changes" panel (PLAN §5.4): everything that has not reached
// Forgejo yet — conflicts to resolve, changes Forgejo refused (their text
// kept: retry, copy, discard), changes waiting to be sent — so nothing is
// ever lost or dropped without the user knowing. Its own chunk, opened from
// the sync indicator and from notices.

import {useNavigate} from '@tanstack/react-router';
import {runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useId} from 'react';
import {discardable, type IntentRecord} from '../../intents/executor.ts';
import {describeIntent, type Intent, intentText} from '../../intents/intents.ts';
import {editing} from '../../intents/session.ts';
import type {DraftRecord} from '../../intents/store.ts';
import {Entry, EntryList, SectionHeading} from '../../ui/index.ts';
import {notify} from '../notices.ts';
import {type App, useApp} from '../store.ts';
import {AlertIcon, IssueDraftIcon, CheckCircleIcon, CopyIcon, GitMergeIcon, RedoIcon, TrashIcon} from '@primer/octicons-react';
import {Button, IconButton, Dialog} from '@primer/react';
import {Blankslate} from '@primer/react/experimental';

export const UnsyncedPanel = observer(function UnsyncedPanel() {
  const app = useApp();
  const {intents} = editing(app);
  const close = () => {
    runInAction(() => {
      app.ui.unsyncedOpen = false;
    });
  };
  const records = [...intents.records.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const parked = records.filter((r) => r.state === 'parked');
  const waiting = records.filter((r) => r.state !== 'parked');
  const drafts = [...intents.drafts.values()].sort((a, b) => b.at - a.at);
  const failed = drafts.filter((d) => d.kind === 'failed');
  const texts = drafts.filter((d) => d.kind === 'text');
  const empty = !records.length && !drafts.length;
  const offline = app.session?.data.status.connection !== 'live';
  return (
    <Dialog title="Unsynced changes" subtitle={empty ? undefined : 'Changes made here that Forgejo does not have yet. Nothing is dropped without you deciding.'} width="xlarge" onClose={() => { const open = false; if (!open) close(); }} renderFooter={() => <Dialog.Footer>{<Button type="button" onClick={close}>Close</Button>}</Dialog.Footer>}>
      {empty ? <Blankslate><Blankslate.Visual><CheckCircleIcon size={24} className="text-success"/></Blankslate.Visual><Blankslate.Heading>Everything is synced</Blankslate.Heading><Blankslate.Description>Changes you make offline wait here until Forgejo has them.</Blankslate.Description></Blankslate> : (
        <div className="flex flex-col gap-4">
          {parked.length > 0 && (
            <Section title="Conflicts">
              {parked.map((r) => <ParkedEntry key={r.id} app={app} rec={r} onOpen={close}/>)}
            </Section>
          )}
          {failed.length > 0 && (
            <Section title="Not sent">
              {failed.map((d) => <FailedEntry key={d.key} app={app} draft={d}/>)}
            </Section>
          )}
          {waiting.length > 0 && (
            <Section title={offline ? 'Waiting for a connection' : 'Syncing'}>
              {waiting.map((r) => <WaitingEntry key={r.id} app={app} rec={r} offline={offline}/>)}
            </Section>
          )}
          {texts.length > 0 && (
            <Section title="Drafts">
              {texts.map((d) => <FailedEntry key={d.key} app={app} draft={d}/>)}
            </Section>
          )}
        </div>
      )}
    </Dialog>
  );
});

function Section({title, children}: {title: string; children: ReactNode}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1">
      <SectionHeading id={id}>{title}</SectionHeading>
      <EntryList>{children}</EntryList>
    </section>
  );
}

/** Takes back a queued change, with Undo (the same change again, as a new intent). */
function discardWithUndo(app: App, rec: IntentRecord): void {
  const {intents} = editing(app);
  void intents.discard(rec.id).then((r) => {
    // Not taken back (sent meanwhile, or unknown): an Undo could make it twice.
    if (r !== 'discarded') {
      notify(app, {tone: 'neutral', title: 'Not discarded', description: NOT_DISCARDED[r]});
      return;
    }
    notify(app, {tone: 'neutral', title: 'Discarded', description: describeIntent(rec.intent, names(app)), action: {label: 'Undo', run: () => {
      intents.resubmit(rec.intent);
    }}});
  });
}

const NOT_DISCARDED = {
  sending: 'It was being sent already.',
  kept: 'Could not discard it; try again.',
  unknown: 'Could not tell whether it was sent: check the issue.',
} as const;

/** "#12 · dev/big" for an intent's issue, from the pool (else the number it had when the change was made). */
function where(app: App, i: Pick<Intent, 'issueId' | 'repoId'> | undefined, known?: number): {meta: string; path: string | undefined} {
  const pool = app.session?.data.pool;
  if (!pool || !i) return {meta: '', path: undefined};
  return untracked(() => {
    const repo = pool.model('Repository').get(i.repoId)?.data;
    const issue = pool.model('Issue').get(i.issueId)?.data;
    const n = issue?.number ?? known;
    const number = n !== undefined ? `#${String(n)}` : i.issueId < 0 ? 'new issue' : '';
    const path = repo && issue ? `/${encodeURIComponent(repo.owner_name)}/${encodeURIComponent(repo.name)}/${issue.is_pull ? 'pulls' : 'issues'}/${String(issue.number)}` : undefined;
    return {meta: [number, repo?.full_name].filter(Boolean).join(' · '), path};
  });
}

function names(app: App) {
  const pool = app.session?.data.pool;
  return untracked(() => ({
    label: (id: number) => pool?.model('Label').get(id)?.data.name ?? '',
    user: (id: number) => pool?.model('User').get(id)?.data.login ?? '',
    milestone: (id: number) => pool?.model('Milestone').get(id)?.data.title ?? '',
  }));
}

function copy(app: App, text: string): void {
  void navigator.clipboard.writeText(text).then(() => {
    notify(app, {tone: 'success', title: 'Copied'});
  }, () => {
    notify(app, {tone: 'danger', title: 'Could not copy', description: 'The browser did not allow it.'});
  });
}

function ParkedEntry({app, rec, onOpen}: {app: App; rec: IntentRecord; onOpen: () => void}) {
  const navigate = useNavigate();
  const w = where(app, rec.intent, rec.issueNumber);
  return (
    <Entry
      leading={<GitMergeIcon size={16} className="shrink-0 text-warning"/>}
      title={describeIntent(rec.intent, names(app))}
      meta={w.meta}
      description="You and someone else changed the same lines. Open it to resolve the conflict in the editor."
      actions={<>
        {w.path && <Button size="small" type="button" onClick={() => {
          onOpen();
          void navigate({to: w.path ?? '/'});
        }}>Resolve</Button>}
        <IconButton icon={CopyIcon} variant="invisible" size="small" aria-label="Copy your text" type="button" onClick={() => {
          copy(app, intentText(rec.intent) ?? '');
        }}/>
        <IconButton icon={TrashIcon} variant="invisible" size="small" aria-label="Discard your change" type="button" onClick={() => {
          discardWithUndo(app, rec);
        }}/>
      </>}
    />
  );
}

const FailedEntry = observer(function FailedEntry({app, draft}: {app: App; draft: DraftRecord}) {
  const {intents} = editing(app);
  const w = where(app, draft.issueId === undefined || draft.repoId === undefined ? undefined : {issueId: draft.issueId, repoId: draft.repoId}, draft.issueNumber);
  return (
    <Entry
      leading={draft.kind === 'failed' ? <AlertIcon size={16} className="shrink-0 text-danger"/> : <IssueDraftIcon size={16} className="shrink-0"/>}
      title={draft.title}
      meta={w.meta}
      description={excerpt(draft.text) ? <>{excerpt(draft.text)}<br/>{draft.reason}</> : draft.reason}
      actions={<>
        {draft.intent && !draft.refused && <IconButton icon={RedoIcon} variant="invisible" size="small" aria-label="Retry" type="button" onClick={() => {
          intents.retry(draft.key);
        }}/>}
        {draft.text !== undefined && <IconButton icon={CopyIcon} variant="invisible" size="small" aria-label="Copy the text" type="button" onClick={() => {
          copy(app, draft.text ?? '');
        }}/>}
        <IconButton icon={TrashIcon} variant="invisible" size="small" aria-label="Discard" type="button" onClick={() => {
          void intents.discardDraft(draft.key).then(() => {
            notify(app, {tone: 'neutral', title: 'Discarded', description: draft.title, action: {label: 'Undo', run: () => {
              void intents.restoreDraft(draft);
            }}});
          });
        }}/>
      </>}
    />
  );
});

/** The start of an intent's text (a comment, a description), so that entries of the same kind can be told apart. */
function excerpt(text: string | undefined): string | undefined {
  const t = text?.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > 80 ? `“${t.slice(0, 79)}…”` : `“${t}”`;
}

function WaitingEntry({app, rec, offline}: {app: App; rec: IntentRecord; offline: boolean}) {
  const w = where(app, rec.intent, rec.issueNumber);
  const reachable = app.session?.data.status.connection !== 'unreachable';
  const state = rec.state === 'acked' ? 'Saved; waiting for it to sync back.' :
    rec.note ?? (!offline ? 'Sending…' : reachable ? 'Sent when you are back online.' : 'Sent when Forgejo can be reached again.');
  const text = excerpt(intentText(rec.intent));
  // Attempted already (its request may have reached Forgejo): giving it up stops the retries; whatever Forgejo
  // has syncs back.
  const tried = rec.req !== undefined;
  return (
    <Entry
      leading={rec.attempts > 2 ? <AlertIcon size={16} className="shrink-0 text-warning"/> : <IssueDraftIcon size={16} className="shrink-0"/>}
      title={describeIntent(rec.intent, names(app))}
      meta={w.meta}
      description={text ? <>{text}<br/>{state}</> : state}
      actions={discardable(rec) ? <IconButton icon={TrashIcon} variant="invisible" size="small" aria-label={tried ? 'Stop sending (it may have reached Forgejo)' : 'Discard (not sent yet)'} type="button" onClick={() => {
        discardWithUndo(app, rec);
      }}/> : undefined}
    />
  );
}
