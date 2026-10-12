// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Forgejo marks drafts with a title prefix, so both controls queue an offline title edit.

import {observer} from 'mobx-react-lite';
import {runInAction} from 'mobx';
import {canWrite} from '../../app/access.ts';
import {useApp, useSession} from '../../app/store.ts';
import {useShortcut} from '../../app/shortcuts/index.ts';
import type {Entity} from '../../data/entity.ts';
import {notify} from '../../app/notices.ts';
import {editing} from '../../intents/session.ts';
import {issueTitle} from '../../intents/view.ts';
import {isDraftPull, draftTitle, wipPrefixes} from './draft.ts';
import {Button} from '@primer/react';

function useDraft(issue: Entity<'Issue'>) {
  const app = useApp();
  const session = useSession();
  const {overlay, intents} = editing(app);
  const title = issueTitle(overlay, issue);
  const prefixes = wipPrefixes(app.config);
  const draft = isDraftPull(app, overlay, issue);
  const allowed = issue.get('state') === 'open' && (issue.get('poster_id') === session.userId || canWrite(session, issue.get('repo_id')));
  const toggle = () => {
    const next = draftTitle(title, !draft, prefixes);
    if (!next.trim() || next.length > 255 || next === title) return;
    const setTitle = (to: string, base: string) => {
      runInAction(() => {
        intents.submit({kind: 'issue.title', issueId: issue.id, repoId: issue.get('repo_id'), title: to, base});
      });
    };
    setTitle(next, title);
    notify(app, {tone: 'neutral', series: 'draft', title: draft ? 'Marked as ready for review' : 'Converted to draft', action: {label: 'Undo', run: () => {
      setTitle(title, next);
    }}});
  };
  return {draft, allowed, toggle, canDraft: Boolean(prefixes[0])};
}

/** In the merge box of a draft, as on GitHub. */
export const ReadyForReview = observer(function ReadyForReview({issue}: {issue: Entity<'Issue'>}) {
  const {draft, allowed, toggle} = useDraft(issue);
  if (!draft) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 font-semibold text-default">This pull request is still a work in progress</span>
      {allowed && <Button size="small" type="button" onClick={toggle}>Ready for review</Button>}
    </div>
  );
});

/** Under the reviewers, as on GitHub; it also binds both draft shortcuts, since the sidebar is always there. */
export const ConvertToDraft = observer(function ConvertToDraft({issue}: {issue: Entity<'Issue'>}) {
  const {draft, allowed, toggle, canDraft} = useDraft(issue);
  useShortcut('pull.ready', toggle, allowed && draft);
  useShortcut('pull.draft', toggle, allowed && !draft && canDraft);
  if (!allowed || draft || !canDraft) return null;
  return (
    <p className="mt-2 text-sm text-muted">
      Still in progress? <Button variant="link" size="small" type="button" onClick={toggle}>Convert to draft</Button>
    </p>
  );
});
