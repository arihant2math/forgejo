// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {render, screen, within} from '@testing-library/react';
import {expect, test} from 'vitest';
import {BorderBox, BoxHeader} from './BorderBox.tsx';

test('a box is a region named by its label, headed by a level-2 heading unless asked otherwise', () => {
  render(<>
    <BorderBox label="Unread" title="Unread" actions={<button type="button">View all</button>}><p>row</p></BorderBox>
    <BorderBox label="Keys" title="2 keys" headingLevel={3}><p>row</p></BorderBox>
  </>);
  const unread = screen.getByRole('region', {name: 'Unread'});
  expect(within(unread).getByRole('heading', {level: 2, name: 'Unread'})).toBeTruthy();
  expect(within(unread).getByRole('button', {name: 'View all'}).closest('header')).toBeTruthy();
  expect(within(screen.getByRole('region', {name: 'Keys'})).getByRole('heading', {level: 3, name: '2 keys'})).toBeTruthy();
});

test('a free header is not a heading, a padded box pads its body, and an unlabelled box is no landmark', () => {
  const {container} = render(<>
    <BorderBox label="Files" header={<span>main · Fix the build</span>}><p>entries</p></BorderBox>
    <BorderBox title="Addresses" padded><p>body</p></BorderBox>
  </>);
  const files = screen.getByRole('region', {name: 'Files'});
  expect(within(files).queryByRole('heading')).toBeNull();
  expect(within(files).getByText('main · Fix the build').closest('header')).toBeTruthy();
  expect(screen.getByText('body').parentElement?.className).toContain('p-4');
  expect(screen.getAllByRole('region')).toHaveLength(1);
  expect(container.querySelectorAll('header')).toHaveLength(2);
});

test('the accent header marks a linked comment', () => {
  render(<><BoxHeader accent>linked</BoxHeader><BoxHeader>plain</BoxHeader></>);
  expect(screen.getByText('linked').className).toContain('bg-accent-muted');
  expect(screen.getByText('plain').className).toContain('bg-muted');
  expect(screen.getByText('plain').className).not.toContain('bg-accent-muted');
});
