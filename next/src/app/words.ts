// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

const numbers = new Intl.NumberFormat();

export function noun(n: number, one: string, many = one + 's'): string {
  return n === 1 ? one : many;
}

export function count(n: number, one: string, many = one + 's'): string {
  return `${numbers.format(n)} ${noun(n, one, many)}`;
}
