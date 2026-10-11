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
import {makeAutoObservable, runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {cloneElement, createElement, useEffect, useRef, useState} from 'react';
import {connectivity} from '../../app/online.ts';
import {notify} from '../../app/notices.ts';
import {shortcutHint} from '../../app/shortcuts/index.ts';
import {type App, useApp, useSession} from '../../app/store.ts';
import {tempNum, uuid} from '../../intents/intents.ts';
import {editing} from '../../intents/session.ts';
import type {Label} from '../../protocol/types.gen.ts';
import {FilteredSelect} from './FilteredSelect.tsx';
import {MarkdownField} from '../editor/Composer.tsx';
import {hasPendingUploads} from '../editor/attachments.ts';
import {tempIssuePath} from '../issue/paths.ts';
import {repoLabels} from '../issues/candidates.ts';
import {repoPeople} from '../issues/people.ts';
import {PickerPopover} from '../issues/Picker.tsx';
import {priorityIcon, statusIcon, usePool} from '../issues/cells.tsx';
import {exclusiveScope, kindRank, labelKind, scopedValue} from '../issues/labels.ts';
import {canWrite} from '../../app/access.ts';
import {formBody, initialValues, loadTemplates, missingFields, type FormValues, type IssueTemplate, type TemplateSet} from './templates.ts';
import {TemplateFields} from './TemplateFields.tsx';
import {RepoIcon, MilestoneIcon, TagIcon, PersonIcon} from '@primer/octicons-react';
import {ActionList, Button, Dialog, FormControl, LinkButton, TextInput} from '@primer/react';
import {Tooltip} from '@primer/react';

/** The dialog's draft in a repository. */
const draftKey = (repoId: number) => `text:new-issue:${String(repoId)}`;
const LAST_REPO = 'forgejo-next:create';
const templateDraftKey = (repoId: number) => `${draftKey(repoId)}:template`;
interface TemplateDraft {file: string; values: FormValues; labels: number[]; assignees: number[]}

function templateDraft(app: App, repoId: number): TemplateDraft | undefined {
  const text = untracked(() => editing(app).intents.drafts.get(templateDraftKey(repoId)))?.text;
  if (!text) return undefined;
  try { return JSON.parse(text) as TemplateDraft; } catch { return undefined; }
}

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

/** A fresh device can recover a repository from the user's synced issue and timeline activity. */
export function recentActivityRepo(app: App, allowed: readonly {id: number}[]): number {
  const session = app.session;
  if (!session) return 0;
  const pool = session.data.pool;
  const ids = new Set(allowed.map((r) => r.id));
  let latest = '';
  let repoId = 0;
  const consider = (id: number, date: string) => {
    if (ids.has(id) && date > latest) {
      latest = date;
      repoId = id;
    }
  };
  for (const {data: issue} of pool.model('Issue').all()) {
    if (issue.poster_id === session.userId) consider(issue.repo_id, issue.created_at);
  }
  for (const {data: comment} of pool.model('Comment').all()) {
    if (comment.poster_id !== session.userId) continue;
    const issue = pool.model('Issue').get(comment.issue_id)?.data;
    if (issue) consider(issue.repo_id, comment.created_at);
  }
  return repoId;
}

/** One opening's form. */
class Form {
  repoId: number;
  title: string;
  body: string;
  labels: number[] = [];
  assignees: number[] = [];
  milestone = 0;
  templates: TemplateSet | undefined;
  choosing = true;
  template: IssueTemplate | undefined;
  values: FormValues = {};
  fieldErrors: string[] = [];

  choose(template?: IssueTemplate): void {
    this.choosing = false;
    this.fieldErrors = [];
    if (template && this.template === template) return;
    const previous = this.template;
    this.template = template;
    const draft = templateDraft(this.app, this.repoId);
    if (!template) {
      if (previous) {
        this.discard();
        this.title = this.prefill;
        this.labels = [];
        this.assignees = [];
      }
      void editing(this.app).intents.discardDraft(templateDraftKey(this.repoId));
      return;
    }
    if (this.restored && draft?.file === template.file_name) {
      this.values = {...initialValues(template.body ?? []), ...draft.values};
      this.labels = draft.labels;
      this.assignees = draft.assignees;
      return;
    }
    this.restored = false;
    // A template's title is a prefix ("[Bug] "): the text the issue was started with follows it.
    this.setTitle(`${template.title ?? ''}${this.prefill}`);
    this.values = initialValues(template.body ?? []);
    this.setBody(template.body?.length ? formBody(template.body, this.values) : template.content ?? '');
    const pool = this.app.session?.data.pool;
    this.labels = pool ? repoLabels(pool, this.repoId).filter((l) => template.labels?.includes(l.name)).map((l) => l.id) : [];
    const known = [...(this.templates?.people ?? []), ...[...(pool?.model('User').all() ?? [])].map((u) => ({id: u.data.id, login: u.data.login}))];
    this.assignees = [...new Set(known.filter((u) => template.assignees?.includes(u.login)).map((u) => u.id))];
  }

  setValue(id: string, value: string | number[]): void {
    this.values[id] = value;
    this.setBody(formBody(this.template?.body ?? [], this.values));
    this.fieldErrors = this.fieldErrors.filter((key) => key !== id);
  }

  async load(templateName?: string): Promise<void> {
    const id = this.repoId;
    const result = await loadTemplates(this.app, id);
    if (this.repoId !== id) return;
    runInAction(() => {
      this.templates = result;
      const name = templateName ?? templateDraft(this.app, id)?.file;
      const chosen = name ? result.templates.find((t) => t.file_name === name || t.file_name.split('/').at(-1) === name) : undefined;
      if (chosen) this.choose(chosen);
      else if (!result.templates.length && result.config.blank_issues_enabled && !result.config.contact_links.length) this.choose();
    });
  }
  /** The text came back from a draft (the footer offers to discard it). */
  restored = false;
  /** Create was asked for without a title: the field says what is missing. */
  missing = false;
  /** The board column it goes on (a column's "New issue"), if any. */
  readonly board: {projectId: number; columnId: number} | undefined;
  /** The title it was opened with (a board's "Add existing issues" text that matched none), or "". */
  readonly prefill: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private done = false;
  private readonly app: App;

  constructor(app: App, initialRepo: number, board?: {projectId: number; columnId: number}, title?: string) {
    this.app = app;
    this.board = board;
    this.prefill = title?.trim() ?? '';
    const repos = repoChoices(app, board);
    // The page's repository (or the one last opened, or last created in); its own draft, if any.
    this.repoId = [initialRepo, lastRepo(), recentActivityRepo(app, repos)].find((id) => id > 0 && repos.some((r) => r.id === id)) ?? repos[0]?.id ?? 0;
    const text = untracked(() => editing(app).intents.drafts.get(draftKey(this.repoId)))?.text ?? '';
    // Opened with a title: that title, with the draft's description (if any; the footer offers to discard it).
    this.title = this.prefill || (text.split('\n')[0] ?? '');
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
      void intents.discardDraft(templateDraftKey(this.repoId));
    }
    this.repoId = id;
    this.templates = undefined;
    this.template = undefined;
    this.choosing = true;
    this.values = {};
    void this.load();
    this.labels = [];
    this.assignees = [];
    this.milestone = 0;
    this.keep();
  }

  setAssignee(id: number, on: boolean): void {
    this.assignees = on ? [...new Set([...this.assignees, id])] : this.assignees.filter((x) => x !== id);
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
    void editing(this.app).intents.discardDraft(templateDraftKey(this.repoId));
    this.values = initialValues(this.template?.body ?? []);
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
    if (!this.choosing && this.template) void intents.keepText({key: templateDraftKey(this.repoId), title: 'Issue template draft', issueId: 0, repoId: this.repoId, text: JSON.stringify({file: this.template.file_name, values: this.values, labels: this.labels, assignees: this.assignees})});
    if (!this.title.trim() && !this.body.trim()) void intents.discardDraft(draftKey(this.repoId));
    else void intents.keepText({key: draftKey(this.repoId), title: 'A new issue', issueId: 0, repoId: this.repoId, text: `${this.title}\n\n${this.body}`});
  }

  /** Creates the issue (an intent) and forgets the draft; returns its page, or undefined when it cannot be made. */
  create(): string | undefined {
    if (this.choosing) return undefined;
    this.fieldErrors = missingFields(this.template?.body ?? [], this.values);
    if (this.fieldErrors.length) return undefined;
    if (this.template?.body?.length) this.body = formBody(this.template.body, this.values);
    const t = this.title.trim();
    const repo = untracked(() => this.app.session?.data.pool.model('Repository').get(this.repoId)?.data);
    if (!t) this.missing = true;
    if (!t || !repo || hasPendingUploads(this.body)) return undefined;
    this.done = true;
    clearTimeout(this.timer);
    const {intents} = editing(this.app);
    void intents.discardDraft(draftKey(this.repoId));
    void intents.discardDraft(templateDraftKey(this.repoId));
    const tempId = uuid();
    // A reader's issue has no properties (the pickers are not offered; Forgejo would drop them).
    const s = this.app.session;
    const writable = s !== undefined && canWrite(s, this.repoId);
    intents.submit({
      kind: 'issue.create', issueId: tempNum(tempId), repoId: this.repoId, tempId, title: t, body: this.body, labelIds: writable ? [...this.labels] : [],
      assigneeIds: writable ? [...this.assignees] : [], milestoneId: writable ? this.milestone : 0,
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
  const returnFocus = useRef<HTMLElement>(null);
  // A fresh form for each opening (the draft brings the text back).
  const [form, setForm] = useState<Form | undefined>();
  const [previousRequest, setPreviousRequest] = useState<typeof req>();
  if (req !== previousRequest) {
    setPreviousRequest(req);
    if (previousRequest && req) form?.flush();
    if (req) {
      const activeBeforeOpen = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const column = req.board?.columnId;
      returnFocus.current = column === undefined ? activeBeforeOpen : document.querySelector<HTMLElement>(`[data-column="${String(column)}"] [role="listbox"]`) ?? activeBeforeOpen;
      const next = new Form(app, req.repoId, req.board, req.title);
      setForm(next);
      void next.load(req.template);
    }
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
    else notify(app, {tone: 'neutral', title: 'Issue added to the column', description: form.title.trim(), action: {label: 'Open', run: () => {
      void navigate({to: path});
    }}});
  };
  if (!req) return null;
  return (
    <Dialog onClose={close} returnFocusRef={returnFocus} title="New issue" width="xlarge"
      renderFooter={() => <Dialog.Footer>{form && <Footer form={form} onCancel={close} onCreate={create}/>}</Dialog.Footer>}>
      {form && (form.choosing ? <TemplatePicker form={form}/> : <Fields form={form} onCreate={create} onClose={close}/>)}
    </Dialog>
  );
});

const TemplatePicker = observer(function TemplatePicker({form}: {form: Form}) {
  const set = form.templates;
  const [filter, setFilter] = useState('');
  const listRef = useRef<HTMLUListElement>(null);
  if (!set) return <p className="text-sm text-muted" role="status">Loading issue templates…</p>;
  return <div className="flex flex-col gap-2">
    <p className="text-sm text-muted">Choose an issue template</p>
    {set.note && <p className="text-sm text-muted">{set.note}</p>}
    <FormControl><FormControl.Label>Issue templates</FormControl.Label>
      <TextInput autoFocus placeholder="Find a template…" value={filter} onChange={(event) => { setFilter(event.target.value); }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'Enter') {
            event.preventDefault();
            const first = listRef.current?.querySelector<HTMLElement>('[role="option"]');
            if (event.key === 'Enter') first?.click();
            else first?.focus();
          }
        }}/>
    </FormControl>
    <ActionList ref={listRef} aria-label="Issue templates" role="listbox">
      {set.templates.filter((t) => `${t.name} ${t.about}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map((t) =>
        <ActionList.Item role="option" key={t.file_name} onSelect={() => { form.choose(t); }}>
          {t.name}<ActionList.Description variant="block">{t.about}</ActionList.Description>
        </ActionList.Item>)}
      {set.config.blank_issues_enabled && 'blank issue'.includes(filter.toLocaleLowerCase()) &&
        <ActionList.Item role="option" onSelect={() => { form.choose(); }}>Blank issue</ActionList.Item>}
    </ActionList>
    {!set.templates.some((t) => `${t.name} ${t.about}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) &&
      !(set.config.blank_issues_enabled && 'blank issue'.includes(filter.toLocaleLowerCase())) && <p role="status">No matching templates</p>}
    {set.config.contact_links.filter((l) => /^https?:\/\//i.test(l.url)).map((l) => <div key={l.url}>
      <LinkButton variant="invisible" href={l.url} target="_blank" rel="noopener noreferrer">{l.name}↗</LinkButton>
      <p className="text-sm text-muted">{l.about}</p>
    </div>)}
    <Properties form={form}/>
  </div>;
});

