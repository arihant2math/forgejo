// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Pagination} from '@primer/react';
import {useLinkClick} from '../app/links.ts';

export interface PagerProps {
  /** The current page, from 1. */
  page: number;
  /** The address of page n (an href: the pages are real links). */
  href: (n: number) => string;
  /** Known page count: numbered pages, as GitHub's search. */
  pageCount?: number | undefined;
  /** Without a page count, whether a next page exists: Previous and Next only. */
  more?: boolean | undefined;
  /** Layout classes of the row around the pager. */
  className?: string | undefined;
}

/** Primer's pagination with real links that navigate in place; nothing when everything fits on one page. */
export function Pager({page, href, pageCount, more = false, className}: PagerProps) {
  const click = useLinkClick();
  const last = pageCount === undefined ? page + (more ? 1 : 0) : Math.max(1, pageCount);
  if (last <= 1) return null;
  return (
    <div className={className}>
      <Pagination pageCount={last} currentPage={Math.min(page, last)} showPages={pageCount !== undefined} hrefBuilder={href}
        onPageChange={(e, n) => { click(e, href(n)); }}/>
    </div>
  );
}
