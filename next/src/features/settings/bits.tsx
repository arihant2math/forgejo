// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Banner, Button} from '@primer/react';


import {observer} from 'mobx-react-lite';
import {type ReactNode, useState} from 'react';
import {notify} from '../../app/notices.ts';
import {connectivity, onlineOnly} from '../../app/online.ts';
import type {App} from '../../app/store.ts';
import {problemOf} from './problems.ts';
import type {Resource} from './resource.ts';
import type {Icon as OcticonType} from '@primer/octicons-react';
import {SkeletonAvatar, SkeletonBox, Blankslate} from '@primer/react/experimental';

function same(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
}

/** Overlay until sync matches, undo, or a later pool change supersedes the completed request. */
export interface Optimistic<T> {
  shown: T;
  pending: boolean;
  set: (v: T) => void;
  done: () => void;
  undo: () => void;
}

export function useOptimistic<T>(actual: T): Optimistic<T> {
  const [o, setO] = useState<{v: T; from: T; done: boolean} | undefined>(undefined);
  if (o && (same(actual, o.v) || (o.done && !same(actual, o.from)))) setO(undefined);
  return {
    shown: o ? o.v : actual,
    pending: o !== undefined && !o.done,
    set: (v: T) => {
      setO({v, from: actual, done: false});
    },
    done: () => {
      setO((cur) => (cur ? {...cur, done: true} : cur));
    },
    undo: () => {
      setO(undefined);
    },
  };
}

/** Roll back the optimistic value and show a notice on failure. */
export function sendChange<T>(app: App, opt: Optimistic<T>, value: T, what: string, send: () => Promise<unknown>, success?: string): void {
  opt.set(value);
  send().then(() => {
    opt.done();
    if (success) notify(app, {tone: 'success', title: success});
  }, (err: unknown) => {
    opt.undo();
    notify(app, {tone: 'danger', title: `${what} was not changed`, description: problemOf(err).message});
  });
}

export function useOffline(): boolean {
  return !connectivity.online;
}

/** Offline settings writes are not queued. */
export const OfflineNote = observer(function OfflineNote() {
  if (connectivity.online) return null;
  return <Banner variant="warning" title="You are offline" description={<>{onlineOnly('Changing settings')} What this device knows is shown.</>}/>;
});

export function ListSkeleton({rows = 3}: {rows?: number}) {
  return (
    <ul className="flex flex-col">
      {Array.from({length: rows}, (_, i) => (
        <li key={i} aria-hidden className="flex items-center gap-2 border-b border-muted px-4 py-3 last:border-b-0">
          <SkeletonAvatar size={20}/>
          <span className="flex flex-1 flex-col gap-1"><SkeletonBox className="h-3 w-40"/><SkeletonBox className="h-3 w-24"/></span>
        </li>
      ))}
    </ul>
  );
}

export function ResourceList<T>({res, what, empty, children}: {
  res: Resource<T[]>;
  /** Sentence subject, e.g. "The webhooks". */
  what: string;
  empty: {icon: OcticonType; title: string; description: string; action?: ReactNode};
  children: (items: T[]) => ReactNode;
}) {
  if (res.value === undefined) {
    if (res.state === 'loading') return <ListSkeleton/>;
    if (res.state === 'offline') return <Blankslate><Blankslate.Heading>Not on this device yet</Blankslate.Heading><Blankslate.Description>{`${what} load when you are online.`}</Blankslate.Description></Blankslate>;
    return (
      <Banner variant="critical" title={`${what} could not be loaded`} primaryAction={<Button size="small" type="button" onClick={res.reload}>Try again</Button>} description={res.status === 403 ? 'Forgejo refused: this instance may have turned the feature off.' : res.error}/>
    );
  }
  if (!res.value.length) return <Blankslate><Blankslate.Visual><empty.icon size={24}/></Blankslate.Visual><Blankslate.Heading>{empty.title}</Blankslate.Heading><Blankslate.Description>{empty.description}</Blankslate.Description>{empty.action}</Blankslate>;
  return <ul className="flex flex-col rounded-md border border-default">{children(res.value)}</ul>;
}