const Fields = observer(function Fields({form, onCreate, onClose}: {form: Form; onCreate: () => void; onClose: () => void}) {
  const app = useApp();
  // Written on the way out (Esc, the overlay, a route change).
  useEffect(() => () => {
    form.flush();
  }, [form]);
  if (!repoChoices(app, form.board).length) {
    return <p className="text-base text-muted">{form.board ?
      'No repository whose issues this board can hold is on this device: a board takes the issues of its owner\'s repositories.' :
      'No repository is on this device yet: issues are created in one.'}</p>;
  }
  // ⌘↵ creates from anywhere in the form (the Write/Preview tabs, the property buttons), not only from the fields.
  return (
    <div className="flex flex-col gap-3" onKeyDownCapture={(e) => {
      if (e.key === 'Escape' && e.target instanceof HTMLElement && e.target.closest('button[aria-expanded="false"]')) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }} onKeyDown={(e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.defaultPrevented) {
        e.preventDefault();
        onCreate();
      }
    }}>
      {form.templates?.templates.length ? <Button variant="invisible" size="small" type="button" onClick={() => { runInAction(() => { form.choosing = true; }); }}>Change template</Button> : null}
      <Title form={form} onCreate={onCreate}/>
      {form.templates?.note && <p className="text-sm text-muted">{form.templates.note}</p>}
      {form.template?.body?.length ? <TemplateFields fields={form.template.body} values={form.values} missing={form.fieldErrors} repoId={form.repoId} onChange={form.setValue}/> : <Description form={form} onCreate={onCreate}/>}
      <Properties form={form}/>
    </div>
  );
});

