// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// View controls store filters, grouping and ordering in URL search params so views are shareable.

import {labelFill} from './labels.ts';
import {count} from '../../app/words.ts';
import {useLocation, useNavigate, useSearch} from '@tanstack/react-router';
import {untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {useState, createElement} from 'react';
import {afterPaint} from '../../app/paint.ts';
import {viewChange} from '../../app/shell/Frame.tsx';
import {type ListGroup, type ListSearch, type ListSort, type ListState, parseLabels} from '../../app/search.ts';
import type {IssueListModel} from './list.ts';
import {shortcutHint, useShortcut} from '../../app/shortcuts/index.ts';
import {useApp, useSession} from '../../app/store.ts';
import {SaveViewDialog} from '../views/SaveView.tsx';
import {type SavedView, viewStore} from '../views/views.ts';
import {notify} from '../../app/notices.ts';
import {LocalSelectPanel} from '../../components/LocalSelectPanel.tsx';
import type {PickOption} from '../../components/pickOptions.ts';
import {ViewNameDialog} from '../views/ViewNameDialog.tsx';
import {SearchField} from './SearchField.tsx';
import {LabelGlyph} from './cells.tsx';
import {UserAvatar} from './cells.tsx';
import {usePool} from '../../app/store.ts';
import {FILTER_KEYS, narrowed} from './query.ts';
import {issueActions} from './actions.ts';
import {issuesOf} from './edits.ts';
import {repoLabels} from './candidates.ts';
import {priorityIcon, statusIcon} from './cells.tsx';
import {kindRank, labelKind, scopedValue} from './labels.ts';
import type {Label} from '../../protocol/types.gen.ts';
import {loadPeople, repoPeople} from './people.ts';
import {ChevronDownIcon, RepoIcon, StackIcon, TasklistIcon, FilterIcon, PencilIcon, RowsIcon, CheckIcon, TrashIcon, PersonIcon, XIcon, MilestoneIcon} from '@primer/octicons-react';
import {IssueLabelToken, Label as PrimerLabel, SegmentedControl, Button, IconButton, ActionMenu, ActionList} from '@primer/react';

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
  repoId?: number | undefined;
  /** Omitting milestone grouping also omits its filter, as on milestone pages. */
  hideGroups?: readonly ListGroup[];
  stateButtons?: boolean;
}

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
  const {userId} = useSession();
  const path = useLocation({select: (l) => l.pathname});
  const type = useSearch({strict: false, select: (s: Record<string, unknown>) => (typeof s.type === 'string' ? s.type : undefined)});
  const viewSearch = {...search, ...(type ? {type} : {})};
  const [saving, setSaving] = useState(false);
  useShortcut('view.save', () => {
    setSaving(true);
  });
  const store = viewStore(userId);
  const saved = store.match(path, viewSearch);
  const openedId = store.opened.get();
  const origin = saved ?? store.views.find((v) => v.id === openedId && v.path === path);
  const modified = search.group !== undefined || search.sort !== undefined;
  const chooseState = (value: ListState) => {afterPaint(() => {setState(value);});};
  const chooseGroup = (value: ListGroup) => {afterPaint(() => {set({group: value});});};
  const chooseSort = (value: ListSort) => {afterPaint(() => {set({sort: value === 'newest' ? undefined : value});});};
  return (
    <>
      {saving && <SaveViewDialog path={path} search={viewSearch} onClose={() => {
        setSaving(false);
      }}/>}
      {stateButtons && <SegmentedControl aria-label="Issue state" size="small" onChange={(index) => {
        const choice = index === undefined ? undefined : STATES[index];
        if (choice) setState(choice.state);
      }}>{STATES.map((choice) => <SegmentedControl.Button key={choice.state} selected={state === choice.state}>{choice.label}</SegmentedControl.Button>)}</SegmentedControl>}
      <SearchField label="Search titles" toList grow={model.source.kind === 'my' && model.source.pulls} value={search.q ?? ''} onChange={(q) => {
        set({q: q.trim() ? q : undefined}, false);
      }} onSettle={() => {
        updateUrl(model.search, viewChange());
      }}/>
      <FilterMenu search={search} repoId={repoId} set={set} byMilestone={!hideGroups.includes('milestone')}/>
      <ActionMenu>
        <ActionMenu.Anchor><Button variant="default" size="small" leadingVisual={RowsIcon} {...(modified ? {count: Number(search.group !== undefined) + Number(search.sort !== undefined)} : {})} type="button" aria-label={modified ? 'Display (changed)' : 'Display'}>Display</Button></ActionMenu.Anchor>
        <ActionMenu.Overlay><ActionList>
          {!stateButtons && (
            <>
              <ActionList.Group selectionVariant="single"><ActionList.GroupHeading>Show</ActionList.GroupHeading>
              
                {STATES.map((s) => <ActionList.Item key={s.state} selected={state === s.state} onSelect={() => {chooseState(s.state);}}>{s.label}</ActionList.Item>)}
              </ActionList.Group>
              <ActionList.Divider/>
            </>
          )}
          <ActionList.Group selectionVariant="single"><ActionList.GroupHeading>Grouping</ActionList.GroupHeading>
          {/* Close first; defer expensive list updates until the next paint. */}
            {GROUPS.filter((g) => !hideGroups.includes(g.group)).map((g) => <ActionList.Item key={g.group} selected={group === g.group} onSelect={() => {chooseGroup(g.group);}}>{g.label}</ActionList.Item>)}
          </ActionList.Group><ActionList.Divider/>
          <ActionList.Group selectionVariant="single"><ActionList.GroupHeading>Ordering</ActionList.GroupHeading>
          
            {SORTS.map((s) => <ActionList.Item key={s.sort} selected={sort === s.sort} onSelect={() => {chooseSort(s.sort);}}>{s.label}</ActionList.Item>)}
          </ActionList.Group>
          <ActionList.Divider/>
          <ActionList.Item onSelect={() => {
            setSaving(true);
          }}><ActionList.LeadingVisual><StackIcon/></ActionList.LeadingVisual>Save view…<ActionList.TrailingVisual>{shortcutHint('view.save')}</ActionList.TrailingVisual></ActionList.Item>
        </ActionList></ActionMenu.Overlay>
      </ActionMenu>
      <SelectionBar model={model}/>
      <ResultCount model={model}/>
      {origin && <ViewMenu view={origin} changed={!saved} search={viewSearch} onSaveAs={() => {
        setSaving(true);
      }}/>}
    </>
  );
});

