// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useState} from 'react';
import {online} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {useApp} from '../../app/store.ts';
import {useReach} from '../../app/online.ts';
import {problemOf} from './problems.ts';
import type {Resource} from '../../app/resource.ts';

/**
 * A confirmed API v1 DELETE of one item of a settings list: `ask(item)` opens the confirmation, and a success
 * drops the item from `res` and says `done(item)`; a failure stays in the dialog.
 */
export function useRemoval<T>(res: Resource<T[]>, {path, same, done}: {path: (item: T) => string; same: (a: T, b: T) => boolean; done: (item: T) => string}) {
  const app = useApp();
  const offline = useReach() !== 'online';
  const [target, setTarget] = useState<T | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const remove = async (item: T) => {
    if (busy || offline) return;
    setBusy(true);
    setError(undefined);
    try {
      await online(app, {method: 'DELETE', api: 'v1', path: path(item)});
      res.update((list) => (list ?? []).filter((x) => !same(x, item)));
      setTarget(undefined);
      notify(app, {tone: 'success', title: done(item)});
    } catch (err) {
      setError(problemOf(err).message);
    } finally {
      setBusy(false);
    }
  };
  return {
    target,
    ask: (item: T) => {
      setError(undefined);
      setTarget(item);
    },
    dialog: {
      open: target !== undefined, busy, error,
      onOpenChange: (open: boolean) => { if (!open && !busy) setTarget(undefined); },
      onConfirm: () => { if (target !== undefined) void remove(target); },
    },
  };
}
