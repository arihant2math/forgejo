// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The new-issue dialog (C anywhere; PLAN §5.4: creating works offline). The
// issue appears at once under a temporary id (its page is
// /{owner}/{repo}/issues/new-<tempId>) and gets Forgejo's number when the
// queue sends it — the page's URL is then replaced (IssueView). Title,
// description (the markdown composer), labels (status and priority are
// exclusive scoped labels), assignee and milestone, each a picker that
// filters as you type; ⌘↵ creates. What is
// typed is kept as a draft of that repository until it is created or
// discarded (also when the dialog closes before the debounce); the dialog
// opens on the page's repository and says when it brought a draft back.
//
// The form is a small observable model: typing re-renders the field typed
// in, not the menus.

import {useNavigate} from '@tanstack/react-router';
import {BookMarked, Milestone as MilestoneIcon, Tag, User} from 'lucide-react';
import {makeAutoObservable, runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';
import {connectivity} from '../../app/online.ts';
import {shortcutHint} from '../../app/shortcuts/index.ts';
import {type App, useApp, useSession} from '../../app/store.ts';
import {tempNum, uuid} from '../../intents/intents.ts';
import {editing} from '../../intents/session.ts';
import type {Label} from '../../protocol/types.gen.ts';
import {Avatar, Button, CommandPopover, Dialog, Input, LabelDot, LabelIcon} from '../../ui/index.ts';
import {MarkdownField} from '../editor/Composer.tsx';
import {tempIssuePath} from '../issue/paths.ts';
import {repoLabels} from '../issues/candidates.ts';
import {loadPeople, repoPeople} from '../issues/people.ts';
import {priorityIcon, statusIcon, usePool} from '../issues/cells.tsx';
import {exclusiveScope, kindRank, labelKind, scopedValue} from '../issues/labels.ts';
import {canWrite} from '../../app/access.ts';

/** The dialog's draft in a repository. */
const draftKey = (repoId: number) => `text:new-issue:${String(repoId)}`;
const LAST_REPO = 'forgejo-next:create';

function rememberRepo(repoId: number): void {
  try {
    sessionStorage.setItem(LAST_REPO, String(repoId));
  } catch {
    // Storage blocked.
  }
}

function lastRepo(): number {
  try {
    return Number(sessionStorage.getItem(LAST_REPO)) || 0;
  } catch {
    return 0;
  }
}

/**
 * The repositories on this device that are not archived, by name. From a board: only those whose issues the board
 * can hold (Forgejo's rule: a repository's board, its own issues; an organization's or a user's board, the issues
 * of that owner's repositories) — a new issue elsewhere could not go on it.
 */
function repoChoices(app: App, board?: {projectId: number}): {id: number; name: string}[] {
  const pool = app.session?.data.pool;
  if (!pool) return [];
  const project = board ? untracked(() => pool.model('Project').get(board.projectId)?.data) : undefined;
  return [...pool.model('Repository').all()].map((e) => e.data).filter((r) => !r.archived)
    .filter((r) => !project || (project.repo_id ? r.id === project.repo_id : r.owner_id === project.owner_id))
    .map((r) => ({id: r.id, name: r.full_name})).sort((a, b) => a.name.localeCompare(b.name));
}

/** One opening's form. */
class Form {
  repoId: number;
  title: string;
  body: string;
  labels: number[] = [];
  assignee = 0;
  milestone = 0;
  /** The text came back from a draft (the footer offers to discard it). */
  restored = false;
  /** Create was asked for without a title: the field says what is missing. */
  missing = false;
  /** The board column it goes on (a column's "New issue"), if any. */
  readonly board: {projectId: number; columnId: number} | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private done = false;
  private readonly app: App;

  constructor(app: App, initialRepo: number, board?: {projectId: number; columnId: number}) {
    this.app = app;
    this.board = board;
    const repos = repoChoices(app, board);
    // The page's repository (or the one last opened, or last created in); its own draft, if any.
    this.repoId = [initialRepo, lastRepo()].find((id) => id > 0 && repos.some((r) => r.id === id)) ?? repos[0]?.id ?? 0;
    const text = untracked(() => editing(app).intents.drafts.get(draftKey(this.repoId)))?.text ?? '';
    this.title = text.split('\n')[0] ?? '';
    this.body = text.split('\n').slice(2).join('\n');
    this.restored = Boolean(text.trim());
    makeAutoObservable<Form, 'timer' | 'done' | 'app'>(this, {timer: false, done: false, app: false}, {autoBind: true});
  }

  setTitle(t: string): void {
    this.title = t;
    this.keep();
  }

  setBody(b: string): void {
    this.body = b;
    this.keep();
  }

  setRepo(id: number): void {
    const {intents} = editing(this.app);
    const theirs = untracked(() => intents.drafts.get(draftKey(id)))?.text ?? '';
    if (theirs.trim()) {
      // That repository has a draft of its own: it comes back, and this text stays this repository's draft.
      this.flush();
      this.title = theirs.split('\n')[0] ?? '';
      this.body = theirs.split('\n').slice(2).join('\n');
      this.restored = true;
    } else {
      // Otherwise the text goes along: its draft moves to the new repository.
      clearTimeout(this.timer);
      void intents.discardDraft(draftKey(this.repoId));
    }
    this.repoId = id;
    this.labels = [];
    this.assignee = 0;
    this.milestone = 0;
    this.keep();
  }

  setAssignee(id: number): void {
    this.assignee = id;
  }

  setMilestone(id: number): void {
    this.milestone = id;
  }

  toggleLabel(l: Label, on: boolean, all: readonly Label[]): void {
    if (!on) {
      this.labels = this.labels.filter((x) => x !== l.id);
      return;
    }
    // An exclusive scoped label replaces its siblings (status, priority), as Forgejo does.
    const scope = exclusiveScope(l);
    const keep = scope ? this.labels.filter((x) => {
      const other = all.find((y) => y.id === x);
      return !other || exclusiveScope(other) !== scope;
    }) : this.labels;
    this.labels = [...keep, l.id];
  }

  /** Kept while typing (a reload or a crash never loses it), like every editor. */
  private keep(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.flush();
    }, 400);
  }

  /** Empties the form and forgets its draft. */
  discard(): void {
    clearTimeout(this.timer);
    void editing(this.app).intents.discardDraft(draftKey(this.repoId));
    this.title = '';
    this.body = '';
    this.restored = false;
  }

  /** Writes the draft now (the dialog closes before the debounce). */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.done) return;
    const {intents} = editing(this.app);
    if (!this.title.trim() && !this.body.trim()) void intents.discardDraft(draftKey(this.repoId));
    else void intents.keepText({key: draftKey(this.repoId), title: 'A new issue', issueId: 0, repoId: this.repoId, text: `${this.title}\n\n${this.body}`});
  }

  /** Creates the issue (an intent) and forgets the draft; returns its page, or undefined when it cannot be made. */
  create(): string | undefined {
    const t = this.title.trim();
    const repo = untracked(() => this.app.session?.data.pool.model('Repository').get(this.repoId)?.data);
    if (!t) this.missing = true;
    if (!t || !repo) return undefined;
    this.done = true;
    clearTimeout(this.timer);
    const {intents} = editing(this.app);
    void intents.discardDraft(draftKey(this.repoId));
    const tempId = uuid();
    // A reader's issue has no properties (the pickers are not offered; Forgejo would drop them).
    const s = this.app.session;
    const writable = s !== undefined && canWrite(s, this.repoId);
    intents.submit({
      kind: 'issue.create', issueId: tempNum(tempId), repoId: this.repoId, tempId, title: t, body: this.body, labelIds: writable ? [...this.labels] : [],
      assigneeIds: writable && this.assignee ? [this.assignee] : [], milestoneId: writable ? this.milestone : 0,
    });
    // On the board it was created from (sent once Forgejo has numbered the issue: it waits for the create).
    if (this.board) {
      intents.submit({kind: 'issue.project', issueId: tempNum(tempId), repoId: this.repoId, projectId: this.board.projectId, columnId: this.board.columnId, base: 0});
    }
    rememberRepo(this.repoId);
    return tempIssuePath(repo.owner_name, repo.name, tempId);
  }
}