const SelectionBar = observer(function SelectionBar({model}: {model: IssueListModel}) {
  const navigate = useNavigate();
  const cursor = model.cursor;
  const n = cursor.selected.size;
  if (!n) return null;
  const listed = model.result.get().ids;
  return (
    <>
      <PrimerLabel variant="accent">{n} selected · Esc clears</PrimerLabel>
      <ActionMenu>
        <ActionMenu.Anchor><Button size="small" leadingVisual={TasklistIcon} trailingAction={ChevronDownIcon} type="button">Edit selected</Button></ActionMenu.Anchor>
        <ActionMenu.Overlay><ActionList>
          <SelectionActions ids={cursor.selected.values()} navigate={(path) => void navigate({to: path})}/>
        </ActionList></ActionMenu.Overlay>
      </ActionMenu>
      {n < listed.length && <Button variant="invisible" size="small" type="button" onClick={() => {
        cursor.selected.replace(listed);
      }}>Select all {listed.length}</Button>}
      <IconButton icon={XIcon} variant="invisible" size="small" aria-label="Clear the selection" keybindingHint={'Esc'} type="button" onClick={() => {
        cursor.clearSelection();
      }}/>
    </>
  );
});

const ResultCount = observer(function ResultCount({model}: {model: IssueListModel}) {
  if (!narrowed(model.search)) return null;
  const n = model.result.get().ids.length;
  // Plain text avoids looking like another pressed state-filter button.
  return <span className="text-sm whitespace-nowrap text-muted tabular-nums">{count(n, 'result', 'results')}</span>;
});

function SelectionActions({ids, navigate}: {ids: readonly number[]; navigate: (path: string) => void}) {
  const app = useApp();
  const actions = issueActions(app, issuesOf(app, ids), {navigate}).filter((a) => a.id !== 'open');
  return actions.map((a) => (
    <ActionList.Item key={a.id} onSelect={() => {
      a.run();
    }}><ActionList.LeadingVisual>{createElement(a.icon)}</ActionList.LeadingVisual>{a.label}<ActionList.TrailingVisual>{a.shortcut && shortcutHint(a.shortcut)}</ActionList.TrailingVisual></ActionList.Item>
  ));
}

/** Search params owned by the list; preserve unrelated params such as the "my" list type. */
const LIST_KEYS = new Set<string>([...FILTER_KEYS, 'state', 'sort', 'group']);

type Setter = (patch: Partial<Record<keyof ListSearch, string | number | undefined>>) => void;

interface ActiveFilter {
  key: string;
  label: string;
  clear: () => void;
}

