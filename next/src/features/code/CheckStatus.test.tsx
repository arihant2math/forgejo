// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {render} from '@testing-library/react';
import {expect, test} from 'vitest';
import {CheckIcon, DotFillIcon, XIcon} from '@primer/octicons-react';
import {CHECK_SUMMARY} from '../pull/checks.ts';
import {CheckStatus} from './CheckStatus.tsx';

test('check summaries use small row glyphs and shared labels', () => {
  expect(CHECK_SUMMARY.success).toEqual({icon: CheckIcon, tone: 'text-success', label: 'All checks have passed'});
  expect(CHECK_SUMMARY.failure).toEqual({icon: XIcon, tone: 'text-danger', label: 'Some checks were not successful'});
  expect(CHECK_SUMMARY.pending).toEqual({icon: DotFillIcon, tone: 'text-attention', label: "Some checks haven't completed yet"});
  const {container, rerender} = render(<CheckStatus summary="pending"/>);
  expect(container.querySelector('svg')?.classList.contains('text-attention')).toBe(true);
  rerender(<CheckStatus summary="success"/>);
  expect(container.querySelector('svg')?.classList.contains('text-success')).toBe(true);
});
