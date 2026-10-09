// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A list's view controls, in the page header (one line, so the page has the
// boot shell's shape): open / closed / all, a search over titles, filters
// (labels, assignee, author, milestone; the filters in effect are listed in
// the menu with a way to drop each) and display options (grouping,
// ordering). Everything lives in the URL's search params (search.ts), so a
// view is a link; the list recomputes locally on every change.

import {useLocation, useNavigate, useSearch} from '@tanstack/react-router';
import {FolderGit2, Layers, ListFilter, Rows3, Search, User, UserPen, X, Milestone as MilestoneIcon} from 'lucide-react';
import {untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type RefObject, useEffect, useRef, useState} from 'react';
import {afterPaint} from '../../app/paint.ts';
import {viewChange} from '../../app/shell/Frame.tsx';
import {type ListGroup, type ListSearch, type ListSort, type ListState, parseLabels} from '../../app/search.ts';
import type {IssueListModel} from './list.ts';
import {shortcutHint, useShortcut} from '../../app/shortcuts/index.ts';
import {useApp, useSession} from '../../app/store.ts';
import {SaveViewDialog} from '../views/SaveView.tsx';
import {viewStore} from '../views/views.ts';
import {
  Avatar, Badge, Button, CommandPopover, Icon, Input, LabelDot, LabelIcon, Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator,
  MenuTrigger, type PickOption,
} from '../../ui/index.ts';
import {ResultCount, SelectionCount, usePool} from './cells.tsx';
import {repoLabels} from './candidates.ts';
import {priorityIcon, statusIcon} from './cells.tsx';
import {kindRank, labelKind, scopedValue} from './labels.ts';
import type {Label} from '../../protocol/types.gen.ts';
import {loadPeople, repoPeople} from './people.ts';

const STATES: {state: ListState; label: string}[] = [{state: 'open', label: 'Open'}, {state: 'closed', label: 'Closed'}, {state: 'all', label: 'All'}];

const GROUPS: {group: ListGroup; label: string}[] = [
  {group: 'none', label: 'No grouping'}, {group: 'status', label: 'Status'}, {group: 'priority', label: 'Priority'},
  {group: 'assignee', label: 'Assignee'}, {group: 'milestone', label: 'Milestone'}, {group: 'repo', label: 'Repository'},
];

const SORTS: {sort: ListSort; label: string}[] = [
  {sort: 'newest', label: 'Newest'}, {sort: 'oldest', label: 'Oldest'}, {sort: 'recentupdate', label: 'Recently updated'},
  {sort: 'leastupdate', label: 'Least recently updated'}, {sort: 'priority', label: 'Priority'}, {sort: 'mostcomment', label: 'Most commented'},
  {sort: 'leastcomment', label: 'Least commented'}, {sort: 'nearduedate', label: 'Due soonest'}, {sort: 'farduedate', label: 'Due latest'},
];

export interface ListControlsProps {
  model: IssueListModel;
  /** The repository whose labels, people and milestones the filters offer (repository lists). */
  repoId?: number | undefined;
  /** Groupings that make no sense here (by repository in one repository). */
  hideGroups?: readonly ListGroup[];
  /** Open / closed / all as buttons (else in the Display menu: the header has less room). */
  stateButtons?: boolean;
}

