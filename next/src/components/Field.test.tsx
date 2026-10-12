// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {render, screen} from '@testing-library/react';
import {TextInput} from '@primer/react';
import {expect, test} from 'vitest';
import {Field} from './Field.tsx';

const description = (el: HTMLElement) => (el.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();

test('the label names the input and the hint describes it', () => {
  render(<Field label="Name" hint="Short and memorable." optional><TextInput/></Field>);
  const input = screen.getByRole('textbox', {name: 'Name (optional)'});
  expect(description(input)).toBe('Short and memorable.');
  expect(input.getAttribute('aria-invalid')).not.toBe('true');
});

test('an error replaces the hint, marks the input invalid and is its description', () => {
  render(<Field label="Name" hint="Short and memorable." error="This name is taken." required><TextInput/></Field>);
  const input = screen.getByRole('textbox', {name: /^Name/});
  expect(description(input)).toBe('This name is taken.');
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(input.getAttribute('aria-required')).toBe('true');
  expect(screen.queryByText('Short and memorable.')).toBeNull();
});
