// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useNavigate, useRouterState} from '@tanstack/react-router';
import {runInAction, untracked} from 'mobx';
import {useDeferredValue, useEffect, useMemo, useRef, useState} from 'react';
import {Dialog} from '@primer/react';
import {PaletteList, type PaletteRow} from './PaletteList.tsx';
import {classicHref} from '../classic.ts';
import {sitePath} from '../config.ts';
import {canGoToCode, GO_CODE_WHY, goToCode} from '../goto.ts';
import {openCreate} from '../create.ts';
import {lastBoard} from '../lastBoard.ts';
import {notify, undoLatest} from '../notices.ts';
import {httpsCloneUrl} from '../../code/clone.ts';
import {parseCodePath, resolveRef} from '../../code/refs.ts';
import {refTable} from '../../features/code/hooks.ts';
import {codeTo} from '../../features/code/nav.tsx';
import {repoAccess} from '../access.ts';
import {connectivity, onlineOnly} from '../online.ts';
import {classicOfHere, requestSignOut, switchToClassic} from '../session.ts';
import {KEYMAP, type ShortcutId, shortcuts} from '../shortcuts/index.ts';
import {type App, useApp} from '../store.ts';
import {setThemePreference, themeState} from '../theme.ts';
import {issueActions} from '../../features/issues/actions.ts';
import {isMerged, StateGlyph, stateLook} from '../../features/issues/cells.tsx';
import {issuePath, issuesOf} from '../../features/issues/edits.ts';
import type {Entity} from '../../data/entity.ts';
import {editing} from '../../intents/session.ts';
import {localSearch} from '../../features/search/local.ts';
import {searchServer, searchServerOrgs, searchServerRepos, searchServerUsers, type ServerHit, type ServerRepo, type ServerUser} from '../../features/search/server.ts';
import {discoverySearch} from '../../features/search/params.ts';
import {viewStore} from '../../features/views/views.ts';
import type {Issue, Repository} from '../../protocol/types.gen.ts';
import {searchBoards, searchMilestones, searchPeople} from './entities.ts';
import {useFiles} from './files.ts';
import {type Narrowing, repoScore, score, searchPool, type SearchResults, startScore} from './search.ts';
import {BrowserIcon, RepoIcon, OrganizationIcon, UploadIcon, CodeIcon, IssueOpenedIcon, TelescopeIcon, FileCodeIcon, GitPullRequestIcon, ArrowRightIcon, HomeIcon, RepoPushIcon, InboxIcon, ProjectIcon, KeyIcon, KeyAsteriskIcon, StackIcon, SignOutIcon, MailIcon, MilestoneIcon, DeviceDesktopIcon, MoonIcon, PaintbrushIcon, SidebarExpandIcon, GearIcon, StarIcon, SunIcon, PersonIcon, UndoIcon} from '@primer/octicons-react';
import type {Icon as OcticonType} from '@primer/octicons-react';

type Navigate = ReturnType<typeof useNavigate>;

interface PaletteCommand {
  id: string;
  /** Uses the shared keymap label when bound. */
  label?: string;
  icon: OcticonType;
  shortcut?: ShortcutId;
  aliases?: readonly string[];
  keywords?: string;
  /** Disabled reason; Enter announces it without running the command. */
  unavailable?: (app: App) => string | undefined;
  hidden?: () => boolean;
  /** Never selected by default unless the query exactly names it. */
  destructive?: boolean;
  names?: readonly string[];
  classic?: string;
  run: (app: App, navigate: Navigate) => void;
}

const PAGE_SKIP = new Set<ShortcutId>([
  'list.next', 'list.prev', 'list.select', 'board.left', 'board.right', 'code.upAlt',
  'issue.state', 'issue.labels', 'issue.assignee', 'issue.milestone', 'issue.priority',
]);

