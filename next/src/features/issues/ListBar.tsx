// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A list's view controls, in the page header (one line, so the page has the
// boot shell's shape): open / closed / all, a search over titles, filters
// (labels, assignee, author, milestone; the filters in effect are listed in
// the menu with a way to drop each) and display options (grouping,
// ordering). Everything lives in the URL's search params (search.ts), so a
// view is a link; the list recomputes locally on every change.

import {useNavigate} from '@tanstack/react-router';
import {ListFilter, Rows3, Search, Tag, User, UserPen, X, Milestone as MilestoneIcon} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {useEffect, useRef, useState} from 'react';
import {type ListGroup, type ListSearch, type ListSort, type ListState, parseLabels} from '../../app/search.ts';
import type {IssueListModel} from './list.ts';
import {useApp} from '../../app/store.ts';
import {
  Button, Input, LabelDot, Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator,
  MenuSub, MenuTrigger,
} from '../../ui/index.ts';
import {usePool} from './cells.tsx';
import {assigneeCandidates, repoLabels} from './candidates.ts';

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
    const next = Object.fromEntries(Object.entries({...model.search, ...patch}).filter(([, v]) => v !== undefined && v !== '')) as ListSearch;
    model.setSearch(next);
    if (url) updateUrl(next);
  };
  const updateUrl = (next: ListSearch) => {
    void navigate({
      to: '.',
      replace: true,
      search: (prev: Record<string, unknown>) => ({...Object.fromEntries(Object.entries(prev).filter(([k]) => !LIST_KEYS.has(k))), ...next}),
    });
  };
  const {state, group, sort} = {state: search.state ?? 'open', group: model.query.group, sort: model.query.sort};
  const setState = (s: ListState) => {
    set({state: s === 'open' ? undefined : s});
  };
  return (
    <>
      {stateButtons && STATES.map((s) => (
        <Button key={s.state} size="sm" variant={state === s.state ? 'secondary' : 'ghost'} aria-pressed={state === s.state} onClick={() => {
          setState(s.state);
        }}>{s.label}</Button>
      ))}
      <SearchField value={search.q ?? ''} onChange={(q) => {
        // The list filters as you type; the URL follows a moment later.
        set({q: q.trim() ? q : undefined}, false);
      }} onSettle={() => {
        updateUrl(model.search);
      }}/>
      <FilterMenu search={search} repoId={repoId} set={set}/>
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" variant="ghost" icon={Rows3}>Display</Button>
        </MenuTrigger>
        <MenuContent>
          {!stateButtons && (
            <>
              <MenuLabel>Show</MenuLabel>
              <MenuRadioGroup value={state} onValueChange={(v) => {
                setState(v as ListState);
              }}>
                {STATES.map((s) => <MenuRadioItem key={s.state} value={s.state}>{s.label}</MenuRadioItem>)}
              </MenuRadioGroup>
              <MenuSeparator/>
            </>
          )}
          <MenuLabel>Grouping</MenuLabel>
          <MenuRadioGroup value={group} onValueChange={(g) => {
            set({group: g});
          }}>
            {GROUPS.filter((g) => !hideGroups.includes(g.group)).map((g) => <MenuRadioItem key={g.group} value={g.group}>{g.label}</MenuRadioItem>)}
          </MenuRadioGroup>
          <MenuSeparator/>
          <MenuLabel>Ordering</MenuLabel>
          <MenuRadioGroup value={sort} onValueChange={(v) => {
            set({sort: v === 'newest' ? undefined : v});
          }}>
            {SORTS.map((s) => <MenuRadioItem key={s.sort} value={s.sort}>{s.label}</MenuRadioItem>)}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
    </>
  );
});

/** The search params a list's view owns (others, like the "my" list's type, are kept). */
const LIST_KEYS = new Set(['state', 'q', 'labels', 'milestone', 'assignee', 'poster', 'sort', 'group']);

