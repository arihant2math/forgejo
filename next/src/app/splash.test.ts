// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {splashScript} from '../../tools/vite-plugin-shell.ts';
import {
  applySplash, readSplash, SIDEBAR_MAX, SIDEBAR_MIN, SKELETON_DEFAULT_ROWS, SKELETON_MAX_ROWS, writeSplash, type Splash,
} from './splash.ts';

const html = document.documentElement;
const real = window.matchMedia.bind(window);

function reset() {
  localStorage.clear();
  for (const a of ['data-theme', 'data-shell', 'data-skeleton', 'style']) html.removeAttribute(a);
  for (const s of document.head.querySelectorAll('style')) s.remove();
  performance.clearMarks();
}

function boot(splash?: Splash | string, prefersDark = false) {
  if (splash !== undefined) localStorage.setItem('splash', typeof splash === 'string' ? splash : JSON.stringify(splash));
  vi.spyOn(window, 'matchMedia').mockImplementation((q) => {
    const mql = real(q);
    Object.defineProperty(mql, 'matches', {value: prefersDark && q === '(prefers-color-scheme: dark)'});
    return mql;
  });
  applySplash(window);
}

function hiddenRowsRule() {
  return [...document.head.querySelectorAll('style')].map((s) => s.textContent).join('');
}

beforeEach(reset);
afterEach(() => {
  vi.restoreAllMocks();
});

describe('applySplash', () => {
  test('defaults: system theme, logged-out shell, list skeleton, default rows, appStart mark', () => {
    boot(undefined, false);
    expect(html.dataset.theme).toBe('light');
    expect(html.dataset.shell).toBe('logged-out');
    expect(html.dataset.skeleton).toBe('list');
    expect(html.style.getPropertyValue('--sidebar-width')).toBe('');
    expect(hiddenRowsRule()).toBe(`[data-sk-row]:nth-child(n+${SKELETON_DEFAULT_ROWS + 1}){display:none}`);
    expect(performance.getEntriesByName('appStart', 'mark')).toHaveLength(1);
  });

  test('system theme follows prefers-color-scheme', () => {
    boot({theme: 'system'}, true);
    expect(html.dataset.theme).toBe('dark');
  });

  test('explicit theme wins over the OS', () => {
    boot({theme: 'light'}, true);
    expect(html.dataset.theme).toBe('light');
    reset();
    boot({theme: 'dark'}, false);
    expect(html.dataset.theme).toBe('dark');
  });

  test('stored state: app shell, sidebar width, detail shape, row count, initial', () => {
    boot({user: '7', sidebarWidth: 300.4, skeleton: {shape: 'detail', rows: 5}, initial: 'A'});
    expect(html.dataset.shell).toBe('app');
    expect(html.style.getPropertyValue('--sidebar-width')).toBe('300px');
    expect(html.dataset.skeleton).toBe('detail');
    expect(hiddenRowsRule()).toContain('nth-child(n+6)');
    expect(html.style.getPropertyValue('--splash-initial')).toBe('"A"');
  });

  test('clamps to the limits declared in splash.ts', () => {
    boot({sidebarWidth: 1e9, skeleton: {rows: 1e9}});
    expect(html.style.getPropertyValue('--sidebar-width')).toBe(`${SIDEBAR_MAX}px`);
    expect(hiddenRowsRule()).toContain(`nth-child(n+${SKELETON_MAX_ROWS + 1})`);
    reset();
    boot({sidebarWidth: -5, skeleton: {rows: -3}});
    expect(html.style.getPropertyValue('--sidebar-width')).toBe(`${SIDEBAR_MIN}px`);
    expect(hiddenRowsRule()).toContain('nth-child(n+1)');
  });

  test('ignores garbage without throwing', () => {
    boot('{not json');
    expect(html.dataset.theme).toBe('light');
    reset();
    boot({theme: 'blue', sidebarWidth: 'wide', user: 3, skeleton: {shape: 'grid', rows: Number.NaN}, initial: '</style>'} as unknown as Splash);
    expect(html.dataset.theme).toBe('light');
    expect(html.dataset.shell).toBe('logged-out');
    expect(html.dataset.skeleton).toBe('list');
    expect(html.style.getPropertyValue('--sidebar-width')).toBe('');
    expect(html.style.getPropertyValue('--splash-initial')).toBe('');
    reset();
    boot('null');
    expect(html.dataset.shell).toBe('logged-out');
  });

  test('survives blocked storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => {
      boot();
    }).not.toThrow();
    expect(html.dataset.shell).toBe('logged-out');
  });
});

describe('inlined script', () => {
  test('is self-contained and behaves like applySplash', () => {
    localStorage.setItem('splash', JSON.stringify({theme: 'dark', user: '1', sidebarWidth: 250}));
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the exact text inlined into index.html
    (new Function(splashScript()) as () => void)();
    expect(html.dataset.theme).toBe('dark');
    expect(html.dataset.shell).toBe('app');
    expect(html.style.getPropertyValue('--sidebar-width')).toBe('250px');
    expect(performance.getEntriesByName('appStart', 'mark')).toHaveLength(1);
  });
});

describe('readSplash / writeSplash', () => {
  test('merge and round-trip', () => {
    writeSplash({theme: 'dark'});
    writeSplash({user: '42'});
    expect(readSplash()).toEqual({theme: 'dark', user: '42'});
  });
});
