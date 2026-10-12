// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Cache dates by timestamp: Intl formatting across many rows is costly per scroll frame.

const DAY = 86_400_000;

const short = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric'});
const withYear = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
const full = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'});
const month = new Intl.DateTimeFormat(undefined, {month: 'short'});

const cache = new Map<string, string>();

function cached(key: string, make: () => string): string {
  let v = cache.get(key);
  if (v === undefined) {
    if (cache.size > 20_000) cache.clear();
    v = make();
    cache.set(key, v);
  }
  return v;
}

const parse = (iso: string | undefined) => (iso ? Date.parse(iso) : Number.NaN);

export function shortDate(iso: string | undefined, now = Date.now()): string {
  const t = parse(iso);
  if (Number.isNaN(t)) return '';
  const thisYear = new Date(t).getFullYear() === new Date(now).getFullYear();
  return cached(`${thisYear ? 's' : 'y'}${String(t)}`, () => (thisYear ? short.format(t) : withYear.format(t)));
}

export function fullDate(iso: string | undefined): string {
  const t = parse(iso);
  return Number.isNaN(t) ? '' : cached(`f${String(t)}`, () => full.format(t));
}

export function ago(iso: string | undefined, now = Date.now()): string {
  const t = parse(iso);
  if (Number.isNaN(t)) return '';
  const d = Math.max(0, now - t);
  if (d < 60_000) return 'now';
  if (d < 3_600_000) return `${String(Math.floor(d / 60_000))}m`;
  if (d < DAY) return `${String(Math.floor(d / 3_600_000))}h`;
  if (d < 30 * DAY) return `${String(Math.floor(d / DAY))}d`;
  // Earlier years must fit the same fixed-width row slot.
  if (new Date(t).getFullYear() !== new Date(now).getFullYear()) return cached(`m${String(t)}`, () => `${month.format(t)} ’${String(new Date(t).getFullYear() % 100).padStart(2, '0')}`);
  return shortDate(iso, now);
}
