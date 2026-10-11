// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {formBody, initialValues, missingFields, type TemplateField} from './templates.ts';

const fields: TemplateField[] = [
  {type: 'markdown', id: 'intro', attributes: {value: 'Read this first.'}},
  {type: 'input', id: 'version', attributes: {label: 'Version', value: '1.0'}, validations: {required: true}},
  {type: 'textarea', id: 'logs', attributes: {label: 'Logs', render: 'text'}},
  {type: 'dropdown', id: 'platforms', attributes: {label: 'Platforms', multiple: true, list: true, options: ['Linux', 'macOS'], default: [1]}, validations: {required: true}},
  {type: 'checkboxes', id: 'confirm', attributes: {label: 'Confirmation', options: [{label: 'I searched', required: true}, {label: 'Optional'}, {label: 'Hidden', visible: ['content']}, {label: 'Form only', visible: ['form']}, {label: 'Never visible', visible: []}]}},
  {type: 'input', id: 'private', visible: ['form'], attributes: {label: 'Not submitted'}},
  {type: 'markdown', id: 'footer', visible: ['content'], attributes: {value: 'Thanks!'}},
];

test('form body matches Forgejo headings, options, visibility, empty answers and code fences', () => {
  expect(formBody(fields, {...initialValues(fields), logs: ' ```nested\nlog\n``` ', platforms: [1, 0], confirm: [0, 3]})).toBe(
    '### Version\n\n1.0\n\n' +
    '### Logs\n\n````text\n```nested\nlog\n```\n````\n\n' +
    '### Platforms\n\n- Linux\n- macOS\n\n' +
    '### Confirmation\n\n- [x] I searched\n- [ ] Optional\n- [ ] Hidden\n\nThanks!\n\n',
  );
  expect(formBody(fields.slice(1, 4).map((f) => ({...f, attributes: {...f.attributes, list: false}})), {})).toBe('### Version\n\n_No response_\n\n### Logs\n\n_No response_\n\n### Platforms\n\n_No response_\n\n');
  expect(formBody([{type: 'input', id: 'hidden-label', attributes: {hide_label: true}}], {'hidden-label': 'value'})).toBe('value\n\n');
});

test('defaults and required fields, including individual required checkboxes', () => {
  const values = initialValues(fields);
  expect(values.platforms).toEqual([1]);
  expect(missingFields(fields, values)).toEqual(['confirm']);
  expect(missingFields(fields, {...values, version: '  ', platforms: [], confirm: [1]})).toEqual(['version', 'platforms', 'confirm']);
  expect(missingFields(fields, {...values, confirm: [0]})).toEqual([]);
});
