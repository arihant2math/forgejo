// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The one "this is not here" state (an unknown address, a repository, an
// issue or a code page that does not exist or is not on this device). Online
// it says what is missing and offers the classic page when Forgejo has one;
// offline it lists what this device can show (PLAN §5.5: no dead ends).

import {Link} from '@tanstack/react-router';
import {CloudOff, FileQuestion, Home} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {Button, EmptyState, Icon, type LucideIcon} from '../ui/index.ts';
import {AvailableOffline} from './Available.tsx';
import {ClassicLink} from './ClassicLink.tsx';
import {connectivity} from './online.ts';
import {useApp} from './store.ts';

export interface MissingProps {
  /** What is missing, as the subject of a sentence ("This repository"). */
  what: string;
  /** The online title (default "Not available here"). */
  title?: string | undefined;
  /** The online explanation (default: "<what> does not exist, or you cannot see it."). */
  description?: ReactNode;
  icon?: LucideIcon | undefined;
  /** The classic page of the same thing (a site path), offered online. */
  classic?: string | undefined;
}

/**
 * The sentences about something missing, agreeing with their subject ("This file is", "These commits are").
 * A subject starting with "These" or "Those" is plural.
 */
export function missingWords(what: string): {offline: string; notFound: string; tooLarge: string} {
  const plural = /^(?:these|those)\b/i.test(what);
  const [be, it] = plural ? ['are', 'them'] : ['is', 'it'];
  return {
    offline: `${what} ${be} not on this device. Connect to load ${it}, or open one of these:`,
    notFound: `${what} ${plural ? 'do' : 'does'} not exist, or you cannot see ${it}.`,
    tooLarge: `${what} ${be} too large for this view: open ${it} in the classic UI.`,
  };
}

export const Missing = observer(function Missing({what, title, description, icon, classic}: MissingProps) {
  const app = useApp();
  const offline = !connectivity.online || app.session?.data.status.connection === 'offline';
  if (offline) {
    return (
      <div className="flex flex-col items-center">
        <EmptyState icon={CloudOff} title="Not available offline" description={missingWords(what).offline}/>
        <AvailableOffline/>
      </div>
    );
  }
  return (
    <EmptyState
      icon={icon ?? FileQuestion}
      title={title ?? 'Not available here'}
      description={description ?? missingWords(what).notFound}
      action={
        <span className="flex flex-wrap justify-center gap-2">
          {classic && <ClassicLink to={classic} variant="primary">Open in the classic UI</ClassicLink>}
          <Button asChild variant={classic ? 'secondary' : 'primary'}><Link to="/"><Icon icon={Home} size="md"/>Go to Home</Link></Button>
        </span>
      }
    />
  );
});
