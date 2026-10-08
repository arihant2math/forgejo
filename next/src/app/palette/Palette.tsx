// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The ⌘K palette (PLAN §5.6): commands, and repositories, issues and pull
// requests found in the in-memory pool (search.ts) as you type. Its own
// chunk, preloaded when the app is idle.

import {useNavigate} from '@tanstack/react-router';
import {CircleDot, CircleCheck, GitPullRequest, GitPullRequestClosed, Home, Inbox, Keyboard, LogOut, Monitor, Moon, SunMoon, Sun, BookMarked} from 'lucide-react';
import {runInAction, untracked} from 'mobx';
import {useMemo, useState} from 'react';
import {CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList} from '../../ui/Command.tsx';
import type {LucideIcon} from '../../ui/index.ts';
import {requestSignOut, switchToClassic} from '../session.ts';
import {shortcutHint, type ShortcutId} from '../shortcuts/index.ts';
import {type App, useApp} from '../store.ts';
import {setThemePreference} from '../theme.ts';
import {score, searchPool, type SearchResults} from './search.ts';

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

const COMMANDS: PaletteCommand[] = [
  {id: 'inbox', label: 'Go to the inbox', icon: Inbox, shortcut: 'go.inbox', keywords: 'notifications', run: (_, nav) => void nav({to: '/notifications'})},
  {id: 'issues', label: 'Go to my issues', icon: CircleDot, shortcut: 'go.issues', run: (_, nav) => void nav({to: '/issues'})},
  {id: 'pulls', label: 'Go to my pull requests', icon: GitPullRequest, shortcut: 'go.pulls', keywords: 'pr', run: (_, nav) => void nav({to: '/pulls'})},
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
    switchToClassic(app);
  }},
  {id: 'sign-out', label: 'Sign out', icon: LogOut, keywords: 'log out logout', run: (app) => {
    void requestSignOut(app);
  }},
];

/** Searches the pool, timed (User Timing measure "palette:search"). Untracked: no subscriptions to what it read. */
function search(app: App, query: string): SearchResults {
  const s = app.session;
  if (!s || !query.trim()) return {repos: [], issues: []};
  const t0 = performance.now();
  const results = untracked(() => searchPool(s.data.pool, query, {extraRepos: s.data.peek('Repository')}));
  try {
    performance.measure('palette:search', {start: t0, end: performance.now(), detail: {query: query.length}});
  } catch {
    // No User Timing.
  }
  return results;
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
  const results = useMemo(() => search(app, query), [app, query]);
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
  const nothing = !commands.length && !results.repos.length && !results.issues.length;
  return (
    <>
      <CommandInput value={query} onValueChange={setQuery} placeholder="Search repositories, issues and commands…"/>
      <CommandList>
        {nothing && <CommandEmpty>Nothing found on this device.</CommandEmpty>}
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
        {results.issues.length > 0 && (
          <CommandGroup heading="Issues and pull requests">
            {results.issues.map(({issue, repo}) => repo && (
              <CommandItem key={issue.id} value={`issue:${String(issue.id)}`}
                icon={issue.is_pull ? (issue.state === 'open' ? GitPullRequest : GitPullRequestClosed) : (issue.state === 'open' ? CircleDot : CircleCheck)}
                meta={`${repo.full_name}#${String(issue.number)}`}
                onSelect={run(() => void navigate({
                  to: issue.is_pull ? '/$owner/$repo/pulls/$index' : '/$owner/$repo/issues/$index',
                  params: {owner: repo.owner_name, repo: repo.name, index: String(issue.number)},
                }))}>
                {issue.title}
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
