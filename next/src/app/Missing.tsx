// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {createElement} from 'react';
import {AvailableOffline} from './Available.tsx';
import {ClassicLink} from './ClassicLink.tsx';
import {reach} from './online.ts';
import {useNotFound, usePageStatus} from './shell/PageHeader.tsx';
import {useApp} from './store.ts';
import {CloudOfflineIcon, QuestionIcon, HomeIcon} from '@primer/octicons-react';
import type {Icon as OcticonType} from '@primer/octicons-react';
import {RouterLinkButton} from '../app/routerLinks.tsx';
import {Blankslate} from '@primer/react/experimental';
import {missingWords, offlineTitle} from './missingWords.ts';

export interface MissingProps {
  /** What is missing, as the subject of a sentence ("This repository"). */
  what: string;
  /** Defaults to "Not found"; use "Not available here" for classic-only pages. */
  title?: string | undefined;
  /** The online explanation (default: "<what> does not exist, or you cannot see it."). */
  description?: ReactNode;
  icon?: OcticonType | undefined;
  /** The classic page of the same thing (a site path), offered online. */
  classic?: string | undefined;
}

/** Content that is not on this device while Forgejo cannot be asked: what is available instead. */
export function OfflineState({what, reach: r, retry}: {what: string; reach: 'offline' | 'unreachable'; retry?: ReactNode}) {
  return (
    <div className="flex flex-col items-center">
      <Blankslate spacious>
        <Blankslate.Visual><CloudOfflineIcon size={24}/></Blankslate.Visual>
        <Blankslate.Heading>{offlineTitle(r)}</Blankslate.Heading>
        <Blankslate.Description>{missingWords(what)[r]}</Blankslate.Description>
        {retry}
      </Blankslate>
      <AvailableOffline/>
    </div>
  );
}

export const Missing = observer(function Missing({what, title, description, icon, classic}: MissingProps) {
  const app = useApp();
  const r = reach(app.session?.data.status.connection);
  useNotFound(r === 'online' && !classic);
  usePageStatus(r === 'online' ? undefined : offlineTitle(r));
  if (r !== 'online') return <OfflineState what={what} reach={r}/>;
  return (
    <Blankslate spacious>
      <Blankslate.Visual>{createElement(icon ?? QuestionIcon, {size: 24})}</Blankslate.Visual>
      <Blankslate.Heading>{title ?? (classic ? 'Not available here' : 'Not found')}</Blankslate.Heading>
      <Blankslate.Description>{description ?? missingWords(what).notFound}</Blankslate.Description>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {classic && <ClassicLink to={classic} size="small" variant="primary">Open this page</ClassicLink>}
        <RouterLinkButton size="small" variant={classic ? 'default' : 'primary'} leadingVisual={HomeIcon} to="/">Go to Home</RouterLinkButton>
      </div>
    </Blankslate>
  );
});