const Title = observer(function Title({form, onCreate}: {form: Form; onCreate: () => void}) {
  const missing = form.missing && !form.title.trim();
  return (
    <FormControl>
    <FormControl.Label>Title</FormControl.Label>
    <TextInput aria-label="Title" placeholder="Issue title" value={form.title} autoFocus className="w-full" maxLength={255} aria-describedby={missing ? 'create-title-missing' : undefined} onChange={(e) => {
        form.setTitle(e.target.value);
      }} onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onCreate();
        }
      }} {...(missing ? {validationStatus: 'error' as const} : {})}/>
    {missing && <FormControl.Validation id="create-title-missing" variant="error">An issue needs a title.</FormControl.Validation>}
    </FormControl>
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
  const people = repoId ? repoPeople(pool, repoId, userId, form.assignees) : [];
  const chosenLabels = plain.filter((l) => form.labels.includes(l.id));
  const who = [...people, ...(form.templates?.people ?? []).filter((p) => !people.some((u) => u.id === p.id)).map((p) => ({id: p.id, name: p.login}))].filter((u) => form.assignees.includes(u.id));
  const ms = pool.model('Milestone').get(form.milestone)?.data;
  // Every property filters as you type (a repository with many labels or people stays usable).
  return (
    <div className="flex flex-wrap items-center gap-1">
      <FilteredSelect title="Repository" placeholder="Repository" placeholderText="Create in the repository…"
        message={{title: 'No repository is on this device.', body: '', variant: 'empty'}}
        items={repos.map((r) => ({id: r.id, text: r.name}))}
        selected={repo ? {id: repoId, text: repo.full_name} : undefined}
        onSelectedChange={(item) => { if (item) form.setRepo(Number(item.id)); }}
        renderAnchor={(props) => cloneElement(<Button size="small" leadingVisual={RepoIcon} type="button">{repo?.full_name ?? 'Repository'}</Button>, props)}/>
      {writable ? <>
        <KindChip form={form} kind="status" labels={ofKind('status')}/>
        <KindChip form={form} kind="priority" labels={ofKind('priority')}/>
        {/* A trigger with a value looks filled (as the list's filters do); it is not a toggle (aria-pressed). */}
        <PickerPopover kind="labels" draft={form}
          trigger={
            <Button variant={chosenLabels.length > 0 ? 'default' : 'invisible'} size="small" leadingVisual={TagIcon} type="button">
              {chosenLabels.length > 2 ? `${String(chosenLabels.length)} labels` : chosenLabels.length ? chosenLabels.map((l) => l.name).join(', ') : 'Labels'}
            </Button>
          }/>
        <PickerPopover kind="assignees" draft={form}
          trigger={<Button variant={who.length ? 'default' : 'invisible'} size="small" leadingVisual={PersonIcon} type="button">{who.length ? who.map((u) => u.name).join(', ') : 'Assignees'}</Button>}/>
        <PickerPopover kind="milestone" draft={form}
          trigger={<Button variant={ms ? 'default' : 'invisible'} size="small" leadingVisual={MilestoneIcon} type="button">{ms?.title ?? 'Milestone'}</Button>}/>
      </> : repoId > 0 && <span className="px-1 text-sm text-muted">You can read this repository: its maintainers set labels, people and milestones.</span>}
    </div>
  );
});

