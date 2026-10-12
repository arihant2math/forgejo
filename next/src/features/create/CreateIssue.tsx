// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Offline creation uses a temporary id until the server assigns an issue number.
// Repository drafts survive dialog close; observable fields avoid re-rendering menus while typing.

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
import {Button, Dialog, FormControl, LinkButton, TextInput} from '@primer/react';
import {FilteredActionList} from '@primer/react/experimental';
import {Tooltip} from '@primer/react';

const draftKey = (repoId: number) => `text:new-issue:${String(repoId)}`;
const LAST_REPO = 'forgejo-next:create';
const templateDraftKey = (repoId: number) => `${draftKey(repoId)}:template`;
interface TemplateDraft {file: string; values: FormValues; labels: number[]; assignees: number[]}

function templateDraft(app: App, repoId: number): TemplateDraft | undefined {
  const text = untracked(() => editing(app).intents.drafts.get(templateDraftKey(repoId)))?.text;
  if (!text) return undefined;
  try { return JSON.parse(text) as TemplateDraft; } catch { return undefined; }
}

/** A new issue's draft is stored as its title, a blank line and its body. */
function textDraft(app: App, repoId: number): {title: string; body: string; restored: boolean} {
  const text = untracked(() => editing(app).intents.drafts.get(draftKey(repoId)))?.text ?? '';
  const [title = '', , ...body] = text.split('\n');
  return {title, body: body.join('\n'), restored: Boolean(text.trim())};
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

/** Limit repositories to those the board can hold; cross-owner issues cannot be added. */
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
  restored = false;
  missing = false;
  readonly board: {projectId: number; columnId: number} | undefined;
  readonly prefill: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private done = false;
  private readonly app: App;

  constructor(app: App, initialRepo: number, board?: {projectId: number; columnId: number}, title?: string) {
    this.app = app;
    this.board = board;
    this.prefill = title?.trim() ?? '';
    // Built while the dialog renders, so the scans stay untracked; the activity scan (every issue and comment) runs
    // only when no known repository applies.
    const repos = untracked(() => repoChoices(app, board));
    const ok = (id: number) => id > 0 && repos.some((r) => r.id === id);
    const last = lastRepo();
    this.repoId = ok(initialRepo) ? initialRepo : ok(last) ? last : untracked(() => recentActivityRepo(app, repos)) || (repos[0]?.id ?? 0);
    const draft = textDraft(app, this.repoId);
    this.title = this.prefill || draft.title;
    this.body = draft.body;
    this.restored = draft.restored;
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
    const theirs = textDraft(this.app, id);
    if (theirs.restored) {
      this.flush();
      this.title = theirs.title;
      this.body = theirs.body;
      this.restored = true;
    } else {
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
    const scope = exclusiveScope(l);
    const keep = scope ? this.labels.filter((x) => {
      const other = all.find((y) => y.id === x);
      return !other || exclusiveScope(other) !== scope;
    }) : this.labels;
    this.labels = [...keep, l.id];
  }

  private keep(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.flush();
    }, 400);
  }

  discard(): void {
    clearTimeout(this.timer);
    void editing(this.app).intents.discardDraft(draftKey(this.repoId));
    void editing(this.app).intents.discardDraft(templateDraftKey(this.repoId));
    this.values = initialValues(this.template?.body ?? []);
    this.title = '';
    this.body = '';
    this.restored = false;
  }

  /** Flush before closing so the debounce cannot lose the draft. */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.done) return;
    const {intents} = editing(this.app);
    if (!this.choosing && this.template) void intents.keepText({key: templateDraftKey(this.repoId), title: 'Issue template draft', issueId: 0, repoId: this.repoId, text: JSON.stringify({file: this.template.file_name, values: this.values, labels: this.labels, assignees: this.assignees})});
    if (!this.title.trim() && !this.body.trim()) void intents.discardDraft(draftKey(this.repoId));
    else void intents.keepText({key: draftKey(this.repoId), title: 'A new issue', issueId: 0, repoId: this.repoId, text: `${this.title}\n\n${this.body}`});
  }

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
    // Forgejo drops issue properties submitted without write access.
    const s = this.app.session;
    const writable = s !== undefined && canWrite(s, this.repoId);
    intents.submit({
      kind: 'issue.create', issueId: tempNum(tempId), repoId: this.repoId, tempId, title: t, body: this.body, labelIds: writable ? [...this.labels] : [],
      assigneeIds: writable ? [...this.assignees] : [], milestoneId: writable ? this.milestone : 0,
    });
    // Project assignment waits for creation to supply the server issue number.
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
  if (!set) return <p className="text-sm text-muted" role="status">Loading issue templates…</p>;
  const choices: TemplateChoice[] = set.templates.map((t) => ({id: t.file_name, text: t.name, description: t.about, descriptionVariant: 'block', onAction: () => { form.choose(t); }}));
  if (set.config.blank_issues_enabled) choices.push({id: '', text: 'Blank issue', onAction: () => { form.choose(); }});
  const q = filter.toLocaleLowerCase();
  const items = choices.filter((c) => `${c.text} ${c.description ?? ''}`.toLocaleLowerCase().includes(q));
  return <div className="flex flex-col gap-2">
    <p className="text-sm text-muted">Choose an issue template</p>
    {set.note && <p className="text-sm text-muted">{set.note}</p>}
    <FilteredActionList aria-label="Issue templates" items={items} filterValue={filter} onFilterChange={setFilter} placeholderText="Find a template…"
      textInputProps={{'aria-label': 'Issue templates', autoFocus: true}}
      {...(items.length ? {} : {message: <p className="p-2 text-sm text-muted">No matching templates</p>, messageText: {title: 'No matching templates', description: ''}})}/>
    {set.config.contact_links.filter((l) => /^https?:\/\//i.test(l.url)).map((l) => <div key={l.url}>
      <LinkButton variant="invisible" href={l.url} target="_blank" rel="noopener noreferrer">{l.name}↗</LinkButton>
      <p className="text-sm text-muted">{l.about}</p>
    </div>)}
    <Properties form={form}/>
  </div>;
});

