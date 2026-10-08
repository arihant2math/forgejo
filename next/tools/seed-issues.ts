// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Seeds a dev Forgejo (tools/dev-forgejo.sh) with a large repository for
// the list and detail checks (F4): workflow and priority labels (exclusive
// scoped, PLAN §7.3), plain labels, milestones, a second user who
// collaborates, and N issues spread over them, some closed, some with
// comments. Idempotent per repository: an existing repository with at least
// N issues is left alone.
//
//   node tools/seed-issues.ts [--url http://127.0.0.1:3000] [--repo big] [--issues 5000]

import {parseArgs} from 'node:util';

const {values} = parseArgs({options: {
  url: {type: 'string', default: process.env.NEXT_FORGEJO_URL ?? 'http://127.0.0.1:3000'},
  user: {type: 'string', default: 'dev'},
  password: {type: 'string', default: 'devdevdev1'},
  repo: {type: 'string', default: 'big'},
  issues: {type: 'string', default: '5000'},
  concurrency: {type: 'string', default: '8'},
}});

const BASE = values.url.replace(/\/$/, '');
const OWNER = values.user;
const REPO = values.repo;
const N = Number(values.issues);
const auth = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const admin = auth(OWNER, values.password);

async function api(method: string, path: string, body?: unknown, as = admin): Promise<{status: number; json: unknown}> {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method, headers: {'Authorization': as, 'Content-Type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  const text = await res.text();
  return {status: res.status, json: text ? JSON.parse(text) as unknown : undefined};
}

/** api() with the JSON answer typed by the caller (a seed script trusts its own server). */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the JSON shape
async function apiAs<T>(method: string, path: string, body?: unknown): Promise<{status: number; json: T}> {
  const r = await api(method, path, body);
  return {status: r.status, json: r.json as T};
}

async function ensureUser(login: string): Promise<void> {
  const {status} = await api('GET', `/users/${login}`);
  if (status === 200) return;
  const r = await api('POST', '/admin/users', {username: login, email: `${login}@example.com`, password: 'alicealice1', must_change_password: false, full_name: `${login.slice(0, 1).toUpperCase()}${login.slice(1)}`});
  if (r.status !== 201) throw new Error(`create user ${login}: ${String(r.status)} ${JSON.stringify(r.json)}`);
}

const STATUS = ['Backlog', 'Todo', 'In Progress', 'In Review', 'Done', 'Canceled'];
const PRIORITY = ['Urgent', 'High', 'Medium', 'Low'];
const PLAIN = ['bug', 'feature', 'docs', 'performance', 'security', 'ux', 'refactor', 'tests'];
const COLORS = ['#e11d48', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#64748b'];
const WORDS = 'crash settings page dashboard dark mode login token refresh sync list filter label assignee milestone keyboard shortcut palette timeline markdown preview upload avatar email webhook branch merge review comment search notification inbox board column drag drop export import cache offline service worker'.split(' ');

function title(i: number): string {
  const pick = (k: number) => WORDS[(i * 7 + k * 13 + Math.floor(i / 3)) % WORDS.length] ?? 'thing';
  return `${pick(0)[0]?.toUpperCase() ?? ''}${pick(0).slice(1)} ${pick(1)} ${pick(2)} when ${pick(3)} ${pick(4)} (#${String(i)})`;
}

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({length: n}, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i] as T, i);
    }
  }));
}

