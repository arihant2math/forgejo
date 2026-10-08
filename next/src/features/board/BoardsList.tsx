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
import {Badge, EmptyState, Entry, EntryList, Icon, SectionHeading, TextLink} from '../../ui/index.ts';
import {usePool} from '../issues/cells.tsx';

export const BoardsList = observer(function BoardsList() {
  const pool = usePool();
  const projects = [...pool.model('Project').all()].map((e) => e.data);
  const owner = (p: Project) => pool.model('Repository').get(p.repo_id)?.get('full_name') ?? pool.model('User').get(p.owner_id)?.get('login') ?? '';
  const groups = new Map<string, Project[]>();
  for (const p of projects.sort((a, b) => Number(a.closed) - Number(b.closed) || a.title.localeCompare(b.title))) {
    const k = owner(p);
    let g = groups.get(k);
    if (!g) groups.set(k, g = []);
    g.push(p);
  }
  const sorted = [...groups].sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <>
      <PageHeader icon={KanbanSquare} title="Boards"/>
      <PageBody>
        {sorted.length === 0 ?
          <EmptyState icon={KanbanSquare} title="No boards on this device" description="Projects of your repositories and organizations show here."/> :
          <div className="mx-auto flex max-w-lg flex-col gap-6 px-4 py-6">
            {sorted.map(([name, list]) => (
              <section key={name} aria-labelledby={`boards-${name}`}>
                <SectionHeading id={`boards-${name}`}>{name || 'Other'}</SectionHeading>
                <EntryList>
                  {list.map((p) => <BoardEntry key={p.id} project={p}/>)}
                </EntryList>
              </section>
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
