// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Opening a pull request from a comparison (the compare view's form; PLAN
// §5.4: a code operation, online only, never queued — offline the button
// says why). Title and description start as Forgejo proposes them (one
// commit: its message; several: the head branch), then are kept as a draft
// of this comparison while typed. Writers also set labels, assignees and a
// milestone; anyone asks for reviews. Creating is API v1's
// POST /repos/{owner}/{repo}/pulls; the new pull request's page opens once
// the sync delta holding it has arrived (the echoed sync id), so it paints
// at once instead of saying "not on this device".

import {useNavigate} from '@tanstack/react-router';
import {Eye, Milestone as MilestoneIcon, Tag, User} from 'lucide-react';
import {makeAutoObservable, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useState} from 'react';
import {canWrite} from '../../app/access.ts';
import {failureText, onlineWrite} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {onlineOnly, reach} from '../../app/online.ts';
import {shortcutHint} from '../../app/shortcuts/index.ts';
import {type App, useApp, useSession} from '../../app/store.ts';
import {editing} from '../../intents/session.ts';
import {Avatar, Button, Card, Code, CommandPopover, Input, LabelDot, StatusDot, type StatusTone} from '../../ui/index.ts';
import {MarkdownField} from '../editor/Composer.tsx';
import {repoLabels} from '../issues/candidates.ts';
import {usePool} from '../issues/cells.tsx';
import {loadPeople, type Person, repoPeople} from '../issues/people.ts';
import {createPullBody, type MergeOutlook, TITLE_MAX, withLabel} from './proposal.ts';

/** How long the new pull request's page waits for its sync delta before it opens anyway (it shows up there then). */
const SYNC_WAIT_MS = 5000;

const draftKey = (repoId: number, base: string, head: string) => `text:new-pull:${String(repoId)}:${base}...${head}`;

/** One comparison's form. Title and body undefined: Forgejo's proposal (`defaults`), until typed in. */
class PullDraft {
  title: string | undefined;
  body: string | undefined;
  labels: number[] = [];
  assignees: number[] = [];
  reviewers: number[] = [];
  milestone = 0;
  missing = false;
  busy = false;
  restored = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly app: App;
  private readonly key: string;
  private readonly repoId: number;

  constructor(app: App, repoId: number, base: string, head: string) {
    this.app = app;
    this.repoId = repoId;
    this.key = draftKey(repoId, base, head);
    const text = untracked(() => editing(app).intents.drafts.get(this.key))?.text;
    if (text?.trim()) {
      this.title = text.split('\n')[0] ?? '';
      this.body = text.split('\n').slice(2).join('\n');
      this.restored = true;
    }
    makeAutoObservable<PullDraft, 'timer' | 'app' | 'key' | 'repoId'>(this, {timer: false, app: false, key: false, repoId: false}, {autoBind: true});
  }

  setTitle(t: string): void {
    this.title = t;
    this.keep();
  }

  setBody(b: string): void {
    this.body = b;
    this.keep();
  }

  setMilestone(id: number): void {
    this.milestone = id;
  }

  setMissing(on: boolean): void {
    this.missing = on;
  }

  setBusy(on: boolean): void {
    this.busy = on;
  }

  toggle(list: 'assignees' | 'reviewers', id: number): void {
    this[list] = this[list].includes(id) ? this[list].filter((x) => x !== id) : [...this[list], id];
  }

  setLabels(ids: number[]): void {
    this.labels = ids;
  }

  /** Back to Forgejo's proposal; the draft goes. */
  discard(): void {
    clearTimeout(this.timer);
    void editing(this.app).intents.discardDraft(this.key);
    this.title = undefined;
    this.body = undefined;
    this.restored = false;
  }