const COMMANDS: PaletteCommand[] = [
  {id: 'undo', icon: UndoIcon, shortcut: 'undo', aliases: ['undo'], run: (app) => { undoLatest(app); }},
  {id: 'inbox', icon: InboxIcon, shortcut: 'go.inbox', aliases: ['inbox', 'notifications'], run: (_, nav) => void nav({to: '/notifications'})},
  {id: 'issues', icon: IssueOpenedIcon, shortcut: 'go.issues', aliases: ['my issues', 'issues'], run: (_, nav) => void nav({to: '/issues'})},
  {id: 'pulls', icon: GitPullRequestIcon, shortcut: 'go.pulls', aliases: ['my pull requests', 'pull requests', 'prs'], keywords: 'pr', run: (_, nav) => void nav({to: '/pulls'})},
  {id: 'create', icon: IssueOpenedIcon, shortcut: 'create', aliases: ['new issue', 'create issue', 'add issue', 'open an issue', 'file an issue'], run: (app) => {
    openCreate(app);
  }},
  {id: 'boards', icon: ProjectIcon, shortcut: 'go.board', aliases: ['board', 'boards', 'projects'], keywords: 'kanban', run: (app, nav) => {
    const id = app.session && lastBoard(app.session.userId);
    void nav(id ? {to: '/-/next/projects/$id', params: {id: String(id)}} : {to: '/-/next/boards'});
  }},
  {id: 'code', icon: CodeIcon, shortcut: 'go.code', aliases: ['go to the code', 'code', 'files', 'source'], keywords: 'tree browse',
    unavailable: (app) => (canGoToCode(app) ? undefined : GO_CODE_WHY), run: (app, nav) => {
      goToCode(app, nav);
    }},
  {id: 'home', icon: HomeIcon, shortcut: 'go.home', aliases: ['home', 'go home', 'dashboard'], run: (_, nav) => void nav({to: '/'})},
  {id: 'sidebar', icon: SidebarExpandIcon, shortcut: 'sidebar.toggle', aliases: ['hide the sidebar', 'show the sidebar', 'toggle the sidebar', 'collapse the sidebar'], run: () => {
    shortcuts.run('sidebar.toggle');
  }},
  {id: 'profile', label: 'Your profile', icon: PersonIcon, keywords: 'me account', run: (app, nav) => {
    const login = myLogin(app);
    if (login) void nav({to: '/$owner', params: {owner: login}});
  }},
  {id: 'my-repos', label: 'Your repositories', icon: RepoIcon, keywords: 'me mine', run: (app, nav) => {
    const login = myLogin(app);
    if (login) void nav({href: sitePath(app.config, `/${encodeURIComponent(login)}?tab=repositories`)});
  }},
  {id: 'my-stars', label: 'Your stars', icon: StarIcon, keywords: 'me starred', run: (app, nav) => {
    const login = myLogin(app);
    if (login) void nav({href: sitePath(app.config, `/${encodeURIComponent(login)}?tab=stars`)});
  }},
  {id: 'settings', label: 'Settings', icon: GearIcon, keywords: 'preferences profile account', run: (_, nav) => void nav({to: '/user/settings'})},
  {id: 'settings-account', label: 'Settings: Email addresses', icon: MailIcon, keywords: 'account emails password', run: (_, nav) => void nav({to: '/user/settings/account'})},
  {id: 'settings-appearance', label: 'Settings: Appearance', icon: PaintbrushIcon, keywords: 'theme language diff', run: (_, nav) => void nav({to: '/user/settings/appearance'})},
  {id: 'settings-keys', label: 'Settings: SSH and GPG keys', icon: KeyIcon, keywords: 'ssh gpg keys', run: (_, nav) => void nav({to: '/user/settings/keys'})},
  {id: 'new-repo', label: 'New repository', icon: RepoIcon, aliases: ['create a repository', 'new repo'], keywords: 'create repo', run: (_, nav) => void nav({to: '/repo/create'})},
  {id: 'new-migration', label: 'Import repository', icon: RepoPushIcon, keywords: 'new migration migrate mirror classic', classic: '/repo/migrate', run: () => undefined},
  {id: 'new-org', label: 'New organization', icon: OrganizationIcon, aliases: ['create an organization', 'new org'], keywords: 'create org team', run: (_, nav) => void nav({to: '/org/create'})},
  {id: 'explore', label: 'Explore', icon: TelescopeIcon, keywords: 'repositories people users organizations discover browse find public', run: (_, nav) => void nav({to: '/explore/repos', search: discoverySearch({})})},
  {id: 'shortcuts', label: 'Keyboard shortcuts', icon: KeyAsteriskIcon, shortcut: 'help.shortcuts', keywords: 'help keys', run: (app) => {
    runInAction(() => {
      app.ui.shortcutsOpen = true;
    });
  }},
  {id: 'theme-dark', label: 'Switch to the dark theme', icon: MoonIcon, aliases: ['dark theme', 'dark mode'], keywords: 'appearance', hidden: () => themeState.preference === 'dark', run: () => {
    setThemePreference('dark');
  }},
  {id: 'theme-light', label: 'Switch to the light theme', icon: SunIcon, aliases: ['light theme', 'light mode'], keywords: 'appearance', hidden: () => themeState.preference === 'light', run: () => {
    setThemePreference('light');
  }},
  {id: 'theme-system', label: 'Follow the system theme', icon: DeviceDesktopIcon, aliases: ['system theme'], keywords: 'appearance', hidden: () => themeState.preference === 'system', run: () => {
    setThemePreference('system');
  }},
  {id: 'classic-page', label: 'Open this page in the classic UI', icon: BrowserIcon, keywords: 'old forgejo', run: (app) => {
    location.assign(classicHref(app, classicOfHere(app, currentSitePath(app), location.search)));
  }},
  {id: 'classic', label: 'Turn off Forgejo Next', icon: DeviceDesktopIcon, keywords: 'classic ui old forgejo switch', run: (app) => {
    if (!connectivity.online) notify(app, {tone: 'neutral', title: onlineOnly('The classic UI')});
    else switchToClassic(app);
  }},
  {id: 'sign-out', label: 'Sign out', icon: SignOutIcon, keywords: 'log out logout', destructive: true, names: ['sign out', 'signout', 'log out', 'logout'], run: (app) => {
    void requestSignOut(app);
  }},
];