/** The view controls; they change the list at once (the model) and then the URL. */
export const ListControls = observer(function ListControls({model, repoId, hideGroups = [], stateButtons = true}: ListControlsProps) {
  const navigate = useNavigate();
  const search = model.search;
  const set = (patch: Partial<Record<keyof ListSearch, string | number | undefined>>, url = true) => {
    const keep = url ? viewChange() : undefined;
    const next = Object.fromEntries(Object.entries({...model.search, ...patch}).filter(([, v]) => v !== undefined && v !== '')) as ListSearch;
    model.setSearch(next);
    if (url) updateUrl(next, keep);
  };
  const updateUrl = (next: ListSearch, keep?: {resetScroll: false}) => {
    model.pushed = next;
    void navigate({
      to: '.',
      replace: true,
      ...keep,
      search: (prev: Record<string, unknown>) => ({...Object.fromEntries(Object.entries(prev).filter(([k]) => !LIST_KEYS.has(k))), ...next}),
    });
  };
  const {state, group, sort} = {state: search.state ?? 'open', group: model.query.group, sort: model.query.sort};
  const setState = (s: ListState) => {
    set({state: s === 'open' ? undefined : s});
  };
  // Saving the view (Shift+V): this page with its search params, the "my" lists' type included.
  const {userId} = useSession();
  const path = useLocation({select: (l) => l.pathname});
  const type = useSearch({strict: false, select: (s: Record<string, unknown>) => (typeof s.type === 'string' ? s.type : undefined)});
  const viewSearch = {...search, ...(type ? {type} : {})};
  const [saving, setSaving] = useState(false);
  useShortcut('view.save', () => {
    setSaving(true);
  });
  const saved = viewStore(userId).match(path, viewSearch);
  // "/" searches the list (Linear, GitHub).
  const searchRef = useRef<HTMLInputElement>(null);
  useShortcut('list.search', () => {
    searchRef.current?.focus();
    searchRef.current?.select();
  });
  // Display marks a grouping or an ordering other than the list's default (the list looks different for a reason).
  const modified = search.group !== undefined || search.sort !== undefined;
  return (
    <>
      {saving && <SaveViewDialog path={path} search={viewSearch} onClose={() => {
        setSaving(false);
      }}/>}
      {saved && <Badge><Icon icon={Layers} size="sm"/>{saved.name}</Badge>}
      <SelectionCount cursor={model.cursor}/>
      <ResultCount model={model}/>
      {stateButtons && STATES.map((s) => (
        <Button key={s.state} size="sm" pressed={state === s.state} onClick={() => {
          setState(s.state);
        }}>{s.label}</Button>
      ))}
      <SearchField inputRef={searchRef} value={search.q ?? ''} onChange={(q) => {
        // The list filters as you type; the URL follows a moment later.
        set({q: q.trim() ? q : undefined}, false);
      }} onSettle={() => {
        updateUrl(model.search, viewChange());
      }}/>
      <FilterMenu search={search} repoId={repoId} set={set}/>
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" variant="ghost" icon={Rows3} pressed={modified} aria-label={modified ? 'Display (changed)' : 'Display'}>Display</Button>
        </MenuTrigger>
        <MenuContent>
          {!stateButtons && (
            <>
              <MenuLabel>Show</MenuLabel>
              <MenuRadioGroup value={state} onValueChange={(v) => {
                afterPaint(() => {
                  setState(v as ListState);
                });
              }}>
                {STATES.map((s) => <MenuRadioItem key={s.state} value={s.state}>{s.label}</MenuRadioItem>)}
              </MenuRadioGroup>
              <MenuSeparator/>
            </>
          )}
          <MenuLabel>Grouping</MenuLabel>
          {/* The menu closes first; the list regroups or reorders after that frame (a long list takes a while). */}
          <MenuRadioGroup value={group} onValueChange={(g) => {
            afterPaint(() => {
              set({group: g});
            });
          }}>
            {GROUPS.filter((g) => !hideGroups.includes(g.group)).map((g) => <MenuRadioItem key={g.group} value={g.group}>{g.label}</MenuRadioItem>)}
          </MenuRadioGroup>
          <MenuSeparator/>
          <MenuLabel>Ordering</MenuLabel>
          <MenuRadioGroup value={sort} onValueChange={(v) => {
            afterPaint(() => {
              set({sort: v === 'newest' ? undefined : v});
            });
          }}>
            {SORTS.map((s) => <MenuRadioItem key={s.sort} value={s.sort}>{s.label}</MenuRadioItem>)}
          </MenuRadioGroup>
          <MenuSeparator/>
          <MenuItem icon={Layers} shortcut={shortcutHint('view.save')} onSelect={() => {
            setSaving(true);
          }}>Save view…</MenuItem>
        </MenuContent>
      </Menu>
    </>
  );
});

