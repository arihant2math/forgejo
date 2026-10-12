// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Code views share Forgejo's classic URLs; spa.go codeAddress serves the app there.

import {Link, type LinkProps, useNavigate} from '@tanstack/react-router';
import {sitePath} from '../../app/config.ts';
import {codePath} from '../../app/paths.ts';
import {useApp} from '../../app/store.ts';
import type {ReactNode} from 'react';
import {codeParams} from '../../code/refs.ts';

export const CODE_ROUTE = '/$owner/$repo/$view/$';

/** splat is the path after owner/repo. */
export function codeTo(owner: string, repo: string, splat: string) {
  return {to: CODE_ROUTE, params: {owner, repo, ...codeParams(splat)}} as const;
}

export interface CodeLinkProps {
  owner: string;
  repo: string;
  /** Path after owner/repo. */
  to: string;
  children: ReactNode;
  className?: string;
  hash?: string;
  onPointerEnter?: (() => void) | undefined;
  exact?: boolean;
  label?: string;
}

export function CodeLink({owner, repo, to, children, className, hash, onPointerEnter, exact = false, label}: CodeLinkProps) {
  const props: LinkProps = {...codeTo(owner, repo, to), ...(hash ? {hash} : {}), activeOptions: {exact, includeSearch: false}};
  return <Link {...props} className={className} onPointerEnter={onPointerEnter} {...(label ? {'aria-label': label, title: label} : {})}>{children}</Link>;
}

/** Plain clicks and Enter navigate in-app; linkOf supports middle-click and new tabs. */
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