interface TemplateChoice {id: string; text: string; description?: string; descriptionVariant?: 'block'; onAction: () => void}

const Fields = observer(function Fields({form, onCreate, onClose}: {form: Form; onCreate: () => void; onClose: () => void}) {
  const app = useApp();
  useEffect(() => () => {
    form.flush();
  }, [form]);
  if (!repoChoices(app, form.board).length) {
    return <p className="text-base text-muted">{form.board ?
      'No repository whose issues this board can hold is on this device: a board takes the issues of its owner\'s repositories.' :
      'No repository is on this device yet: issues are created in one.'}</p>;
  }
  return (
    <div className="flex flex-col gap-4" onKeyDownCapture={(e) => {
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
    <TextInput placeholder="Issue title" value={form.title} autoFocus className="w-full" maxLength={255} onChange={(e) => {
        form.setTitle(e.target.value);
      }} onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onCreate();
        }
      }}/>
    {missing && <FormControl.Validation variant="error">An issue needs a title.</FormControl.Validation>}
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

/** Observe properties separately from text; hide write-only properties that Forgejo would drop. */
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
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilteredSelect title="Repository" placeholder="Repository" placeholderText="Create in the repository…"
        message={{title: 'No repository is on this device.', body: '', variant: 'empty'}}
        items={repos.map((r) => ({id: r.id, text: r.name}))}
        selected={repo ? {id: repoId, text: repo.full_name} : undefined}
        onSelectedChange={(item) => { if (item) form.setRepo(Number(item.id)); }}
        renderAnchor={(props) => cloneElement(<Button size="small" leadingVisual={RepoIcon} type="button">{repo?.full_name ?? 'Repository'}</Button>, props)}/>
      {writable ? <>
        <KindChip form={form} kind="status" labels={ofKind('status')}/>
        <KindChip form={form} kind="priority" labels={ofKind('priority')}/>
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
      <Button variant="invisible" size="small" type="button" onClick={onCancel}>Cancel</Button>
      {/* aria-disabled, not disabled: the tooltip (with ⌘↵) still shows and says what is missing. */}
      {!form.choosing && <Tooltip text={uploading ? 'Wait for the attachments to finish uploading.' : ready ? 'Create the issue (works offline)' : 'Add a title first'} keybindingHint={shortcutHint('submit')}><Button variant="primary" size="small" type="button" aria-disabled={!ready} onClick={onCreate}>
        Create issue
      </Button></Tooltip>}
    </>
  );
});

const BoardHint = observer(function BoardHint({board}: {board: {projectId: number; columnId: number}}) {
  const pool = usePool();
  const project = pool.model('Project').get(board.projectId)?.get('title');
  const column = pool.model('ProjectColumn').get(board.columnId)?.get('title');
  return project ? <span>On {project}{column ? ` · ${column}` : ''}.</span> : null;
});
