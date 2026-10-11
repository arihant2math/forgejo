// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {observer} from 'mobx-react-lite';
import {useEffect, useRef, useState} from 'react';
import {connectivity} from '../../app/online.ts';
import {useApp, useSession} from '../../app/store.ts';
import {loadRepo} from '../../app/repo.ts';
import type {Entity} from '../../data/entity.ts';
import {editing} from '../../intents/session.ts';
import {issueProject} from '../../intents/view.ts';
import {CommandDialog, CommandPick, type PickOption} from '../../ui/index.ts';
import {searchServer, type ServerHit} from '../search/server.ts';
import type {BoardModel} from './model.ts';
import {PencilIcon} from '@primer/octicons-react';

/**
 * A column's "Add existing issue…": the issues the board can hold (this device's, and what the server search finds)
 * to pick, then add at once. Cards are issues (Forgejo's boards hold nothing else), so the dialog says so and offers a
 * new issue in this column (`onCreate`: the create dialog, the text typed as its title) where no issue matches.
 */
export const AddExisting = observer(function AddExisting({model, project, columnId, onClose, onCreate}: {
  model: BoardModel; project: Entity<'Project'>; columnId: number; onClose: () => void; onCreate: (title: string) => void;
}) {
  const app = useApp();
  const {data} = useSession();
  const pool = data.pool;
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
  const options: PickOption[] = [...candidates.values()].filter((c) =>
    issueProject(pool, editing(app).overlay, c.id).project !== project.id &&
    words.every((w) => `${c.number} ${c.title}`.toLowerCase().includes(w)),
  ).map((c) => ({
    value: String(c.id), label: c.title, meta: `#${c.number}`, checked: selected.includes(c.id), keepOpen: true,
    onSelect: () => { setSelected((ids) => ids.includes(c.id) ? ids.filter((id) => id !== c.id) : [...ids, c.id]); },
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
  // Only once something is picked: an "Add 0" row would be the first (Enter's) choice, and do nothing. Choosing it
  // closes the dialog (CommandPick).
  if (selected.length) options.unshift({value: 'add', label: `Add ${String(selected.length)} selected ${selected.length === 1 ? 'issue' : 'issues'}`, onSelect: add});
  // Typed text is not a card: where nothing matches it says so, and Enter makes a new issue in this column instead,
  // titled with that text (a number searched for is no title).
  const typed = query.trim();
  const none = typed !== '' && matches === 0;
  const title = /^#?\d+$/.test(typed) ? '' : typed;
  options.push({
    value: 'new', label: title ? `New issue “${title}” in this column…` : 'New issue in this column…', icon: PencilIcon, keepOpen: true, onSelect: () => { onCreate(title); },
    ...(none ? {group: connectivity.online ? 'No issue matches' : 'No issue on this device matches'} : {}),
  });
  return <CommandDialog open label="Add existing issues" bare onOpenChange={(open) => { if (!open) onClose(); }}>
    <CommandPick label="Add existing issues" placeholder="Search by number or title…" query={query} onQueryChange={setQuery} filtered options={options} empty="No issues to add."
      target="Cards are issues: pick existing ones, or create a new issue in this column." onClose={onClose}/>
  </CommandDialog>;
});
