// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useState} from 'react';
import {observable} from 'mobx';
import {observer} from 'mobx-react-lite';
import {useApp, useSession} from '../../app/store.ts';
import {online, failureText} from '../../app/api.ts';
import {canWrite} from '../../app/access.ts';
import {reach} from '../../app/online.ts';
import {usePool} from '../issues/cells.tsx';
import {pullOf, poolHead} from '../../code/pull.ts';
import {conversationRoot} from './resolve.tsx';
import {editing} from '../../intents/session.ts';
import type {Comment} from '../../protocol/types.gen.ts';
import {CodeLine, LineNo} from '../../code/parts.tsx';
import {parseDiff, DEL} from '../../code/diff.ts';
import {suggestionOf, replaceSuggestions} from './suggestions.ts';
import {Banner, Button, Dialog, TextInput} from '@primer/react';

function originalLines(c: Comment, start: number, end: number): string[] {
  const file = parseDiff(`diff --git a/file b/file\n--- a/file\n+++ b/file\n${c.diff_hunk}`)[0];
  return file?.lines.filter((l) => l.k !== DEL && l.n >= start && l.n <= end).map((l) => l.t) ?? [];
}
const batches = observable.map<number, Comment[]>();
const decode = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
const encode = (s: string) => btoa(Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join(''));
export const SuggestionCard = observer(function SuggestionCard({comment}: {comment: Comment}) {
  const app = useApp(), session = useSession(), pool = usePool();
  const pr = pullOf(pool, comment.issue_id);
  const suggestion = suggestionOf(comment.body, comment.line);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [message, setMessage] = useState('Apply suggested changes');
  if (!suggestion || !pr) return null;
  const repository = pool.model('Repository').get(pr.head_repo_id)?.data;
  const base = pool.model('Repository').get(pr.base_repo_id)?.data;
  const head = poolHead(pool, pr);
  const batch = batches.get(comment.issue_id) ?? [];
  const pending = comment.review_id ? pool.model('Review').get(comment.review_id)?.get('state') === 'PENDING' : false;
  const original = originalLines(comment, suggestion.start, suggestion.end);
  const why = pending ? 'Submit the review before committing this suggestion.' : original.length !== suggestion.end - suggestion.start + 1 ? 'The original lines are unavailable.' : pr.merged ? 'This pull request has been merged.' : reach(session.data.status.connection) !== 'online' ? 'Committing suggestions requires a connection.' : comment.invalidated || comment.commit_id !== head ? 'Suggestion is stale: the head changed.' : !(canWrite(session, pr.head_repo_id) || (pr.allow_maintainer_edit && canWrite(session, pr.base_repo_id))) ? 'Write access to the head branch is required.' : undefined;
  const commit = async () => {
    if (!repository || !base || !head || why) return;
    setBusy(true); setError('');
    try {
      const path = `/repos/${encodeURIComponent(repository.owner_name)}/${encodeURIComponent(repository.name)}`;
      const selected = batch.length ? batch : [comment];
      const files = [];
      for (const filename of new Set(selected.map((c) => c.path))) {
        const file = await online<{content: string; sha: string}>(app, {api: 'v1', path: `${path}/contents/${filename.split('/').map(encodeURIComponent).join('/')}?ref=${head}`});
        if (!file) throw new Error('File unavailable.');
        const text = decode(file.content);
        const edits = selected.filter((c) => c.path === filename).map((c) => {
          const s = suggestionOf(c.body, c.line);
          if (!s || c.invalidated || c.commit_id !== head) throw new Error('Suggestion is stale.');
          // The review diff records the original lines, even when the current file moved.
          const original = originalLines(c, s.start, s.end).join('\n');
          return {...s, original};
        });
        files.push({operation: 'update', path: filename, sha: file.sha, content: encode(replaceSuggestions(text, edits))});
      }
      const branch = await online<{commit: {id: string}}>(app, {api: 'v1', path: `${path}/branches/${encodeURIComponent(pr.head_branch)}`});
      if (branch?.commit.id !== head) throw new Error('The head moved. Reload before committing.');
      await online(app, {api: 'v1', method: 'POST', path: `${path}/contents`, body: {branch: pr.head_branch, message, files}});
      for (const c of selected) editing(app).intents.submit({kind: 'comment.resolve', issueId: c.issue_id, repoId: pr.base_repo_id, commentId: (conversationRoot(pool, c) ?? c).id, resolved: true});
      batches.delete(comment.issue_id); setOpen(false);
    } catch (e) { setError(failureText(e)); } finally { setBusy(false); }
  };
  // Named as what it is (classic's and GitHub's "Suggested change"): the lines it replaces and their replacement.
  return <section aria-label="Suggested change" className="flex flex-col gap-2">
    <span className="text-sm font-medium text-muted">Suggested change</span>
    <div>
      {original.map((line, i) => <CodeLine key={`old${i}`} tone="del" gutter={<LineNo n={suggestion.start + i}/>}>{line}</CodeLine>)}
      {suggestion.text.split('\n').map((line, i) => <CodeLine key={i} tone="add" gutter={<LineNo n={suggestion.start + i}/>}>{line}</CodeLine>)}
    </div>
    <div className="flex gap-2"><Button size="small" type="button" inactive={!!why} onClick={() => {setOpen(true);}}>{batch.length ? `Commit ${batch.length} suggestions` : 'Commit suggestion'}</Button>
      <Button size="small" type="button" inactive={!!why} onClick={() => batches.set(comment.issue_id, batch.some((c) => c.id === comment.id) ? batch.filter((c) => c.id !== comment.id) : [...batch, comment])}>{batch.some((c) => c.id === comment.id) ? 'Remove from batch' : 'Add to batch'}</Button></div>
    {why && <span className="text-sm text-muted">{why}</span>}
    {open && <Dialog title="Commit suggestions" width="large" onClose={() => { setOpen(false); }} footerButtons={[{content: 'Commit', buttonType: 'primary', disabled: busy || !message.trim() || !!why, onClick: () => {void commit();}}]}><TextInput aria-label="Commit message" value={message} onChange={(e) => {setMessage(e.target.value);}}/>{error && <Banner variant="critical" title={error}/>}</Dialog>}
  </section>;
});
