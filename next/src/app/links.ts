// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useRouter} from '@tanstack/react-router';
import type {MouseEvent} from 'react';
import {sitePath} from './config.ts';
import type {App} from './store.ts';

/** True for unhandled, unmodified primary clicks; other clicks belong to the browser. */
export function plainClick(e: MouseEvent): boolean {
  return !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/** @deprecated Use `sitePath(app.config, path)`. */
export const hrefOf = (app: App, path: string): string => sitePath(app.config, path);

/** Returns true when a plain click navigates in place; leaves other clicks to the browser. */
export function useLinkClick(): (e: MouseEvent, href: string) => boolean {
  const router = useRouter();
  return (e, href) => {
    if (!plainClick(e)) return false;
    e.preventDefault();
    void router.navigate({href});
    return true;
  };
}

export interface SiteLinkProps {
  href: string;
  onClick: (e: MouseEvent) => void;
  onPointerEnter: (e: {currentTarget: EventTarget}) => void;
  onPointerLeave: (e: {currentTarget: EventTarget}) => void;
  onFocus: (e: {currentTarget: EventTarget}) => void;
  onBlur: (e: {currentTarget: EventTarget}) => void;
}

const intents = new WeakMap<EventTarget, ReturnType<typeof setTimeout>>();

/** Anchor props for a site path (from `sitePath`) that has no typed route: plain clicks navigate in place and,
 * as with the router's own links, pointer or focus intent preloads the destination's chunk and loader. */
export function useSiteLink(): (href: string) => SiteLinkProps {
  const router = useRouter();
  const click = useLinkClick();
  const delay = router.options.defaultPreloadDelay ?? 50;
  const cancel = (e: {currentTarget: EventTarget}) => {
    clearTimeout(intents.get(e.currentTarget));
    intents.delete(e.currentTarget);
  };
  return (href) => {
    const intent = (e: {currentTarget: EventTarget}) => {
      const target = e.currentTarget;
      if (intents.has(target)) return;
      intents.set(target, setTimeout(() => {
        intents.delete(target);
        // The href decides the destination; the type still asks for a `to`.
        router.preloadRoute({to: '.', href}).catch(() => undefined);
      }, delay));
    };
    return {href, onClick: (e) => { click(e, href); }, onPointerEnter: intent, onPointerLeave: cancel, onFocus: intent, onBlur: cancel};
  };
}
