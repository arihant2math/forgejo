// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {BaseStyles, Button, ThemeProvider} from '@primer/react';
import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {useState} from 'react';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {ChoicePanel} from './ChoicePanel.tsx';

// Focus-zone visibility requires layout metrics, which jsdom does not calculate.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(32);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(256);
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (this: HTMLElement) { return this.parentElement; });
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => {
    const rect = new DOMRect(0, 0, 256, 32);
    return Object.assign([rect], {item: (index: number) => index === 0 ? rect : null});
  });
});
afterEach(() => { vi.restoreAllMocks(); });

function Wrapper({multiple = false, picked}: {multiple?: boolean; picked: (value: string) => void}) {
  const [selected, setSelected] = useState<string[]>([]);
  return <ThemeProvider><BaseStyles><ChoicePanel title="Branches" placeholder="Find a branch…" multiple={multiple}
    choices={['main', 'feature/keyboard'].map((value) => ({value, label: value, checked: selected.includes(value), onSelect: () => {
      picked(value); setSelected((previous) => previous.includes(value) ? previous.filter((item) => item !== value) : [...previous, value]);
    }}))} anchor={<Button>Choose branch</Button>}/></BaseStyles></ThemeProvider>;
}

test('a ref picker filters locally, Enter chooses, and Escape returns focus to its anchor', async () => {
  const picked = vi.fn();
  render(<Wrapper picked={picked}/>);
  const anchor = screen.getByRole('button', {name: 'Choose branch'});
  fireEvent.click(anchor);
  fireEvent.change(screen.getByRole('combobox', {name: 'Branches'}), {target: {value: 'feature'}});

  fireEvent.keyDown(screen.getByRole('combobox', {name: 'Branches'}), {key: 'Enter', code: 'Enter'});

  expect(picked).toHaveBeenCalledWith('feature/keyboard');
  await waitFor(() => { expect(screen.queryByRole('combobox', {name: 'Branches'})).toBeNull(); });
  fireEvent.click(anchor);
  fireEvent.keyDown(screen.getByRole('combobox', {name: 'Branches'}), {key: 'Escape', code: 'Escape'});
  await waitFor(() => { expect(document.activeElement).toBe(anchor); });
});

test('multiple metadata choices stay open and toggle independently', () => {

  const picked = vi.fn();
  render(<Wrapper multiple picked={picked}/>);
  fireEvent.click(screen.getByRole('button', {name: 'Choose branch'}));
  fireEvent.click(screen.getByRole('option', {name: 'main'}));
  expect(picked).toHaveBeenLastCalledWith('main');
  expect(screen.getByRole('combobox', {name: 'Branches'})).toBeTruthy();
  fireEvent.click(screen.getByRole('option', {name: 'feature/keyboard'}));
  expect(picked).toHaveBeenLastCalledWith('feature/keyboard');
  fireEvent.click(screen.getByRole('option', {name: 'main'}));
  expect(picked).toHaveBeenLastCalledWith('main');
});