/** The title search: the list filters on every keystroke (onChange); the URL follows when typing pauses (onSettle). */
function SearchField({value, onChange, onSettle}: {value: string; onChange: (q: string) => void; onSettle: () => void}) {
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
    <Input size="sm" icon={Search} type="search" aria-label="Search titles" placeholder="Search…" value={text} className="ml-1 w-48"
      onChange={(e) => {
        change(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && text) {
          e.stopPropagation();
          change('');
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
  return out;
}

const FilterMenu = observer(function FilterMenu({search, repoId, set}: {search: ListSearch; repoId: number | undefined; set: Setter}) {
  const pool = usePool();
  const app = useApp();
  const me = app.session?.userId ?? 0;
  const active = activeFilters(pool, search, set);
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="sm" variant={active.length ? 'secondary' : 'ghost'} icon={ListFilter}>
          {active.length ? `Filter · ${String(active.length)}` : 'Filter'}
        </Button>
      </MenuTrigger>
      <MenuContent>
        {active.length > 0 && (
          <>
            <MenuLabel>In effect</MenuLabel>
            {active.map((f) => <MenuItem key={f.key} icon={X} onSelect={f.clear}>{f.label}</MenuItem>)}
            {active.length > 1 && <MenuItem onSelect={() => {
              set({labels: undefined, assignee: undefined, poster: undefined, milestone: undefined});
            }}>Clear all filters</MenuItem>}
            <MenuSeparator/>
          </>
        )}
        {repoId === undefined ?
          active.length === 0 && <MenuItem disabled>Filters by label, assignee and milestone work in a repository’s list</MenuItem> :
          <RepoFilters search={search} repoId={repoId} me={me} set={set}/>}
      </MenuContent>
    </Menu>
  );
});

const RepoFilters = observer(function RepoFilters({search, repoId, me, set}: {search: ListSearch; repoId: number; me: number; set: Setter}) {
  const pool = usePool();
  const labels = repoLabels(pool, repoId);
  const chosen = new Set(parseLabels(search.labels));
  const users = assigneeCandidates(pool, repoId, me).map((id) => pool.model('User').get(id)?.data).filter((u) => u !== undefined)
    .sort((a, b) => a.login.localeCompare(b.login));
  const milestones = [...pool.model('Milestone').by('repo_id', repoId)].map((m) => m.data).sort((a, b) => a.title.localeCompare(b.title));
  const toggleLabel = (id: number, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    set({labels: [...next].join(',') || undefined});
  };
  return (
    <>
      <MenuSub label="Labels" icon={Tag}>
        {labels.length === 0 && <MenuItem disabled>No labels</MenuItem>}
        {labels.map((l) => (
          <MenuCheckboxItem key={l.id} checked={chosen.has(l.id)} onSelect={(e) => {
            e.preventDefault();
          }} onCheckedChange={(on) => {
            toggleLabel(l.id, on);
          }}>
            <span className="flex min-w-0 items-center gap-2"><LabelDot color={l.color}/><span className="truncate">{l.name}</span></span>
          </MenuCheckboxItem>
        ))}
      </MenuSub>
      <MenuSub label="Assignee" icon={User}>
        <MenuRadioGroup value={String(search.assignee ?? 0)} onValueChange={(v) => {
          set({assignee: v === '0' ? undefined : Number(v)});
        }}>
          <MenuRadioItem value="0">Anyone</MenuRadioItem>
          <MenuRadioItem value="-1">Nobody</MenuRadioItem>
          {users.map((u) => <MenuRadioItem key={u.id} value={String(u.id)}>{u.id === me ? `${u.login} (you)` : u.login}</MenuRadioItem>)}
        </MenuRadioGroup>
      </MenuSub>
      <MenuSub label="Author" icon={UserPen}>
        <MenuRadioGroup value={String(search.poster ?? 0)} onValueChange={(v) => {
          set({poster: v === '0' ? undefined : Number(v)});
        }}>
          <MenuRadioItem value="0">Anyone</MenuRadioItem>
          {users.map((u) => <MenuRadioItem key={u.id} value={String(u.id)}>{u.id === me ? `${u.login} (you)` : u.login}</MenuRadioItem>)}
        </MenuRadioGroup>
      </MenuSub>
      <MenuSub label="Milestone" icon={MilestoneIcon}>
        <MenuRadioGroup value={String(search.milestone ?? 0)} onValueChange={(v) => {
          set({milestone: v === '0' ? undefined : Number(v)});
        }}>
          <MenuRadioItem value="0">Any</MenuRadioItem>
          <MenuRadioItem value="-1">No milestone</MenuRadioItem>
          {milestones.map((m) => <MenuRadioItem key={m.id} value={String(m.id)}>{m.title}</MenuRadioItem>)}
        </MenuRadioGroup>
      </MenuSub>
    </>
  );
});