/** The search params a list's view owns (others, like the "my" list's type, are kept). */
const LIST_KEYS = new Set(['state', 'q', 'labels', 'milestone', 'assignee', 'poster', 'sort', 'group', 'status', 'priority', 'label', 'repo']);

/** The title search: the list filters on every keystroke (onChange); the URL follows when typing pauses (onSettle). */
function SearchField({inputRef, value, onChange, onSettle}: {inputRef: RefObject<HTMLInputElement | null>; value: string; onChange: (q: string) => void; onSettle: () => void}) {
  const [text, setText] = useState(value);
  const settle = useRef(onSettle);
  useEffect(() => {
    settle.current = onSettle;
  });
  // The URL may change from elsewhere (back button, a link).
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setText(value);
  }
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => {
    clearTimeout(timer.current);
  }, []);
  const change = (q: string) => {
    setText(q);
    setSeen(q);
    onChange(q);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      settle.current();
    }, 300);
  };
  return (
    <Input ref={inputRef} size="sm" icon={Search} type="search" aria-label="Search titles" placeholder="Search…" aria-keyshortcuts="/" value={text} className="ml-1 w-48 min-w-24 shrink"
      onChange={(e) => {
        change(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && text) {
          e.stopPropagation();
          change('');
        } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
          // On to the results: the list takes the focus (its cursor on the first row); Enter opens that row.
          const list = document.querySelector<HTMLElement>('main [role="listbox"]');
          if (!list) return;
          e.preventDefault();
          list.focus();
          if (e.key === 'Enter') list.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
        }
      }}/>
  );
}

type Setter = (patch: Partial<Record<keyof ListSearch, string | number | undefined>>) => void;

interface ActiveFilter {
  key: string;
  label: string;
  clear: () => void;
}

/** The filters in effect, each with a way to drop it. Observes the names it shows. */
function activeFilters(pool: ReturnType<typeof usePool>, search: ListSearch, set: Setter): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  const labels = parseLabels(search.labels);
  for (const id of labels) {
    const name = pool.model('Label').get(Math.abs(id))?.get('name') ?? `#${String(Math.abs(id))}`;
    out.push({key: `l${String(id)}`, label: id < 0 ? `Label is not ${name}` : `Label: ${name}`, clear: () => {
      set({labels: labels.filter((x) => x !== id).join(',') || undefined});
    }});
  }
  const user = (id: number) => pool.model('User').get(id)?.get('login') ?? `#${String(id)}`;
  if (search.assignee !== undefined) out.push({key: 'a', label: search.assignee === -1 ? 'Unassigned' : `Assignee: ${user(search.assignee)}`, clear: () => {
    set({assignee: undefined});
  }});
  if (search.poster !== undefined) out.push({key: 'p', label: `Author: ${user(search.poster)}`, clear: () => {
    set({poster: undefined});
  }});
  if (search.milestone !== undefined) {
    const t = search.milestone === -1 ? 'No milestone' : `Milestone: ${pool.model('Milestone').get(search.milestone)?.get('title') ?? `#${String(search.milestone)}`}`;
    out.push({key: 'm', label: t, clear: () => {
      set({milestone: undefined});
    }});
  }
  if (search.status !== undefined) out.push({key: 's', label: `Status: ${search.status}`, clear: () => {
    set({status: undefined});
  }});
  if (search.priority !== undefined) out.push({key: 'r', label: `Priority: ${search.priority}`, clear: () => {
    set({priority: undefined});
  }});
  if (search.label !== undefined) out.push({key: 'n', label: `Label: ${search.label}`, clear: () => {
    set({label: undefined});
  }});
  if (search.repo !== undefined) out.push({key: 'o', label: `Repository: ${pool.model('Repository').get(search.repo)?.get('full_name') ?? `#${String(search.repo)}`}`, clear: () => {
    set({repo: undefined});
  }});
  return out;
}

/**
 * The viewer's lists across repositories: a label by name (the same name in every repository), a repository, an
 * author (the viewer first, then everyone whose issues are on this device).
 */
