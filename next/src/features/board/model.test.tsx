// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {createApp} from '../../app/store.ts';
import {editing} from '../../intents/session.ts';
import {issueProject} from '../../intents/view.ts';
import {fakeSession, issue} from '../../test/fakeSession.ts';
import {BoardModel} from './model.ts';

test('adding two existing issues and removing one uses offline project intents', () => {
  const s = fakeSession();
  for (const id of [30, 31]) s.data.put('Issue', 'repo:20', issue(id, 20, id, `Issue ${id}`));
  const app = createApp({app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null}, s);
  const model = new BoardModel(app, 10);
  const {overlay} = editing(app);
  model.setProject(30, 10, 11);
  model.setProject(31, 10, 11);
  expect(issueProject(s.data.pool, overlay, 30)).toEqual({project: 10, column: 11});
  expect(issueProject(s.data.pool, overlay, 31)).toEqual({project: 10, column: 11});
  model.setProject(30, 0, 0);
  expect(issueProject(s.data.pool, overlay, 30)).toEqual({project: 0, column: 0});
  expect(issueProject(s.data.pool, overlay, 31)).toEqual({project: 10, column: 11});
  model.dispose();
});
