// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Tooltip as T} from 'radix-ui';
import {useRef, useState, type ReactElement, type ReactNode} from 'react';
import {Shortcut} from './Kbd.tsx';
import {floating} from './recipes.ts';
import {cx} from './cx.ts';

/**
 * Mount once around the app shell (F3; the boot route does not need it): one
 * shared delay timer, so moving across a toolbar is instant. Tooltip throws
 * without it.
 */
export function TooltipProvider({children}: {children: ReactNode}) {
  return <T.Provider delayDuration={500} skipDelayDuration={300}>{children}</T.Provider>;
}

export interface TooltipProps {
  content: ReactNode;
  /** Shortcut hint, e.g. "C" or "G I". */
  shortcut?: string | undefined;
  side?: 'top' | 'right' | 'bottom' | 'left' | undefined;
  /** The trigger: a single element that accepts a ref (e.g. a Button). */
  children: ReactElement;
}

const POPUP_ROLES = new Set(['dialog', 'alertdialog', 'menu', 'listbox']);

/** Whether focus went into a dialog, menu or listbox (what a trigger with aria-haspopup opens). */
function inPopup(to: EventTarget | null): boolean {
  for (let el = to instanceof Element ? to : null; el; el = el.parentElement) if (POPUP_ROLES.has(el.getAttribute('role') ?? '')) return true;
  return false;
}

// A trigger can also open a menu or popover (aria-expanded). No tooltip while
// that is open, and none after it closes until the pointer leaves the trigger
// or focus moves on (closing returns focus, and the pointer may still rest on it).
export function Tooltip({content, shortcut, side = 'bottom', children}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const suppressed = useRef(false);
  const onOpenChange = (next: boolean) => {
    if (next && (suppressed.current || trigger.current?.getAttribute('aria-expanded') === 'true')) return;
    setOpen(next);
  };
  const popupOpen = () => trigger.current?.getAttribute('aria-expanded') === 'true';
  return (
    <T.Root open={open} onOpenChange={onOpenChange}>
      <T.Trigger
        asChild
        ref={trigger}
        onPointerDownCapture={() => {
          if (trigger.current?.hasAttribute('aria-haspopup')) suppressed.current = true;
        }}
        onKeyDownCapture={() => {
          if (trigger.current?.hasAttribute('aria-haspopup')) suppressed.current = true;
        }}
        onBlurCapture={(e) => {
          // Focus moving into the popup keeps the suppression (a menu marks its trigger expanded; a dialog
          // opened by it, such as a picker, is recognised by its role), so focus coming back when it closes
          // shows no tooltip over what is next to the trigger. Anything else ends it.
          if (popupOpen() || inPopup(e.relatedTarget)) return;
          suppressed.current = false;
        }}
        onPointerLeave={() => {
          if (!popupOpen()) suppressed.current = false;
        }}
      >
        {children}
      </T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className={cx(floating, 'z-tooltip flex max-w-xs items-center gap-2 overflow-hidden px-2 py-1 text-sm')}
        >
          {content}
          {shortcut && <Shortcut keys={shortcut}/>}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
