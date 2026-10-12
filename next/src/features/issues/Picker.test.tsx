// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test, vi} from 'vitest';
import {fallbackConfig} from '../../app/config.ts';
import {createApp} from '../../app/store.ts';
import {fakeSession, issue, repo, user} from '../../test/fakeSession.ts';
import {matchOptions, type PickOption} from './pickerItems.tsx';
import {pickerOptions, type PickerDraft} from './Picker.tsx';

test('new issues use the people names, multi-selection and dated milestones of the issue picker', () => {
  const session = fakeSession({userId: 1});
  const app = createApp(fallbackConfig(), session);
  const dev = {...user(1, 'dev'), full_name: 'Dev Admin'};
  session.data.put('User', 'profiles:public', dev);
  session.data.put('User', 'profiles:public', {...user(2, 'alice'), full_name: 'Alice Nakamura'});
  session.data.put('Repository', 'repo:10', repo(10, dev, 'demo'));
  session.data.put('Collaboration', 'repo:10', {id: 1, repo_id: 10, user_id: 2, permission: 'write', created_at: '', updated_at: ''});
  const draft: PickerDraft = {
    repoId: 10, labels: [], assignees: [1, 2], milestone: 0,
    toggleLabel: vi.fn(), setMilestone: vi.fn(),
    setAssignee(id, on) {
      this.assignees = on ? [...this.assignees, id] : this.assignees.filter((x) => x !== id);
    },
  };
  const people = () => pickerOptions(app, 'assignees', [], '', draft).options;
  expect(people().map((p) => p.label)).toEqual(['Dev Admin (you)', 'Alice Nakamura']);
  expect(people().every((p) => p.checked && p.keepOpen)).toBe(true);
  people()[1]?.onSelect();
  expect(draft.assignees).toEqual([1]);
  people()[1]?.onSelect();
  expect(draft.assignees).toEqual([1, 2]);
  for (const [id, title, due] of [[1, 'Backlog', undefined], [2, 'Sprint 1', '2026-10-20T00:00:00Z']] as const) {
    session.data.put('Milestone', 'repo:10', {
      id, repo_id: 10, title, description: '', state: 'open', open_issues: 0, closed_issues: 0,
      created_at: '', updated_at: '', ...(due ? {due_on: due} : {}),
    });
  }
  const milestones = pickerOptions(app, 'milestone', [], '', draft).options;
  expect(milestones.map((m) => m.label)).toEqual(['No milestone', 'Sprint 1', 'Backlog']);
  expect(milestones[1]?.meta).toContain('due ');
  milestones[1]?.onSelect();
  expect(draft.setMilestone).toHaveBeenCalledWith(2);
});

test('assignee and reviewer rows show the login beside the full name, so namesakes can be told apart (#263)', () => {
  const session = fakeSession({userId: 1});
  const app = createApp(fallbackConfig(), session);
  const dev = {...user(1, 'dev'), full_name: 'Dev Admin'};
  session.data.put('User', 'profiles:public', dev);
  session.data.put('Repository', 'repo:10', repo(10, dev, 'demo'));
  for (const [id, login] of [[2, 'alice'], [3, 'u-m14-next'], [4, 'u-m14-classic'], [5, 'carol']] as const) {
    session.data.put('User', 'profiles:public', {...user(id, login), full_name: login === 'carol' ? '' : 'Alice Nakamura'});
    session.data.put('Collaboration', 'repo:10', {id, repo_id: 10, user_id: id, permission: 'write', created_at: '', updated_at: ''});
  }
  session.data.put('Issue', 'repo:10', issue(100, 10, 1, 'A pull request', {is_pull: true, poster_id: 5}));
  const draft: PickerDraft = {repoId: 10, labels: [], assignees: [3], milestone: 0, toggleLabel: vi.fn(), setMilestone: vi.fn(), setAssignee: vi.fn()};
  const rows = (o: readonly PickOption[]) => o.map((p) => [p.label, p.meta, p.checked]);
  const alices = matchOptions(pickerOptions(app, 'assignees', [], 'alice', draft).options, 'alice');
  expect(rows(alices)).toEqual([
    ['Alice Nakamura', 'alice', false],
    ['Alice Nakamura', 'u-m14-classic', false],
    ['Alice Nakamura', 'u-m14-next', true],
  ]);
  expect(rows(pickerOptions(app, 'assignees', [], '', draft).options)).toContainEqual(['carol', undefined, false]);
  expect(rows(pickerOptions(app, 'assignees', [], '', draft).options)[0]).toEqual(['Dev Admin (you)', 'dev', false]);
  const reviewers = pickerOptions(app, 'reviewers', [100], '', undefined).options;
  expect(rows(reviewers).map(([label, meta]) => [label, meta])).toEqual([
    ['Dev Admin (you)', 'dev'], ['Alice Nakamura', 'alice'], ['Alice Nakamura', 'u-m14-classic'], ['Alice Nakamura', 'u-m14-next'],
  ]);
});
