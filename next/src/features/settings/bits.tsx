// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {type ReactNode, useState} from 'react';
import {notify} from '../../app/notices.ts';
import type {Resource} from '../../app/resource.ts';
import type {App} from '../../app/store.ts';
import {LoadState, type LoadStateProps} from '../../components/LoadState.tsx';
import {problemOf} from './problems.ts';

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

/** A settings list in its frame, with the shared loading, offline, failure and empty states. */
export function ResourceList<T>({res, what, empty, children}: {
  res: Resource<T[]>;
  /** Sentence subject, e.g. "The webhooks". */
  what: string;
  empty: NonNullable<LoadStateProps<T[]>['empty']>;
  children: (items: T[]) => ReactNode;
}) {
  return <LoadState res={res} what={what} empty={empty}>{(items) => <ul className="flex flex-col rounded-md border border-default">{children(items)}</ul>}</LoadState>;
}
