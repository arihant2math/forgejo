// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The new-issue dialog (C anywhere; PLAN §5.4: creating works offline). The
// issue appears at once under a temporary id (its page is
// /{owner}/{repo}/issues/new-<tempId>) and gets Forgejo's number when the
// queue sends it — the page's URL is then replaced (IssueView). Title,
// description (the markdown composer), labels (status and priority are
// exclusive scoped labels), assignee and milestone; ⌘↵ creates. What is
// typed is kept as a draft until it is created or discarded.

import {useNavigate} from '@tanstack/react-router';
import {BookMarked, Milestone as MilestoneIcon, Tag, User} from 'lucide-react';
import {runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {useEffect, useRef, useState} from 'react';
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

/** The repositories on this device the viewer can open issues in (not archived), by name. */
function repoChoices(app: App): {id: number; name: string}[] {
  const pool = app.session?.data.pool;
  if (!pool) return [];
  return [...pool.model('Repository').all()].map((e) => e.data).filter((r) => !r.archived)
    .map((r) => ({id: r.id, name: r.full_name})).sort((a, b) => a.name.localeCompare(b.name));
}

export const CreateIssue = observer(function CreateIssue() {
  const app = useApp();
  const req = app.ui.create;
  const close = () => {
    runInAction(() => {
      app.ui.create = undefined;
    });
  };
  // A fresh form for each opening (the draft brings the text back).
  const [n, setN] = useState(0);
  const [wasOpen, setWasOpen] = useState(false);
  if (Boolean(req) !== wasOpen) {
    setWasOpen(Boolean(req));
    if (req) setN(n + 1);
  }
  return (
    <Dialog open={Boolean(req)} onOpenChange={(o) => {
      if (!o) close();
    }} title="New issue" size="lg">
      {req && <CreateForm key={n} initialRepo={req.repoId || lastRepo()} onDone={close}/>}
    </Dialog>
  );
});

const CreateForm = observer(function CreateForm({initialRepo, onDone}: {initialRepo: number; onDone: () => void}) {
  const app = useApp();
  const {userId} = useSession();
  const pool = usePool();
  const navigate = useNavigate();
  const {intents} = editing(app);
  const repos = repoChoices(app);
  const [repoId, setRepoId] = useState(() => (repos.some((r) => r.id === initialRepo) ? initialRepo : repos[0]?.id ?? 0));
  const draftKey = `text:new-issue:${String(repoId)}`;
  const [restored] = useState(() => untracked(() => intents.drafts.get(draftKey)));
  const [title, setTitle] = useState(() => (restored?.text ?? '').split('\n')[0] ?? '');
  const [body, setBody] = useState(() => (restored?.text ?? '').split('\n').slice(2).join('\n'));
  const [labels, setLabels] = useState<number[]>([]);
  const [assignee, setAssignee] = useState(0);
  const [milestone, setMilestone] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const done = useRef(false);
  useEffect(() => () => {
    clearTimeout(timer.current);
  }, []);
  // Kept while typing (a reload or a crash never loses it), like every editor.
  const keep = (t: string, b: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (done.current) return;
      if (!t.trim() && !b.trim()) void intents.discardDraft(draftKey);
      else void intents.keepText({key: draftKey, title: 'A new issue', issueId: 0, repoId, text: `${t}\n\n${b}`});
    }, 400);
  };
  const repo = pool.model('Repository').get(repoId)?.data;
  const allLabels = repoId ? repoLabels(pool, repoId) : [];
  const people = repoId ? assigneeCandidates(pool, repoId, userId).map((id) => pool.model('User').get(id)?.data).filter((u) => u !== undefined)
    .sort((a, b) => a.login.localeCompare(b.login)) : [];
  const milestones = repoId ? [...pool.model('Milestone').by('repo_id', repoId)].map((m) => m.data).filter((m) => m.state === 'open')
    .sort((a, b) => a.title.localeCompare(b.title)) : [];
  const toggleLabel = (l: Label, on: boolean) => {
    setLabels((cur) => {
      if (!on) return cur.filter((x) => x !== l.id);
      // An exclusive scoped label replaces its siblings (status, priority), as Forgejo does.
      const scope = exclusiveScope(l);
      const keep = scope ? cur.filter((x) => {
        const other = allLabels.find((y) => y.id === x);
        return !other || exclusiveScope(other) !== scope;
      }) : cur;
      return [...keep, l.id];
    });
  };
  const create = () => {
    const t = title.trim();
    if (!t || !repo) return;
    done.current = true;
    clearTimeout(timer.current);
    void intents.discardDraft(draftKey);
    const tempId = uuid();
    runInAction(() => {
      intents.submit({
        kind: 'issue.create', issueId: tempNum(tempId), repoId, tempId, title: t, body, labelIds: labels,
        assigneeIds: assignee ? [assignee] : [], milestoneId: milestone,
      });
    });
    rememberRepo(repoId);
    onDone();
    void navigate({to: tempIssuePath(repo.owner_name, repo.name, tempId)});
  };
  const chosenLabels = allLabels.filter((l) => labels.includes(l.id));
  const who = people.find((u) => u.id === assignee);
  const ms = milestones.find((m) => m.id === milestone);
  if (!repos.length) return <p className="text-base text-fg-muted">No repository is on this device yet: issues are created in one.</p>;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1">
        <Menu>
          <MenuTrigger asChild><Button size="sm" variant="secondary" icon={BookMarked}>{repo?.full_name ?? 'Repository'}</Button></MenuTrigger>
          <MenuContent>
            <MenuRadioGroup value={String(repoId)} onValueChange={(v) => {
              setRepoId(Number(v));
              setLabels([]);
              setAssignee(0);
              setMilestone(0);
            }}>
              {repos.map((r) => <MenuRadioItem key={r.id} value={String(r.id)}>{r.name}</MenuRadioItem>)}
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
      </div>
      <Input aria-label="Title" placeholder="Issue title" value={title} autoFocus className="w-full" maxLength={255}
        onChange={(e) => {
          setTitle(e.target.value);
          keep(e.target.value, body);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            create();
          }
        }}/>
      <MarkdownField repoId={repoId} label="Description" placeholder="Add a description…" value={body} rows={6}
        onChange={(b) => {
          setBody(b);
          keep(title, b);
        }} onSubmit={create}/>
      <div className="flex flex-wrap items-center gap-1">
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm" variant={chosenLabels.length ? 'secondary' : 'ghost'} icon={Tag} tooltip="Labels, status and priority">
              {chosenLabels.length ? chosenLabels.map((l) => l.name).join(', ') : 'Labels'}
            </Button>
          </MenuTrigger>
          <MenuContent>
            {allLabels.length === 0 && <MenuItem disabled>No labels</MenuItem>}
            {allLabels.map((l) => (
              <MenuCheckboxItem key={l.id} checked={labels.includes(l.id)} onSelect={(e) => {
                e.preventDefault();
              }} onCheckedChange={(on) => {
                toggleLabel(l, on);
              }}>
                <span className="flex min-w-0 items-center gap-2"><LabelDot color={l.color}/><span className="truncate">{l.name}</span></span>
              </MenuCheckboxItem>
            ))}
          </MenuContent>
        </Menu>
        <Menu>
          <MenuTrigger asChild><Button size="sm" variant={who ? 'secondary' : 'ghost'} icon={User}>{who?.login ?? 'Assignee'}</Button></MenuTrigger>
          <MenuContent>
            <MenuRadioGroup value={String(assignee)} onValueChange={(v) => {
              setAssignee(Number(v));
            }}>
              <MenuRadioItem value="0">Nobody</MenuRadioItem>
              {people.map((u) => <MenuRadioItem key={u.id} value={String(u.id)}>{u.id === userId ? `${u.login} (you)` : u.login}</MenuRadioItem>)}
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
        <Menu>
          <MenuTrigger asChild><Button size="sm" variant={ms ? 'secondary' : 'ghost'} icon={MilestoneIcon}>{ms?.title ?? 'Milestone'}</Button></MenuTrigger>
          <MenuContent>
            <MenuRadioGroup value={String(milestone)} onValueChange={(v) => {
              setMilestone(Number(v));
            }}>
              <MenuRadioItem value="0">No milestone</MenuRadioItem>
              {milestones.map((m) => <MenuRadioItem key={m.id} value={String(m.id)}>{m.title}</MenuRadioItem>)}
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
        <span className="ml-auto text-sm text-fg-subtle">{connectivity.online ? '' : 'Offline: it syncs when you are back.'}</span>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
        <Button variant="primary" shortcut={shortcutHint('submit')} tooltip="Create the issue (works offline)" disabled={!title.trim() || !repo} onClick={create}>
          Create issue
        </Button>
      </div>
    </div>
  );
});
