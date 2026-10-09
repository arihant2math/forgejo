// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The boards on this device (/-/next/boards): every project the viewer's
// groups hold — repositories', organizations' and their own — open ones
// first, by owner. A short list: projects are few.

import {Link} from '@tanstack/react-router';
import {KanbanSquare} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {PageBody} from '../../app/shell/Frame.tsx';
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

export const BoardsList = observer(function BoardsList() {
  const pool = usePool();
  const projects = [...pool.model('Project').all()].map((e) => e.data);
  const place = (p: Project): Place => {
    const r = pool.model('Repository').get(p.repo_id)?.data;
    if (r) return {key: r.full_name, owner: r.owner_name, repo: r.name};
    const u = pool.model('User').get(p.owner_id)?.data;
    return {key: u?.login ?? '', owner: u?.login ?? ''};
  };
  const groups = new Map<string, {place: Place; list: Project[]}>();
  for (const p of projects.sort((a, b) => Number(a.closed) - Number(b.closed) || a.title.localeCompare(b.title))) {
    const pl = place(p);
    let g = groups.get(pl.key);
    if (!g) groups.set(pl.key, g = {place: pl, list: []});
    g.list.push(p);
  }
  const sorted = [...groups.values()].sort((a, b) => a.place.key.localeCompare(b.place.key));
  return (
    <>
      <PageHeader icon={KanbanSquare} title="Boards"/>
      <PageBody>
        {sorted.length === 0 ?
          <EmptyState icon={KanbanSquare} title="No boards on this device" description="Projects of your repositories and organizations show here."/> :
          <div className="mx-auto flex max-w-lg flex-col gap-4 px-4 py-6">
            {sorted.map(({place: pl, list}) => (
              <Panel key={pl.key} label={pl.key || 'Other'} padded
                title={pl.repo ?
                  <TextLink><Link to="/$owner/$repo" params={{owner: pl.owner, repo: pl.repo}}>{pl.key}</Link></TextLink> :
                  pl.owner ? <TextLink><Link to="/-/next/$owner" params={{owner: pl.owner}}>{pl.owner}</Link></TextLink> : 'Other'}
                actions={pl.owner && (
                  <ClassicLink size="sm" to={pl.repo ? `/${encodeURIComponent(pl.owner)}/${encodeURIComponent(pl.repo)}/projects/new` : `/${encodeURIComponent(pl.owner)}/-/projects/new`}>New board</ClassicLink>
                )}>
                <EntryList>
                  {list.map((p) => <BoardEntry key={p.id} project={p}/>)}
                </EntryList>
              </Panel>
            ))}
          </div>}
      </PageBody>
    </>
  );
});

const BoardEntry = observer(function BoardEntry({project}: {project: Project}) {
  const pool = usePool();
  const columns = pool.model('ProjectColumn').by('project_id', project.id).size;
  const cards = pool.model('ProjectIssue').by('project_id', project.id).size;
  return (
    <Entry
      leading={<Icon icon={KanbanSquare}/>}
      title={<TextLink><Link to="/-/next/projects/$id" params={{id: String(project.id)}}>{project.title}</Link></TextLink>}
      meta={`${String(columns)} ${columns === 1 ? 'column' : 'columns'} · ${String(cards)} ${cards === 1 ? 'card' : 'cards'}`}
      description={project.description || undefined}
      actions={project.closed ? <Badge tone="done">Closed</Badge> : undefined}
    />
  );
});
