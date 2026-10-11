// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {render, screen} from '@testing-library/react';
import {expect, test} from 'vitest';
import {LoggedOut} from './LoggedOut.tsx';

test('anonymous viewing requires a verified public page, independently of opting out', () => {
  const {rerender} = render(<LoggedOut classic={{optOut: '/opt-out'}}/>);
  expect(screen.queryByText('View this page without signing in')).toBeNull();
  expect(screen.getByText('Turn off Forgejo Next').getAttribute('href')).toBe('/opt-out');
  rerender(<LoggedOut classic={{page: '/acme/public?ui=classic', optOut: '/opt-out'}}/>);
  expect(screen.getByText('View this page without signing in').getAttribute('href')).toBe('/acme/public?ui=classic');
});
