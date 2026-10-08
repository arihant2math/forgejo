// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Dates as lists and the detail view show them: compact ("Oct 3", "Oct 3,
// 2024") and relative ("5m", "3h", "2d" in rows; "5 minutes ago" in prose).
// Intl formatting costs tens of µs per call and a list mounts dozens of rows
// per scroll frame, so formatted dates are cached per timestamp.

const DAY = 86_400_000;

const short = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric'});
const withYear = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
const full = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'});

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

/** "Oct 3" this year, "Oct 3, 2024" before. */
export function shortDate(iso: string | undefined, now = Date.now()): string {
  const t = parse(iso);
  if (Number.isNaN(t)) return '';
  const thisYear = new Date(t).getFullYear() === new Date(now).getFullYear();
  return cached(`${thisYear ? 's' : 'y'}${String(t)}`, () => (thisYear ? short.format(t) : withYear.format(t)));
}

/** A full date and time (tooltips). */
export function fullDate(iso: string | undefined): string {
  const t = parse(iso);
  return Number.isNaN(t) ? '' : cached(`f${String(t)}`, () => full.format(t));
}

/** "now", "5m", "3h", "2d", then the short date. */
export function ago(iso: string | undefined, now = Date.now()): string {
  const t = parse(iso);
  if (Number.isNaN(t)) return '';
  const d = Math.max(0, now - t);
  if (d < 60_000) return 'now';
  if (d < 3_600_000) return `${String(Math.floor(d / 60_000))}m`;
  if (d < DAY) return `${String(Math.floor(d / 3_600_000))}h`;
  if (d < 30 * DAY) return `${String(Math.floor(d / DAY))}d`;
  return shortDate(iso, now);
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago", then "on Oct 3". */
export function agoWords(iso: string | undefined, now = Date.now()): string {
  const t = parse(iso);
  if (Number.isNaN(t)) return '';
  const d = Math.max(0, now - t);
  const n = (x: number, unit: string) => `${String(x)} ${unit}${x === 1 ? '' : 's'} ago`;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return n(Math.floor(d / 60_000), 'minute');
  if (d < DAY) return n(Math.floor(d / 3_600_000), 'hour');
  if (d < 30 * DAY) return n(Math.floor(d / DAY), 'day');
  return `on ${shortDate(iso, now)}`;
}