  private keep(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.flush();
    }, 400);
  }

  /** Writes the draft now (the page closes before the debounce). Only what was typed is a draft. */
  flush(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const {intents} = editing(this.app);
    const title = this.title ?? '';
    const body = this.body ?? '';
    if (!title.trim() && !body.trim()) void intents.discardDraft(this.key);
    else void intents.keepText({key: this.key, title: 'A new pull request', issueId: 0, repoId: this.repoId, text: `${title}\n\n${body}`});
  }

  /** Created: nothing is kept. */
  done(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    void editing(this.app).intents.discardDraft(this.key);
  }
}

export interface NewPullProps {
  owner: string;
  repo: string;
  repoId: number;
  base: string;
  head: string;
  /** Forgejo's proposal for this comparison (proposal.ts pullDefaults). */
  defaults: {title: string; body: string};
  outlook: MergeOutlook;
  onCancel: () => void;
}

/** The form: properties, title, description, and Create. */
export const NewPull = observer(function NewPull(props: NewPullProps) {
  const {owner, repo, repoId, base, head, defaults, onCancel} = props;
  const app = useApp();
  const session = useSession();
  const pool = usePool();
  const navigate = useNavigate();
  const [form] = useState(() => new PullDraft(app, repoId, base, head));
  useEffect(() => () => {
    form.flush();
  }, [form]);
  const repoData = pool.model('Repository').get(repoId)?.data;
  const isOnline = reach(session.data.status.connection) === 'online';
  const title = form.title ?? defaults.title;
  const body = form.body ?? defaults.body;
  const why = repoData?.archived ? 'This repository is archived: it takes no new pull requests.' :
    !isOnline ? onlineOnly('Opening a pull request') : !title.trim() ? 'Add a title first' : undefined;
  const create = () => {
    if (form.busy) return;
    if (!title.trim()) {
      form.setMissing(true);
      return;
    }
    if (why || !repoData) return;
    form.setBusy(true);
    void openPull(app, {owner: repoData.owner_name, repo: repoData.name, repoId, form, base, head, title, body}).then((number) => {
      form.done();
      void navigate({to: '/$owner/$repo/pulls/$index', params: {owner, repo, index: String(number)}});
    }, (err: unknown) => {
      form.setBusy(false);
      notify(app, {tone: 'danger', title: 'The pull request was not opened', description: failureText(err)});
    });
  };
  const missing = form.missing && !title.trim();
  return (
    <Card as="section" label="Open a pull request">
      <div className="flex flex-col gap-3" onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.defaultPrevented) {
          e.preventDefault();
          create();
        }
      }}>
        <Properties form={form} repoId={repoId}/>
        <div className="flex flex-col gap-1">
          <Input aria-label="Title" placeholder="Pull request title" value={title} autoFocus className="w-full" maxLength={TITLE_MAX} invalid={missing}
            aria-describedby={missing ? 'new-pull-title-missing' : undefined}
            onChange={(e) => {
              form.setTitle(e.target.value);
            }}/>
          {missing && <p id="new-pull-title-missing" role="alert" className="text-sm text-danger">A pull request needs a title.</p>}
        </div>
        <MarkdownField repoId={repoId} label="Description" placeholder="Add a description…" value={body} rows={8}
          onChange={(b) => {
            form.setBody(b);
          }} onSubmit={create}/>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto flex items-center gap-1 text-sm text-fg-subtle">
            {form.restored && <>Draft restored<Button size="sm" variant="ghost" onClick={() => {
              form.discard();
            }}>Discard</Button></>}
            {!isOnline && <span>Offline: opening a pull request needs a connection.</span>}
          </span>
          <Button variant="ghost" onClick={() => {
            form.flush();
            onCancel();
          }}>Cancel</Button>
          {/* aria-disabled, not disabled: the tooltip says what is missing (offline, a title). */}
          <Button variant="primary" shortcut={shortcutHint('submit')} tooltip={why ?? `Merge ${head} into ${base}`} aria-disabled={Boolean(why) || form.busy} onClick={create}>
            {form.busy ? 'Opening…' : 'Create pull request'}
          </Button>
        </div>
      </div>
    </Card>
  );
});

/**
 * Creates the pull request, asks for its reviews, and waits (at most SYNC_WAIT_MS) until the pool holds what
 * Forgejo wrote. Returns its number.
 */