/** Missing labels in loaded repositories are deleted filters, not database ids to display. */
function activeFilters(pool: ReturnType<typeof usePool>, search: ListSearch, set: Setter, loading: () => boolean): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  const labels = parseLabels(search.labels);
  for (const id of labels) {
    const name = pool.model('Label').get(Math.abs(id))?.get('name') ?? (loading() ? '…' : DELETED_LABEL);
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

export const DELETED_LABEL = '(deleted label)';

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
    out.push({value: `n:${key}`, label: l.name, words: 'label', group: 'Labels', leading: <IssueLabelToken text={l.name} fillColor={labelFill(l.color)}/>, checked: current === key, onSelect: () => {
      set({label: current === key ? undefined : l.name});
    }});
  }
  const repos = [...pool.model('Repository').all()].map((e) => e.data).sort((a, b) => a.full_name.localeCompare(b.full_name));
  for (const r of repos) {
    out.push({value: `o:${String(r.id)}`, label: r.full_name, words: 'repository', group: 'Repository', icon: RepoIcon, checked: search.repo === r.id, onSelect: () => {
      set({repo: search.repo === r.id ? undefined : r.id});
    }});
  }
  const posters = new Set<number>();
  for (const e of pool.model('Issue').all()) posters.add(e.data.poster_id);
  const users = [...posters].map((id) => pool.model('User').get(id)?.data).filter((u) => u !== undefined)
    .sort((a, b) => Number(b.id === me) - Number(a.id === me) || a.login.localeCompare(b.login));
  for (const u of users) {
    out.push({value: `p:${String(u.id)}`, label: u.id === me ? `${u.login} (you)` : u.login, words: `author ${u.full_name}`, group: 'Author', icon: PersonIcon,
      checked: search.poster === u.id, onSelect: () => {
        set({poster: search.poster === u.id ? undefined : u.id});
      }});
  }
  return out;
}

/** Deduplicate status and priority values across repositories, preserving workflow or urgency order. */
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
        value: `${kind}:${key}`, label: v, words: `${kind} ${l.name}`, group: kind === 'status' ? 'Status' : 'Priority', checked: current === key,
        leading: <LabelGlyph icon={kind === 'status' ? statusIcon(l.name) : priorityIcon(l.name)} color={l.color}/>,
        onSelect: () => {
          set({[kind]: current === key ? undefined : v});
        },
      });
    }
  }
  return out;
}

const FilterMenu = observer(function FilterMenu({search, repoId, set, byMilestone}: {search: ListSearch; repoId: number | undefined; set: Setter; byMilestone: boolean}) {
  const pool = usePool();
  const app = useApp();
  const me = app.session?.userId ?? 0;
  // Sync progress matters only while a filtered label is missing, so it is read only then.
  const active = activeFilters(pool, search, set, () => (app.session?.data.status.loading ?? 0) > 0);
  // The options scan labels, people and (on My lists) every issue: the panel builds them only while open.
  return <LocalSelectPanel title="Filter" placeholder="Filter by…" multiple empty="Nothing to filter by is on this device."
    options={() => filterOptions(pool, search, set, active, repoId, me, byMilestone)}
    onOpenChange={(next) => { if (next && repoId !== undefined) loadPeople(app, repoId); }}
    renderAnchor={(props) => <Button {...props} variant="default" size="small" leadingVisual={FilterIcon} type="button">
      <span className="max-w-xs truncate">{active[0] ? `${active[0].label}${active.length > 1 ? ` +${String(active.length - 1)}` : ''}` : 'Filter'}</span>
    </Button>}/>;
});

const NO_FILTERS = Object.fromEntries(FILTER_KEYS.filter((k) => k !== 'q').map((k) => [k, undefined])) as Partial<Record<keyof ListSearch, undefined>>;

function filterOptions(pool: ReturnType<typeof usePool>, search: ListSearch, set: Setter, active: readonly ActiveFilter[], repoId: number | undefined, me: number, byMilestone: boolean): PickOption[] {
  const options: PickOption[] = active.map((f) => ({value: `x:${f.key}`, label: f.label, group: 'In effect', icon: XIcon, onSelect: f.clear}));
  if (active.length > 1) options.push({value: 'x:all', label: 'Clear all filters', group: 'In effect', icon: XIcon, onSelect: () => {
    set(NO_FILTERS);
  }});
  options.push(...kindFilters(pool, search, repoId, set));
  if (repoId !== undefined) options.push(...repoFilters(pool, search, repoId, me, set, byMilestone));
  // Avoid subscribing the open menu to every issue in the workspace.
  else options.push(...untracked(() => workspaceFilters(pool, search, me, set)));
  // Only label toggles keep the panel open: every other filter takes one value.
  return options.map((option) => ({...option, keepOpen: option.keepOpen === true}));
}

