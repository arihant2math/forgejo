// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {appWorkerURL} from '../app/trusted.ts';

/** Vite emits worker paths relative to the build; deploy them below the app's base. */
export function pierreWorker(base: string, workerURL: string, name: string): Worker {
  const at = workerURL.indexOf('assets/');
  const url = at >= 0 ? `${base}${workerURL.slice(at)}` : workerURL;
  return new Worker(appWorkerURL(base, url), {type: 'module', name});
}
