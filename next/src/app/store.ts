// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The app's root state: the server config, the signed-in session (the
// user's auth and data) and a little observable UI state. One instance per
// page, created by main.tsx before the first render and handed to the
// router as context and to components through AppContext.

import {observable} from 'mobx';
import {createContext, useContext} from 'react';
import type {AuthSession} from '../auth/session.ts';
import type {NextConfig} from '../protocol/types.gen.ts';
import type {Data} from '../sync/data.ts';

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
  /** Intents not synced yet (the sync indicator's "N pending"; F5 keeps it current). */
  pendingIntents: number;
}

export interface App {
  readonly config: NextConfig;
  /** undefined: nobody is signed in on this device (the logged-out screen). */
  readonly session: Session | undefined;
  readonly ui: UiState;
}

export function createApp(config: NextConfig, session: Session | undefined): App {
  const ui = observable<UiState>({paletteOpen: false, shortcutsOpen: false, signOut: undefined, pendingIntents: 0});
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
