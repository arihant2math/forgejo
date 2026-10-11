// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {describe, expect, it} from 'vitest';
import {dispatchDefaults, dispatchProblem, type DispatchInput} from './DispatchWorkflow.tsx';

const input = (name: string, type: string, extra: Partial<DispatchInput> = {}): DispatchInput => ({name, type, description: '', required: false, default: '', options: null, ...extra});

describe('workflow dispatch inputs', () => {
  it('preserves server defaults and sends false for an unchecked boolean', () => {
    expect(dispatchDefaults([input('dry', 'boolean'), input('count', 'number', {default: '0'}), input('target', 'choice', {default: 'staging'})])).toEqual({dry: 'false', count: '0', target: 'staging'});
  });
  it('validates required, numeric and choice inputs without rejecting false or zero', () => {
    const inputs = [input('name', 'string', {required: true}), input('count', 'number'), input('target', 'choice', {options: ['staging']}), input('dry', 'boolean', {required: true})];
    expect(dispatchProblem(inputs, {})).toBe('name is required.');
    expect(dispatchProblem(inputs, {name: 'release', count: 'no'})).toBe('count must be a number.');
    expect(dispatchProblem(inputs, {name: 'release', target: 'unknown'})).toBe('Choose a value for target.');
    expect(dispatchProblem(inputs, {name: 'release', count: '0', target: 'staging', dry: 'false'})).toBeUndefined();
  });
});
