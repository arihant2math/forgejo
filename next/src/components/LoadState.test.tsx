// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {act, fireEvent, render, screen} from '@testing-library/react';
import {PeopleIcon} from '@primer/octicons-react';
import {observable, runInAction} from 'mobx';
import {beforeEach, expect, test, vi} from 'vitest';
import type {Resource} from '../app/resource.ts';
import {LoadState} from './LoadState.tsx';

const app = vi.hoisted(() => ({session: {data: {status: {connection: 'live'}}}}));
vi.mock('../app/store.ts', () => ({useApp: () => app}));

beforeEach(() => {
  app.session.data.status = observable({connection: 'live'});
});

const controls = {fresh: false, update: () => undefined, reload: () => undefined};
const ready = <T,>(value: T): Resource<T> => ({...controls, fresh: true, state: 'ready', value});
const empty = {icon: PeopleIcon, title: 'No people', description: 'None that you can see.'};

test('a ready value renders the children, an empty list its empty state', () => {
  const view = render(<LoadState res={ready(['ada'])} what="The people" empty={empty}>{(people) => <p>{people.join()}</p>}</LoadState>);
  expect(screen.getByText('ada')).toBeTruthy();
  view.rerender(<LoadState res={ready([])} what="The people" empty={empty}>{(people) => <p>{people.join()}</p>}</LoadState>);
  expect(screen.getByText('No people')).toBeTruthy();
});

test('loading shows a skeleton, the given one first', () => {
  const view = render(<LoadState res={{state: 'loading'}} what="The people"/>);
  expect(view.container.querySelector('[aria-busy]')).toBeTruthy();
  view.rerender(<LoadState res={{state: 'loading'}} what="The people" skeleton={<p>rows</p>}/>);
  expect(screen.getByText('rows')).toBeTruthy();
});

test('offline in a section says it loads later; connected, the same state is a failed request with a retry', () => {
  const reload = vi.fn();
  runInAction(() => {
    app.session.data.status.connection = 'offline';
  });
  const view = render(<LoadState res={{state: 'offline', reload}} what="The webhooks"/>);
  expect(screen.getByText('Not available offline')).toBeTruthy();
  expect(screen.getByText('The webhooks are not on this device yet: they load once Forgejo answers.')).toBeTruthy();
  act(() => {
    runInAction(() => {
      app.session.data.status.connection = 'live';
    });
  });
  view.rerender(<LoadState res={{state: 'offline', reload}} what="The webhooks"/>);
  expect(screen.getByText('The webhooks could not be loaded')).toBeTruthy();
  // Banner renders its action for narrow and wide layouts.
  fireEvent.click(screen.getAllByRole('button', {name: 'Try again'})[0] as HTMLElement);
  expect(reload).toHaveBeenCalledOnce();
});

test('failures: not found offers the action, a refusal explains itself, server faults show their text and a retry', () => {
  const reload = vi.fn();
  const view = render(<LoadState res={{state: 'error', error: 'Not Found', status: 404, reload}} what="This file" page action={<a href="/">Back</a>}/>);
  expect(screen.getByText('Not found')).toBeTruthy();
  expect(screen.getByText('This file does not exist, or you cannot see it.')).toBeTruthy();
  expect(screen.getByText('Back')).toBeTruthy();
  expect(screen.queryByRole('button', {name: 'Retry'})).toBeNull();
  view.rerender(<LoadState res={{state: 'error', error: 'Forgejo refused it (HTTP 403).', status: 403, reload}} what="The deploy keys"/>);
  expect(screen.getByText('Forgejo refused: you may not see this, or this instance turned the feature off.')).toBeTruthy();
  // Asking again does not cure a refusal.
  expect(screen.queryByRole('button', {name: 'Try again'})).toBeNull();
  view.rerender(<LoadState res={{state: 'error', error: 'Forgejo ran into an error. Try again in a moment.', status: 500, reload}} what="This file" page/>);
  expect(screen.getByText('Could not load')).toBeTruthy();
  expect(screen.getByText('Forgejo ran into an error. Try again in a moment.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: 'Retry'}));
  expect(reload).toHaveBeenCalledOnce();
  view.rerender(<LoadState res={{state: 'error', error: 'You are signed out.', status: 401}} what="This file" page/>);
  expect(screen.getByText('Signed out')).toBeTruthy();
});