function workspaceFilters(pool: ReturnType<typeof usePool>, search: ListSearch, me: number, set: Setter): PickOption[] {
  const out: PickOption[] = [];
  const names = new Map<string, Label>();
  for (const e of pool.model('Label').all()) {
    const l = e.data;
    if (labelKind(l)) continue;
    const key = l.name.toLowerCase();
    if (!names.has(key)) names.set(key, l);
  }
  const current = search.label?.toLowerCase();
  for (const [key, l] of [...names].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push({value: `n:${key}`, label: l.name, words: 'label', group: 'Labels', leading: <LabelDot color={l.color}/>, checked: current === key, onSelect: () => {
      set({label: current === key ? undefined : l.name});
    }});
  }
  const repos = [...pool.model('Repository').all()].map((e) => e.data).sort((a, b) => a.full_name.localeCompare(b.full_name));
  for (const r of repos) {
    out.push({value: `o:${String(r.id)}`, label: r.full_name, words: 'repository', group: 'Repository', icon: FolderGit2, checked: search.repo === r.id, onSelect: () => {
      set({repo: search.repo === r.id ? undefined : r.id});
    }});
  }
  const posters = new Set<number>();
  for (const e of pool.model('Issue').all()) posters.add(e.data.poster_id);
  const users = [...posters].map((id) => pool.model('User').get(id)?.data).filter((u) => u !== undefined)
    .sort((a, b) => Number(b.id === me) - Number(a.id === me) || a.login.localeCompare(b.login));
  for (const u of users) {
    out.push({value: `p:${String(u.id)}`, label: u.id === me ? `${u.login} (you)` : u.login, words: `author ${u.full_name}`, group: 'Author', icon: UserPen,
      checked: search.poster === u.id, onSelect: () => {
        set({poster: search.poster === u.id ? undefined : u.id});
      }});
  }
  return out;
}

/**
 * The statuses and priorities to filter by, by value (the same in every repository): a repository's, or every
 * one on this device for the viewer's lists; in their workflow (urgency) order, each value once.
 */
function kindFilters(pool: ReturnType<typeof usePool>, search: ListSearch, repoId: number | undefined, set: Setter): PickOption[] {
  const labels = repoId === undefined ? [...pool.model('Label').all()].map((l) => l.data) : repoLabels(pool, repoId);
  const out: PickOption[] = [];
  for (const kind of ['status', 'priority'] as const) {
    const seen = new Map<string, Label>();
    for (const l of labels.filter((x) => labelKind(x) === kind).sort((a, b) => kindRank(kind, a.name) - kindRank(kind, b.name))) {
      const v = scopedValue(l.name);
      if (!seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), l);
    }
    const current = search[kind]?.toLowerCase();
    for (const [key, l] of seen) {
      const v = scopedValue(l.name);
      out.push({
        value: `${kind}:${key}`, label: v, words: kind, group: kind === 'status' ? 'Status' : 'Priority', checked: current === key,
        leading: <LabelIcon icon={kind === 'status' ? statusIcon(l.name) : priorityIcon(l.name)} color={l.color}/>,
        onSelect: () => {
          set({[kind]: current === key ? undefined : v});
        },
      });
    }
  }
  return out;
}

/**
 * The filters: one picker over every value (labels, assignee, author, milestone) that filters as you type
 * ("alice", "bug"), the filters in effect first (choosing one drops it). Labels stay open for more.
 */
