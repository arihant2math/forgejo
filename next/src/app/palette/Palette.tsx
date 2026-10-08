// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The ⌘K palette (PLAN §5.6): commands, and repositories, issues and pull
// requests found in the in-memory pool (search.ts) as you type. Its own
// chunk, preloaded when the app is idle.

import {useNavigate} from '@tanstack/react-router';
import {BookMarked, CircleCheck, CircleDot, GitPullRequest, GitPullRequestClosed, CornerDownRight, Globe, Home, Inbox, KanbanSquare, Layers, Keyboard, LogOut, Monitor, Moon, SquarePen, Sun, SunMoon} from 'lucide-react';
import {runInAction, untracked} from 'mobx';
import {useDeferredValue, useEffect, useMemo, useState} from 'react';
import {CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList} from '../../ui/Command.tsx';
import type {LucideIcon} from '../../ui/index.ts';
import {openCreate} from '../create.ts';
import {lastBoard} from '../lastBoard.ts';
import {notify} from '../notices.ts';
import {connectivity, onlineOnly} from '../online.ts';
import {requestSignOut, switchToClassic} from '../session.ts';
import {KEYMAP, shortcutHint, type ShortcutId, shortcuts} from '../shortcuts/index.ts';
import {type App, useApp} from '../store.ts';
import {setThemePreference} from '../theme.ts';
import {issueActions} from '../../features/issues/actions.ts';
import {issuesOf} from '../../features/issues/edits.ts';
import {localSearch} from '../../features/search/local.ts';
import {searchServer, type ServerHit} from '../../features/search/server.ts';
import {viewStore} from '../../features/views/views.ts';
import type {Issue, Repository} from '../../protocol/types.gen.ts';
import {type Narrowing, score, searchPool, type SearchResults} from './search.ts';

type Navigate = ReturnType<typeof useNavigate>;

interface PaletteCommand {
  id: string;
  label: string;
  icon: LucideIcon;
  shortcut?: ShortcutId;
  /** Extra words it is found by. */
  keywords?: string;
  run: (app: App, navigate: Navigate) => void;
}

/** Bound shortcuts not listed as page commands: movement (J/K/X/H/L), and the issue pickers (the issue's own group has them). */
const PAGE_SKIP = new Set<ShortcutId>([
  'list.next', 'list.prev', 'list.select', 'board.left', 'board.right',
  'issue.state', 'issue.labels', 'issue.assignee', 'issue.milestone', 'issue.priority',
]);

const COMMANDS: PaletteCommand[] = [
  {id: 'inbox', label: 'Go to the inbox', icon: Inbox, shortcut: 'go.inbox', keywords: 'notifications', run: (_, nav) => void nav({to: '/notifications'})},
  {id: 'issues', label: 'Go to my issues', icon: CircleDot, shortcut: 'go.issues', run: (_, nav) => void nav({to: '/issues'})},
  {id: 'pulls', label: 'Go to my pull requests', icon: GitPullRequest, shortcut: 'go.pulls', keywords: 'pr', run: (_, nav) => void nav({to: '/pulls'})},
  {id: 'create', label: 'Create an issue', icon: SquarePen, shortcut: 'create', keywords: 'new issue', run: (app) => {
    openCreate(app);
  }},
  {id: 'boards', label: 'Go to the board', icon: KanbanSquare, shortcut: 'go.board', keywords: 'project kanban boards', run: (app, nav) => {
    const id = app.session && lastBoard(app.session.userId);
    void nav(id ? {to: '/-/next/projects/$id', params: {id: String(id)}} : {to: '/-/next/boards'});
  }},
  {id: 'home', label: 'Go home', icon: Home, keywords: 'dashboard', run: (_, nav) => void nav({to: '/'})},
  {id: 'shortcuts', label: 'Keyboard shortcuts', icon: Keyboard, shortcut: 'help.shortcuts', keywords: 'help keys', run: (app) => {
    runInAction(() => {
      app.ui.shortcutsOpen = true;
    });
  }},
  {id: 'theme-dark', label: 'Switch to the dark theme', icon: Moon, keywords: 'appearance', run: () => {
    setThemePreference('dark');
  }},
  {id: 'theme-light', label: 'Switch to the light theme', icon: Sun, keywords: 'appearance', run: () => {
    setThemePreference('light');
  }},
  {id: 'theme-system', label: 'Follow the system theme', icon: SunMoon, keywords: 'appearance', run: () => {
    setThemePreference('system');
  }},
  {id: 'classic', label: 'Switch to the classic UI', icon: Monitor, keywords: 'old forgejo', run: (app) => {
    // Online only (never queued): offline it says why instead.
    if (!connectivity.online) notify(app, {tone: 'neutral', title: onlineOnly('The classic UI')});
    else switchToClassic(app);
  }},
  {id: 'sign-out', label: 'Sign out', icon: LogOut, keywords: 'log out logout', run: (app) => {
    void requestSignOut(app);
  }},
];

