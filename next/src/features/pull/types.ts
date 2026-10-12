// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {Entity} from '../../data/entity.ts';

export interface TabProps {
  issue: Entity<'Issue'>;
  owner: string;
  repo: string;
}
