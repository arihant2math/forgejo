// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The ⌘K palette (PLAN §5.6): commands, and repositories, issues and pull
// requests found in the in-memory pool (search.ts) as you type. Its own
// chunk, preloaded when the app is idle.

import {useNavigate} from '@tanstack/react-router';
import {
  AppWindow, BookMarked, BookPlus, Building2, CircleCheck, CloudUpload, Code2, CircleDot, Compass, FileCode, GitPullRequest, GitPullRequestClosed, CornerDownRight, Globe, Home,
  Inbox, KanbanSquare, Layers, Keyboard, LogOut, Milestone, Monitor, Moon, PanelLeft, Settings, SquarePen, Sun, SunMoon, User,
} from 'lucide-react';
import {runInAction, untracked} from 'mobx';
import {type ReactNode, useDeferredValue, useEffect, useMemo, useRef, useState} from 'react';
import {CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandRoot} from '../../ui/Command.tsx';
import {classicHref} from '../classic.ts';
import {canGoToCode, GO_CODE_WHY, goToCode} from '../goto.ts';
import type {LucideIcon} from '../../ui/index.ts';
import {openCreate} from '../create.ts';
import {lastBoard} from '../lastBoard.ts';
import {notify} from '../notices.ts';
import {connectivity, onlineOnly} from '../online.ts';
import {classicOfHere, requestSignOut, switchToClassic} from '../session.ts';
import {activeHint, KEYMAP, shortcutHint, type ShortcutId, shortcuts} from '../shortcuts/index.ts';
import {type App, useApp} from '../store.ts';
import {setThemePreference, themeState} from '../theme.ts';
import {issueActions} from '../../features/issues/actions.ts';
import {issuePath, issuesOf} from '../../features/issues/edits.ts';
import type {Entity} from '../../data/entity.ts';
import {editing} from '../../intents/session.ts';
import {localSearch} from '../../features/search/local.ts';
import {searchServer, searchServerRepos, searchServerUsers, type ServerHit, type ServerRepo, type ServerUser} from '../../features/search/server.ts';
import {viewStore} from '../../features/views/views.ts';
import type {Issue, Repository} from '../../protocol/types.gen.ts';
import {searchBoards, searchMilestones, searchPeople} from './entities.ts';
import {useFiles} from './files.ts';
import {type Narrowing, repoScore, score, searchPool, type SearchResults, startScore} from './search.ts';

type Navigate = ReturnType<typeof useNavigate>;

interface PaletteCommand {
  id: string;
  /** The keymap's label when it has a shortcut (one label and hint per action: palette, help, tooltips). */
  label?: string;
  icon: LucideIcon;
  shortcut?: ShortcutId;
  /** Other names: found by them as by its label ("new issue" names "Create an issue"). */
  aliases?: readonly string[];
  /** Extra words it is found by (weaker than a name). */
  keywords?: string;
  /** Why it cannot run now (listed with the reason; Enter says it), or undefined. */
  unavailable?: (app: App) => string | undefined;
  /** Not listed now (a theme already chosen). */
  hidden?: () => boolean;
  /** Never the default (Enter right after typing never runs it) — unless the query is one of these names. */
  destructive?: boolean;
  names?: readonly string[];
  /** A classic page: the command opens it (same tab), labelled as such. */
  classic?: string;
  run: (app: App, navigate: Navigate) => void;
}

/** Bound shortcuts not listed as page commands: movement (J/K/X/H/L), and the issue pickers (the issue's own group has them). */
const PAGE_SKIP = new Set<ShortcutId>([
  'list.next', 'list.prev', 'list.select', 'board.left', 'board.right',
  'issue.state', 'issue.labels', 'issue.assignee', 'issue.milestone', 'issue.priority',
]);