function myLogin(app: App): string | undefined {
  return app.session?.data.pool.model('User').get(app.session.userId)?.get('login');
}

function currentSitePath(app: App): string {
  const sub = app.config.app_sub_url;
  return location.pathname.startsWith(`${sub}/`) ? location.pathname.slice(sub.length) : '/';
}

/** Measures search without subscribing to every entity read. */
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

/** Mounted only while open: every opening starts with a fresh query and immediately focused input. */
export function Palette() {
  const app = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement>(document.activeElement instanceof HTMLElement ? document.activeElement : document.body);
  const close = () => {
    runInAction(() => { app.ui.paletteOpen = false; });
  };
  return (
    <Dialog title="Command menu" width="xlarge" align="top" onClose={close} initialFocusRef={inputRef} returnFocusRef={returnFocusRef}
      renderHeader={({dialogLabelId, title}) => <h1 id={dialogLabelId} className="sr-only">{title}</h1>}
      renderFooter={() => <Dialog.Footer><p className="flex-1 text-sm text-muted">{TIP}</p></Dialog.Footer>}>
      <PaletteBody app={app} inputRef={inputRef} onChoose={() => {
        // Body cannot act as a focusable trigger: dialog cleanup must not steal the new page's focus.
        returnFocusRef.current = document.body;
      }}/>
    </Dialog>
  );
}

type Row = PaletteRow;

/** GitHub's command palette prefixes: each limits the results to one kind. */
const MODES = {'>': 'command', '#': 'issue', '@': 'owner', '/': 'file', '!': 'board'} as const;
type Mode = typeof MODES[keyof typeof MODES];
const TIP = 'Tip: type > for commands, # for issues and pull requests, @ for repositories and people, / for files, ! for boards.';
const MODE_HINTS: Record<Mode, string> = {
  command: 'Type the name of a command.',
  issue: 'Type to search issues and pull requests.',
  owner: 'Type to search repositories, people and organizations.',
  file: 'Type to search the files of this repository.',
  board: 'Type to search boards.',
};

function scoped(query: string): {mode: Mode | undefined; text: string} {
  const mode = MODES[query.charAt(0) as keyof typeof MODES] as Mode | undefined;
  return mode ? {mode, text: query.slice(1)} : {mode, text: query};
}

