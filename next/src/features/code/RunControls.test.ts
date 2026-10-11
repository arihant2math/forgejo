// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {describe, expect, it} from 'vitest';
import type {ActionRun, ActionRunJob} from '../../protocol/types.gen.ts';
import {actionPaths} from './RunControls.tsx';

const run = {id: 42, run_number: 7} as ActionRun;
const job = (id: number, status: string, needs: string[] = []): ActionRunJob => ({id, job_id: String(id), status, needs}) as ActionRunJob;

describe('Actions requests', () => {
  it('uses run ids, not the number in the route, and escapes repository names', () => {
    expect(actionPaths('a b', 'ci', run, [], 'all')).toEqual(['/repos/a%20b/ci/actions/runs/42/rerun']);
    expect(actionPaths('a', 'ci', run, [], 'cancel')).toEqual(['/repos/a/ci/actions/runs/42/cancel']);
  });
  it('reruns failed roots only, since the API resets their dependents', () => {
    const jobs = [job(1, 'failure'), job(2, 'skipped', ['1']), job(3, 'failure', ['2']), job(4, 'success'), job(5, 'failure')];
    expect(actionPaths('a', 'ci', run, jobs, 'failed')).toEqual(['/repos/a/ci/actions/jobs/1/rerun', '/repos/a/ci/actions/jobs/5/rerun']);
    expect(actionPaths('a', 'ci', run, [job(4, 'success')], 'job')).toEqual(['/repos/a/ci/actions/jobs/4/rerun']);
  });
});
