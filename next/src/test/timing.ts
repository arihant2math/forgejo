// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The cost of a piece of work, for tests that hold code to a time budget (Node only).
//
// The wall clock also counts the time this thread waited for a CPU: on a loaded
// machine (the verifier runs many test files at once beside other jobs) a 10 ms
// search measured 17 ms and failed a 16 ms budget (#288). This thread's CPU time
// counts only the work, but in steps of about a millisecond. A measure is the
// shorter of the two: the wall clock on a quiet machine (as before), the CPU time
// when the machine was busy with something else. Neither is shorter than the work
// done (within the CPU clock's millisecond).

import process from 'node:process';

/** Milliseconds this thread spent on the CPU so far. */
function cpuNow(): number {
  const {user, system} = process.threadCpuUsage();
  return (user + system) / 1000;
}

/** Runs `fn` and returns its result with its cost in milliseconds (see the top of this file). */
export function measure<T>(fn: () => T): {value: T; ms: number} {
  const cpu0 = cpuNow();
  const wall0 = performance.now();
  const value = fn();
  const wall = performance.now() - wall0;
  const cpu = cpuNow() - cpu0;
  return {value, ms: Math.min(wall, cpu)};
}