const COMMANDS: PaletteCommand[] = [
  {id: 'inbox', icon: Inbox, shortcut: 'go.inbox', aliases: ['inbox', 'notifications'], run: (_, nav) => void nav({to: '/notifications'})},
  {id: 'issues', icon: CircleDot, shortcut: 'go.issues', aliases: ['my issues', 'issues'], run: (_, nav) => void nav({to: '/issues'})},
  {id: 'pulls', icon: GitPullRequest, shortcut: 'go.pulls', aliases: ['my pull requests', 'pull requests', 'prs'], keywords: 'pr', run: (_, nav) => void nav({to: '/pulls'})},
  {id: 'create', icon: SquarePen, shortcut: 'create', aliases: ['new issue', 'create issue', 'add issue', 'open an issue', 'file an issue'], run: (app) => {
    openCreate(app);
  }},
  {id: 'boards', icon: KanbanSquare, shortcut: 'go.board', aliases: ['board', 'boards', 'projects'], keywords: 'kanban', run: (app, nav) => {
    const id = app.session && lastBoard(app.session.userId);
    void nav(id ? {to: '/-/next/projects/$id', params: {id: String(id)}} : {to: '/-/next/boards'});
  }},
  {id: 'code', icon: Code2, shortcut: 'go.code', aliases: ['go to the code', 'code', 'files', 'source'], keywords: 'tree browse',
    unavailable: (app) => (canGoToCode(app) ? undefined : GO_CODE_WHY), run: (app, nav) => {
      goToCode(app, nav);
    }},
  {id: 'home', icon: Home, shortcut: 'go.home', aliases: ['home', 'go home', 'dashboard'], run: (_, nav) => void nav({to: '/'})},
  {id: 'sidebar', icon: PanelLeft, shortcut: 'sidebar.toggle', aliases: ['hide the sidebar', 'show the sidebar', 'toggle the sidebar', 'collapse the sidebar'], run: () => {
    shortcuts.run('sidebar.toggle');
  }},
  {id: 'profile', label: 'Your profile and repositories', icon: User, keywords: 'me account', run: (app, nav) => {
    const login = app.session?.data.pool.model('User').get(app.session.userId)?.get('login');
    if (login) void nav({to: '/$owner', params: {owner: login}});
  }},
  {id: 'settings', label: 'Settings', icon: Settings, keywords: 'preferences account ssh keys password classic', classic: '/user/settings', run: () => undefined},
  {id: 'new-repo', label: 'New repository', icon: BookPlus, keywords: 'create repo classic', classic: '/repo/create', run: () => undefined},
  {id: 'new-org', label: 'New organization', icon: Building2, keywords: 'create org team classic', classic: '/org/create', run: () => undefined},
  {id: 'explore', label: 'Explore repositories, people and organizations', icon: Compass, keywords: 'explore discover browse find public classic', classic: '/explore/repos', run: () => undefined},
  {id: 'shortcuts', label: 'Keyboard shortcuts', icon: Keyboard, shortcut: 'help.shortcuts', keywords: 'help keys', run: (app) => {
    runInAction(() => {
      app.ui.shortcutsOpen = true;
    });
  }},
  // The theme in use is not offered again.
  {id: 'theme-dark', label: 'Switch to the dark theme', icon: Moon, aliases: ['dark theme', 'dark mode'], keywords: 'appearance', hidden: () => themeState.preference === 'dark', run: () => {
    setThemePreference('dark');
  }},
  {id: 'theme-light', label: 'Switch to the light theme', icon: Sun, aliases: ['light theme', 'light mode'], keywords: 'appearance', hidden: () => themeState.preference === 'light', run: () => {
    setThemePreference('light');
  }},
  {id: 'theme-system', label: 'Follow the system theme', icon: SunMoon, aliases: ['system theme'], keywords: 'appearance', hidden: () => themeState.preference === 'system', run: () => {
    setThemePreference('system');
  }},
  {id: 'classic-page', label: 'Open this page in the classic UI', icon: AppWindow, keywords: 'old forgejo', run: (app) => {
    location.assign(classicHref(app, classicOfHere(app, currentSitePath(app), location.search)));
  }},
  {id: 'classic', label: 'Turn off Forgejo Next', icon: Monitor, keywords: 'classic ui old forgejo switch', run: (app) => {
    // Online only (never queued): offline it says why instead.
    if (!connectivity.online) notify(app, {tone: 'neutral', title: onlineOnly('The classic UI')});
    else switchToClassic(app);
  }},
  {id: 'sign-out', label: 'Sign out', icon: LogOut, keywords: 'log out logout', destructive: true, names: ['sign out', 'signout', 'log out', 'logout'], run: (app) => {
    void requestSignOut(app);
  }},
];

/** The page on screen as a site path (without the instance's sub-path). */
function currentSitePath(app: App): string {
  const sub = app.config.app_sub_url;
  return location.pathname.startsWith(`${sub}/`) ? location.pathname.slice(sub.length) : '/';
}

