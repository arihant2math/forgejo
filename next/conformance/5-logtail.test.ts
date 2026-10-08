// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The Actions log tail over the session (B9): a real workflow run, picked
// up by a runner that speaks Forgejo's runner protocol (Connect, JSON) and
// uploads its log; the session tails the job's log by offset, sees new
// lines as they are uploaded and the end of the job, resumes from an
// offset, and is refused a job it may not read.

import {afterAll, beforeAll, describe, expect, test} from 'vitest';
import type {ActionRunJob, LogMessage} from '../src/protocol/types.gen.ts';
import {env} from './env.ts';
import {type Account, type Repo, api, createRepo, createUser, eventually} from './forgejo.ts';
import {type Session, connect} from './sync.ts';

const open: Session[] = [];
afterAll(() => {
  for (const s of open) {
    s.close();
    expect(s.violations).toEqual([]);
  }
});

/** A runner talking Forgejo's runner protocol (connect-go, JSON encoding). */
class Runner {
  private readonly uuid: string;
  private readonly token: string;

  constructor(uuid: string, token: string) {
    this.uuid = uuid;
    this.token = token;
  }

  async call<T>(method: string, body: unknown): Promise<T> {
    const res = await fetch(`${env.url}/api/actions/runner.v1.RunnerService/${method}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'x-runner-uuid': this.uuid, 'x-runner-token': this.token},
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`runner ${method}: ${res.status} ${text}`);
    return JSON.parse(text) as T;
  }

  log(taskId: number, index: number, lines: string[], noMore = false): Promise<unknown> {
    const now = new Date().toISOString();
    return this.call('UpdateLog', {taskId: String(taskId), index: String(index), rows: lines.map((content) => ({time: now, content})), noMore});
  }
}

const WORKFLOW = `on: [push]
jobs:
  build:
    runs-on: conformance
    steps:
      - run: echo hello
`;

describe('actions log tail', () => {
  let alice: Account;
  let bob: Account;
  let repo: Repo;
  let runner: Runner;
  let taskId: number;
  let job: ActionRunJob;

  beforeAll(async () => {
    alice = await createUser('alice');
    bob = await createUser('bob');
    repo = await createRepo(alice, {private: true, init: true});
    await api('PATCH', `/repos/${repo.full}`, {token: alice.token, body: {has_actions: true}});
    const reg = await api<{uuid: string; token: string}>('POST', `/repos/${repo.full}/actions/runners`, {token: alice.token, body: {name: 'conformance'}});
    runner = new Runner(reg.uuid, reg.token);
    await runner.call('Declare', {version: 'conformance', labels: ['conformance']});
    const b = await connect('ws', alice.token, [{group: repo.group}]);
    open.push(b.s);
    await b.s.next('caught_up');
    // Pushing a workflow starts a run whose job waits for our runner.
    await api('POST', `/repos/${repo.full}/contents/.forgejo/workflows/ci.yml`, {token: alice.token, body: {content: btoa(WORKFLOW), message: 'ci', branch: 'main'}});
    const task = await eventually('a task for the runner', async () => {
      const r = await runner.call<{task?: {id: string}}>('FetchTask', {tasksVersion: '0'});
      return r.task;
    }, 60_000);
    taskId = Number(task.id);
    // The job arrives through the sync log (repo group, actions unit).
    const c = await b.s.change((x) => x.m === 'ActionRunJob' && (x.d as ActionRunJob).task_id === taskId, {timeout: 30_000});
    job = c.d as ActionRunJob;
  });

  test('tail: lines as they are uploaded, steps, then done; resume from an offset', async () => {
    const {s} = await connect('ws', alice.token);
    open.push(s);
    let from = s.mark;
    s.send({type: 'log_tail', job_id: job.id});
    const first = await s.next('log', (m) => m.job_id === job.id, {from});
    expect(first.steps?.length).toBeGreaterThan(0);

    from = s.mark;
    await runner.log(taskId, 0, ['line 1', 'line 2']);
    const lines: LogMessage[] = [];
    const got = async (n: number) => eventually(`${n} lines`, () => {
      lines.length = 0;
      for (let i = from; i < s.messages.length; i++) {
        const m = s.messages[i];
        if (m?.type === 'log' && m.job_id === job.id && m.lines.length) lines.push(m);
      }
      const all = lines.flatMap((m) => m.lines.map((l, i) => ({offset: m.offset + i, text: l.c})));
      return all.length >= n ? all : undefined;
    }, 30_000);
    expect(await got(2)).toEqual([{offset: 0, text: 'line 1'}, {offset: 1, text: 'line 2'}]);
    expect(lines.every((m) => m.task_id === taskId)).toBe(true);

    await runner.log(taskId, 2, ['line 3']);
    expect((await got(3)).map((l) => l.text)).toEqual(['line 1', 'line 2', 'line 3']);

    // The runner finishes: result + the log's end.
    const stopped = new Date().toISOString();
    await runner.call('UpdateTask', {state: {id: String(taskId), result: 'RESULT_SUCCESS', stoppedAt: stopped}});
    await runner.log(taskId, 3, [], true);
    const done = await s.next('log', (m) => m.job_id === job.id && m.done === true, {from, timeout: 30_000});
    expect(done.expired).toBeUndefined();

    // Resume from an offset in a new session: the rest only.
    const again = await connect('sse', alice.token);
    open.push(again.s);
    again.s.send({type: 'log_tail', job_id: job.id, task_id: taskId, offset: 1});
    const rest = await again.s.next('log', (m) => m.job_id === job.id && m.lines.length > 0);
    expect(rest.offset).toBe(1);
    expect(rest.lines.map((l) => l.c)).toEqual(['line 2', 'line 3']);
    await again.s.next('log', (m) => m.job_id === job.id && m.done === true);
  });

  test('a job of a repository the viewer cannot read: log_closed{forbidden}', async () => {
    const {s} = await connect('ws', bob.token);
    open.push(s);
    s.send({type: 'log_tail', job_id: job.id});
    expect(await s.next('log_closed', (m) => m.job_id === job.id)).toMatchObject({reason: 'forbidden'});
    s.send({type: 'log_tail', job_id: 999_999_999});
    expect(await s.next('log_closed', (m) => m.job_id === 999_999_999)).toMatchObject({reason: 'forbidden'});
    expect(s.messages.some((m) => m.type === 'log')).toBe(false);
  });
});
