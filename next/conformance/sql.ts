// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// CONFORMANCE_SQL accepts statements on stdin for fault injection.

import {type ChildProcessWithoutNullStreams, spawn} from 'node:child_process';
import {env} from './env.ts';

function argv(): [string, string[]] {
  const [cmd, ...args] = env.sql ?? [];
  if (!cmd) throw new Error('CONFORMANCE_SQL is not set');
  return [cmd, args];
}

/** Runs statements; answers stdout (one row per line, tab-separated columns). */
export function run(statements: string): Promise<string> {
  const [cmd, args] = argv();
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {stdio: ['pipe', 'pipe', 'pipe']});
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err}`));
    });
    p.stdin.end(statements);
  });
}

const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** A transaction kept open by the scenario (e.g. holding a row lock). */
export class OpenTx {
  private out = '';
  private readonly p: ChildProcessWithoutNullStreams;

  private constructor(p: ChildProcessWithoutNullStreams) {
    this.p = p;
    p.stdout.on('data', (d: Buffer) => (this.out += d.toString()));
  }

  /** Begins a transaction, runs `statement` and waits until it printed `marker` (it holds its locks then). */
  static async begin(statement: string, marker: string): Promise<OpenTx> {
    const [cmd, args] = argv();
    const tx = new OpenTx(spawn(cmd, args, {stdio: ['pipe', 'pipe', 'pipe']}));
    tx.p.stdin.write(`BEGIN;\n${statement}\nSELECT ${quote(marker)};\n`);
    const deadline = Date.now() + 20_000;
    while (!tx.out.includes(marker)) {
      if (Date.now() > deadline || tx.p.exitCode !== null) throw new Error(`transaction did not start: ${tx.out}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return tx;
  }

  rollback(): Promise<void> {
    return new Promise((resolve) => {
      if (this.p.exitCode !== null) {
        resolve();
        return;
      }
      this.p.on('close', () => {
        resolve();
      });
      this.p.stdin.end('ROLLBACK;\n');
    });
  }
}

export const sql = {
  async meta(name: string): Promise<string | undefined> {
    const out = (await run(`SELECT value FROM livesync_meta WHERE name = ${quote(name)};\n`)).trim();
    return out === '' ? undefined : out;
  },

  setMeta(name: string, value: string): Promise<string> {
    const upsert = env.db === 'pg'
      ? `INSERT INTO livesync_meta (name, value) VALUES (${quote(name)}, ${quote(value)}) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value;`
      : `INSERT INTO livesync_meta (name, value) VALUES (${quote(name)}, ${quote(value)}) ON DUPLICATE KEY UPDATE value = VALUES(value);`;
    return run(`${upsert}\n`);
  },

  /** Drops the label-insert capture trigger. */
  dropLabelTrigger(): Promise<string> {
    return run(env.db === 'pg' ? 'DROP TRIGGER livesync_capture ON label;\n' : 'DROP TRIGGER livesync_label_ai;\n');
  },

  /** Holds the sync log head lock to stall materialization until rollback. */
  holdLogHead(): Promise<OpenTx> {
    return OpenTx.begin(`SELECT value FROM livesync_meta WHERE name = 'log_head' FOR UPDATE;`, 'held');
  },

  async count(table: string, where: string): Promise<number> {
    return Number((await run(`SELECT COUNT(*) FROM ${table} WHERE ${where};\n`)).trim());
  },
};
