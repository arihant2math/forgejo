// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The boards on this device (/-/next/boards): every project the viewer's
// groups hold — repositories', organizations' and their own — and the boards
// of other owners known by reference (a user's board shared through a
// repository the viewer reads), open ones first, by owner. A short list:
// projects are few. J/K walk them, Enter opens one, and Back finds the cursor
// on the board it opened.

import {Link, useNavigate} from '@tanstack/react-router';
import {useLayoutEffect, useState} from 'react';
import {rememberedRow, rememberRow} from '../../app/listReturn.ts';
import {useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {KanbanSquare} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {PageBody, PageColumn} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import type {Project} from '../../protocol/types.gen.ts';
import {ClassicLink} from '../../app/ClassicLink.tsx';
import {Badge, EmptyState, Entry, EntryList, Icon, Panel, TextLink} from '../../ui/index.ts';
import {usePool} from '../issues/cells.tsx';

interface Place {
  key: string;
  /** The repository's owner and name, or the owner alone. */
  owner: string;
  repo?: string | undefined;
}

/** A board of the list: a Project, or (`ref`) the reference of another owner's board, which opens and loads it. */
type Board = Pick<Project, 'id' | 'title' | 'closed' | 'owner_id'> & {repo_id: number; description: string; ref?: boolean};

const LIST = '/-/next/boards';

export const BoardsList = observer(function BoardsList() {
  const pool = usePool();
  const projects: Board[] = [...pool.model('Project').all()].map((e) => e.data);
  for (const e of pool.model('ProjectRef').all()) {
    if (!pool.model('Project').get(e.id)) projects.push({...e.data, repo_id: 0, description: '', ref: true});
  }
  const place = (p: Board): Place => {
    const r = pool.model('Repository').get(p.repo_id)?.data;
    if (r) return {key: r.full_name, owner: r.owner_name, repo: r.name};
    const u = pool.model('User').get(p.owner_id)?.data;
    return {key: u?.login ?? '', owner: u?.login ?? ''};
  };
  const groups = new Map<string, {place: Place; list: Board[]}>();
  for (const p of projects.sort((a, b) => Number(a.closed) - Number(b.closed) || a.title.localeCompare(b.title))) {
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
      <PageHeader icon={KanbanSquare} title="Boards"/>
      <PageBody>
        {sorted.length === 0 ?
          <EmptyState icon={KanbanSquare} title="No boards on this device" description="Projects of your repositories and organizations show here."/> :
          <PageColumn>
            {sorted.map(({place: pl, list}) => (
              <Panel key={pl.key} label={pl.key || 'Other'} padded
                title={pl.repo ?
                  <TextLink><Link to="/$owner/$repo" params={{owner: pl.owner, repo: pl.repo}}>{pl.key}</Link></TextLink> :
                  pl.owner ? <TextLink><Link to="/$owner" params={{owner: pl.owner}}>{pl.owner}</Link></TextLink> : 'Other'}
                actions={pl.owner && (
                  <ClassicLink size="sm" to={pl.repo ? `/${encodeURIComponent(pl.owner)}/${encodeURIComponent(pl.repo)}/projects/new` : `/${encodeURIComponent(pl.owner)}/-/projects/new`}>New board</ClassicLink>
                )}>
                <EntryList>
                  {list.map((p) => <BoardEntry key={p.id} project={p} active={p.id === cursor} onOpen={() => {
                    rememberRow(LIST, p.id);
                  }}/>)}
                </EntryList>
              </Panel>
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
    <Entry
      id={`board-${String(project.id)}`}
      active={active}
      leading={<Icon icon={KanbanSquare}/>}
      title={<TextLink><Link to="/-/next/projects/$id" params={{id: String(project.id)}} onClick={onOpen}>{project.title}</Link></TextLink>}
      // A board known by reference loads when opened: its columns and cards are not counted here yet.
      meta={project.ref ? 'Shared with you' : `${String(columns)} ${columns === 1 ? 'column' : 'columns'} · ${String(cards)} ${cards === 1 ? 'card' : 'cards'}`}
      description={project.description || undefined}
      actions={project.closed ? <Badge tone="done">Closed</Badge> : undefined}
    />
  );
});
