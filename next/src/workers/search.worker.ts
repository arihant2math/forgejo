// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Index pool documents off-thread so local search does not block the page.

import {expose} from 'comlink';
import {createIndex} from './searchIndex.ts';

export type {SearchAnswer, SearchApi, SearchDoc, SearchHit} from './searchIndex.ts';

expose(createIndex());
