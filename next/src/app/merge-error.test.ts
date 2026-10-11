import {describe, expect, it} from 'vitest';
import {failureText, RequestFailed} from './api.ts';

describe('merge refusals', () => {
  it('explains missing approvals without the internal error wrapper', () => {
    expect(failureText(new RequestFailed(405, 'not allowed to merge [reason: Does not have enough approvals]'))).toBe('More approvals are required before this pull request can be merged.');
  });
  it('gives an actionable fallback for unfamiliar merge rules', () => {
    expect(failureText(new RequestFailed(405, 'not allowed to merge [reason: unfamiliar rule]'))).toBe('This pull request cannot be merged yet. Check its reviews, required checks and branch protection rules.');
  });
});