async function main(): Promise<void> {
  await ensureUser('alice');
  const repo = await apiAs<{id: number; open_issues_count: number}>('GET', `/repos/${OWNER}/${REPO}`);
  if (repo.status === 404) {
    const r = await api('POST', '/user/repos', {name: REPO, auto_init: true, description: 'A large repository for the list checks'});
    if (r.status !== 201) throw new Error(`create repo: ${String(r.status)}`);
  }
  await api('PUT', `/repos/${OWNER}/${REPO}/collaborators/alice`, {permission: 'write'});

  // Labels (create the missing ones).
  const existing = (await apiAs<{id: number; name: string}[]>('GET', `/repos/${OWNER}/${REPO}/labels?limit=100`)).json;
  const labelId = new Map(existing.map((l) => [l.name, l.id]));
  const want: {name: string; color: string; exclusive: boolean}[] = [
    ...STATUS.map((v, i) => ({name: `status/${v}`, color: COLORS[(i + 2) % COLORS.length] ?? '#888888', exclusive: true})),
    ...PRIORITY.map((v, i) => ({name: `priority/${v}`, color: COLORS[i] ?? '#888888', exclusive: true})),
    ...PLAIN.map((v, i) => ({name: v, color: COLORS[(i * 3) % COLORS.length] ?? '#888888', exclusive: false})),
  ];
  for (const l of want) {
    if (labelId.has(l.name)) continue;
    const r = await apiAs<{id: number}>('POST', `/repos/${OWNER}/${REPO}/labels`, l);
    labelId.set(l.name, r.json.id);
  }
  const milestones = (await apiAs<{id: number; title: string}[]>('GET', `/repos/${OWNER}/${REPO}/milestones?state=all&limit=50`)).json;
  const msId = new Map(milestones.map((m) => [m.title, m.id]));
  for (const [i, t] of ['Cycle 41', 'Cycle 42', 'Cycle 43', 'v2.0'].entries()) {
    if (msId.has(t)) continue;
    const due = new Date(Date.UTC(2026, 9, 1 + i * 14)).toISOString();
    const r = await apiAs<{id: number}>('POST', `/repos/${OWNER}/${REPO}/milestones`, {title: t, due_on: due});
    msId.set(t, r.json.id);
  }

  const have = Number((await fetch(`${BASE}/api/v1/repos/${OWNER}/${REPO}/issues?state=all&limit=1&type=issues`, {headers: {Authorization: admin}})).headers.get('X-Total-Count') ?? 0);
  const todo = Array.from({length: Math.max(0, N - have)}, (_, k) => have + k + 1);
  const t0 = Date.now();
  let done = 0;
  await pool(todo, Number(values.concurrency), async (i) => {
    const labels = [
      labelId.get(`status/${STATUS[i % STATUS.length] ?? 'Todo'}`),
      i % 3 === 0 ? undefined : labelId.get(`priority/${PRIORITY[i % PRIORITY.length] ?? 'Low'}`),
      labelId.get(PLAIN[i % PLAIN.length] ?? 'bug'),
      i % 5 === 0 ? labelId.get(PLAIN[(i + 3) % PLAIN.length] ?? 'docs') : undefined,
    ].filter((x): x is number => x !== undefined);
    const body = {
      title: title(i),
      body: `Steps to reproduce **${String(i)}**:\n\n1. Open the ${WORDS[i % WORDS.length] ?? ''} page\n2. Press \`${String(i % 9)}\`\n\n> Expected: it works.\n\n- [x] checked\n- [ ] not yet`,
      labels,
      assignees: i % 4 === 0 ? [OWNER] : i % 4 === 1 ? ['alice'] : i % 4 === 2 ? [OWNER, 'alice'] : [],
      milestone: [...msId.values()][i % (msId.size + 1)] ?? 0,
      closed: i % 7 === 0,
    };
    const r = await apiAs<{number: number}>('POST', `/repos/${OWNER}/${REPO}/issues`, body);
    if (r.status !== 201) throw new Error(`issue ${String(i)}: ${String(r.status)} ${JSON.stringify(r.json)}`);
    if (i % 50 === 0) {
      for (let c = 0; c < 3; c++) await api('POST', `/repos/${OWNER}/${REPO}/issues/${String(r.json.number)}/comments`, {body: `Comment ${String(c)} on ${String(i)}: looks like the \`${WORDS[c] ?? ''}\` code path.`});
    }
    if (++done % 500 === 0) console.log(`${String(done)} issues (${String(Math.round(done / ((Date.now() - t0) / 1000)))}/s)`);
  });
  console.log(`seeded ${OWNER}/${REPO}: ${String(have + todo.length)} issues (${String(todo.length)} new) in ${String(Math.round((Date.now() - t0) / 1000))} s`);
}

await main();
