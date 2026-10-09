// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The "Unsynced changes" panel (PLAN §5.4): everything that has not reached
// Forgejo yet — conflicts to resolve, changes Forgejo refused (their text
// kept: retry, copy, discard), changes waiting to be sent — so nothing is
// ever lost or dropped without the user knowing. Its own chunk, opened from
// the sync indicator and from notices.

import {useNavigate} from '@tanstack/react-router';
import {CircleAlert, CircleDashed, CloudCheck, Copy, GitMerge, RotateCw, Trash2, TriangleAlert} from 'lucide-react';
import {runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useId} from 'react';
import {discardable, type IntentRecord} from '../../intents/executor.ts';
import {describeIntent, type Intent, intentText} from '../../intents/intents.ts';
import {editing} from '../../intents/session.ts';
import type {DraftRecord} from '../../intents/store.ts';
import {Button, Dialog, EmptyState, Entry, EntryList, Icon, IconButton, SectionHeading} from '../../ui/index.ts';
import {notify} from '../notices.ts';
import {type App, useApp} from '../store.ts';

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
    <Dialog open size="lg" title="Unsynced changes" initialFocus="dialog" onOpenChange={(open) => {
      if (!open) close();
    }} description={empty ? undefined : 'Changes made here that Forgejo does not have yet. Nothing is dropped without you deciding.'}
    footer={<Button onClick={close}>Close</Button>}>
      {empty ? <EmptyState icon={CloudCheck} tone="success" title="Everything is synced" description="Changes you make offline wait here until Forgejo has them."/> : (
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

/** "#12 · dev/big" for an intent's issue, from the pool. */
function where(app: App, i: Pick<Intent, 'issueId' | 'repoId'> | undefined): {meta: string; path: string | undefined} {
  const pool = app.session?.data.pool;
  if (!pool || !i) return {meta: '', path: undefined};
  return untracked(() => {
    const repo = pool.model('Repository').get(i.repoId)?.data;
    const issue = pool.model('Issue').get(i.issueId)?.data;
    const number = issue ? `#${String(issue.number)}` : i.issueId < 0 ? 'new issue' : '';
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
  const w = where(app, rec.intent);
  return (
    <Entry
      leading={<Icon icon={GitMerge} className="text-warning"/>}
      title={describeIntent(rec.intent, names(app))}
      meta={w.meta}
      description="You and someone else changed the same lines. Open it to resolve the conflict in the editor."
      actions={<>
        {w.path && <Button size="sm" onClick={() => {
          onOpen();
          void navigate({to: w.path ?? '/'});
        }}>Resolve</Button>}
        <IconButton size="sm" icon={Copy} label="Copy your text" onClick={() => {
          copy(app, intentText(rec.intent) ?? '');
        }}/>
        <IconButton size="sm" icon={Trash2} label="Discard your change" onClick={() => {
          discardWithUndo(app, rec);
        }}/>
      </>}
    />
  );
}

const FailedEntry = observer(function FailedEntry({app, draft}: {app: App; draft: DraftRecord}) {
  const {intents} = editing(app);
  const w = where(app, draft.issueId === undefined || draft.repoId === undefined ? undefined : {issueId: draft.issueId, repoId: draft.repoId});
  return (
    <Entry
      leading={draft.kind === 'failed' ? <Icon icon={CircleAlert} className="text-danger"/> : <Icon icon={CircleDashed}/>}
      title={draft.title}
      meta={w.meta}
      description={draft.reason}
      actions={<>
        {draft.intent && <IconButton size="sm" icon={RotateCw} label="Retry" onClick={() => {
          intents.retry(draft.key);
        }}/>}
        {draft.text !== undefined && <IconButton size="sm" icon={Copy} label="Copy the text" onClick={() => {
          copy(app, draft.text ?? '');
        }}/>}
        <IconButton size="sm" icon={Trash2} label="Discard" onClick={() => {
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

function WaitingEntry({app, rec, offline}: {app: App; rec: IntentRecord; offline: boolean}) {
  const w = where(app, rec.intent);
  const state = rec.state === 'acked' ? 'Saved; waiting for it to sync back.' : rec.note ?? (offline ? 'Sent when you are back online.' : 'Sending…');
  return (
    <Entry
      leading={rec.attempts > 2 ? <Icon icon={TriangleAlert} className="text-warning"/> : <Icon icon={CircleDashed}/>}
      title={describeIntent(rec.intent, names(app))}
      meta={w.meta}
      description={state}
      actions={discardable(rec) ? <IconButton size="sm" icon={Trash2} label="Discard (not sent yet)" onClick={() => {
        discardWithUndo(app, rec);
      }}/> : undefined}
    />
  );
}
