// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The one "this is not here" state (an unknown address, a repository, an
// issue or a code page that does not exist or is not on this device). Online
// it says what is missing and offers the classic page when Forgejo has one;
// offline it lists what this device can show (PLAN §5.5: no dead ends).
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {EmptyState} from '../ui/index.ts';
import {AvailableOffline} from './Available.tsx';
import {ClassicLink} from './ClassicLink.tsx';
import {reach} from './online.ts';
import {useNotFound, usePageStatus} from './shell/PageHeader.tsx';
import {useApp} from './store.ts';
import {CloudOfflineIcon, QuestionIcon, HomeIcon} from '@primer/octicons-react';
import type {Icon as OcticonType} from '@primer/octicons-react';
import {RouterLinkButton} from '../app/routerLinks.tsx';
import {Blankslate} from '@primer/react/experimental';

export interface MissingProps {
  /** What is missing, as the subject of a sentence ("This repository"). */
  what: string;
  /** The online title (default "Not found", or "Not available here" when the classic UI has the page). */
  title?: string | undefined;
  /** The online explanation (default: "<what> does not exist, or you cannot see it."). */
  description?: ReactNode;
  icon?: OcticonType | undefined;
  /** The classic page of the same thing (a site path), offered online. */
  classic?: string | undefined;
}

/**
 * The sentences about something missing, agreeing with their subject ("This file is", "These commits are",
 * "This repository's files are", "Its description and comments are"). A subject is plural when it starts with
 * "These" or "Those", joins two things with "and", or names a plural noun last ("…'s files", "…'s changes").
 */
export function missingWords(what: string): {offline: string; unreachable: string; notFound: string; tooLarge: string} {
  const plural = /^(?:these|those)\b/i.test(what) || /\band\b/i.test(what) || /'s \w+(?:s|es)$/i.test(what) && !/'s \w*ss$/i.test(what);
  const [be, it] = plural ? ['are', 'them'] : ['is', 'it'];
  return {
    offline: `${what} ${be} not on this device. Connect to load ${it}, or open one of these:`,
    unreachable: `${what} ${be} not on this device, and Forgejo is not answering. ${plural ? 'They load' : 'It loads'} once it is back; meanwhile open one of these:`,
    notFound: `${what} ${plural ? 'do' : 'does'} not exist, or you cannot see ${it}.`,
    tooLarge: `${what} ${be} too large for this view: open ${it} in the classic UI.`,
  };
}

export const Missing = observer(function Missing({what, title, description, icon, classic}: MissingProps) {
  const app = useApp();
  const r = reach(app.session?.data.status.connection);
  useNotFound(r === 'online' && !classic);
  usePageStatus(r === 'offline' ? 'Not available offline' : r === 'unreachable' ? 'Can’t reach Forgejo' : undefined);
  if (r !== 'online') {
    return (
      <div className="flex flex-col items-center">
        <Blankslate><Blankslate.Visual><CloudOfflineIcon size={24}/></Blankslate.Visual><Blankslate.Heading>{r === 'offline' ? 'Not available offline' : 'Can’t reach Forgejo'}</Blankslate.Heading><Blankslate.Description>{missingWords(what)[r]}</Blankslate.Description></Blankslate>
        <AvailableOffline/>
      </div>
    );
  }
  return (
    <EmptyState
      icon={icon ?? QuestionIcon}
      title={title ?? (classic ? 'Not available here' : 'Not found')}
      description={description ?? missingWords(what).notFound}
      action={
        <span className="flex flex-wrap justify-center gap-2">
          {classic && <ClassicLink to={classic} variant="primary">Open this page</ClassicLink>}
          <RouterLinkButton variant={classic ? 'default' : 'primary'} leadingVisual={HomeIcon} to="/">Go to Home</RouterLinkButton>
        </span>
      }
    />
  );
});