export const CreateIssue = observer(function CreateIssue() {
  const app = useApp();
  const navigate = useNavigate();
  const req = app.ui.create;
  // A fresh form for each opening (the draft brings the text back).
  const [form, setForm] = useState<Form | undefined>();
  const [wasOpen, setWasOpen] = useState(false);
  if (Boolean(req) !== wasOpen) {
    setWasOpen(Boolean(req));
    if (req) setForm(new Form(app, req.repoId, req.board));
  }
  const close = () => {
    form?.flush();
    runInAction(() => {
      app.ui.create = undefined;
    });
  };
  const create = () => {
    const path = form?.create();
    if (!path) return;
    runInAction(() => {
      app.ui.create = undefined;
    });
    // Created from a board column: the card shows there at once (the board stays); otherwise its page opens.
    if (!form?.board) void navigate({to: path});
  };
  return (
    <Dialog open={Boolean(req)} onOpenChange={(o) => {
      if (!o) close();
    }} title="New issue" size="lg" footer={form && <Footer form={form} onCancel={close} onCreate={create}/>}>
      {form && <Fields form={form} onCreate={create}/>}
    </Dialog>
  );
});

const Fields = observer(function Fields({form, onCreate}: {form: Form; onCreate: () => void}) {
  const app = useApp();
  // Written on the way out (Esc, the overlay, a route change).
  useEffect(() => () => {
    form.flush();
  }, [form]);
  if (!repoChoices(app, form.board).length) {
    return <p className="text-base text-fg-muted">{form.board ?
      'No repository whose issues this board can hold is on this device: a board takes the issues of its owner\'s repositories.' :
      'No repository is on this device yet: issues are created in one.'}</p>;
  }
  // ⌘↵ creates from anywhere in the form (the Write/Preview tabs, the property buttons), not only from the fields.
  return (
    <div className="flex flex-col gap-3" onKeyDown={(e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.defaultPrevented) {
        e.preventDefault();
        onCreate();
      }
    }}>
      <Properties form={form}/>
      <Title form={form} onCreate={onCreate}/>
      <Description form={form} onCreate={onCreate}/>
    </div>
  );
});