/** Searches the pool, timed (User Timing measure "palette:search"). Untracked: no subscriptions to what it read. */
function search(app: App, query: string, narrow: Narrowing | undefined): SearchResults {
  const s = app.session;
  if (!s || !query.trim()) return {repos: [], issues: []};
  const t0 = performance.now();
  const results = untracked(() => searchPool(s.data.pool, query, {extraRepos: s.data.peek('Repository'), narrow}));
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
  run(query: string): SearchResults {
    const r = search(this.app, query, this.prev);
    this.prev = r.matched ? {query, matched: r.matched} : undefined;
    return r;
  }
}

/** The dialog stays mounted once opened (it fades out); each opening starts with an empty query. */
export function Palette({open}: {open: boolean}) {
  const app = useApp();
  const [opened, setOpened] = useState({open, n: 0});
  if (open !== opened.open) setOpened({open, n: open ? opened.n + 1 : opened.n});
  return (
    <CommandDialog open={open} onOpenChange={(o) => {
      runInAction(() => {
        app.ui.paletteOpen = o;
      });
    }} label="Command menu">
      <PaletteBody key={opened.n} app={app}/>
    </CommandDialog>
  );
}

function PaletteBody({app}: {app: App}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  // The input never waits for the search (a large pool's first keystroke scans it all);
  // each search narrows the previous one's matches while typing.
  const deferred = useDeferredValue(query);
  const [searcher] = useState(() => new Searcher(app));
  const results = useMemo(() => searcher.run(deferred), [searcher, deferred]);
  const more = useMoreResults(app, deferred, results);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const commands = words.length ? COMMANDS.filter((c) => score(`${c.label} ${c.keywords ?? ''}`.toLowerCase(), words) >= 0) : COMMANDS;
  const close = () => {
    runInAction(() => {
      app.ui.paletteOpen = false;
    });
  };
  const run = (fn: () => void) => () => {
    close();
    fn();
  };
  // The actions on the issues the keyboard is on (the list's selection or cursor, the open issue).
  const [target] = useState(() => untracked(() => issuesOf(app, app.ui.issueTarget)));
  const actions = untracked(() => issueActions(app, target, {navigate: (path) => void navigate({to: path})}))
    .filter((a) => !words.length || score(`${a.label} ${a.keywords ?? ''}`.toLowerCase(), words) >= 0);
  const targetName = untracked(() => (target.length === 1 ? `#${String(target[0]?.data.number)} ${target[0]?.data.title ?? ''}` : `${String(target.length)} selected`));
  // What the page on screen offers by key (inbox triage, board moves, save the view, comment…), as commands.
  const [onPage] = useState(() => shortcuts.available().filter((id) => !PAGE_SKIP.has(id)));
  const pageCommands = onPage.filter((id) => !words.length || score(KEYMAP[id].label.toLowerCase(), words) >= 0);
  const views = untracked(() => (app.session ? viewStore(app.session.userId).views.slice() : []))
    .filter((v) => !words.length || score(v.name.toLowerCase(), words) >= 0);
  const nothing = !pageCommands.length && !views.length && !commands.length && !actions.length && !results.repos.length && !results.issues.length && !more.local.length && !more.server.length;
  const openIssue = (issue: Issue, repo: Repository) => run(() => void navigate({
    to: issue.is_pull ? '/$owner/$repo/pulls/$index' : '/$owner/$repo/issues/$index',
    params: {owner: repo.owner_name, repo: repo.name, index: String(issue.number)},
  }));
  return (
    <>
      <CommandInput value={query} onValueChange={setQuery} placeholder="Search repositories, issues and commands…"/>
      <CommandList>
        {nothing && <CommandEmpty>Nothing found on this device.</CommandEmpty>}
        {actions.length > 0 && (
          <CommandGroup heading={targetName}>
            {actions.map((a) => (
              <CommandItem key={a.id} value={`act:${a.id}`} icon={a.icon} shortcut={a.shortcut && shortcutHint(a.shortcut)} onSelect={run(() => {
                a.run();
              })}>
                {a.label}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {results.repos.length > 0 && (
          <CommandGroup heading="Repositories">
            {results.repos.map((r) => (
              <CommandItem key={r.id} value={`repo:${String(r.id)}`} icon={BookMarked} meta={r.description}
                onSelect={run(() => void navigate({to: '/$owner/$repo/issues', params: {owner: r.owner_name, repo: r.name}}))}>
                {r.full_name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {(results.issues.length > 0 || more.local.length > 0) && (
          <CommandGroup heading="Issues and pull requests">
            {[...results.issues, ...more.local].map(({issue, repo}) => repo && (
              <CommandItem key={issue.id} value={`issue:${String(issue.id)}`}
                icon={issue.is_pull ? (issue.state === 'open' ? GitPullRequest : GitPullRequestClosed) : (issue.state === 'open' ? CircleDot : CircleCheck)}
                meta={`${repo.full_name}#${String(issue.number)}`}
                onSelect={openIssue(issue, repo)}>
                {issue.title}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {more.server.length > 0 && (
          <CommandGroup heading="On Forgejo">
            {more.server.map((h) => (
              <CommandItem key={`s${String(h.id)}`} value={`server:${String(h.id)}`} icon={Globe} meta={`${h.fullName}#${String(h.number)}`}
                onSelect={run(() => void navigate({
                  to: h.pull ? '/$owner/$repo/pulls/$index' : '/$owner/$repo/issues/$index',
                  params: {owner: h.owner, repo: h.repo, index: String(h.number)},
                }))}>
                {h.title}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {pageCommands.length > 0 && (
          <CommandGroup heading="On this page">
            {pageCommands.map((id) => (
              <CommandItem key={id} value={`page:${id}`} icon={CornerDownRight} shortcut={shortcutHint(id)} onSelect={run(() => {
                // After the palette closed (focus back on the page), as the key would.
                requestAnimationFrame(() => {
                  shortcuts.run(id);
                });
              })}>
                {KEYMAP[id].label}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {views.length > 0 && (
          <CommandGroup heading="Views">
            {views.map((v) => (
              <CommandItem key={v.id} value={`view:${v.id}`} icon={Layers} onSelect={run(() => void navigate({to: v.path, search: v.search as never}))}>
                {v.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {commands.length > 0 && (
          <CommandGroup heading="Commands">
            {commands.map((c) => (
              <CommandItem key={c.id} value={`cmd:${c.id}`} icon={c.icon} shortcut={c.shortcut && shortcutHint(c.shortcut)} onSelect={run(() => {
                c.run(app, navigate);
              })}>
                {c.label}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </>
  );
}

/** Local matches beyond the pool scan's (MiniSearch: prefixes, typos), then the server's beyond both. */
interface More {
  local: {issue: Issue; repo: Repository | undefined}[];
  server: ServerHit[];
}

const NONE: More = {local: [], server: []};
/** Typing pauses this long before the server is asked. */
const SERVER_DELAY = 300;

function useMoreResults(app: App, query: string, scan: SearchResults): More {
  const [answer, setAnswer] = useState<{query: string; value: More}>({query: '', value: NONE});
  useEffect(() => {
    const q = query.trim();
    const s = app.session;
    if (!q || !s) return undefined;
    const ctl = new AbortController();
    const shown = new Set(scan.issues.map((r) => r.issue.id));
    const pool = s.data.pool;
    const repoOf = (id: number) => pool.model('Repository').get(id)?.data ?? s.data.peek('Repository').get(id);
    const same = (a: {query: string}) => a.query === query;
    const ix = localSearch(app);
    void ix?.search(q, 20).then((a) => {
      if (ctl.signal.aborted) return;
      const local = untracked(() => a.hits.filter((h) => !shown.has(h.id)).map((h) => pool.model('Issue').get(h.id)?.data)
        .filter((i) => i !== undefined).map((issue) => ({issue, repo: repoOf(issue.repo_id)})).filter((r) => r.repo !== undefined)
        .slice(0, Math.max(0, 12 - shown.size)));
      // Nothing new (the scan filled the slots, as it usually does): no render.
      setAnswer((m) => (same(m) && !local.length && !m.value.local.length ? m : {query, value: {local, server: same(m) ? m.value.server : []}}));
    }).catch(() => undefined);
    const timer = q.length >= 2 && connectivity.online ? setTimeout(() => {
      void searchServer(app, q, ctl.signal).then((server) => {
        if (ctl.signal.aborted) return;
        setAnswer((m) => (same(m) && !server.length && !m.value.server.length ? m : {query, value: {local: same(m) ? m.value.local : [], server}}));
      }).catch(() => undefined);
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
    const shown = new Set(scan.issues.map((r) => r.issue.id));
    const local = answer.value.local.filter((r) => !shown.has(r.issue.id));
    for (const r of local) shown.add(r.issue.id);
    const server = answer.value.server.filter((h) => !shown.has(h.id));
    return local.length || server.length ? {local, server} : NONE;
  }, [answer, query, scan]);
}
