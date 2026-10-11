// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The boards on this device (/-/next/boards): every project the viewer's
// groups hold — repositories', organizations' and their own — and the boards
// of other owners known by reference (a user's board shared through a
// repository the viewer reads), open ones first, by owner. A short list:
// projects are few. J/K walk them, Enter opens one, and Back finds the cursor
// on the board it opened.

import {getRouteApi, useNavigate} from '@tanstack/react-router';
import {useLayoutEffect, useState} from 'react';
import {rememberedRow, rememberRow} from '../../app/listReturn.ts';
import {useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {observer} from 'mobx-react-lite';
import {PageBody, PageColumn} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import type {Project} from '../../protocol/types.gen.ts';
import {useSession} from '../../app/store.ts';
import {useHold} from '../../app/repo.ts';
import {NewBoard, pendingBoards, type BoardScope} from './ProjectDialogs.tsx';
import {usePool} from '../issues/cells.tsx';
import {ProjectIcon} from '@primer/octicons-react';
import {Blankslate} from '@primer/react/experimental';
import {RouterLink} from '../../app/routerLinks.tsx';
import {Heading, Label, SegmentedControl, Text} from '@primer/react';

interface Place {
  key: string;
  scope: BoardScope;
  /** The repository's owner and name, or the owner alone. */
  owner: string;
  repo?: string | undefined;
}

/** A board of the list: a Project, or (`ref`) the reference of another owner's board, which opens and loads it. */
type Board = Pick<Project, 'id' | 'title' | 'closed' | 'owner_id'> & {repo_id: number; description: string; ref?: boolean};

const LIST = '/-/next/boards';

export const BoardsList = observer(function BoardsList() {
  const pool = usePool();
  const session = useSession();
  const {repoId, ownerId} = getRouteApi('/shell/-/next/boards').useSearch();
  const owner = ownerId ? pool.model('User').get(ownerId) : undefined;
  const scope = repoId ? {repo_id: repoId, owner_id: 0} : ownerId ? {repo_id: 0, owner_id: ownerId} : undefined;
  useHold(session.data, repoId ? `repo:${String(repoId)}` : ownerId ? `${owner?.get('type') === 'organization' ? 'org' : 'profile'}:${String(ownerId)}` : undefined);
  const [state, setState] = useState('open');
  const projects: Board[] = [...pool.model('Project').all()].map((e) => e.data);
  for (const e of pool.model('ProjectRef').all()) {
    if (!pool.model('Project').get(e.id)) projects.push({...e.data, repo_id: 0, description: '', ref: true});
  }
  const place = (p: Board): Place => {
    const r = pool.model('Repository').get(p.repo_id)?.data;
    if (r) return {key: r.full_name, owner: r.owner_name, repo: r.name, scope: {repo_id: r.id, owner_id: 0}};
    const u = pool.model('User').get(p.owner_id)?.data;
    return {key: u?.login ?? '', owner: u?.login ?? '', scope: {repo_id: 0, owner_id: p.owner_id}};
  };
  const groups = new Map<string, {place: Place; list: Board[]}>();
  for (const p of projects.sort((a, b) => Number(a.closed) - Number(b.closed) || a.title.localeCompare(b.title))) {
    if ((repoId && p.repo_id !== repoId) || (ownerId && (p.owner_id !== ownerId || p.repo_id)) || p.closed !== (state === 'closed')) continue;
    const pl = place(p);
    let g = groups.get(pl.key);
    if (!g) groups.set(pl.key, g = {place: pl, list: []});
    g.list.push(p);
  }
  const sorted = [...groups.values()].sort((a, b) => a.place.key.localeCompare(b.place.key));
  // J/K walk every board (in the order shown), Enter opens it: the keys of every other list.
  const order = sorted.flatMap((g) => g.list.map((p) => p.id));
  const [cursor, setCursor] = useState<number | undefined>();
  const navigate = useNavigate();
  const open = (id: number) => {
    rememberRow(LIST, id);
    void navigate({to: '/-/next/projects/$id', params: {id: String(id)}});
  };
  // Back from a board: the cursor on it, and the page has the keys (J/K/Enter go on from there).
  const hasBoards = order.length > 0;
  useLayoutEffect(() => {
    const back = rememberedRow(LIST);
    if (typeof back !== 'number' || cursor !== undefined || !order.includes(back)) return;
    setCursor(back);
    document.getElementById(`board-${String(back)}`)?.scrollIntoView({block: 'nearest'});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the boards are there
  }, [hasBoards]);
  useShortcutScope('list');
  const move = (d: number) => {
    if (!order.length) return;
    const at = cursor === undefined ? -1 : order.indexOf(cursor);
    const next = order[at < 0 ? (d > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, at + d))];
    setCursor(next);
    if (next !== undefined) document.getElementById(`board-${String(next)}`)?.scrollIntoView({block: 'nearest'});
  };
  useShortcut('list.next', () => {
    move(1);
  });
  useShortcut('list.prev', () => {
    move(-1);
  });
  useShortcut('list.open', () => {
    if (cursor !== undefined) open(cursor);
  }, true, () => cursor !== undefined);
  return (
    <>
      <PageHeader icon={ProjectIcon} title="Boards">
        <SegmentedControl aria-label="Board state" onChange={(index) => { setState(index === 1 ? 'closed' : 'open'); }}>
          <SegmentedControl.Button selected={state === 'open'}>Open</SegmentedControl.Button>
          <SegmentedControl.Button selected={state === 'closed'}>Closed</SegmentedControl.Button>
        </SegmentedControl>
        <NewBoard scope={scope}/>
      </PageHeader>
      <PageBody>
        {[...pendingBoards].filter(([, p]) => (!repoId || p.repo_id === repoId) && (!ownerId || p.owner_id === ownerId)).map(([key, p]) => <div key={key} className="flex items-center gap-3 p-3" aria-busy><ProjectIcon size={16}/><Text>{p.title}</Text><Text size="small">Creating board…</Text></div>)}
        {sorted.length === 0 ?
          <Blankslate><Blankslate.Visual><ProjectIcon size={24}/></Blankslate.Visual><Blankslate.Heading>{state === 'closed' ? 'No closed boards' : 'No open boards'}</Blankslate.Heading><Blankslate.Description>Projects of your repositories and organizations show here.</Blankslate.Description></Blankslate> :
          <PageColumn>
            {sorted.map(({place: pl, list}) => (
              <section key={pl.key} aria-label={pl.key || 'Other'} className="rounded-md border border-default">
                <header className="flex items-center justify-between gap-3 border-b border-default bg-muted p-3"><Heading as="h2" variant="small">{pl.repo ?
                  <RouterLink to="/$owner/$repo" params={{owner: pl.owner, repo: pl.repo}} activeOptions={{exact: true}} muted className="min-w-0 truncate">{pl.key}</RouterLink> :
                  pl.owner ? <RouterLink to="/$owner" params={{owner: pl.owner}} activeOptions={{exact: true}} muted className="min-w-0 truncate">{pl.owner}</RouterLink> : 'Other'}</Heading>
                {pl.owner && <NewBoard scope={pl.scope}/>}</header>
                <ul>
                  {list.map((p) => <BoardEntry key={p.id} project={p} active={p.id === cursor} onOpen={() => {
                    rememberRow(LIST, p.id);
                  }}/>)}
                </ul>
              </section>
            ))}
          </PageColumn>}
      </PageBody>
    </>
  );
});

const BoardEntry = observer(function BoardEntry({project, active, onOpen}: {project: Board; active: boolean; onOpen: () => void}) {
  const pool = usePool();
  const columns = pool.model('ProjectColumn').by('project_id', project.id).size;
  const cards = pool.model('ProjectIssue').by('project_id', project.id).size;
  return (
    <li id={`board-${String(project.id)}`} data-active={active ? '' : undefined} className="flex items-start gap-3 border-b border-muted p-3 last:border-b-0 data-active:bg-accent-muted">
      <ProjectIcon size={16} className="shrink-0 text-muted"/>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <RouterLink to="/-/next/projects/$id" params={{id: String(project.id)}} onClick={onOpen} className="min-w-0 truncate">{project.title}</RouterLink>
        <Text size="small">{project.ref ? 'Shared with you' : `${String(columns)} ${columns === 1 ? 'column' : 'columns'} · ${String(cards)} ${cards === 1 ? 'card' : 'cards'}`}</Text>
        {project.description && <Text size="small">{project.description}</Text>}
      </div>
      {project.closed && <Label variant="done">Closed</Label>}
    </li>
  );
});
