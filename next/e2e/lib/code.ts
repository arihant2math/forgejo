// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Code fixtures: generated source files, commits through the contents API,
// and the code views' URLs.

import {api, apiJson, ok} from './api.ts';
import {BASE, USER} from './env.ts';

export function goFile(n: number): string {
  const out = ['package main', '', 'import "fmt"', ''];
  for (let i = 0; i < n; i++) out.push(`// f${String(i)} prints its number.\nfunc f${String(i)}() {\n\tfmt.Println("value", ${String(i)})\n}\n`);
  return out.join('\n');
}

export function tsFile(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`export const value${String(i)}: number = ${String(i)} * 2; // line ${String(i)}`);
  return `${out.join('\n')}\n`;
}

/** One commit changing files (POST /contents). */
export async function changeFiles(repo: string, body: object, as?: string): Promise<void> {
  await ok(await api('POST', `/repos/${USER}/${repo}/contents`, body, as), 'contents');
}

export async function blobSha(repo: string, path: string, ref?: string): Promise<string> {
  return (await apiJson<{sha: string}>('GET', `/repos/${USER}/${repo}/contents/${path}${ref ? `?ref=${ref}` : ''}`)).sha;
}

/** A code view of dev's repository (F7 routes end with a `/-` segment). */
export const codeUrl = (repo: string, rest: string) => `${BASE}/-/next/code/${USER}/${repo}/${rest}/-`;

export interface Pull {
  number: number;
  id: number;
  head: {sha: string};
  merge_base: string;
}
