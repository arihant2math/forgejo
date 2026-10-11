// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {artifactExpiry, type Artifact} from './Artifacts.tsx';

test('artifact expiry respects server status and the retention deadline', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  const artifact: Artifact = {id: 1, name: 'build', size_in_bytes: 1024, expired: false, expires_at: '2026-10-02T00:00:00Z'};
  expect(artifactExpiry(artifact, now)).toBe('Expires in 1 d');
  expect(artifactExpiry({...artifact, expires_at: '2026-10-01T01:30:00Z'}, now)).toBe('Expires in 2 h');
  expect(artifactExpiry({...artifact, expired: true}, now)).toBe('Expired');
  expect(artifactExpiry(artifact, now + 86_400_000)).toBe('Expired');
  expect(artifactExpiry({...artifact, expires_at: ''}, now)).toBe('Expiry unknown');
});