const Title = observer(function Title({form, onCreate}: {form: Form; onCreate: () => void}) {
  const missing = form.missing && !form.title.trim();
  return (
    <div className="flex flex-col gap-1">
    <Input aria-label="Title" placeholder="Issue title" value={form.title} autoFocus className="w-full" maxLength={255} invalid={missing}
      aria-describedby={missing ? 'create-title-missing' : undefined}
      onChange={(e) => {
        form.setTitle(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onCreate();
        }
      }}/>
    {missing && <p id="create-title-missing" role="alert" className="text-sm text-danger">An issue needs a title.</p>}
    </div>
  );
});

const Description = observer(function Description({form, onCreate}: {form: Form; onCreate: () => void}) {
  return (
    <MarkdownField repoId={form.repoId} label="Description" placeholder="Add a description…" value={form.body} rows={6}
      onChange={(b) => {
        form.setBody(b);
      }} onSubmit={onCreate}/>
  );
});

/**
 * Repository, status, priority, labels, assignee, milestone: observes those only (typing does not re-render it).
 * Status and priority are chips of their own (the exclusive `status/…` and `priority/…` labels, as everywhere
 * else), so Labels lists the plain labels. Without write access only the repository is offered: Forgejo drops
 * what a reader sets on a new issue (QA round 2: silently).
 */
const Properties = observer(function Properties({form}: {form: Form}) {
  const app = useApp();
  const session = useSession();
  const {userId} = session;
  const pool = usePool();
  const repoId = form.repoId;
  const repos = repoChoices(app, form.board);
  const repo = pool.model('Repository').get(repoId)?.data;
  const writable = repoId > 0 && canWrite(session, repoId);
  const allLabels = repoId ? repoLabels(pool, repoId) : [];
  const ofKind = (k: 'status' | 'priority') => allLabels.filter((l) => labelKind(l) === k).sort((a, b) => kindRank(k, a.name) - kindRank(k, b.name));
  const plain = allLabels.filter((l) => labelKind(l) === undefined);
  useEffect(() => {
    if (repoId && writable) loadPeople(app, repoId);
  }, [app, repoId, writable]);
  const people = repoId ? repoPeople(pool, repoId, userId) : [];
  const milestones = repoId ? [...pool.model('Milestone').by('repo_id', repoId)].map((m) => m.data).filter((m) => m.state === 'open')
    .sort((a, b) => a.title.localeCompare(b.title)) : [];
  const chosenLabels = plain.filter((l) => form.labels.includes(l.id));
  const who = people.find((u) => u.id === form.assignee);
  const ms = milestones.find((m) => m.id === form.milestone);
  // Every property filters as you type (a repository with many labels or people stays usable).
  return (
    <div className="flex flex-wrap items-center gap-1">
      <CommandPopover label="Repository" placeholder="Create in the repository…" empty="No repository is on this device."
        options={repos.map((r) => ({value: String(r.id), label: r.name, checked: r.id === repoId, onSelect: () => {
          form.setRepo(r.id);
        }}))}
        trigger={<Button size="sm" icon={BookMarked}>{repo?.full_name ?? 'Repository'}</Button>}/>
      {writable ? <>
        <KindChip form={form} kind="status" labels={ofKind('status')} all={allLabels}/>
        <KindChip form={form} kind="priority" labels={ofKind('priority')} all={allLabels}/>
        {/* A trigger with a value looks filled (as the list's filters do); it is not a toggle (aria-pressed). */}
        <CommandPopover label="Labels" placeholder="Add labels…" empty="This repository has no labels."
          options={plain.map((l) => ({
            value: String(l.id), label: l.name, words: l.description, leading: <LabelDot color={l.color}/>, checked: form.labels.includes(l.id), keepOpen: true,
            onSelect: () => {
              form.toggleLabel(l, !form.labels.includes(l.id), allLabels);
            },
          }))}
          trigger={
            <Button size="sm" variant={chosenLabels.length > 0 ? 'secondary' : 'ghost'} icon={Tag}>
              {chosenLabels.length > 2 ? `${String(chosenLabels.length)} labels` : chosenLabels.length ? chosenLabels.map((l) => l.name).join(', ') : 'Labels'}
            </Button>
          }/>
        <CommandPopover label="Assignee" placeholder="Assign to…"
          options={[
            {value: '0', label: 'Nobody', checked: form.assignee === 0, onSelect: () => {
              form.setAssignee(0);
            }},
            ...people.map((u) => ({
              value: String(u.id), label: u.id === userId ? `${u.login} (you)` : u.login, words: u.name, leading: <Avatar name={u.name} src={u.avatar} size="sm"/>,
              checked: u.id === form.assignee, onSelect: () => {
                form.setAssignee(u.id);
              },
            })),
          ]}
          trigger={<Button size="sm" variant={who ? 'secondary' : 'ghost'} icon={User}>{who?.login ?? 'Assignee'}</Button>}/>
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
      </> : repoId > 0 && <span className="px-1 text-sm text-fg-subtle">You can read this repository: its maintainers set labels, people and milestones.</span>}
    </div>
  );
});