/** The status or the priority of the new issue: one of the repository's exclusive labels of that kind, with its icon. */
const KindChip = observer(function KindChip({form, kind, labels}: {form: Form; kind: 'status' | 'priority'; labels: Label[]}) {
  if (!labels.length) return null;
  const chosen = labels.find((l) => form.labels.includes(l.id));
  const iconOf = kind === 'status' ? statusIcon : priorityIcon;
  const name = kind === 'status' ? 'Status' : 'Priority';
  return (
    <PickerPopover kind={kind} draft={form}
      trigger={
        <Button variant={chosen ? 'default' : 'invisible'} size="small" leadingVisual={chosen ? null : iconOf('')} type="button">
          {chosen ? <>{createElement(iconOf(chosen.name), {fill: chosen.color})}{scopedValue(chosen.name)}</> : name}
        </Button>
      }/>
  );
});

const Footer = observer(function Footer({form, onCancel, onCreate}: {form: Form; onCancel: () => void; onCreate: () => void}) {
  const uploading = hasPendingUploads(form.body);
  const ready = !form.choosing && Boolean(form.title.trim()) && form.repoId > 0 && !uploading;
  return (
    <>
      <span className="mr-auto flex items-center gap-1 self-center text-sm text-muted">
        {form.board && <BoardHint board={form.board}/>}
        {form.restored && <>Draft restored<Button variant="invisible" size="small" type="button" onClick={() => {
          form.discard();
        }}>Discard</Button></>}
        {!connectivity.online && <span>Offline: it syncs when you are back.</span>}
      </span>
      <Button variant="invisible" type="button" onClick={onCancel}>Cancel</Button>
      {/* aria-disabled, not disabled: the tooltip (with ⌘↵) still shows and says what is missing. */}
      {!form.choosing && <Tooltip text={uploading ? 'Wait for the attachments to finish uploading.' : ready ? 'Create the issue (works offline)' : 'Add a title first'} keybindingHint={shortcutHint('submit')}><Button variant="primary" type="button" aria-disabled={!ready} onClick={onCreate}>
        Create issue
      </Button></Tooltip>}
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