const FilterMenu = observer(function FilterMenu({search, repoId, set}: {search: ListSearch; repoId: number | undefined; set: Setter}) {
  const pool = usePool();
  const app = useApp();
  const me = app.session?.userId ?? 0;
  const active = activeFilters(pool, search, set);
  const options: PickOption[] = active.map((f) => ({value: `x:${f.key}`, label: f.label, group: 'In effect', icon: X, onSelect: f.clear}));
  if (active.length > 1) options.push({value: 'x:all', label: 'Clear all filters', group: 'In effect', icon: X, onSelect: () => {
    set({labels: undefined, assignee: undefined, poster: undefined, milestone: undefined, status: undefined, priority: undefined, label: undefined, repo: undefined});
  }});
  // Status and priority everywhere (by value); labels, people and milestones in a repository's list.
  options.push(...kindFilters(pool, search, repoId, set));
  if (repoId !== undefined) options.push(...repoFilters(pool, search, repoId, me, set));
  // Read untracked: the menu does not re-render on every issue of the workspace (it is built again when it renders).
  else options.push(...untracked(() => workspaceFilters(pool, search, me, set)));
  return (
    <CommandPopover label="Filter" placeholder={repoId === undefined ? 'Filter by status, label, repository or author…' : 'Filter by status, label, person or milestone…'}
      width="md" options={options} empty="Nothing to filter by is on this device."
      onOpenChange={(open) => {
        if (open && repoId !== undefined) loadPeople(app, repoId);
      }}
      trigger={
        // The filter in effect by name ("Label: bug"), the others counted.
        <Button size="sm" variant={active.length ? 'secondary' : 'ghost'} icon={ListFilter}>
          <span className="max-w-xs truncate">{active[0] ? `${active[0].label}${active.length > 1 ? ` +${String(active.length - 1)}` : ''}` : 'Filter'}</span>
        </Button>
      }/>
  );
});

/** The values a repository's list filters by, grouped (observes the repository's labels, people and milestones). */
function repoFilters(pool: ReturnType<typeof usePool>, search: ListSearch, repoId: number, me: number, set: Setter): PickOption[] {
  const chosen = new Set(parseLabels(search.labels));
  const users = repoPeople(pool, repoId, me).sort((a, b) => a.login.localeCompare(b.login));
  const milestones = [...pool.model('Milestone').by('repo_id', repoId)].map((m) => m.data).sort((a, b) => a.title.localeCompare(b.title));
  // Status and priority labels are their own groups (kindFilters).
  const out: PickOption[] = repoLabels(pool, repoId).filter((l) => !labelKind(l)).map((l) => ({
    value: `l:${String(l.id)}`, label: l.name, words: 'label', group: 'Labels', leading: <LabelDot color={l.color}/>, checked: chosen.has(l.id), keepOpen: true,
    onSelect: () => {
      const next = new Set(chosen);
      if (next.has(l.id)) next.delete(l.id);
      else next.add(l.id);
      set({labels: [...next].join(',') || undefined});
    },
  }));
  const person = (u: (typeof users)[number]) => (u.id === me ? `${u.login} (you)` : u.login);
  out.push({value: 'a:-1', label: 'Nobody', words: 'assignee unassigned', group: 'Assignee', icon: User, checked: search.assignee === -1, onSelect: () => {
    set({assignee: search.assignee === -1 ? undefined : -1});
  }});
  for (const u of users) out.push({value: `a:${String(u.id)}`, label: person(u), words: `assignee ${u.name}`, group: 'Assignee', leading: <Avatar name={u.name} src={u.avatar} size="sm"/>, checked: search.assignee === u.id, onSelect: () => {
    set({assignee: search.assignee === u.id ? undefined : u.id});
  }});
  for (const u of users) out.push({value: `p:${String(u.id)}`, label: person(u), words: `author ${u.name}`, group: 'Author', icon: UserPen, checked: search.poster === u.id, onSelect: () => {
    set({poster: search.poster === u.id ? undefined : u.id});
  }});
  out.push({value: 'm:-1', label: 'No milestone', words: 'milestone', group: 'Milestone', icon: MilestoneIcon, checked: search.milestone === -1, onSelect: () => {
    set({milestone: search.milestone === -1 ? undefined : -1});
  }});
  for (const m of milestones) out.push({value: `m:${String(m.id)}`, label: m.title, words: `milestone ${m.state === 'closed' ? 'closed' : ''}`, group: 'Milestone', icon: MilestoneIcon, checked: search.milestone === m.id, onSelect: () => {
    set({milestone: search.milestone === m.id ? undefined : m.id});
  }});
  return out;
}
