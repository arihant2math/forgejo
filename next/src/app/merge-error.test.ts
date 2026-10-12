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

describe('refusals without a message', () => {
  it('give the sentence for the status, not the bare status', () => {
    expect(failureText(new RequestFailed(405, 'Forgejo answered 405.'))).toBe('Forgejo could not do it now (the branch changed, or a hook refused it). Check the pull request, then try again.');
    expect(failureText(new RequestFailed(409, 'Forgejo answered 409.'))).toBe('Forgejo could not do it now (the branch changed, or a hook refused it). Check the pull request, then try again.');
    expect(failureText(new RequestFailed(502, 'Forgejo answered 502.'))).toBe('Forgejo ran into an error. Try again in a moment.');
    expect(failureText(new RequestFailed(422, 'Forgejo answered 422.'))).toBe('Forgejo refused it (HTTP 422).');
  });
  it('keep Forgejo\'s own short sentences', () => {
    expect(failureText(new RequestFailed(405, 'Please try again later'))).toBe('Please try again later');
    expect(failureText(new RequestFailed(404, 'Forgejo answered 404 for that branch.'))).toBe('Forgejo answered 404 for that branch.');
    expect(failureText(new Error('Forgejo answered 405.'))).toBe('Forgejo answered 405.');
  });
});
