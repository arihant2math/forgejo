// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A pull request that conflicts with its base: Forgejo cannot resolve that in
// the browser (neither can the classic UI), so the merge box says how to on
// a computer (the classic page's "View command line instructions", here for
// the conflict: merge the base into the head branch, fix, push), and that
// editing the branch's files on the web does not clear a conflict with the
// base's changes.

import {useApp} from '../../app/store.ts';
import {ClassicLink} from '../../app/ClassicLink.tsx';
import type {PullRequest} from '../../protocol/types.gen.ts';
import {Code} from '../../ui/index.ts';

/** The commands that bring the base into the head branch on a computer (the pull request updates once pushed). */
export function conflictCommands(pr: PullRequest, opts: {headRepo: string | undefined; appURL: string}): string {
  const fork = pr.head_repo_id !== pr.base_repo_id;
  const fixed = pr.conflicted_files.length ? pr.conflicted_files.map(quote).join(' ') : '<the conflicting files>';
  if (pr.flow === 1 || (fork && !opts.headRepo)) {
    // AGit (or a fork that is gone): the head is only refs/pull/{n}/head here.
    const local = `pr-${String(pr.number)}`;
    return [
      `git fetch -u origin +refs/pull/${String(pr.number)}/head:${local}`,
      `git switch ${local}`,
      `git merge origin/${pr.base_branch}`,
      `# fix the conflicts, then`,
      `git add ${fixed}`,
      'git commit',
    ].join('\n');
  }
  if (!fork) {
    return [
      'git fetch origin',
      `git switch ${pr.head_branch}`,
      `git merge origin/${pr.base_branch}`,
      `# fix the conflicts, then`,
      `git add ${fixed}`,
      'git commit',
      `git push origin ${pr.head_branch}`,
    ].join('\n');
  }
  const headURL = `${opts.appURL.replace(/\/?$/, '/')}${opts.headRepo ?? ''}.git`;
  const local = `${(opts.headRepo ?? '').split('/')[0] ?? ''}-${pr.head_branch}`;
  return [
    `git fetch -u ${headURL} ${pr.head_branch}:${local}`,
    `git switch ${local}`,
    `git fetch origin ${pr.base_branch}`,
    'git merge FETCH_HEAD',
    `# fix the conflicts, then`,
    `git add ${fixed}`,
    'git commit',
    `git push ${headURL} ${local}:${pr.head_branch}`,
  ].join('\n');
}

function quote(path: string): string {
  return /^[\w./@+-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

export function ConflictHelp({pr, headRepo, pullPath, canPush}: {pr: PullRequest; headRepo: string | undefined; pullPath: string; canPush: boolean}) {
  const app = useApp();
  const fork = pr.head_repo_id !== pr.base_repo_id;
  return (
    <details className="text-sm text-fg-muted">
      <summary className="cursor-pointer text-fg">How to resolve the conflicts</summary>
      <div className="mt-2 flex flex-col gap-2">
        <p>
          Forgejo cannot resolve conflicts in the browser. Merge <Code>{pr.base_branch}</Code> into <Code>{pr.head_branch}</Code> on
          your computer, fix the conflicting files, commit and push{fork ? ' to the fork' : ''}: this pull request updates itself.
          Editing the branch’s files on the web does not clear the conflict, which is with what changed on <Code>{pr.base_branch}</Code>.
        </p>
        {!canPush && <p>Only someone who may push to <Code>{pr.head_branch}</Code> can do this{fork ? ' (the author, or maintainers when the author allows edits)' : ''}.</p>}
        <pre aria-label="Command line instructions" className="max-w-full overflow-x-auto rounded-md border border-border bg-canvas px-3 py-2 font-mono text-code text-fg select-all">{conflictCommands(pr, {headRepo, appURL: app.config.app_url})}</pre>
        <div><ClassicLink size="sm" to={pullPath}>Open the merge instructions</ClassicLink></div>
      </div>
    </details>
  );
}