async function openPull(app: App, a: {owner: string; repo: string; repoId: number; form: PullDraft; base: string; head: string; title: string; body: string}): Promise<number> {
  const s = app.session;
  if (!s) throw new Error('Not signed in.');
  const pool = s.data.pool;
  const login = (id: number) => untracked(() => pool.model('User').get(id)?.data.login) ?? peopleLogin(app, a.repoId, id);
  const logins = (ids: readonly number[]) => ids.map(login).filter((l): l is string => Boolean(l));
  const writable = canWrite(s, a.repoId);
  const path = `/repos/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}/pulls`;
  const made = await onlineWrite<{number?: unknown}>(app, {method: 'POST', api: 'v1', path, body: createPullBody({
    base: a.base, head: a.head, title: a.title, body: a.body,
    // A reader's pull request has no properties (Forgejo would drop them or refuse).
    labelIds: writable ? a.form.labels : [], assignees: writable ? logins(a.form.assignees) : [], milestoneId: writable ? a.form.milestone : 0,
  })});
  const number = typeof made.value?.number === 'number' ? made.value.number : 0;
  if (!number) throw new Error('Forgejo did not say which pull request it opened.');
  let v = made.syncId ?? 0;
  const reviewers = logins(a.form.reviewers);
  if (reviewers.length) {
    try {
      const asked = await onlineWrite(app, {method: 'POST', api: 'v1', path: `${path}/${String(number)}/requested_reviewers`, body: {reviewers}});
      v = Math.max(v, asked.syncId ?? 0);
    } catch (err) {
      notify(app, {tone: 'warning', title: `Pull request #${String(number)} is open, but asking for reviews failed`, description: failureText(err)});
    }
  }
  if (v > 0) {
    const signal = AbortSignal.timeout(SYNC_WAIT_MS);
    await Promise.race([
      s.data.whenSynced(`repo:${String(a.repoId)}`, v, signal).catch(() => undefined),
      new Promise((resolve) => {
        signal.addEventListener('abort', resolve);
      }),
    ]);
  }
  return number;
}

/** A person's login from the repository's people (API v1's assignees, which may not be in the pool). */
function peopleLogin(app: App, repoId: number, id: number): string | undefined {
  const s = app.session;
  return s ? untracked(() => repoPeople(s.data.pool, repoId, s.userId).find((p) => p.id === id)?.login) : undefined;
}

/** Labels, assignees, milestone (writers) and reviewers, each a picker that filters as you type. */
const Properties = observer(function Properties({form, repoId}: {form: PullDraft; repoId: number}) {
  const app = useApp();
  const session = useSession();
  const pool = usePool();
  const {userId} = session;
  const writable = canWrite(session, repoId);
  useEffect(() => {
    loadPeople(app, repoId);
  }, [app, repoId]);
  const people = repoPeople(pool, repoId, userId);
  const labels = repoLabels(pool, repoId);
  const milestones = [...pool.model('Milestone').by('repo_id', repoId)].map((m) => m.data).filter((m) => m.state === 'open')
    .sort((a, b) => a.title.localeCompare(b.title));
  const chosen = labels.filter((l) => form.labels.includes(l.id));
  const ms = milestones.find((m) => m.id === form.milestone);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {writable && <>
        <CommandPopover label="Labels" placeholder="Add labels…" empty="This repository has no labels."
          options={labels.map((l) => ({
            value: String(l.id), label: l.name, words: l.description, leading: <LabelDot color={l.color}/>, checked: form.labels.includes(l.id), keepOpen: true,
            onSelect: () => {
              form.setLabels(withLabel(form.labels, l, !form.labels.includes(l.id), labels));
            },
          }))}
          trigger={
            <Button size="sm" variant={chosen.length ? 'secondary' : 'ghost'} icon={Tag}>
              {chosen.length > 2 ? `${String(chosen.length)} labels` : chosen.length ? chosen.map((l) => l.name).join(', ') : 'Labels'}
            </Button>
          }/>
        <PeoplePick label="Assignees" placeholder="Assign to…" icon={User} people={people} me={userId} chosen={form.assignees} onToggle={(id) => {
          form.toggle('assignees', id);
        }}/>
        <CommandPopover label="Milestone" placeholder="Add to the milestone…"
          options={[
            {value: '0', label: 'No milestone', checked: form.milestone === 0, onSelect: () => {
              form.setMilestone(0);
            }},
            ...milestones.map((m) => ({value: String(m.id), label: m.title, checked: m.id === form.milestone, onSelect: () => {
              form.setMilestone(m.id);
            }})),
          ]}
          trigger={<Button size="sm" variant={ms ? 'secondary' : 'ghost'} icon={MilestoneIcon}>{ms?.title ?? 'Milestone'}</Button>}/>
      </>}
      {/* One's own review cannot be asked for. */}
      <PeoplePick label="Reviewers" placeholder="Ask for a review from…" icon={Eye} people={people.filter((p) => p.id !== userId)} me={userId} chosen={form.reviewers} onToggle={(id) => {
        form.toggle('reviewers', id);
      }}/>
    </div>
  );
});

