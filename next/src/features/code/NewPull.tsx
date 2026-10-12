// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Pull-request creation is online-only and never queued.
// Wait for the echoed sync delta before navigating so the new page can render immediately.

import {useNavigate} from '@tanstack/react-router';
import {BranchName} from '@primer/react';
import {Avatar} from '@primer/react';
import {CheckStatus, type StatusTone} from './CheckStatus.tsx';
import {makeAutoObservable, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useState} from 'react';
import {canWrite} from '../../app/access.ts';
import {failureText, onlineWrite} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {onlineOnly, reach} from '../../app/online.ts';
import {shortcutHint} from '../../app/shortcuts/index.ts';
import {type App, useApp, useSession} from '../../app/store.ts';
import {repoGroup} from '../../data/models.ts';
import {settleWrite} from '../../sync/data.ts';
import {editing} from '../../intents/session.ts';
import {draftTitle, wipPrefixes} from '../pull/draft.ts';

import {IssueLabelToken} from '@primer/react';
import {ChoicePanel} from './ChoicePanel.tsx';
import {MarkdownField} from '../editor/Composer.tsx';
import {hasPendingUploads} from '../editor/attachments.ts';
import {repoLabels} from '../issues/candidates.ts';
import {usePool} from '../issues/cells.tsx';
import {loadPeople, type Person, repoPeople} from '../issues/people.ts';
import {createPullBody, type MergeOutlook, TITLE_MAX, withLabel} from './proposal.ts';
import {EyeIcon, MilestoneIcon, TagIcon, PersonIcon, TriangleDownIcon} from '@primer/octicons-react';
import {ActionList, ActionMenu, Button, ButtonGroup, Checkbox, FormControl, IconButton, TextInput} from '@primer/react';
import {Tooltip} from '@primer/react';

const draftKey = (repoId: number, base: string, head: string) => `text:new-pull:${String(repoId)}:${base}...${head}`;

/** Undefined title/body use the comparison defaults until edited. */
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

  /** Bypass the debounce before page close; persist only edited fields. */
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
  defaults: {title: string; body: string};
  outlook: MergeOutlook;
  onCancel: () => void;
}

