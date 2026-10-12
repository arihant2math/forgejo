// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {AlertIcon, CloudOfflineIcon, RedoIcon, SearchIcon} from '@primer/octicons-react';
import type {Icon as OcticonType} from '@primer/octicons-react';
import {Banner, Button} from '@primer/react';
import {SkeletonBox} from '@primer/react/experimental';
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {OfflineState} from '../app/Missing.tsx';
import {missingWords, offlineTitle} from '../app/missingWords.ts';
import {useReach} from '../app/online.ts';
import {type Resource, transientStatus, type Unready} from '../app/resource.ts';
import {EmptyState} from './EmptyState.tsx';
import {ListSkeleton} from './ListSkeleton.tsx';

export interface LoadStateProps<T> {
  res: Unready | Resource<T>;
  /** The subject of a sentence: "This file", "The webhooks". */
  what: string;
  /** Fills a page body: spacious, and offline it offers what is available instead. Otherwise a section of a page. */
  page?: boolean | undefined;
  skeleton?: ReactNode;
  /** Offered with "Not found" (a way back). */
  action?: ReactNode;
  /** A list's empty state. */
  empty?: {icon: OcticonType; title: string; description: string; action?: ReactNode} | undefined;
  children?: ((value: T) => ReactNode) | undefined;
}

/** Loading, offline, failure and empty states of a server read, else children with its value. */
function LoadStateView<T>({res, what, page = false, skeleton, action, empty, children}: LoadStateProps<T>) {
  const r = useReach();
  if (res.state === 'ready') {
    if (empty && Array.isArray(res.value) && !res.value.length) {
      return <EmptyState spacious={page} icon={empty.icon} title={empty.title} description={empty.description} action={empty.action}/>;
    }
    return children?.(res.value) ?? null;
  }
  if (res.state === 'loading') {
    // The Loading status stays outside the busy skeleton, where assistive tech may hold back a live region.
    return skeleton ?? (page ? <><span role="status" className="sr-only">Loading…</span><div className="flex flex-col gap-2 px-6 py-4" aria-busy><SkeletonBox className="h-3 w-64"/><SkeletonBox className="h-3 w-48"/></div></> : <ListSkeleton/>);
  }
  // Asking again may cure no answer or a server fault, not a refusal (400, 403, 422).
  const reload = 'reload' in res && (res.state === 'offline' || transientStatus(res.status)) ? res.reload : undefined;
  const retry = (label: string) => reload && <Button size="small" type="button" leadingVisual={RedoIcon} onClick={reload}>{label}</Button>;
  const failed = (description: string) => (page ?
    <EmptyState icon={AlertIcon} title="Could not load" description={description} action={retry('Retry')}/> :
    <Banner variant="critical" title={`${what} could not be loaded`} description={description} primaryAction={retry('Try again')}/>);
  if (res.state === 'offline') {
    // Unanswered while connected is a failed request, not missing offline content.
    if (r === 'online') return failed(`${what} could not be loaded: the request to Forgejo failed.`);
    if (page) return <OfflineState what={what} reach={r} retry={r === 'unreachable' && retry('Retry')}/>;
    return <EmptyState spacious={false} icon={CloudOfflineIcon} title={offlineTitle(r)} description={missingWords(what).notHere} action={r === 'unreachable' && retry('Retry')}/>;
  }
  if (res.status === 404) return <EmptyState spacious={page} icon={SearchIcon} title="Not found" description={missingWords(what).notFound} action={action}/>;
  if (res.status === 413) return <EmptyState spacious={page} icon={AlertIcon} title="Too large to show here" description={missingWords(what).tooLarge}/>;
  if (res.status === 401) return <EmptyState spacious={page} icon={CloudOfflineIcon} title="Signed out" description="Sign in again (the sync indicator above) to load this."/>;
  return failed(res.status === 403 ? 'Forgejo refused: you may not see this, or this instance turned the feature off.' : res.error);
}

export const LoadState = observer(LoadStateView) as typeof LoadStateView;
