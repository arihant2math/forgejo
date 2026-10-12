// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The same readable reference in dashboard, inbox and search metadata. */
export function formatIssueReference(repo: string, number: number | undefined): string {
  return [repo, number === undefined ? '' : `#${String(number)}`].filter(Boolean).join(' ');
}

/** Keep the repository and number together; omit only the owner at phone width. */
export function IssueReference({repo, number}: {repo: string; number: number | undefined}) {
  const slash = repo.indexOf('/') + 1;
  return <span title={formatIssueReference(repo, number)} className="flex min-w-0 text-sm text-muted tabular-nums">
    {repo && <span className="max-md:hidden">{repo.slice(0, slash)}</span>}
    {repo && <span className="truncate max-md:max-w-24">{repo.slice(slash)}</span>}
    {number !== undefined && <span className="shrink-0 whitespace-pre">{repo ? ' ' : ''}{formatIssueReference('', number)}</span>}
  </span>;
}