/** The kind of a row, from its value's prefix. */
const ROW_MODES: Partial<Record<string, Mode>> = {
  'cmd': 'command', 'act': 'command', 'page': 'command', 'repo-tab': 'command', 'repo-clone': 'command', 'view': 'command',
  'exact': 'issue', 'issue': 'issue', 'new': 'issue', 'server': 'issue', 'milestone': 'issue',
  'repo': 'owner', 'server-repo': 'owner', 'user': 'owner', 'server-user': 'owner',
  'file': 'file', 'board': 'board',
};
const rowMode = (value: string) => ROW_MODES[value.split(':', 1)[0] ?? ''];

interface Group {
  heading: string;
  rank: number;
  rows: Row[];
}

const NAMED_BONUS = 1.5;
const COMMAND_RANK = 50;

function commandLabel(c: PaletteCommand): string {
  return c.label ?? (c.shortcut ? KEYMAP[c.shortcut].label : c.id);
}

function PaletteBody({app, onChoose, inputRef}: {app: App; onChoose: () => void; inputRef: React.RefObject<HTMLInputElement | null>}) {
  const navigate = useNavigate();
  const pathname = useRouterState({select: (st) => st.location.pathname});
  const [query, setQuery] = useState(() => untracked(() => app.ui.paletteQuery));
  useEffect(() => {
    if (untracked(() => app.ui.paletteQuery)) runInAction(() => {
      app.ui.paletteQuery = '';
    });
  }, [app]);
  // Defer search so a full pool scan cannot block input.
  const deferred = useDeferredValue(query);
  const {mode, text} = scoped(deferred);
  const wants = (kind: Mode) => mode === undefined || mode === kind;
  const [searcher] = useState(() => new Searcher(app));
  const contextRepo = untracked(() => app.ui.repoOpen);
  const poolText = wants('issue') || wants('owner') ? text : '';
  const results = useMemo(() => searcher.run(poolText, contextRepo), [searcher, poolText, contextRepo]);
  const more = useMoreResults(app, poolText, results);
  const files = useFiles(app, untracked(() => app.ui.repoOpen || app.ui.recentRepo), wants('file') ? text : '');
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const pool = app.session?.data.pool;
  // Arrow keys re-render the body: scan the pool only when the query changes.
  const entities = useMemo(() => {
    const w = text.toLowerCase().split(/\s+/).filter(Boolean);
    if (!pool || !w.length) return {boards: [], milestones: [], people: []};
    return untracked(() => ({
      boards: mode === undefined || mode === 'board' ? searchBoards(pool, w) : [],
      milestones: mode === undefined || mode === 'issue' ? searchMilestones(pool, w) : [],
      people: mode === undefined || mode === 'owner' ? searchPeople(pool, w) : [],
    }));
  }, [pool, text, mode]);
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
  const matchName = (text: string) => (words.length ? startScore(text.toLowerCase(), words) : 0);
  const [target] = useState(() => untracked(() => issuesOf(app, app.ui.issueTarget)));
  const [onPage] = useState(() => shortcuts.available().filter((id) => !PAGE_SKIP.has(id)));
  const groups: Group[] = [];
  const add = (heading: string, rank: number, rows: Row[]) => {
    if (rows.length) groups.push({heading, rank, rows});
  };
  const best = (scores: number[]) => (scores.length ? Math.max(...scores) : -1);
  const actionRank = (s: number) => (s >= 2 * words.length ? COMMAND_RANK + s : s + NAMED_BONUS);

  add('Go to', 100, (results.exact ?? []).filter((r) => r.repo).map(({issue, repo}) => ({
    value: `exact:${String(issue.id)}`, leading: issueGlyph(issue), meta: `${repo?.full_name ?? ''}#${String(issue.number)}`, label: issue.title,
    run: openIssue(issue, repo),
  })));

  const onScreen = untracked(() => target.length === 1 && target[0]?.id === app.ui.issueOpen);
  const actionList = untracked(() => issueActions(app, target, {navigate: (path) => void navigate({to: path})}))
    .filter((a) => !onScreen || (a.id !== 'open' && a.id !== 'classic'))
    .map((a) => ({a, s: matchName(`${a.label} ${a.keywords ?? ''}`)})).filter((x) => x.s >= 0);
  const targetName = untracked(() => (target.length === 1 ? `#${String(target[0]?.data.number)} ${target[0]?.data.title ?? ''}` : `${String(target.length)} selected`));
  add(targetName, words.length ? actionRank(best(actionList.map((x) => x.s))) : 90, actionList.map(({a}) => ({
    // Prevent Enter immediately after opening the palette from closing an issue.
    value: `act:${a.id}`, icon: a.icon, shortcut: a.shortcut && !shortcuts.shadowed(a.shortcut) ? KEYMAP[a.shortcut].keys : undefined, label: a.label, destructive: a.id === 'state' && !words.length, run: () => {
      a.run();
    },
  })));

  const shortcutMatch = (id: ShortcutId) => {
    const keys = KEYMAP[id].keys.replaceAll('+', ' ');
    return words.length && keys === words.join(' ') ? 3 * COMMAND_RANK : matchName(keys);
  };
  const splat = /^\/[^/]+\/[^/]+\/(.+)$/.exec(pathname)?.[1];
  const codeRoute = splat === undefined ? undefined : parseCodePath(splat.split('/').map(decodeURIComponent).join('/'));
  const atCodeRoot = untracked(() => {
    const pool = app.session?.data.pool;
    return Boolean(pool && codeRoute?.view === 'src' && resolveRef(refTable(pool, contextRepo), codeRoute.kind, codeRoute.rest)?.path === '');
  });
  const pageList = onPage.map((id) => ({id, s: Math.max(matchName(KEYMAP[id].label), shortcutMatch(id))})).filter((x) => x.s >= 0);
  add('On this page', words.length ? actionRank(best(pageList.map((x) => x.s))) : 80, pageList.map(({id}) => ({
    value: `page:${id}`, icon: ArrowRightIcon,
    muted: id === 'code.up' && atCodeRoot,
    meta: id === 'code.up' && atCodeRoot ? 'Already at the repository root' : undefined,
    shortcut: KEYMAP[id].keys, alternateShortcut: id === 'code.up' ? KEYMAP['code.upAlt'].keys : undefined, label: KEYMAP[id].label,
    // Run after close so focus is back on the page.
    run: () => requestAnimationFrame(() => {
      if (id === 'code.up' && atCodeRoot) {
        notify(app, {tone: 'neutral', title: 'Already at the repository root'});
      } else shortcuts.run(id);
    }),
  })));

  const repo = untracked(() => app.session?.data.pool.model('Repository').get(contextRepo)?.data);
  if (repo) {
    const base = `/${encodeURIComponent(repo.owner_name)}/${encodeURIComponent(repo.name)}`;
    const sections = ['Issues', 'Pull requests', 'Commits', 'Branches', 'Releases', 'Actions', 'Wiki', 'Activity', 'Projects',
      ...app.session && repoAccess(app.session, contextRepo) === 'admin' ? ['Settings'] : []];
    const rows = sections.map((label) => ({label, s: Math.max(matchName(label), matchName(`Go to ${label} of ${repo.full_name}`))})).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s);
    add('This repository', words.length ? actionRank(best(rows.map((x) => x.s))) + COMMAND_RANK : 75, rows.map(({label}) => ({
      value: `repo-tab:${label}`, icon: RepoIcon, label: `Go to ${label} of ${repo.full_name}`, meta: label === 'Projects' ? 'classic UI' : undefined,
      run: () => {
        const section = label === 'Pull requests' ? 'pulls' : label.toLowerCase();
        if (['commits', 'branches', 'releases', 'actions'].includes(section)) {
          const path = section === 'commits' ? `commits/branch/${repo.default_branch}` : section;
          void navigate(codeTo(repo.owner_name, repo.name, path));
        } else if (section === 'projects') location.assign(classicHref(app, `${base}/projects`));
        else void navigate({to: `${base}/${section}`});
      },
    })));
    if (matchName('Copy the clone URL') >= 0) add('Clone', words.length ? COMMAND_RANK + 10 : 74, [{
      value: 'repo-clone', icon: CodeIcon, label: 'Copy the clone URL', run: () => {
        void navigator.clipboard.writeText(httpsCloneUrl(app.config.app_url, repo.owner_name, repo.name)).then(() => {
          notify(app, {tone: 'success', title: 'Copied'});
        }, () => { notify(app, {tone: 'neutral', title: 'Could not copy'}); });
      },
    }]);
  }

  const views = untracked(() => (app.session ? viewStore(app.session.userId).views.slice() : [])).map((v) => ({v, s: match(v.name)})).filter((x) => x.s >= 0);
  add('Views', words.length ? best(views.map((x) => x.s)) + NAMED_BONUS : 70, views.map(({v}) => ({
    value: `view:${v.id}`, icon: StackIcon, label: v.name, run: () => {
      if (app.session) viewStore(app.session.userId).open(v.id);
      void navigate({to: v.path, search: v.search as never});
    },
  })));

  if (words.length) {
    const shownRepoIds = new Set(results.repos.map((r) => r.id));
    const namedOnServer = more.repos.filter((r) => !shownRepoIds.has(r.id))
      .map((r) => ({r, s: repoScore(r.fullName.toLowerCase(), r.name.toLowerCase(), words)})).filter((x) => x.s >= SERVER_REPO_NAMED);
    add('Repositories', best([results.top?.repos ?? -1, ...namedOnServer.map((x) => x.s)]) + NAMED_BONUS, [
      ...results.repos.map((r) => ({
        value: `repo:${String(r.id)}`, icon: RepoIcon, meta: r.description, label: r.full_name,
        run: () => void navigate({to: '/$owner/$repo', params: {owner: r.owner_name, repo: r.name}}),
      })),
      ...namedOnServer.map(({r}) => ({
        value: `server-repo:${String(r.id)}`, icon: RepoIcon, meta: r.description, label: r.fullName,
        run: () => void navigate({to: '/$owner/$repo', params: {owner: r.owner, repo: r.name}}),
      })),
    ]);
    for (const {r} of namedOnServer) shownRepoIds.add(r.id);
    const shownPeople = new Set<number>();
    {
      const {boards, milestones, people} = entities;
      add('Boards', best(boards.map((b) => b.score)) + NAMED_BONUS, boards.map(({item: b, repo}) => ({
        value: `board:${String(b.id)}`, icon: ProjectIcon, meta: repo?.full_name, label: b.title,
        run: () => void navigate({to: '/-/next/projects/$id', params: {id: String(b.id)}}),
      })));
      add('Milestones', best(milestones.map((m) => m.score)) + NAMED_BONUS, milestones.map(({item: m, repo}) => ({
        value: `milestone:${String(m.id)}`, icon: MilestoneIcon, meta: repo?.full_name, label: m.title,
        run: () => {
          if (repo) void navigate({to: '/$owner/$repo/milestone/$index', params: {owner: repo.owner_name, repo: repo.name, index: String(m.id)}});
        },
      })));
      for (const p of people) shownPeople.add(p.item.id);
      add('People', best(people.map((p) => p.score)) + 1, people.map(({item: u}) => ({
        value: `user:${String(u.id)}`, icon: u.type === 'organization' ? OrganizationIcon : PersonIcon, meta: u.full_name, label: u.login,
        run: () => void navigate({to: '/$owner', params: {owner: u.login}}),
      })));
    }
    add('Files', best(files.map((f) => f.score / 2)) + 1, files.map((f) => ({
      value: `file:${f.owner}/${f.repo}/${f.path}`, icon: FileCodeIcon, meta: `${f.owner}/${f.repo}`, label: f.path,
      run: () => void navigate(codeTo(f.owner, f.repo, `src/branch/${f.ref}/${f.path}`)),
    })));
    const pending = untracked(() => (editing(app).overlay.created('Issue') as Entity<'Issue'>[])
      .map((e) => ({e, s: score(e.data.title.toLowerCase(), words)})).filter((x) => x.s >= 0)
      .map(({e, s}) => ({e, s, path: issuePath(app, e), repo: app.session?.data.pool.model('Repository').get(e.data.repo_id)?.data})));
    add('Not synced yet', best(pending.map((x) => x.s)), pending.flatMap(({e, path, repo}) => (path ? [{
      value: `new:${String(e.id)}`, icon: UploadIcon, meta: `${repo?.full_name ?? ''} · pending`, label: e.data.title,
      run: () => void navigate({to: path}),
    }] : [])));
    add('Issues and pull requests', results.top?.issues ?? -1, [...results.issues, ...more.local].filter((r) => r.repo).map(({issue, repo}) => ({
      value: `issue:${String(issue.id)}`, leading: issueGlyph(issue), meta: `${repo?.full_name ?? ''}#${String(issue.number)}`, label: issue.title,
      run: openIssue(issue, repo),
    })));
    add('On Forgejo', 0, [
      ...more.repos.filter((r) => !shownRepoIds.has(r.id)).map((r) => ({
        value: `server-repo:${String(r.id)}`, icon: RepoIcon, meta: r.description, label: r.fullName,
        run: () => void navigate({to: '/$owner/$repo', params: {owner: r.owner, repo: r.name}}),
      })),
      ...more.users.filter((u) => !shownPeople.has(u.id)).map((u) => ({
        value: `server-user:${String(u.id)}`, icon: u.organization ? OrganizationIcon : PersonIcon, meta: u.fullName, label: u.login,
        run: () => void navigate({to: '/$owner', params: {owner: u.login}}),
      })),
      ...more.server.map((h) => ({
        value: `server:${String(h.id)}`, leading: <StateGlyph look={stateLook(h.state, h.pull, false)}/>, meta: `${h.fullName}#${String(h.number)}`, label: h.title,
        run: () => void navigate({
          to: h.pull ? '/$owner/$repo/pulls/$index' : '/$owner/$repo/issues/$index',
          params: {owner: h.owner, repo: h.repo, index: String(h.number)},
        }),
      })),
    ]);
  }

  // Explicit command names outrank fuzzy titles; keyword-only matches get no priority.
  const commands = untracked(() => COMMANDS.filter((c) => !c.hidden?.()).map((c) => {
    const label = commandLabel(c);
    const s = Math.max(matchName(label), ...(c.aliases ?? []).map((a) => matchName(a)), c.shortcut ? shortcutMatch(c.shortcut) : -1);
    return {c, label, s, k: matchName(`${label} ${(c.aliases ?? []).join(' ')} ${c.keywords ?? ''}`)};
  })).filter((x) => x.k >= 0 || x.s >= 0).sort((a, b) => b.s - a.s);
  const typed = words.join(' ');
  const named = (c: PaletteCommand) => (c.names?.includes(typed) ?? false) || (c.aliases?.includes(typed) ?? false);
  const whole = 2 * words.length;
  add('Commands', words.length ? best(commands.map((x) => (named(x.c) ? 100 : x.s >= whole ? COMMAND_RANK + x.s : x.s >= 0 ? x.s + NAMED_BONUS : x.k))) : 60, commands.map(({c, label}) => {
    const why = untracked(() => c.unavailable?.(app));
    return {
      value: `cmd:${c.id}`, icon: c.icon, shortcut: c.shortcut && KEYMAP[c.shortcut].keys, label, destructive: c.destructive && !named(c),
      meta: why ?? (c.classic ? 'classic UI' : undefined), muted: why !== undefined,
      run: why !== undefined ? () => {
        // Keep disabled commands selectable so Enter explains the refusal, not a different action.
        notify(app, {tone: 'neutral', title: why});
      } : c.classic ? () => {
        location.assign(classicHref(app, c.classic ?? '/'));
      } : () => {
        c.run(app, navigate);
      },
    };
  }));

  if (mode) {
    for (const g of groups) g.rows = g.rows.filter((r) => rowMode(r.value) === mode);
    groups.splice(0, groups.length, ...groups.filter((g) => g.rows.length));
  }
  groups.sort((a, b) => b.rank - a.rank);
  const values = groups.flatMap((g) => g.rows.map((r) => r.value));
  const sig = `${deferred}\u0000${values.join('\u0000')}`;
  const rows = groups.flatMap((g) => g.rows);
  const first = rows[0]?.destructive ? '' : rows.find((r) => !(r.muted && r.value === 'page:code.up'))?.value ?? '';
  const [sel, setSel] = useState({sig: '', value: ''});
  let selected = sel.value;
  if (sel.sig !== sig) {
    selected = first;
    setSel({sig, value: first});
  }
  // Search links must not replace a deliberately empty default for a destructive command.
  const searched = scoped(query).text.trim();
  const searchRows: Row[] = searched && mode !== 'command' ? [
    {value: 'search:all', label: 'See all results', run: () => {
      void navigate({to: '/search', search: {q: searched, type: mode === 'issue' ? 'issues' : 'repositories', sort: 'updated', state: 'all', archived: '', language: '', page: 1}});
    }},
    ...repo ? [{value: 'search:repo-code', label: `Search code in ${repo.full_name} for ${searched}`, run: () => {
      void navigate({to: '/search', search: {q: searched, type: 'code', repoId: repo.id, sort: 'updated', state: 'all', archived: '', language: '', page: 1}});
    }}] : [],
    {value: 'search:code', label: `Search code for ${searched}`, run: () => {
      void navigate({to: '/search', search: {q: searched, type: 'code', sort: 'updated', state: 'all', archived: '', language: '', page: 1}});
    }},
  ] : [];
  return (
    <PaletteList inputRef={inputRef} query={query} onQueryChange={setQuery} selected={selected}
      onSelectedChange={(value) => { setSel({sig, value}); }}
      onChoose={(r) => { (r.muted ? r.run : run(r.run))(); }}
      groups={[...groups, ...searchRows.length ? [{heading: 'Search', rows: searchRows}] : []]}
      empty={!groups.length ? mode && !words.length ? MODE_HINTS[mode] : !words.length || !more.asked ? 'Nothing found on this device.' : more.answered ? 'Nothing found on this device or on Forgejo.' : 'Nothing on this device. Asking Forgejo…' : null}/>
  );

  function issueGlyph(issue: Issue) {
    const pool = app.session?.data.pool;
    return <StateGlyph look={stateLook(issue.state, issue.is_pull, Boolean(issue.is_pull && pool && isMerged(pool, issue.id)))}/>;
  }

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

