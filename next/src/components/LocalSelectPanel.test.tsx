// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {BaseStyles, Button, ThemeProvider} from '@primer/react';
import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {useState} from 'react';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {LocalSelectPanel} from './LocalSelectPanel.tsx';
import {matchOptions, type PickOption, VIRTUALIZE_OVER} from './pickOptions.ts';

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

const option = (value: string, more: Partial<PickOption> = {}): PickOption => ({value, label: value, onSelect: () => undefined, ...more});

function Branches({multiple = false, names = ['main', 'feature/keyboard'], picked, group}: {
  multiple?: boolean; names?: string[]; picked: (value: string) => void; group?: (name: string) => string | undefined;
}) {
  const [chosen, setChosen] = useState<string[]>(['main']);
  return <ThemeProvider><BaseStyles><LocalSelectPanel title="Branches" placeholder="Find a branch…" multiple={multiple}
    options={names.map((value) => option(value, {group: group?.(value), words: value === 'main' ? 'default' : undefined, checked: chosen.includes(value), onSelect: () => {
      picked(value);
      setChosen((previous) => multiple ? previous.includes(value) ? previous.filter((item) => item !== value) : [...previous, value] : [value]);
    }}))}
    renderAnchor={(props) => <Button {...props}>Choose branch</Button>}/></BaseStyles></ThemeProvider>;
}

const input = () => screen.getByRole('combobox', {name: 'Branches'});

test('matching wants every typed word in the label or the words', () => {
  const options = [option('main', {words: 'default branch'}), option('feature/keyboard'), option('release')];
  expect(matchOptions(options, 'DEFAULT').map((o) => o.value)).toEqual(['main']);
  expect(matchOptions(options, 'feat key').map((o) => o.value)).toEqual(['feature/keyboard']);
  expect(matchOptions(options, '  ')).toBe(options);
});

test('the filter matches words, Enter picks the first match and closes, and Escape returns focus', async () => {
  const picked = vi.fn();
  render(<Branches picked={picked}/>);
  const anchor = screen.getByRole('button', {name: 'Choose branch'});
  fireEvent.click(anchor);
  fireEvent.change(input(), {target: {value: 'default'}});
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['main']);
  fireEvent.change(input(), {target: {value: 'feature'}});
  fireEvent.keyDown(input(), {key: 'Enter', code: 'Enter'});
  expect(picked).toHaveBeenCalledWith('feature/keyboard');
  await waitFor(() => { expect(screen.queryByRole('combobox', {name: 'Branches'})).toBeNull(); });

  fireEvent.click(anchor);
  expect(input().getAttribute('value')).toBe('');
  fireEvent.keyDown(input(), {key: 'Escape', code: 'Escape'});
  await waitFor(() => { expect(document.activeElement).toBe(anchor); });
});

test('Enter on an empty filter picks nothing', () => {
  const picked = vi.fn();
  render(<Branches picked={picked}/>);
  fireEvent.click(screen.getByRole('button', {name: 'Choose branch'}));
  fireEvent.keyDown(input(), {key: 'Enter', code: 'Enter'});
  expect(picked).not.toHaveBeenCalled();
  expect(input()).toBeTruthy();
});

test('a single-select panel opens on the chosen option', () => {
  render(<Branches picked={vi.fn()} names={['alpha', 'main']}/>);
  fireEvent.click(screen.getByRole('button', {name: 'Choose branch'}));
  const [first] = screen.getAllByRole('option');
  expect(first?.textContent).toBe('main');
  expect(first?.getAttribute('aria-selected')).toBe('true');
});

test('a multi-select panel stays open and toggles each option', () => {
  const picked = vi.fn();
  render(<Branches multiple picked={picked}/>);
  fireEvent.click(screen.getByRole('button', {name: 'Choose branch'}));
  expect(screen.getByRole('listbox', {name: 'Branches'}).getAttribute('aria-multiselectable')).toBe('true');
  expect(screen.getByRole('option', {name: 'main'}).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('option', {name: 'feature/keyboard'}));
  expect(picked).toHaveBeenLastCalledWith('feature/keyboard');
  expect(screen.getByRole('option', {name: 'feature/keyboard'}).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('option', {name: 'main'}));
  expect(screen.getByRole('option', {name: 'main'}).getAttribute('aria-selected')).toBe('false');
  expect(input()).toBeTruthy();
});

test('groups head short lists; long lists virtualize and name the group inline', () => {
  const group = (name: string) => name.startsWith('v') ? 'Tags' : 'Branches';
  const {unmount} = render(<Branches picked={vi.fn()} names={['main', 'v1.0']} group={group}/>);
  fireEvent.click(screen.getByRole('button', {name: 'Choose branch'}));
  expect(screen.getByText('Tags')).toBeTruthy();
  expect(within(screen.getByRole('option', {name: 'v1.0'})).queryByText('Tags')).toBeNull();
  unmount();

  const names = Array.from({length: VIRTUALIZE_OVER + 1}, (_, i) => `v${String(i)}`);
  render(<Branches picked={vi.fn()} names={names} group={group}/>);
  fireEvent.click(screen.getByRole('button', {name: 'Choose branch'}));
  const rows = screen.getAllByRole('option');
  expect(rows.length).toBeLessThan(names.length);
  expect(within(rows[0] as HTMLElement).getByText('Tags')).toBeTruthy();
});

test('says when the filter matches nothing, and what is missing when there is nothing at all', () => {
  render(<ThemeProvider><BaseStyles>
    <LocalSelectPanel title="Tags" placeholder="Find a tag…" empty="No tag without a release." options={[]} renderAnchor={(props) => <Button {...props}>Tags</Button>}/>
    <LocalSelectPanel title="Labels" placeholder="Find a label…" options={() => [option('bug')]} renderAnchor={(props) => <Button {...props}>Labels</Button>}/>
  </BaseStyles></ThemeProvider>);
  fireEvent.click(screen.getByRole('button', {name: 'Tags'}));
  expect(screen.getByText('No tag without a release.')).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('combobox', {name: 'Tags'}), {key: 'Escape', code: 'Escape'});
  fireEvent.click(screen.getByRole('button', {name: 'Labels'}));
  fireEvent.change(screen.getByRole('combobox', {name: 'Labels'}), {target: {value: 'feature'}});
  expect(screen.getByText('Nothing matches “feature”.')).toBeTruthy();
});
