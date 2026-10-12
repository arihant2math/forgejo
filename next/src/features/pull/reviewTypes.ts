// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {type Anchor, commentAnchor} from '../../code/anchor.ts';
import type {ReviewDraft} from '../../code/review.ts';
import type {Comment} from '../../protocol/types.gen.ts';

export type Item = {kind: 'comment'; c: Comment; pending: boolean} | {kind: 'draft'; d: ReviewDraft};

export const composerKey = (c: Composing) => `${String(c.f)}:${String(c.l)}:${c.key ?? ''}`;

export const itemAnchor = (it: Item): Anchor => (it.kind === 'draft' ? it.d.anchor : commentAnchor(it.c));

/** Keep composer text outside virtualized threads so unmounts and head changes cannot lose it. */
export interface Composing {
  f: number;
  l: number;
  key?: string | undefined;
  initial: string;
  start?: number;
}