export const NewPull = observer(function NewPull(props: NewPullProps) {
  const {owner, repo, repoId, base, head, defaults, onCancel} = props;
  const app = useApp();
  const session = useSession();
  const pool = usePool();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(false);
  const [allowEdits, setAllowEdits] = useState(true);
  const [form] = useState(() => new PullDraft(app, repoId, base, head));
  useEffect(() => () => {
    form.flush();
  }, [form]);
  const repoData = pool.model('Repository').get(repoId)?.data;
  const isOnline = reach(session.data.status.connection) === 'online';
  const title = form.title ?? defaults.title;
  const body = form.body ?? defaults.body;
  const why = hasPendingUploads(body) ? 'Wait for the attachments to finish uploading.' : repoData?.archived ? 'This repository is archived: it takes no new pull requests.' :
    !isOnline ? onlineOnly('Opening a pull request') : !title.trim() ? 'Add a title first' : undefined;
  const create = () => {
    if (form.busy) return;
    if (!title.trim()) {
      form.setMissing(true);
      return;
    }
    if (why || !repoData) return;
    form.setBusy(true);
    void openPull(app, {owner: repoData.owner_name, repo: repoData.name, repoId, form, base, head, allowEdits, title: draftTitle(title, draft, wipPrefixes(app.config)), body}).then((number) => {
      form.done();
      void navigate({to: '/$owner/$repo/pulls/$index', params: {owner, repo, index: String(number)}});
    }, (err: unknown) => {
      form.setBusy(false);
      notify(app, {tone: 'danger', title: 'The pull request was not opened', description: failureText(err)});
    });
  };
  const missing = form.missing && !title.trim();
  return (
    <section aria-label="Open a pull request" className="rounded-md border border-default p-3">
      <div className="flex flex-col gap-3" onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.defaultPrevented) {
          e.preventDefault();
          create();
        }
      }}>
        {/* Name the destination to distinguish fork-local and upstream proposals. */}
        <p className="text-sm text-muted">Opens in <code>{`${owner}/${repo}`}</code>: merges <BranchName as="span">{head}</BranchName> into <BranchName as="span">{base}</BranchName>.</p>
        <FormControl>
          <FormControl.Label>Title</FormControl.Label>
          <TextInput placeholder="Pull request title" value={title} autoFocus className="w-full" maxLength={TITLE_MAX} onChange={(e) => {
              form.setTitle(e.target.value);
            }}/>
          {missing && <FormControl.Validation variant="error">A pull request needs a title.</FormControl.Validation>}
        </FormControl>
        <MarkdownField repoId={repoId} label="Description" placeholder="Add a description…" value={body} rows={8}
          onChange={(b) => {
            form.setBody(b);
          }} onSubmit={create}/>
        <Properties form={form} repoId={repoId}/>
        {head.includes(':') && <FormControl><Checkbox checked={allowEdits} onChange={(event) => { setAllowEdits(event.target.checked); }}/><FormControl.Label>Allow edits by maintainers</FormControl.Label></FormControl>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto flex items-center gap-1 text-sm text-muted">
            {form.restored && <>Draft restored<Button variant="invisible" size="small" type="button" onClick={() => {
              form.discard();
            }}>Discard</Button></>}
            {!isOnline && <span>Offline: opening a pull request needs a connection.</span>}
          </span>
          <Button variant="invisible" type="button" onClick={() => {
            form.flush();
            onCancel();
          }}>Cancel</Button>
          <ButtonGroup>
            {/* Inactive retains the explanation tooltip (offline, a title). */}
            <Tooltip text={why ?? `Merge ${head} into ${base}`} keybindingHint={shortcutHint('submit')}><Button variant="primary" type="button" inactive={Boolean(why) || form.busy} aria-disabled={Boolean(why) || form.busy} onClick={create}>
              {form.busy ? 'Opening…' : draft ? 'Create draft pull request' : 'Create pull request'}
            </Button></Tooltip>
            {/* Forgejo drafts are a title prefix, so the choice needs a configured prefix. */}
            {!!wipPrefixes(app.config)[0] && (
              <ActionMenu>
                <ActionMenu.Anchor><IconButton variant="primary" icon={TriangleDownIcon} aria-label="Pull request type"/></ActionMenu.Anchor>
                <ActionMenu.Overlay align="end"><ActionList selectionVariant="single">
                  {([false, true] as const).map((d) => (
                    <ActionList.Item key={String(d)} selected={draft === d} onSelect={() => { setDraft(d); }}>
                      {d ? 'Create draft pull request' : 'Create pull request'}
                      <ActionList.Description variant="block">{d ? 'Cannot be merged until marked ready for review' : 'Open a pull request that is ready for review'}</ActionList.Description>
                    </ActionList.Item>
                  ))}
                </ActionList></ActionMenu.Overlay>
              </ActionMenu>
            )}
          </ButtonGroup>
        </div>
      </div>
    </section>
  );
});

async function openPull(app: App, a: {owner: string; repo: string; repoId: number; form: PullDraft; base: string; head: string; allowEdits: boolean; title: string; body: string}): Promise<number> {
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
  if (a.head.includes(':')) {
    try {
      const edited = await onlineWrite(app, {method: 'PATCH', api: 'v1', path: `${path}/${String(number)}`, body: {allow_maintainer_edit: a.allowEdits}});
      v = Math.max(v, edited.syncId ?? 0);
    } catch (err) {
      notify(app, {tone: 'warning', title: 'Pull request opened, but maintainer permissions were not saved', description: failureText(err)});
    }
  }
  const reviewers = logins(a.form.reviewers);
  if (reviewers.length) {
    try {
      const asked = await onlineWrite(app, {method: 'POST', api: 'v1', path: `${path}/${String(number)}/requested_reviewers`, body: {reviewers}});
      v = Math.max(v, asked.syncId ?? 0);
    } catch (err) {
      notify(app, {tone: 'warning', title: `Pull request #${String(number)} is open, but asking for reviews failed`, description: failureText(err)});
    }
  }
  await settleWrite(s.data, repoGroup(a.repoId), v);
  return number;
}