function PeoplePick({label, placeholder, icon, people, me, chosen, onToggle}: {
  label: string; placeholder: string; icon: typeof User; people: Person[]; me: number; chosen: readonly number[]; onToggle: (id: number) => void;
}) {
  const names = people.filter((p) => chosen.includes(p.id)).map((p) => p.login);
  return (
    <CommandPopover label={label} placeholder={placeholder} empty="Nobody to choose on this device."
      options={people.map((u) => ({
        value: String(u.id), label: u.id === me ? `${u.login} (you)` : u.login, words: u.name, leading: <Avatar name={u.name} src={u.avatar} size="sm"/>,
        checked: chosen.includes(u.id), keepOpen: true, onSelect: () => {
          onToggle(u.id);
        },
      }))}
      trigger={<Button size="sm" variant={names.length ? 'secondary' : 'ghost'} icon={icon}>{names.length > 2 ? `${String(names.length)} ${label.toLowerCase()}` : names.length ? names.join(', ') : label}</Button>}/>
  );
}

/** Whether the branches merge, in words (shown above the commits of a comparison a pull request can be opened from). */
export function OutlookLine({outlook, base, head, children}: {outlook: MergeOutlook; base: string; head: string; children?: ReactNode}) {
  const [tone, text]: [StatusTone, ReactNode] = (() => {
    switch (outlook.kind) {
      case 'clean':
        return ['success', outlook.behind ?
          `Able to merge: ${base} has ${plural(outlook.behind, 'commit')} ${head} lacks, in other files.` :
          `Able to merge: ${head} is ahead of ${base}.`];
      case 'overlap':
        return ['warning', <>
          {`Both branches change ${plural(outlook.files.length, 'file')} since they diverged`}
          {outlook.files.length <= 3 && <>{' ('}{outlook.files.map((f, i) => <span key={f}>{i > 0 && ', '}<Code>{f}</Code></span>)}{')'}</>}
          {': Forgejo checks for conflicts once the pull request is open.'}
        </>];
      case 'unknown':
        return ['muted', outlook.behind ?
          `${base} has ${plural(outlook.behind, 'commit')} ${head} lacks: Forgejo checks for conflicts once the pull request is open.` :
          'Forgejo checks for conflicts once the pull request is open.'];
      case 'empty':
        return ['warning', 'These commits change nothing together: the pull request would have no changes.'];
      case 'checking':
        return ['muted', 'Checking whether it merges…'];
      case 'identical':
        return ['muted', `${base} and ${head} are identical.`];
      case 'up-to-date':
        return ['muted', `${base} is already up to date with ${head}.`];
    }
  })();
  return (
    <div className="flex flex-wrap items-center gap-2 text-base text-fg">
      <StatusDot tone={tone}/><span className="min-w-0 flex-1">{text}</span>{children}
    </div>
  );
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}
