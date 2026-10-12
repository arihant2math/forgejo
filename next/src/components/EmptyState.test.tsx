// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {render, screen} from '@testing-library/react';
import {TagIcon} from '@primer/octicons-react';
import {Button} from '@primer/react';
import {expect, test} from 'vitest';
import {EmptyState} from './EmptyState.tsx';

test('a spacious Blankslate with the icon, heading, description and action', () => {
  const {container} = render(<EmptyState icon={TagIcon} title="No labels yet" description="Labels sort issues." action={<Button>New label</Button>}/>);
  const slate = container.querySelector('[data-component="Blankslate"]');
  expect(slate?.hasAttribute('data-spacious')).toBe(true);
  expect(screen.getByRole('heading', {name: 'No labels yet'})).toBeTruthy();
  expect(screen.getByText('Labels sort issues.')).toBeTruthy();
  expect(screen.getByRole('button', {name: 'New label'})).toBeTruthy();
  expect(slate?.querySelector('svg.octicon-tag')).toBeTruthy();
});

test('inside a box it is compact, and the optional parts stay out', () => {
  const {container} = render(<EmptyState title="Empty directory" spacious={false}/>);
  const slate = container.querySelector('[data-component="Blankslate"]');
  expect(slate?.hasAttribute('data-spacious')).toBe(false);
  expect(slate?.querySelector('svg')).toBeNull();
  expect(slate?.textContent).toBe('Empty directory');
});
