// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Server-rendered markdown (an issue body, a comment): put in through the
// Trusted Types gate (app/trusted.ts) after every change of the HTML, never
// by React. Links to pages this UI renders (issues, pull requests, lists)
// navigate in place; everything else is a normal link.

import {useRouter} from '@tanstack/react-router';
import {type MouseEvent, useLayoutEffect, useRef} from 'react';
import {useApp} from '../../app/store.ts';
import {setMarkup} from '../../app/trusted.ts';
import {Prose} from '../../ui/index.ts';

/** Site paths the router renders (B8's spaRoutes, minus the dashboard). */
// Owner and repository segments as Forgejo names them ([\w.-], not starting with "." or "-"; not "api"): no
// router parameter syntax ("$owner"), no API path.
const NAME = '(?!api/)(?![.-])[\\w.-]+';
const LOCAL = [new RegExp(`^/${NAME}/${NAME}/(?:issues|pulls)(?:/[1-9]\\d*)?/?$`), /^\/(?:issues|pulls|notifications)\/?$/];

export function Markdown({html}: {html: string}) {
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const app = useApp();
  useLayoutEffect(() => {
    if (ref.current) setMarkup(ref.current, html);
  }, [html]);
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element).closest('a');
    if (!a?.href || a.target) return;
    const url = new URL(a.href);
    const sub = app.config.app_sub_url;
    if (url.origin !== location.origin || !url.pathname.startsWith(`${sub}/`)) return;
    const path = url.pathname.slice(sub.length);
    // Encoded dots, slashes and backslashes would be decoded by the router into another path than the one checked.
    if (/%(?:2e|2f|5c)/i.test(path) || !LOCAL.some((re) => re.test(path))) return;
    e.preventDefault();
    void router.navigate({to: path, search: Object.fromEntries(url.searchParams) as never, hash: url.hash.slice(1)});
  };
  return <Prose ref={ref} onClick={onClick}/>;
}
