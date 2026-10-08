// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The app's root state: the server config, the signed-in session (the
// user's auth and data) and a little observable UI state. One instance per
// page, created by main.tsx before the first render and handed to the
// router as context and to components through AppContext.

import {observable, observableRef, observableShallow} from 'mobx';
import {createContext, useContext} from 'react';
import type {AuthSession} from '../auth/session.ts';
import type {NextConfig} from '../protocol/types.gen.ts';
import type {Data} from '../sync/data.ts';
import type {NoticeSpec} from './notices.ts';

export interface Session {
  readonly userId: number;
  readonly auth: AuthSession;
  readonly data: Data;
}

export interface UiState {
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  /** The sign-out warning (unsynced intents), with their count. */
  signOut: {pending: number} | undefined;
  /** Changes not synced yet: queued intents and failed ones kept as drafts (the sync indicator's "N pending"). */
  pendingIntents: number;
  /** The "Unsynced changes" panel is open. */
  unsyncedOpen: boolean;
  /** Transient notices (notices.ts), oldest first. */
  notices: NoticeSpec[];
  /** The issue whose page is open (its conflicts and overrides show inline there, not as notices). */
  issueOpen: number | undefined;
  /** The issues the keyboard acts on (the list's selection or cursor, the open issue): the palette offers their actions. */
  issueTarget: readonly number[];
  /** An open issue picker (S/L/A/M/P): which field, for which issues. */
  picker: {kind: PickerKind; issueIds: readonly number[]} | undefined;
}

export type PickerKind = 'status' | 'priority' | 'labels' | 'assignees' | 'milestone';

export interface App {
  readonly config: NextConfig;
  /** undefined: nobody is signed in on this device (the logged-out screen). */
  readonly session: Session | undefined;
  readonly ui: UiState;
}

export function createApp(config: NextConfig, session: Session | undefined): App {
  const ui = observable<UiState>(
    {paletteOpen: false, shortcutsOpen: false, signOut: undefined, pendingIntents: 0, unsyncedOpen: false, issueOpen: undefined, notices: [], issueTarget: [], picker: undefined},
    {notices: observableShallow, issueTarget: observableRef, picker: observableRef},
  );
  return {config, session, ui};
}

export const AppContext = createContext<App | undefined>(undefined);

export function useApp(): App {
  const app = useContext(AppContext);
  if (!app) throw new Error('useApp outside AppContext');
  return app;
}

/** The signed-in session; only for components below the signed-in shell. */
export function useSession(): Session {
  const s = useApp().session;
  if (!s) throw new Error('useSession without a session');
  return s;
}
