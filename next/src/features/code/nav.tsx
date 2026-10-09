// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Links into the code views and the repository's tab bar. Code URLs live
// below the UI's base (`/-/next/code/{owner}/{repo}/…`; B8's spaRoutes has no
// canonical code routes yet): the part after the repository mirrors
// Forgejo's own URL, so the classic page is the same path without the prefix.
// The repository's tab bar is features/repo/repoPage.tsx (every repository page).

import {Link, type LinkProps, useNavigate} from '@tanstack/react-router';
import {sitePath} from '../../app/config.ts';
import {codePath} from '../../app/paths.ts';
import {useApp} from '../../app/store.ts';
import type {ReactNode} from 'react';
import {withEnd} from '../../code/refs.ts';

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

/**
 * A code list's rows as links (RowList `onOpen` + `linkOf`): each row's code path, opened in place on a
 * plain click or Enter, and a real link for middle-click and a new tab.
 */
export function useCodeRows<T>(owner: string, repo: string, splatOf: (item: T) => string): {onOpen: (item: T) => void; linkOf: (item: T) => string} {
  const navigate = useNavigate();
  const app = useApp();
  return {
    onOpen: (item) => {
      void navigate(codeTo(owner, repo, splatOf(item)));
    },
    linkOf: (item) => sitePath(app.config, codePath(owner, repo, splatOf(item))),
  };
}