function repoFilters(pool: ReturnType<typeof usePool>, search: ListSearch, repoId: number, me: number, set: Setter, byMilestone: boolean): PickOption[] {
  const chosen = new Set(parseLabels(search.labels));
  const users = repoPeople(pool, repoId, me).sort((a, b) => a.login.localeCompare(b.login));
  const milestones = [...pool.model('Milestone').by('repo_id', repoId)].map((m) => m.data).sort((a, b) => a.title.localeCompare(b.title));
  const out: PickOption[] = repoLabels(pool, repoId).filter((l) => !labelKind(l)).map((l) => ({
    value: `l:${String(l.id)}`, label: l.name, words: 'label', group: 'Labels', leading: <IssueLabelToken text={l.name} fillColor={labelFill(l.color)}/>, checked: chosen.has(l.id), keepOpen: true,
    onSelect: () => {
      const next = new Set(chosen);
      if (next.has(l.id)) next.delete(l.id);
      else next.add(l.id);
      set({labels: [...next].join(',') || undefined});
    },
  }));
  const person = (u: (typeof users)[number]) => (u.id === me ? `${u.login} (you)` : u.login);
  out.push({value: 'a:-1', label: 'Nobody', words: 'assignee unassigned', group: 'Assignee', icon: PersonIcon, checked: search.assignee === -1, onSelect: () => {
    set({assignee: search.assignee === -1 ? undefined : -1});
  }});
  for (const u of users) out.push({value: `a:${String(u.id)}`, label: person(u), words: `assignee ${u.name}`, group: 'Assignee', leading: <UserAvatar id={u.id}/>, checked: search.assignee === u.id, onSelect: () => {
    set({assignee: search.assignee === u.id ? undefined : u.id});
  }});
  for (const u of users) out.push({value: `p:${String(u.id)}`, label: person(u), words: `author ${u.name}`, group: 'Author', icon: PersonIcon, checked: search.poster === u.id, onSelect: () => {
    set({poster: search.poster === u.id ? undefined : u.id});
  }});
  if (!byMilestone) return out;
  out.push({value: 'm:-1', label: 'No milestone', words: 'milestone', group: 'Milestone', icon: MilestoneIcon, checked: search.milestone === -1, onSelect: () => {
    set({milestone: search.milestone === -1 ? undefined : -1});
  }});
  for (const m of milestones) out.push({value: `m:${String(m.id)}`, label: m.title, words: `milestone ${m.state === 'closed' ? 'closed' : ''}`, group: 'Milestone', icon: MilestoneIcon, checked: search.milestone === m.id, onSelect: () => {
    set({milestone: search.milestone === m.id ? undefined : m.id});
  }});
  return out;
}

const ViewMenu = observer(function ViewMenu({view, changed, search, onSaveAs}: {view: SavedView; changed: boolean; search: SavedView['search']; onSaveAs: () => void}) {
  const app = useApp();
  const {userId} = useSession();
  const store = viewStore(userId);
  const [renaming, setRenaming] = useState(false);
  return (
    <>
      <ActionMenu>
        <ActionMenu.Anchor><Button variant="invisible" size="small" leadingVisual={StackIcon} trailingAction={ChevronDownIcon} type="button" aria-label={`View “${view.name}”${changed ? ' (changed)' : ''}`}>
            {view.name}{changed && <span className="text-sm text-muted">· changed</span>}
          </Button></ActionMenu.Anchor>
        <ActionMenu.Overlay><ActionList>
          <ActionList.Item disabled={!changed} onSelect={() => {
            store.update(view.id, search);
            notify(app, {tone: 'neutral', title: `Updated the view “${view.name}”`});
          }}><ActionList.LeadingVisual><CheckIcon/></ActionList.LeadingVisual>Update the view with these filters</ActionList.Item>
          <ActionList.Item onSelect={onSaveAs}><ActionList.LeadingVisual><StackIcon/></ActionList.LeadingVisual>Save as a new view…</ActionList.Item>
          <ActionList.Divider/>
          <ActionList.Item onSelect={() => {
            setRenaming(true);
          }}><ActionList.LeadingVisual><PencilIcon/></ActionList.LeadingVisual>Rename…</ActionList.Item>
          <ActionList.Item variant="danger" onSelect={() => {
            const removed = view;
            store.remove(view.id);
            notify(app, {tone: 'neutral', title: `Deleted the view “${removed.name}”`, action: {label: 'Undo', run: () => {
              store.save(removed.name, removed.path, removed.search);
            }}});
          }}><ActionList.LeadingVisual><TrashIcon/></ActionList.LeadingVisual>Delete view</ActionList.Item>
        </ActionList></ActionMenu.Overlay>
      </ActionMenu>
      {renaming && <ViewNameDialog title="Rename the view" initial={view.name} onClose={() => {
        setRenaming(false);
      }} onSave={(name) => {
        store.rename(view.id, name);
      }}/>}
    </>
  );
});
