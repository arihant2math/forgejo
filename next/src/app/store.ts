// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {observable, observableRef, observableShallow} from 'mobx';
import {createContext, useContext} from 'react';
import type {AuthSession} from '../auth/session.ts';
import type {NextConfig} from '../protocol/types.gen.ts';
import type {Pool} from '../data/pool.ts';
import type {Data} from '../sync/data.ts';
import type {NoticeSpec} from './notices.ts';

export interface Session {
  readonly userId: number;
  readonly auth: AuthSession;
  readonly data: Data;
}

export interface UiState {
  paletteOpen: boolean;
  /** Initial palette query, consumed once. */
  paletteQuery: string;
  shortcutsOpen: boolean;
  signOut: {pending: number} | undefined;
  /** Includes queued intents and failed drafts. */
  pendingIntents: number;
  /** Includes pending read/unread intents; undefined until the queue starts. */
  unread: number | undefined;
  /** repoId 0 selects the last-used repository. */
  create: {repoId: number; template?: string; board?: {projectId: number; columnId: number}; title?: string} | undefined;
  unsyncedOpen: boolean;
  /** Oldest first. */
  notices: NoticeSpec[];
  /** Current repository; 0 means none. */
  repoOpen: number;
  /** Last-opened repository, retained after leaving; 0 means none yet. */
  recentRepo: number;
  /** Overrides/conflicts for this issue display inline rather than as notices. */
  issueOpen: number | undefined;
  /** Keyboard targets used for palette actions. */
  issueTarget: readonly number[];
  picker: {kind: PickerKind; issueIds: readonly number[]} | undefined;
  /** Previous site path; an issue's Esc returns only to lists. */
  previousPath: string | undefined;
}

export type PickerKind = 'status' | 'priority' | 'labels' | 'assignees' | 'milestone' | 'reviewers' | 'dependency' | 'project' | 'due';

export interface App {
  readonly config: NextConfig;
  readonly session: Session | undefined;
  readonly ui: UiState;
}

export function createApp(config: NextConfig, session: Session | undefined): App {
  const ui = observable<UiState>(
    {paletteOpen: false, paletteQuery: '', shortcutsOpen: false, signOut: undefined, pendingIntents: 0, unread: undefined, create: undefined, unsyncedOpen: false, issueOpen: undefined, repoOpen: 0, recentRepo: 0, notices: [], issueTarget: [], picker: undefined, previousPath: undefined},
    {notices: observableShallow, issueTarget: observableRef, picker: observableRef, create: observableRef},
  );
  return {config, session, ui};
}

export const AppContext = createContext<App | undefined>(undefined);

export function useApp(): App {
  const app = useContext(AppContext);
  if (!app) throw new Error('useApp outside AppContext');
  return app;
}

/** Requires a signed-in session; throws outside the signed-in shell. */
export function useSession(): Session {
  const s = useApp().session;
  if (!s) throw new Error('useSession without a session');
  return s;
}

/** The session's pool; throws outside the signed-in shell. */
export function usePool(): Pool {
  return useSession().data.pool;
}
