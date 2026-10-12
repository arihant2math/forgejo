// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {noun} from '../../app/words.ts';
import {observer} from 'mobx-react-lite';
import {useEffect, useRef, useState} from 'react';
import {connectivity} from '../../app/online.ts';
import {useApp, useSession} from '../../app/store.ts';
import {loadRepo} from '../../app/repo.ts';
import type {Entity} from '../../data/entity.ts';
import {editing} from '../../intents/session.ts';
import {issueProject} from '../../intents/view.ts';
import {SelectPanel, type SelectPanelItemInput as ItemInput} from '@primer/react';
import {searchServer, type ServerHit} from '../search/server.ts';
import type {BoardModel} from './model.ts';
import {PencilIcon} from '@primer/octicons-react';

export const AddExisting = observer(function AddExisting({model, project, columnId, onClose, onCreate}: {
  model: BoardModel; project: Entity<'Project'>; columnId: number; onClose: () => void; onCreate: (title: string) => void;
}) {
  const app = useApp();
  const {data} = useSession();
  const pool = data.pool;
  const anchorRef = useRef<HTMLElement>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ServerHit[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const repoId = project.get('repo_id');
  const owner = pool.model('User').get(project.get('owner_id'))?.get('login');
  useEffect(() => {
    setHits([]);
    if (!query.trim() || !connectivity.online) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void searchServer(app, query.replace(/^#/, ''), controller.signal, 50).then((found) => {
        if (!controller.signal.aborted) setHits(found);
      }).catch(() => { setHits([]); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [app, query]);
  const cache = useRef(new Map<number, {id: number; number: number; title: string; repoId: number; hit?: ServerHit}>());
  const candidates = cache.current;
  for (const issue of pool.model('Issue').all()) {
    const rid = issue.get('repo_id');
    if (repoId ? rid !== repoId : pool.model('Repository').get(rid)?.get('owner_id') !== project.get('owner_id')) continue;
    candidates.set(issue.id, {id: issue.id, number: issue.get('number'), title: issue.get('title'), repoId: rid});
  }
  for (const hit of hits) {
    const repo = [...pool.model('Repository').all()].find((r) => r.get('owner_name') === hit.owner && r.get('name') === hit.repo);
    if (repoId ? repo?.id !== repoId : hit.owner !== owner) continue;
    candidates.set(hit.id, {id: hit.id, number: hit.number, title: hit.title, repoId: repo?.id ?? 0, hit});
  }
  const words = query.toLowerCase().replace(/^#/, '').split(/\s+/).filter(Boolean);
  const options: ItemInput[] = [...candidates.values()].filter((c) =>
    issueProject(pool, editing(app).overlay, c.id).project !== project.id &&
    words.every((w) => `${c.number} ${c.title}`.toLowerCase().includes(w)),
  ).map((c) => ({
    id: c.id, text: c.title, trailingVisual: `#${c.number}`,
  }));
  const matches = options.length;
  const add = () => {
    for (const id of selected) {
      const candidate = candidates.get(id);
      if (!candidate) continue;
      if (pool.model('Issue').get(id)) model.setProject(id, project.id, columnId);
      else if (candidate.hit) {
        const hit = candidate.hit;
        void loadRepo(app, hit.owner, hit.repo).then((repo) => {
          if (!repo.repoId) return;
          editing(app).intents.submit({kind: 'issue.project', issueId: id, repoId: repo.repoId, projectId: project.id, columnId, base: 0});
        });
      }
    }
  };
  // Keep Enter's first choice useful: offer Add only after something is selected.
  if (selected.length) options.unshift({id: 'add', text: `Add ${String(selected.length)} selected ${noun(selected.length, 'issue', 'issues')}`, onAction: (_, event) => { event.preventDefault(); add(); onClose(); }});
  // Numeric searches are not issue titles.
  const typed = query.trim();
  const none = typed !== '' && matches === 0;
  const title = /^#?\d+$/.test(typed) ? '' : typed;
  options.push({
    id: 'new', text: title ? `New issue “${title}” in this column…` : 'New issue in this column…', leadingVisual: PencilIcon,
    onAction: (_, event) => { event.preventDefault(); onCreate(title); },
  });
  return <SelectPanel open variant="modal" renderAnchor={null} anchorRef={anchorRef} title="Add existing issues"
    subtitle="Cards are issues: pick existing ones, or create a new issue in this column."
    placeholderText="Search by number or title…" inputLabel="Search existing issues"
    filterValue={query} onFilterChange={setQuery} items={options}
    selected={selected.map((id) => ({id, text: candidates.get(id)?.title ?? String(id)}))}
    onSelectedChange={(items: ItemInput[]) => { setSelected(items.flatMap((item) => typeof item.id === 'number' ? [item.id] : [])); }}
    onOpenChange={(open, gesture) => { if (!open) { if (gesture === 'selection') add(); onClose(); } }}
    onCancel={onClose} showSelectedOptionsFirst={false} virtualized={options.length > 50}
    {...(none ? {notice: {variant: 'info' as const, text: connectivity.online ? 'No issue matches' : 'No issue on this device matches'}} : {})}
  />;
});
