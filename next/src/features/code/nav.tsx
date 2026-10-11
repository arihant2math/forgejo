// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Links into the code views and the repository's tab bar. Code views are at
// Forgejo's own addresses (`/{owner}/{repo}/src/branch/main/README.md`,
// `commit/<sha>`, `compare/a...b`, …: spa.go codeAddress serves the app for
// them), so a code page's address is also its classic page's.
// The repository's tab bar is features/repo/repoPage.tsx (every repository page).

import {Link, type LinkProps, useNavigate} from '@tanstack/react-router';
import {sitePath} from '../../app/config.ts';
import {codePath} from '../../app/paths.ts';
import {useApp} from '../../app/store.ts';
import type {ReactNode} from 'react';
import {codeParams} from '../../code/refs.ts';

export const CODE_ROUTE = '/$owner/$repo/$view/$';

/** Where a code path goes (router `to` + params): `splat` is what follows the repository ("src/branch/main/README.md"). */
export function codeTo(owner: string, repo: string, splat: string) {
  return {to: CODE_ROUTE, params: {owner, repo, ...codeParams(splat)}} as const;
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
  /** The link's accessible name and tooltip, for a link whose content is an icon. */
  label?: string;
}

/** A link to a code view (preloaded on intent like every router link). */
export function CodeLink({owner, repo, to, children, className, hash, onPointerEnter, exact = false, label}: CodeLinkProps) {
  const props: LinkProps = {...codeTo(owner, repo, to), ...(hash ? {hash} : {}), activeOptions: {exact, includeSearch: false}};
  return <Link {...props} className={className} onPointerEnter={onPointerEnter} {...(label ? {'aria-label': label, title: label} : {})}>{children}</Link>;
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
