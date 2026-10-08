// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The local search index (PLAN §5.1: MiniSearch in a worker, over Comlink):
// issues and pull requests by title, repository and number, with prefix
// and typo-tolerant matching. The page feeds it from the pool (documents in
// batches, then changes) and asks it as the user types; indexing never
// blocks the page. The server's issue search covers what is not on this
// device (features/search).

import {expose} from 'comlink';
import {createIndex} from './searchIndex.ts';

export type {SearchAnswer, SearchApi, SearchDoc, SearchHit} from './searchIndex.ts';

expose(createIndex());
