// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Column changes (B9 gap endpoints): online only, never queued (PLAN §5.4:
// only card moves are offline-capable). The column itself arrives as a
// delta; a failure says why.

import {online, RequestFailed} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {connectivity, onlineOnly} from '../../app/online.ts';
import type {App} from '../../app/store.ts';
import type {APIColumnCreate, APIColumnEdit, APIColumnOrder} from '../../protocol/types.gen.ts';

async function send(app: App, what: string, req: Parameters<typeof online>[1]): Promise<boolean> {
  if (!connectivity.online) {
    notify(app, {tone: 'neutral', title: onlineOnly(what)});
    return false;
  }
  try {
    await online(app, req);
    return true;
  } catch (err) {
    const reason = err instanceof RequestFailed ? err.message : 'Something went wrong.';
    notify(app, {tone: 'danger', title: `${what} failed`, description: reason});
    return false;
  }
}

const base = (projectId: number) => `/projects/${String(projectId)}`;

export function createColumn(app: App, projectId: number, title: string): Promise<boolean> {
  const body: APIColumnCreate = {title};
  return send(app, 'Adding a column', {method: 'POST', api: 'sync', path: `${base(projectId)}/columns`, body});
}

export function editColumn(app: App, projectId: number, columnId: number, edit: APIColumnEdit): Promise<boolean> {
  return send(app, edit.default ? 'Making the column the default' : 'Renaming the column', {
    method: 'PATCH', api: 'sync', path: `${base(projectId)}/columns/${String(columnId)}`, body: edit,
  });
}

export function deleteColumn(app: App, projectId: number, columnId: number): Promise<boolean> {
  return send(app, 'Deleting the column', {method: 'DELETE', api: 'sync', path: `${base(projectId)}/columns/${String(columnId)}`});
}

export function orderColumns(app: App, projectId: number, ids: number[]): Promise<boolean> {
  const body: APIColumnOrder = {column_ids: ids};
  return send(app, 'Moving the column', {method: 'PUT', api: 'sync', path: `${base(projectId)}/column-order`, body});
}
