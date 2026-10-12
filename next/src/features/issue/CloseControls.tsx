// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {DuplicateIcon, IssueClosedIcon, SkipIcon, TriangleDownIcon} from '@primer/octicons-react';
import {ActionList, ActionMenu, IconButton} from '@primer/react';
import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type RefObject, useState} from 'react';
import {useApp} from '../../app/store.ts';
import {LocalSelectPanel} from '../../components/LocalSelectPanel.tsx';
import type {PickOption} from '../../components/pickOptions.ts';
import type {Entity} from '../../data/entity.ts';
import {uuid} from '../../intents/intents.ts';
import {editing} from '../../intents/editing.ts';
import type {Label} from '../../protocol/types.gen.ts';
import {changeState, setWorkflowStatus} from '../issues/actions.ts';
import {repoLabels} from '../issues/candidates.ts';
import {usePool} from '../../app/store.ts';
import {kindRank, labelKind, scopedValue, statusStage} from '../issues/labels.ts';

export type CloseReason = 'completed' | 'not-planned';

/** Forgejo recognizes this convention as a bidirectional duplicate reference. */
export function duplicateComment(number: number, text: string): string {
  return `Duplicate of #${String(number)}${text.trim() ? `\n\n${text}` : ''}`;
}

/** Forgejo has no native close reason: not planned is the repository's canceled workflow status. */
export function closeStatuses(pool: ReturnType<typeof usePool>, repoId: number): {notPlanned: Label | undefined; duplicate: Label | undefined} {
  const canceled = repoLabels(pool, repoId).filter((l) => labelKind(l) === 'status' && statusStage(scopedValue(l.name)) === 'canceled')
    .sort((a, b) => kindRank('status', a.name) - kindRank('status', b.name));
  const duplicate = canceled.find((l) => /^duplicate/i.test(scopedValue(l.name)));
  return {notPlanned: canceled.find((l) => l !== duplicate), duplicate};
}

/** GitHub's close menu: the reason renames the close button; a duplicate is closed once its original is picked. */
export const CloseReasons = observer(function CloseReasons({issue, act, anchor, reason, notPlanned, onReason}: {
  issue: Entity<'Issue'>; act: (run: (text: string) => void) => void; anchor: RefObject<HTMLButtonElement | null>;
  reason: CloseReason; notPlanned: boolean; onReason: (reason: CloseReason) => void;
}) {
  const [picking, setPicking] = useState(false);
  return <>
    <ActionMenu>
      <ActionMenu.Anchor><IconButton icon={TriangleDownIcon} size="small" aria-label="Choose a close reason"/></ActionMenu.Anchor>
      <ActionMenu.Overlay width="medium"><ActionList selectionVariant="single">
        <ActionList.Item selected={reason === 'completed'} onSelect={() => { onReason('completed'); }}>
          <ActionList.LeadingVisual><IssueClosedIcon className="text-done"/></ActionList.LeadingVisual>Close as completed
          <ActionList.Description variant="block">Done, closed, fixed, resolved</ActionList.Description>
        </ActionList.Item>
        {notPlanned && <ActionList.Item selected={reason === 'not-planned'} onSelect={() => { onReason('not-planned'); }}>
          <ActionList.LeadingVisual><SkipIcon/></ActionList.LeadingVisual>Close as not planned
          <ActionList.Description variant="block">Won’t fix, can’t repro, stale</ActionList.Description>
        </ActionList.Item>}
        <ActionList.Item selected={false} onSelect={() => { setPicking(true); }}>
          <ActionList.LeadingVisual><DuplicateIcon/></ActionList.LeadingVisual>Close as duplicate
          <ActionList.Description variant="block">Duplicate of another issue</ActionList.Description>
        </ActionList.Item>
      </ActionList></ActionMenu.Overlay>
    </ActionMenu>
    {picking && <DuplicatePicker issue={issue} anchor={anchor} act={act} onClose={() => { setPicking(false); }}/>}
  </>;
});

const DuplicatePicker = observer(function DuplicatePicker({issue, anchor, act, onClose}: {
  issue: Entity<'Issue'>; anchor: RefObject<HTMLButtonElement | null>; act: (run: (text: string) => void) => void; onClose: () => void;
}) {
  const app = useApp();
  const pool = usePool();
  const [query, setQuery] = useState('');
  const repoId = issue.get('repo_id');
  const {duplicate} = closeStatuses(pool, repoId);
  const others = [...pool.model('Issue').by('repo_id', repoId)].map((e) => e.data)
    .filter((i) => i.id !== issue.id && !i.is_pull && i.number > 0)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const close = (number: number) => {
    act((text) => {
      runInAction(() => {
        editing(app).intents.submit({kind: 'comment.create', issueId: issue.id, repoId, tempId: uuid(), body: duplicateComment(number, text)});
        if (duplicate) setWorkflowStatus(app, [issue], duplicate);
        else changeState(app, [issue], 'closed');
      });
    });
  };
  // An issue that is not on this device can still be named by its number.
  const q = query.trim().replace(/^#/, '');
  const exact = /^[1-9]\d{0,15}$/.test(q) ? Number(q) : undefined;
  const options: PickOption[] = exact !== undefined && exact !== issue.get('number') && !others.some((i) => i.number === exact) ?
    [{value: `number-${String(exact)}`, label: `#${String(exact)}`, onSelect: () => { close(exact); }}] : [];
  for (const i of exact === undefined ? others : [...others.filter((o) => o.number === exact), ...others.filter((o) => o.number !== exact)]) {
    options.push({value: `issue-${String(i.id)}`, label: `#${String(i.number)} ${i.title}`, onSelect: () => { close(i.number); }});
  }
  return <LocalSelectPanel title="Close as duplicate of" placeholder="Duplicate of… (number or title)" empty="No other issue of this repository is on this device. Type an issue number to name one."
    unmatched="Type an issue number to name one that is not on this device."
    open onOpenChange={(open) => { if (!open) onClose(); }} anchorRef={anchor} query={query} onQueryChange={setQuery} options={options}/>;
});