interface More {
  local: {issue: Issue; repo: Repository | undefined}[];
  server: ServerHit[];
  repos: ServerRepo[];
  users: ServerUser[];
  asked?: boolean | undefined;
  answered?: boolean | undefined;
}

const NONE: More = {local: [], server: [], repos: [], users: []};
const SERVER_REPO_NAMED = 4;
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
      ask('users', Promise.all([searchServerUsers(app, q, ctl.signal).catch(() => []), searchServerOrgs(app, q, ctl.signal).catch(() => [])]).then((parts) => parts.flat()));
    }, SERVER_DELAY) : undefined;
    return () => {
      ctl.abort();
      clearTimeout(timer);
    };
  }, [app, query, scan]);
  // Keep prior answers while loading to avoid flicker; exclude issues already listed by the scan.
  return useMemo(() => {
    const q = query.trim().toLowerCase();
    const a = answer.query.trim().toLowerCase();
    if (!q || !a || !(q.startsWith(a) || a.startsWith(q))) return NONE;
    const shown = shownIssues(scan);
    const local = answer.value.local.filter((r) => !shown.has(r.issue.id));
    for (const r of local) shown.add(r.issue.id);
    const server = answer.value.server.filter((h) => !shown.has(h.id));
    const {repos, users} = answer.value;
    // Status must describe this query, not the previous answers.
    const status = q === a ? {asked: answer.value.asked, answered: answer.value.answered} : {};
    return local.length || server.length || repos.length || users.length || status.asked ? {local, server, repos, users, ...status} : NONE;
  }, [answer, query, scan]);
}

function shownIssues(scan: SearchResults): Set<number> {
  return new Set([...scan.issues, ...scan.exact ?? []].map((r) => r.issue.id));
}