/** Searches the pool, timed (User Timing measure "palette:search"). Untracked: no subscriptions to what it read. */
function search(app: App, query: string, narrow: Narrowing | undefined, contextRepo: number): SearchResults {
  const s = app.session;
  if (!s || !query.trim()) return {repos: [], issues: []};
  const t0 = performance.now();
  const results = untracked(() => searchPool(s.data.pool, query, {extraRepos: s.data.peek('Repository'), narrow, contextRepo: contextRepo || undefined}));
  try {
    performance.measure('palette:search', {start: t0, end: performance.now(), detail: {query: query.length}});
  } catch {
    // No User Timing.
  }
  return results;
}

/** Searches as the user types, each search narrowing the previous one's matches. */
class Searcher {
  private prev: Narrowing | undefined;
  private readonly app: App;
  constructor(app: App) {
    this.app = app;
  }
  run(query: string, contextRepo: number): SearchResults {
    const r = search(this.app, query, this.prev, contextRepo);
    this.prev = r.matched ? {query, matched: r.matched} : undefined;
    return r;
  }
}

/** The dialog stays mounted once opened (it fades out); each opening starts with an empty query. */
export function Palette({open}: {open: boolean}) {
  const app = useApp();
  const [opened, setOpened] = useState({open, n: 0});
  if (open !== opened.open) setOpened({open, n: open ? opened.n + 1 : opened.n});
  // A row was chosen: the focus goes to the page it led to, not back to the sidebar's Search (and its tooltip).
  const chose = useRef(-1);
  const n = opened.n;
  return (
    // Keyed by the opening: Ctrl+K while the last one still fades out opens a new one at once, its input focused
    // (QA round 2: reopened mid-fade, the old one kept no focus, and typing ran the page's shortcuts).
    <CommandDialog key={opened.n} open={open} onOpenChange={(o) => {
      runInAction(() => {
        app.ui.paletteOpen = o;
      });
    }} label="Command menu" bare restoreFocus={() => chose.current !== n}>
      <PaletteBody key={opened.n} app={app} onChoose={() => {
        chose.current = n;
      }}/>
    </CommandDialog>
  );
}

/** One row of the palette. */
interface Row {
  value: string;
  label: ReactNode;
  icon?: LucideIcon | undefined;
  meta?: ReactNode;
  shortcut?: string | undefined;
  /** Never selected by default. */
  destructive?: boolean | undefined;
  /** Cannot run now (its meta says why). */
  muted?: boolean | undefined;
  run: () => void;
}

/** A group of rows and how well it matched (groups are ordered by it; ties keep the listed order). */
interface Group {
  heading: string;
  rank: number;
  rows: Row[];
}

/** Commands and other named things whose label matches outrank fuzzy title matches of the same strength. */
const NAMED_BONUS = 1.5;
/** Commands and page actions the query names (every word at a word start of the label or a name): above everything found. */
const COMMAND_RANK = 50;

function commandLabel(c: PaletteCommand): string {
  return c.label ?? (c.shortcut ? KEYMAP[c.shortcut].label : c.id);
}

