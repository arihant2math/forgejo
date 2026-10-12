// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {fireEvent, render, screen} from '@testing-library/react';
import {useState} from 'react';
import {expect, test} from 'vitest';
import {GlobeIcon, LockIcon} from '@primer/octicons-react';
import {Field} from '../../components/Field.tsx';
import {Choice, NamePicker} from './parts.tsx';

test('Primer visibility radios keep a forced-private reason and accessible descriptions', () => {
  render(<Choice name="visibility" label="Visibility" value="private" onChange={() => undefined} options={[
    {value: 'public', label: 'Public', description: 'Everyone can see it.', icon: GlobeIcon, disabled: 'This instance requires private repositories.'},
    {value: 'private', label: 'Private', description: 'Only invited people can see it.', icon: LockIcon},
  ]}/>);
  expect(screen.getByRole<HTMLInputElement>('radio', {name: 'Public'}).disabled).toBe(true);
  expect(screen.getByRole<HTMLInputElement>('radio', {name: 'Private'}).checked).toBe(true);
  expect(screen.getByText('This instance requires private repositories.')).toBeTruthy();
});

function Names() {
  const [chosen, setChosen] = useState<string[]>([]);
  return <Field label="Ignore templates" hint="Several combine."><NamePicker label="Ignore templates" placeholder="Filter templates…"
    names={['Go', 'Node', 'Python']} chosen={chosen} multi none="No .gitignore" empty="No matching templates" onChange={setChosen}/></Field>;
}

test('multi-template picker filters local names, retains choices, and None clears them', async () => {
  render(<Names/>);
  const anchor = screen.getByRole('button', {name: 'Ignore templates'});
  // The picker's anchor takes the field's label and hint from the FormControl around it.
  expect(document.getElementById(anchor.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Several combine.');
  fireEvent.click(anchor);
  fireEvent.click(await screen.findByRole('option', {name: 'Go'}));
  fireEvent.click(screen.getByRole('option', {name: 'Node'}));
  expect(screen.getByRole('option', {name: 'Go'}).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('option', {name: 'Node'}).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('option', {name: 'No .gitignore'}));
  expect(screen.getByRole('option', {name: 'Go'}).getAttribute('aria-selected')).toBe('false');
  fireEvent.change(screen.getByRole('combobox', {name: 'Ignore templates'}), {target: {value: 'Py'}});
  expect(await screen.findByRole('option', {name: 'Python'})).toBeTruthy();
  expect(screen.queryByRole('option', {name: 'Node'})).toBeNull();
});
