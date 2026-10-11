// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What the settings sections share: a change shown before Forgejo confirms
// it (optimistic), the "you are offline" note, a list's placeholder rows and
// the lists' rows.

import {observer} from 'mobx-react-lite';
import {type ReactNode, useState} from 'react';
import {notify} from '../../app/notices.ts';
import {connectivity, onlineOnly} from '../../app/online.ts';
import type {App} from '../../app/store.ts';
import {Button, Callout, EmptyState, EntryList, Skeleton, type LucideIcon} from '../../ui/index.ts';
import {problemOf} from './problems.ts';
import type {Resource} from './resource.ts';

function same(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
}

/**
 * A value changed here and sent: shown at once in place of the pool's value, until the pool says the same
 * (the change synced back), the request fails (`undo`), or — once the request is done — the pool's value
 * moves on to something else (someone changed it again).
 */
export interface Optimistic<T> {
  shown: T;
  /** Sent, not answered yet. */
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

/**
 * Sends one change shown optimistically: on success the notice (if any), on failure the value goes back and
 * a notice says why.
 */
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

/** Whether a write can be sent now (observes the browser's connectivity). */
export function useOffline(): boolean {
  return !connectivity.online;
}

/** Said at the top of a settings page while offline: its changes are not queued. */
export const OfflineNote = observer(function OfflineNote() {
  if (connectivity.online) return null;
  return <Callout tone="warning" title="You are offline">{onlineOnly('Changing settings')} What this device knows is shown.</Callout>;
});

/** A list's rows before its first answer: the rows' own geometry. */
export function ListSkeleton({rows = 3}: {rows?: number}) {
  return (
    <EntryList>
      {Array.from({length: rows}, (_, i) => (
        <li key={i} aria-hidden className="flex items-center gap-3 border-b border-border-subtle py-2 last:border-b-0">
          <Skeleton round="full" className="size-5"/>
          <span className="flex flex-1 flex-col gap-1.5"><Skeleton className="h-3 w-40"/><Skeleton className="h-3 w-24"/></span>
        </li>
      ))}
    </EntryList>
  );
}

/**
 * A settings list: its rows, a placeholder before the first answer, what Forgejo said when it refused, or the
 * empty state.
 */
export function ResourceList<T>({res, what, empty, children}: {
  res: Resource<T[]>;
  /** What the list is, as the subject of a sentence ("The webhooks"). */
  what: string;
  empty: {icon: LucideIcon; title: string; description: string; action?: ReactNode};
  children: (items: T[]) => ReactNode;
}) {
  if (res.value === undefined) {
    if (res.state === 'loading') return <ListSkeleton/>;
    if (res.state === 'offline') return <EmptyState title="Not on this device yet" description={`${what} load when you are online.`}/>;
    return (
      <Callout tone="danger" title={`${what} could not be loaded`} actions={<Button size="sm" onClick={res.reload}>Try again</Button>}>
        {res.status === 403 ? 'Forgejo refused: this instance may have turned the feature off.' : res.error}
      </Callout>
    );
  }
  if (!res.value.length) return <EmptyState icon={empty.icon} title={empty.title} description={empty.description} action={empty.action}/>;
  return <EntryList>{children(res.value)}</EntryList>;
}

