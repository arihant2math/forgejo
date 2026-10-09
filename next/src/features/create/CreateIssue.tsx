// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The new-issue dialog (C anywhere; PLAN §5.4: creating works offline). The
// issue appears at once under a temporary id (its page is
// /{owner}/{repo}/issues/new-<tempId>) and gets Forgejo's number when the
// queue sends it — the page's URL is then replaced (IssueView). Title,
// description (the markdown composer), labels (status and priority are
// exclusive scoped labels), assignee and milestone; ⌘↵ creates. What is
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
import {
  Button, Dialog, Input, LabelDot, Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuTrigger,
} from '../../ui/index.ts';
import {MarkdownField} from '../editor/Composer.tsx';
import {tempIssuePath} from '../issue/paths.ts';
import {assigneeCandidates, repoLabels} from '../issues/candidates.ts';
import {usePool} from '../issues/cells.tsx';
import {exclusiveScope} from '../issues/labels.ts';

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

/** The repositories on this device that are not archived, by name. */
function repoChoices(app: App): {id: number; name: string}[] {
  const pool = app.session?.data.pool;
  if (!pool) return [];
  return [...pool.model('Repository').all()].map((e) => e.data).filter((r) => !r.archived)
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
  private timer: ReturnType<typeof setTimeout> | undefined;
  private done = false;
  private readonly app: App;

  constructor(app: App, initialRepo: number) {
    this.app = app;
    const repos = repoChoices(app);
    // The page's repository (or the one last used); its own draft, if any.
    this.repoId = repos.some((r) => r.id === initialRepo) ? initialRepo : repos[0]?.id ?? 0;
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
    if (!t || !repo) return undefined;
    this.done = true;
    clearTimeout(this.timer);
    const {intents} = editing(this.app);
    void intents.discardDraft(draftKey(this.repoId));
    const tempId = uuid();
    intents.submit({
      kind: 'issue.create', issueId: tempNum(tempId), repoId: this.repoId, tempId, title: t, body: this.body, labelIds: [...this.labels],
      assigneeIds: this.assignee ? [this.assignee] : [], milestoneId: this.milestone,
    });
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
    if (req) setForm(new Form(app, req.repoId || lastRepo()));
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
    void navigate({to: path});
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
  if (!repoChoices(app).length) return <p className="text-base text-fg-muted">No repository is on this device yet: issues are created in one.</p>;
  return (
    <div className="flex flex-col gap-3">
      <Properties form={form}/>
      <Title form={form} onCreate={onCreate}/>
      <Description form={form} onCreate={onCreate}/>
    </div>
  );
});

const Title = observer(function Title({form, onCreate}: {form: Form; onCreate: () => void}) {
  return (
    <Input aria-label="Title" placeholder="Issue title" value={form.title} autoFocus className="w-full" maxLength={255}
      onChange={(e) => {
        form.setTitle(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onCreate();
        }
      }}/>
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

/** Repository, labels, assignee, milestone: observes those only (typing does not re-render it). */
const Properties = observer(function Properties({form}: {form: Form}) {
  const app = useApp();
  const {userId} = useSession();
  const pool = usePool();
  const repoId = form.repoId;
  const repos = repoChoices(app);
  const repo = pool.model('Repository').get(repoId)?.data;
  const allLabels = repoId ? repoLabels(pool, repoId) : [];
  const people = repoId ? assigneeCandidates(pool, repoId, userId).map((id) => pool.model('User').get(id)?.data).filter((u) => u !== undefined)
    .sort((a, b) => a.login.localeCompare(b.login)) : [];
  const milestones = repoId ? [...pool.model('Milestone').by('repo_id', repoId)].map((m) => m.data).filter((m) => m.state === 'open')
    .sort((a, b) => a.title.localeCompare(b.title)) : [];
  const chosenLabels = allLabels.filter((l) => form.labels.includes(l.id));
  const who = people.find((u) => u.id === form.assignee);
  const ms = milestones.find((m) => m.id === form.milestone);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Menu>
        <MenuTrigger asChild><Button size="sm" icon={BookMarked}>{repo?.full_name ?? 'Repository'}</Button></MenuTrigger>
        <MenuContent>
          <MenuRadioGroup value={String(repoId)} onValueChange={(v) => {
            form.setRepo(Number(v));
          }}>
            {repos.map((r) => <MenuRadioItem key={r.id} value={String(r.id)}>{r.name}</MenuRadioItem>)}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
      {/* A menu trigger with a value looks filled (as the list's filters do); it is not a toggle (aria-pressed). */}
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" variant={chosenLabels.length > 0 ? 'secondary' : 'ghost'} icon={Tag} tooltip="Labels, status and priority">
            {chosenLabels.length > 2 ? `${String(chosenLabels.length)} labels` : chosenLabels.length ? chosenLabels.map((l) => l.name).join(', ') : 'Labels'}
          </Button>
        </MenuTrigger>
        <MenuContent>
          {allLabels.length === 0 && <MenuItem disabled>No labels</MenuItem>}
          {allLabels.map((l) => (
            <MenuCheckboxItem key={l.id} checked={form.labels.includes(l.id)} onSelect={(e) => {
              e.preventDefault();
            }} onCheckedChange={(on) => {
              form.toggleLabel(l, on, allLabels);
            }}>
              <span className="flex min-w-0 items-center gap-2"><LabelDot color={l.color}/><span className="truncate">{l.name}</span></span>
            </MenuCheckboxItem>
          ))}
        </MenuContent>
      </Menu>
      <Menu>
        <MenuTrigger asChild><Button size="sm" variant={who ? 'secondary' : 'ghost'} icon={User}>{who?.login ?? 'Assignee'}</Button></MenuTrigger>
        <MenuContent>
          <MenuRadioGroup value={String(form.assignee)} onValueChange={(v) => {
            form.setAssignee(Number(v));
          }}>
            <MenuRadioItem value="0">Nobody</MenuRadioItem>
            {people.map((u) => <MenuRadioItem key={u.id} value={String(u.id)}>{u.id === userId ? `${u.login} (you)` : u.login}</MenuRadioItem>)}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
      <Menu>
        <MenuTrigger asChild><Button size="sm" variant={ms ? 'secondary' : 'ghost'} icon={MilestoneIcon}>{ms?.title ?? 'Milestone'}</Button></MenuTrigger>
        <MenuContent>
          <MenuRadioGroup value={String(form.milestone)} onValueChange={(v) => {
            form.setMilestone(Number(v));
          }}>
            <MenuRadioItem value="0">No milestone</MenuRadioItem>
            {milestones.map((m) => <MenuRadioItem key={m.id} value={String(m.id)}>{m.title}</MenuRadioItem>)}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
    </div>
  );
});

const Footer = observer(function Footer({form, onCancel, onCreate}: {form: Form; onCancel: () => void; onCreate: () => void}) {
  const ready = Boolean(form.title.trim()) && form.repoId > 0;
  return (
    <>
      <span className="mr-auto flex items-center gap-1 self-center text-sm text-fg-subtle">
        {form.restored && <>Draft restored<Button size="sm" variant="ghost" onClick={() => {
          form.discard();
        }}>Discard</Button></>}
        {!connectivity.online && <span>Offline: it syncs when you are back.</span>}
      </span>
      <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      {/* aria-disabled, not disabled: the tooltip (with ⌘↵) still shows and says what is missing. */}
      <Button variant="primary" shortcut={shortcutHint('submit')} tooltip={ready ? 'Create the issue (works offline)' : 'Add a title first'} aria-disabled={!ready} onClick={() => {
        if (ready) onCreate();
      }}>
        Create issue
      </Button>
    </>
  );
});
