// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Pagination, UnderlineNav} from '@primer/react';
import {useEffect, useState} from 'react';
import {sitePath} from '../../app/config.ts';
import {useLinkClick} from '../../app/links.ts';
import type {App} from '../../app/store.ts';
import {type Kind, kinds} from './params.ts';

const LABELS: Record<Kind, string> = {code: 'Code', repositories: 'Repositories', issues: 'Issues', pulls: 'Pull requests', users: 'Users', organizations: 'Organizations'};

/** Explore lists only what the instance lets everyone browse; search also has issues, pulls and code. */
export function availableKinds(app: App, explore: boolean): Kind[] {
  return kinds.filter((kind) => (!explore || kind !== 'issues' && kind !== 'pulls' && kind !== 'code') &&
    (kind !== 'users' || !app.config.explore?.disable_users) && (kind !== 'organizations' || !app.config.explore?.disable_organizations));
}

/** A plain-string query, as the classic UI writes it; empty values are left out. */
export function searchHref(app: App, path: string, search: object): string {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(search) as [string, unknown][]) if (typeof v === 'number' || typeof v === 'string' && v) query.set(k, String(v));
  const q = query.toString();
  return sitePath(app.config, q ? `${path}?${q}` : path);
}

/** Changing the result type is navigation, so it is an UnderlineNav of links, as on GitHub. */
export function SearchTypeNav({label, available, current, counts = {}, href}: {
  label: string; available: readonly Kind[]; current: Kind; counts?: Partial<Record<Kind, number | undefined>>; href: (kind: Kind) => string;
}) {
  const click = useLinkClick();
  return <UnderlineNav aria-label={label}>
    {available.map((kind) => {
      const to = href(kind);
      const count = counts[kind];
      return <UnderlineNav.Item key={kind} href={to} aria-current={kind === current ? 'page' : false} {...(count === undefined ? {} : {counter: count})}
        onClick={(e) => { click(e, to); }}>{LABELS[kind]}</UnderlineNav.Item>;
    })}
  </UnderlineNav>;
}

export function ResultPager({page, pageCount, href}: {page: number; pageCount: number; href: (page: number) => string}) {
  const click = useLinkClick();
  if (pageCount <= 1) return null;
  return <div className="py-2"><Pagination pageCount={pageCount} currentPage={Math.min(page, pageCount)} hrefBuilder={href} onPageChange={(e, n) => { click(e, href(n)); }}/></div>;
}

/** A text field's draft, committed after a pause in typing and replaced when the committed value changes. */
export function useDraft(value: string, commit: (draft: string) => void): [string, (draft: string) => void] {
  const [state, setState] = useState({value, draft: value});
  const current = state.value === value ? state : {value, draft: value};
  if (current !== state) setState(current);
  const {draft} = current;
  useEffect(() => {
    if (draft === value) return undefined;
    const timer = setTimeout(() => { commit(draft); }, 250);
    return () => { clearTimeout(timer); };
  }, [draft, value, commit]);
  return [draft, (next) => { setState({value, draft: next}); }];
}
