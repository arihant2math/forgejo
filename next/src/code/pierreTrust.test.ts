// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {readdirSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {afterEach, expect, test, vi} from 'vitest';
import {TrustedTypesDiffsPolicy} from '../protocol/types.gen.ts';

afterEach(() => {vi.unstubAllGlobals(); vi.resetModules(); vi.doUnmock('@pierre/diffs');});

test('Pierre gets one private forgejo-next-diffs policy, whose HTML it alone receives', async () => {
  const set = vi.fn<(create: (html: string) => unknown) => void>();
  vi.doMock('@pierre/diffs', () => ({setTrustedHTML: set}));
  const createPolicy = vi.fn((_name: string, rules: {createHTML: (html: string) => string}) => ({createHTML: (html: string) => ({trusted: rules.createHTML(html)})}));
  vi.stubGlobal('trustedTypes', {createPolicy});
  await import('./pierreTrust.ts');
  expect(TrustedTypesDiffsPolicy).toBe('forgejo-next-diffs');
  expect(createPolicy).toHaveBeenCalledTimes(1);
  expect(createPolicy.mock.calls[0]?.[0]).toBe(TrustedTypesDiffsPolicy);
  expect(set).toHaveBeenCalledTimes(1);
  expect(set.mock.calls[0]?.[0]('<span>x</span>')).toEqual({trusted: '<span>x</span>'});
});

test('without Trusted Types Pierre writes its strings as they are', async () => {
  const set = vi.fn();
  vi.doMock('@pierre/diffs', () => ({setTrustedHTML: set}));
  await import('./pierreTrust.ts');
  expect(set).not.toHaveBeenCalled();
});

// The SSR renderer, the editor (only behind @pierre/diffs/edit), the portable worker and the prerender helper take
// caller-supplied HTML and are not used: they keep plain strings, which the CSP rejects.
const UNUSED = /^(?:ssr|editor)\/|^worker\/worker-portable\.js$|^utils\/prerenderHTMLIfNecessary\.js$/;

test('the installed @pierre/diffs is patched: every HTML sink the app can reach goes through trustedHTML()', () => {
  const dist = join(process.cwd(), 'node_modules/@pierre/diffs/dist');
  const sinks: string[] = [];
  for (const entry of readdirSync(dist, {recursive: true, withFileTypes: true})) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const path = join(entry.parentPath, entry.name);
    const name = relative(dist, path);
    if (UNUSED.test(name)) continue;
    for (const m of readFileSync(path, 'utf8').matchAll(/(?:\.innerHTML\s*=(?!=)|\.outerHTML\s*=(?!=)|insertAdjacentHTML\([^,]+,|createContextualFragment\(|setHTMLUnsafe\(|dangerouslySetInnerHTML)\s*(.{0,12})/g)) {
      sinks.push(`${name}: ${m[0]}`);
      if (!m[1]?.startsWith('trustedHTML(') && !m[0].includes('dangerouslySetInnerHTML')) throw new Error(`unwrapped sink in ${name}: ${m[0]}`);
    }
  }
  // react/utils/templateRender.js renders SSR templates only (typeof window === 'undefined').
  expect(sinks.filter((s) => s.includes('dangerouslySetInnerHTML'))).toEqual([expect.stringMatching(/^react\/utils\/templateRender\.js/)]);
  expect(sinks).toHaveLength(20);
});