function PaletteBody({app, onChoose}: {app: App; onChoose: () => void}) {
  const navigate = useNavigate();
  // Opened with a query (a list's "Search everywhere"): taken once.
  const [query, setQuery] = useState(() => untracked(() => app.ui.paletteQuery));
  useEffect(() => {
    if (untracked(() => app.ui.paletteQuery)) runInAction(() => {
      app.ui.paletteQuery = '';
    });
  }, [app]);
  // The input never waits for the search (a large pool's first keystroke scans it all);
  // each search narrows the previous one's matches while typing.
  const deferred = useDeferredValue(query);
  const [searcher] = useState(() => new Searcher(app));
  const contextRepo = untracked(() => app.ui.repoOpen);
  const results = useMemo(() => searcher.run(deferred, contextRepo), [searcher, deferred, contextRepo]);
  const more = useMoreResults(app, deferred, results);
  const files = useFiles(app, untracked(() => app.ui.repoOpen || app.ui.recentRepo), deferred);
  const words = deferred.toLowerCase().split(/\s+/).filter(Boolean);
  const close = () => {
    runInAction(() => {
      app.ui.paletteOpen = false;
    });
  };
  const run = (fn: () => void) => () => {
    onChoose();
    close();
    fn();
  };
  const match = (text: string) => (words.length ? score(text.toLowerCase(), words) : 0);
  // Commands and actions are found by the starts of their words only: "board" is not "Keyboard shortcuts".
  const matchName = (text: string) => (words.length ? startScore(text.toLowerCase(), words) : 0);
  // The actions on the issues the keyboard is on (the list's selection or cursor, the open issue).
  const [target] = useState(() => untracked(() => issuesOf(app, app.ui.issueTarget)));
  // What the page on screen offers by key (inbox triage, board moves, save the view, comment…), as commands.
  const [onPage] = useState(() => shortcuts.available().filter((id) => !PAGE_SKIP.has(id)));
  const groups: Group[] = [];
  const add = (heading: string, rank: number, rows: Row[]) => {
    if (rows.length) groups.push({heading, rank, rows});
  };
  const best = (scores: number[]) => (scores.length ? Math.max(...scores) : -1);
  // Actions found by their label (every word at a word start) rank with the commands, above what merely contains the words.
  const actionRank = (s: number) => (s >= 2 * words.length ? COMMAND_RANK + s : s + NAMED_BONUS);

  // Exactly the issue the query names ("atlas#85"): always first.
  add('Go to', 100, (results.exact ?? []).filter((r) => r.repo).map(({issue, repo}) => ({
    value: `exact:${String(issue.id)}`, icon: issueIcon(issue), meta: `${repo?.full_name ?? ''}#${String(issue.number)}`, label: issue.title,
    run: openIssue(issue, repo),
  })));

  // The issue on screen: no "Open" (it is open) and no second classic exit ("Open this page in the classic UI" is it).
  const onScreen = untracked(() => target.length === 1 && target[0]?.id === app.ui.issueOpen);
  const actionList = untracked(() => issueActions(app, target, {navigate: (path) => void navigate({to: path})}))
    .filter((a) => !onScreen || (a.id !== 'open' && a.id !== 'classic'))
    .map((a) => ({a, s: matchName(`${a.label} ${a.keywords ?? ''}`)})).filter((x) => x.s >= 0);
  const targetName = untracked(() => (target.length === 1 ? `#${String(target[0]?.data.number)} ${target[0]?.data.title ?? ''}` : `${String(target.length)} selected`));
  add(targetName, words.length ? actionRank(best(actionList.map((x) => x.s))) : 90, actionList.map(({a}) => ({
    // Closing or reopening is never the default (Enter right after ⌘K on an issue must not close it).
    value: `act:${a.id}`, icon: a.icon, shortcut: a.shortcut && activeHint(a.shortcut), label: a.label, destructive: a.id === 'state' && !words.length, run: () => {
      a.run();
    },
  })));

  const pageList = onPage.map((id) => ({id, s: matchName(KEYMAP[id].label)})).filter((x) => x.s >= 0);
  add('On this page', words.length ? actionRank(best(pageList.map((x) => x.s))) : 80, pageList.map(({id}) => ({
    value: `page:${id}`, icon: CornerDownRight, shortcut: shortcutHint(id), label: KEYMAP[id].label,
    // After the palette closed (focus back on the page), as the key would.
    run: () => requestAnimationFrame(() => {
      shortcuts.run(id);
    }),
  })));

  const views = untracked(() => (app.session ? viewStore(app.session.userId).views.slice() : [])).map((v) => ({v, s: match(v.name)})).filter((x) => x.s >= 0);
  add('Views', words.length ? best(views.map((x) => x.s)) + NAMED_BONUS : 70, views.map(({v}) => ({
    value: `view:${v.id}`, icon: Layers, label: v.name, run: () => {
      if (app.session) viewStore(app.session.userId).open(v.id);
      void navigate({to: v.path, search: v.search as never});
    },
  })));

  if (words.length) {
    // A repository named by the query (repoScore) outranks boards and milestones that share its name. Repositories
    // only Forgejo knows (a fork outside the workspace) join them when the query names them too.
    const shownRepoIds = new Set(results.repos.map((r) => r.id));
    const namedOnServer = more.repos.filter((r) => !shownRepoIds.has(r.id))
      .map((r) => ({r, s: repoScore(r.fullName.toLowerCase(), r.name.toLowerCase(), words)})).filter((x) => x.s >= SERVER_REPO_NAMED);
    add('Repositories', best([results.top?.repos ?? -1, ...namedOnServer.map((x) => x.s)]) + NAMED_BONUS, [
      ...results.repos.map((r) => ({
        value: `repo:${String(r.id)}`, icon: BookMarked, meta: r.description, label: r.full_name,
        run: () => void navigate({to: '/$owner/$repo', params: {owner: r.owner_name, repo: r.name}}),
      })),
      ...namedOnServer.map(({r}) => ({
        value: `server-repo:${String(r.id)}`, icon: BookMarked, meta: r.description, label: r.fullName,
        run: () => void navigate({to: '/$owner/$repo', params: {owner: r.owner, repo: r.name}}),
      })),
    ]);
    for (const {r} of namedOnServer) shownRepoIds.add(r.id);
    const pool = app.session?.data.pool;
    const shownPeople = new Set<number>();
    if (pool) {
      const boards = untracked(() => searchBoards(pool, words));
      add('Boards', best(boards.map((b) => b.score)) + NAMED_BONUS, boards.map(({item: b, repo}) => ({
        value: `board:${String(b.id)}`, icon: KanbanSquare, meta: repo?.full_name, label: b.title,
        run: () => void navigate({to: '/-/next/projects/$id', params: {id: String(b.id)}}),
      })));
      const milestones = untracked(() => searchMilestones(pool, words));
      add('Milestones', best(milestones.map((m) => m.score)) + NAMED_BONUS, milestones.map(({item: m, repo}) => ({
        value: `milestone:${String(m.id)}`, icon: Milestone, meta: repo?.full_name, label: m.title,
        run: () => {
          if (repo) void navigate({to: '/$owner/$repo/issues', params: {owner: repo.owner_name, repo: repo.name}, search: {milestone: m.id, state: 'all'}});
        },
      })));
      const people = untracked(() => searchPeople(pool, words));
      for (const p of people) shownPeople.add(p.item.id);
      add('People', best(people.map((p) => p.score)) + 1, people.map(({item: u}) => ({
        value: `user:${String(u.id)}`, icon: u.type === 'organization' ? Building2 : User, meta: u.full_name, label: u.login,
        run: () => void navigate({to: '/$owner', params: {owner: u.login}}),
      })));
    }
    add('Files', best(files.map((f) => f.score / 2)) + 1, files.map((f) => ({
      value: `file:${f.owner}/${f.repo}/${f.path}`, icon: FileCode, meta: `${f.owner}/${f.repo}`, label: f.path,
      run: () => void navigate({to: '/-/next/code/$owner/$repo/$', params: {owner: f.owner, repo: f.repo, _splat: `src/branch/${f.ref}/${f.path}/-`}}),
    })));
    // Issues created on this device that Forgejo has not numbered yet (offline): found by title, marked pending.
    const pending = untracked(() => (editing(app).overlay.created('Issue') as Entity<'Issue'>[])
      .map((e) => ({e, s: score(e.data.title.toLowerCase(), words)})).filter((x) => x.s >= 0)
      .map(({e, s}) => ({e, s, path: issuePath(app, e), repo: app.session?.data.pool.model('Repository').get(e.data.repo_id)?.data})));
    add('Not synced yet', best(pending.map((x) => x.s)), pending.flatMap(({e, path, repo}) => (path ? [{
      value: `new:${String(e.id)}`, icon: CloudUpload, meta: `${repo?.full_name ?? ''} · pending`, label: e.data.title,
      run: () => void navigate({to: path}),
    }] : [])));
    add('Issues and pull requests', results.top?.issues ?? -1, [...results.issues, ...more.local].filter((r) => r.repo).map(({issue, repo}) => ({
      value: `issue:${String(issue.id)}`, icon: issueIcon(issue), meta: `${repo?.full_name ?? ''}#${String(issue.number)}`, label: issue.title,
      run: openIssue(issue, repo),
    })));
    // What only the server knows: repositories and people outside the workspace, then issues by their text.
    add('On Forgejo', 0, [
      ...more.repos.filter((r) => !shownRepoIds.has(r.id)).map((r) => ({
        value: `server-repo:${String(r.id)}`, icon: BookMarked, meta: r.description, label: r.fullName,
        run: () => void navigate({to: '/$owner/$repo', params: {owner: r.owner, repo: r.name}}),
      })),
      ...more.users.filter((u) => !shownPeople.has(u.id)).map((u) => ({
        value: `server-user:${String(u.id)}`, icon: User, meta: u.fullName, label: u.login,
        run: () => void navigate({to: '/$owner', params: {owner: u.login}}),
      })),
      ...more.server.map((h) => ({
        value: `server:${String(h.id)}`, icon: Globe, meta: `${h.fullName}#${String(h.number)}`, label: h.title,
        run: () => void navigate({
          to: h.pull ? '/$owner/$repo/pulls/$index' : '/$owner/$repo/issues/$index',
          params: {owner: h.owner, repo: h.repo, index: String(h.number)},
        }),
      })),
    ]);
  }

  // A command is found by its label or one of its names: that outranks every title or name that merely contains the
  // words (Linear: "new issue" is the command, not an issue titled "…new-issue…"); keywords alone rank as any match.
  const commands = untracked(() => COMMANDS.filter((c) => !c.hidden?.()).map((c) => {
    const label = commandLabel(c);
    const s = Math.max(matchName(label), ...(c.aliases ?? []).map((a) => matchName(a)));
    return {c, label, s, k: matchName(`${label} ${(c.aliases ?? []).join(' ')} ${c.keywords ?? ''}`)};
  })).filter((x) => x.k >= 0).sort((a, b) => b.s - a.s);
  // A command the query names outright ("sign out", "logout") is the default, destructive or not: Enter runs it
  // (signing out still asks first when changes are not synced).
  const typed = words.join(' ');
  const named = (c: PaletteCommand) => (c.names?.includes(typed) ?? false) || (c.aliases?.includes(typed) ?? false);
  // Every word at the start of a word of the label or a name: the command is what the query asks for.
  const whole = 2 * words.length;
  add('Commands', words.length ? best(commands.map((x) => (named(x.c) ? 100 : x.s >= whole ? COMMAND_RANK + x.s : x.s >= 0 ? x.s + NAMED_BONUS : x.k))) : 60, commands.map(({c, label}) => {
    const why = untracked(() => c.unavailable?.(app));
    return {
      value: `cmd:${c.id}`, icon: c.icon, shortcut: c.shortcut && shortcutHint(c.shortcut), label, destructive: c.destructive && !named(c),
      meta: why ?? (c.classic ? 'classic UI' : undefined), muted: why !== undefined,
      run: why !== undefined ? () => {
        // Listed with its reason (not left out, so that Enter never opens something else instead): Enter says it again.
        notify(app, {tone: 'neutral', title: why});
      } : c.classic ? () => {
        location.assign(classicHref(app, c.classic ?? '/'));
      } : () => {
        c.run(app, navigate);
      },
    };
  }));

  // Best first; a stable sort keeps the listed order on ties.
  groups.sort((a, b) => b.rank - a.rank);
  // The selection: the first row (never a destructive one) whenever the results change; the user's arrow keys move it.
  const values = groups.flatMap((g) => g.rows.map((r) => r.value));
  const sig = `${deferred}\u0000${values.join('\u0000')}`;
  const first = groups.flatMap((g) => g.rows).find((r) => !r.destructive)?.value ?? '';
  const [sel, setSel] = useState({sig: '', value: ''});
  let selected = sel.value;
  if (sel.sig !== sig) {
    selected = first;
    setSel({sig, value: first});
  }
  return (
    <CommandRoot label="Command menu" value={selected} onValueChange={(v) => {
      setSel({sig, value: v});
    }}>
      <CommandInput value={query} onValueChange={setQuery} placeholder="Search repositories, issues, files, people and commands…"/>
      <CommandList>
        {!groups.length && <CommandEmpty>{!words.length || !more.asked ? 'Nothing found on this device.' : more.answered ? 'Nothing found on this device or on Forgejo.' : 'Nothing on this device. Asking Forgejo…'}</CommandEmpty>}
        {groups.map((g) => (
          <CommandGroup key={g.heading} heading={g.heading}>
            {g.rows.map((r) => (
              <CommandItem key={r.value} value={r.value} icon={r.icon} meta={r.meta} shortcut={r.shortcut} muted={r.muted} onSelect={r.muted ? r.run : run(r.run)}>{r.label}</CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandRoot>
  );

  function openIssue(issue: Issue, repo: Repository | undefined) {
    return () => {
      if (!repo) return;
      void navigate({
        to: issue.is_pull ? '/$owner/$repo/pulls/$index' : '/$owner/$repo/issues/$index',
        params: {owner: repo.owner_name, repo: repo.name, index: String(issue.number)},
      });
    };
  }
}

function issueIcon(issue: Issue): LucideIcon {
  return issue.is_pull ? (issue.state === 'open' ? GitPullRequest : GitPullRequestClosed) : (issue.state === 'open' ? CircleDot : CircleCheck);
}

/** Local matches beyond the pool scan's (MiniSearch: prefixes, typos), then the server's beyond both. */
interface More {
  local: {issue: Issue; repo: Repository | undefined}[];
  server: ServerHit[];
  repos: ServerRepo[];
  users: ServerUser[];
  /** Forgejo is asked for this query (online, two letters or more). */
  asked?: boolean | undefined;
  /** …and has answered (all three searches). */
  answered?: boolean | undefined;
}

const NONE: More = {local: [], server: [], repos: [], users: []};
/** A repository only Forgejo knows joins the Repositories group when the query names it or its name's start (repoScore). */
const SERVER_REPO_NAMED = 4;
/** Typing pauses this long before the server is asked. */
const SERVER_DELAY = 300;

function useMoreResults(app: App, query: string, scan: SearchResults): More {
  const [answer, setAnswer] = useState<{query: string; value: More}>({query: '', value: NONE});
  useEffect(() => {
    const q = query.trim();
    const s = app.session;
    if (!q || !s) return undefined;
    const ctl = new AbortController();
    const shown = shownIssues(scan);
    const pool = s.data.pool;
    const repoOf = (id: number) => pool.model('Repository').get(id)?.data ?? s.data.peek('Repository').get(id);
    const ix = localSearch(app);
    const merge = (part: Partial<More>) => {
      setAnswer((m) => {
        const base = m.query === query ? m.value : NONE;
        const next = {...base, ...part};
        // Nothing to show either way (the scan filled the slots, as it usually does): no render.
        const empty = (v: More) => !v.local.length && !v.server.length && !v.repos.length && !v.users.length && v.asked === m.value.asked && v.answered === m.value.answered;
        return m.query === query && empty(next) && empty(m.value) ? m : {query, value: next};
      });
    };
    void ix?.search(q, 20).then((a) => {
      if (ctl.signal.aborted) return;
      const local = untracked(() => a.hits.filter((h) => !shown.has(h.id)).map((h) => pool.model('Issue').get(h.id)?.data)
        .filter((i) => i !== undefined).map((issue) => ({issue, repo: repoOf(issue.repo_id)})).filter((r) => r.repo !== undefined)
        .slice(0, Math.max(0, 12 - shown.size)));
      merge({local});
    }).catch(() => undefined);
    const asked = q.length >= 2 && connectivity.online;
    if (asked) merge({asked: true});
    const timer = asked ? setTimeout(() => {
      let left = 3;
      const ask = <K extends 'server' | 'repos' | 'users'>(key: K, p: Promise<More[K]>) => {
        void p.then((v) => {
          if (!ctl.signal.aborted) merge({[key]: v});
        }).catch(() => undefined).finally(() => {
          if (--left === 0 && !ctl.signal.aborted) merge({answered: true});
        });
      };
      ask('server', searchServer(app, q, ctl.signal));
      ask('repos', searchServerRepos(app, q, ctl.signal));
      ask('users', searchServerUsers(app, q, ctl.signal));
    }, SERVER_DELAY) : undefined;
    return () => {
      ctl.abort();
      clearTimeout(timer);
    };
  }, [app, query, scan]);
  // The last answers while the next ones are on their way (typing narrows or widens the same query: no flicker), minus
  // what the scan lists now; each issue once (an issue on this device that only the server matched, its body say, shows).
  return useMemo(() => {
    const q = query.trim().toLowerCase();
    const a = answer.query.trim().toLowerCase();
    if (!q || !a || !(q.startsWith(a) || a.startsWith(q))) return NONE;
    const shown = shownIssues(scan);
    const local = answer.value.local.filter((r) => !shown.has(r.issue.id));
    for (const r of local) shown.add(r.issue.id);
    const server = answer.value.server.filter((h) => !shown.has(h.id));
    const {repos, users} = answer.value;
    // Whether Forgejo was asked and answered counts for this very query only.
    const status = q === a ? {asked: answer.value.asked, answered: answer.value.answered} : {};
    return local.length || server.length || repos.length || users.length || status.asked ? {local, server, repos, users, ...status} : NONE;
  }, [answer, query, scan]);
}

/** The issues the scan lists already, the one the query names exactly included (each issue is listed once). */
function shownIssues(scan: SearchResults): Set<number> {
  return new Set([...scan.issues, ...scan.exact ?? []].map((r) => r.issue.id));
}