/** API v1 assignees may not be in the synced pool. */
function peopleLogin(app: App, repoId: number, id: number): string | undefined {
  const s = app.session;
  return s ? untracked(() => repoPeople(s.data.pool, repoId, s.userId).find((p) => p.id === id)?.login) : undefined;
}

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
      <PeoplePick label="Reviewers" placeholder="Ask for a review from…" icon={EyeIcon} people={people.filter((p) => p.id !== userId)} me={userId} chosen={form.reviewers} onToggle={(id) => {
        form.toggle('reviewers', id);
      }}/>
      {writable && <>
        <PeoplePick label="Assignees" placeholder="Assign to…" icon={PersonIcon} people={people} me={userId} chosen={form.assignees} onToggle={(id) => {
          form.toggle('assignees', id);
        }}/>
        <ChoicePanel multiple title="Labels" placeholder="Add labels…" empty="This repository has no labels."
          choices={labels.map((l) => ({
            value: String(l.id), label: l.name, words: l.description, leading: <IssueLabelToken text={l.name} fillColor={`#${l.color.replace(/^#/, '')}`}/>, checked: form.labels.includes(l.id),
            onSelect: () => {
              form.setLabels(withLabel(form.labels, l, !form.labels.includes(l.id), labels));
            },
          }))}
          anchor={
            <Button variant={chosen.length ? 'default' : 'invisible'} size="small" leadingVisual={TagIcon} type="button">
              {chosen.length > 2 ? `${String(chosen.length)} labels` : chosen.length ? chosen.map((l) => l.name).join(', ') : 'Labels'}
            </Button>
          }/>
        <ChoicePanel title="Milestone" placeholder="Add to the milestone…"
          choices={[
            {value: '0', label: 'No milestone', checked: form.milestone === 0, onSelect: () => {
              form.setMilestone(0);
            }},
            ...milestones.map((m) => ({value: String(m.id), label: m.title, checked: m.id === form.milestone, onSelect: () => {
              form.setMilestone(m.id);
            }})),
          ]}
          anchor={<Button variant={ms ? 'default' : 'invisible'} size="small" leadingVisual={MilestoneIcon} type="button">{ms?.title ?? 'Milestone'}</Button>}/>
      </>}
    </div>
  );
});

function PeoplePick({label, placeholder, icon, people, me, chosen, onToggle}: {
  label: string; placeholder: string; icon: typeof PersonIcon; people: Person[]; me: number; chosen: readonly number[]; onToggle: (id: number) => void;
}) {
  const names = people.filter((p) => chosen.includes(p.id)).map((p) => p.login);
  return (
    <ChoicePanel multiple title={label} placeholder={placeholder} empty="Nobody to choose on this device."
      choices={people.map((u) => ({
        value: String(u.id), label: u.id === me ? `${u.login} (you)` : u.login, words: u.name, leading: u.avatar ? <Avatar alt={u.name} src={u.avatar} size={20}/> : null,
        checked: chosen.includes(u.id), onSelect: () => {
          onToggle(u.id);
        },
      }))}
      anchor={<Button variant={names.length ? 'default' : 'invisible'} size="small" leadingVisual={icon} type="button">{names.length > 2 ? `${String(names.length)} ${label.toLowerCase()}` : names.length ? names.join(', ') : label}</Button>}/>
  );
}

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
          {outlook.files.length <= 3 && <>{' ('}{outlook.files.map((f, i) => <span key={f}>{i > 0 && ', '}<code>{f}</code></span>)}{')'}</>}
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
    <div className="flex flex-wrap items-center gap-2 text-base text-default">
      <CheckStatus tone={tone}/><span className="min-w-0 flex-1">{text}</span>{children}
    </div>
  );
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}