/** The status or the priority of the new issue: one of the repository's exclusive labels of that kind, with its icon. */
const KindChip = observer(function KindChip({form, kind, labels, all}: {form: Form; kind: 'status' | 'priority'; labels: Label[]; all: readonly Label[]}) {
  if (!labels.length) return null;
  const chosen = labels.find((l) => form.labels.includes(l.id));
  const iconOf = kind === 'status' ? statusIcon : priorityIcon;
  const name = kind === 'status' ? 'Status' : 'Priority';
  return (
    <CommandPopover label={name} placeholder={kind === 'status' ? 'Set the status…' : 'Set the priority…'}
      options={[
        {value: '0', label: kind === 'status' ? 'No status' : 'No priority', checked: !chosen, onSelect: () => {
          if (chosen) form.toggleLabel(chosen, false, all);
        }},
        ...labels.map((l) => ({
          value: String(l.id), label: scopedValue(l.name), leading: <LabelIcon icon={iconOf(l.name)} color={l.color}/>, checked: chosen?.id === l.id,
          onSelect: () => {
            form.toggleLabel(l, true, all);
          },
        })),
      ]}
      trigger={
        <Button size="sm" variant={chosen ? 'secondary' : 'ghost'} icon={chosen ? undefined : iconOf('')}>
          {chosen ? <><LabelIcon icon={iconOf(chosen.name)} color={chosen.color}/>{scopedValue(chosen.name)}</> : name}
        </Button>
      }/>
  );
});

const Footer = observer(function Footer({form, onCancel, onCreate}: {form: Form; onCancel: () => void; onCreate: () => void}) {
  const ready = Boolean(form.title.trim()) && form.repoId > 0;
  return (
    <>
      <span className="mr-auto flex items-center gap-1 self-center text-sm text-fg-subtle">
        {form.board && <BoardHint board={form.board}/>}
        {form.restored && <>Draft restored<Button size="sm" variant="ghost" onClick={() => {
          form.discard();
        }}>Discard</Button></>}
        {!connectivity.online && <span>Offline: it syncs when you are back.</span>}
      </span>
      <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      {/* aria-disabled, not disabled: the tooltip (with ⌘↵) still shows and says what is missing. */}
      <Button variant="primary" shortcut={shortcutHint('submit')} tooltip={ready ? 'Create the issue (works offline)' : 'Add a title first'} aria-disabled={!ready} onClick={onCreate}>
        Create issue
      </Button>
    </>
  );
});

/** Where the new issue goes on a board ("On Atlas 1.0 · To do"). */
const BoardHint = observer(function BoardHint({board}: {board: {projectId: number; columnId: number}}) {
  const pool = usePool();
  const project = pool.model('Project').get(board.projectId)?.get('title');
  const column = pool.model('ProjectColumn').get(board.columnId)?.get('title');
  return project ? <span>On {project}{column ? ` · ${column}` : ''}.</span> : null;
});
