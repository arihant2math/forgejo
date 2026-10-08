// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Links into the code views and the repository's tab bar. Code URLs live
// below the UI's base (`/-/next/code/{owner}/{repo}/…`; B8's spaRoutes has no
// canonical code routes yet): the part after the repository mirrors
// Forgejo's own URL, so the classic page is the same path without the prefix.

import {Link, type LinkProps} from '@tanstack/react-router';
import type {ReactNode} from 'react';
import {withEnd} from '../../code/refs.ts';
import {TabLink, TabNav} from '../../ui/index.ts';

export const CODE_ROUTE = '/-/next/code/$owner/$repo/$';

/**
 * Where a code path goes (router `to` + params). Code URLs end in a "-"
 * segment (code/refs.ts END): B8 answers 404 for a path below the UI's base
 * whose last segment has an extension (it takes it for a build asset), and a
 * file ("README.md") or a ref ("v1.2") would be one; Forgejo strips a
 * trailing slash before B8 sees it.
 */
export function codeTo(owner: string, repo: string, splat: string) {
  return {to: CODE_ROUTE, params: {owner, repo, _splat: withEnd(splat)}} as const;
}

export interface CodeLinkProps {
  owner: string;
  repo: string;
  /** The path after the repository ("src/branch/main/README.md", "commit/<sha>", "branches", …). */
  to: string;
  children: ReactNode;
  className?: string;
  hash?: string;
  onPointerEnter?: (() => void) | undefined;
  /** Active only on an exact match (tabs): "commits" is not active on "commit/…". */
  exact?: boolean;
}

/** A link to a code view (preloaded on intent like every router link). */
export function CodeLink({owner, repo, to, children, className, hash, onPointerEnter, exact = false}: CodeLinkProps) {
  const props: LinkProps = {...codeTo(owner, repo, to), ...(hash ? {hash} : {}), activeOptions: {exact, includeSearch: false}};
  return <Link {...props} className={className} onPointerEnter={onPointerEnter}>{children}</Link>;
}

/** Which tab a code path belongs to. */
function tabOf(path: string): string {
  const head = path.split('/')[0] ?? '';
  if (head === '' || head === 'src' || head === 'blame') return 'code';
  if (head === 'commit' || head === 'commits' || head === 'compare') return 'commits';
  if (head === 'actions') return 'actions';
  return head;
}

/** The repository's sections: issues and pull requests (lists), then the code views. */
export function RepoTabs({owner, repo, current}: {owner: string; repo: string; current: string}) {
  const tab = tabOf(current);
  const code = (to: string, name: string, label: string) => (
    <TabLink key={name}>
      <Link {...codeTo(owner, repo, to)} aria-current={tab === name ? 'page' : undefined} activeProps={{}} activeOptions={{exact: true}}>{label}</Link>
    </TabLink>
  );
  return (
    <TabNav label="Repository">
      {code('src', 'code', 'Code')}
      <TabLink><Link to="/$owner/$repo/issues" params={{owner, repo}}>Issues</Link></TabLink>
      <TabLink><Link to="/$owner/$repo/pulls" params={{owner, repo}}>Pull requests</Link></TabLink>
      {code('commits', 'commits', 'Commits')}
      {code('branches', 'branches', 'Branches')}
      {code('tags', 'tags', 'Tags')}
      {code('releases', 'releases', 'Releases')}
      {code('actions', 'actions', 'Actions')}
    </TabNav>
  );
}
