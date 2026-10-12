// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The heading of a page whose content is not on this device. */
export function offlineTitle(r: 'offline' | 'unreachable'): string {
  return r === 'offline' ? 'Not available offline' : 'Can’t reach Forgejo';
}

/** The sentences a missing-content page says about its subject ("These commits are…", "This file is…"). */
export function missingWords(what: string): {offline: string; unreachable: string; notFound: string; tooLarge: string} {
  const plural = /^(?:these|those)\b/i.test(what) || /\band\b/i.test(what) || /'s \w+(?:s|es)$/i.test(what) && !/'s \w*ss$/i.test(what);
  const [be, it] = plural ? ['are', 'them'] : ['is', 'it'];
  return {
    offline: `${what} ${be} not on this device. Connect to load ${it}, or open one of these:`,
    unreachable: `${what} ${be} not on this device, and Forgejo is not answering. ${plural ? 'They load' : 'It loads'} once it is back; meanwhile open one of these:`,
    notFound: `${what} ${plural ? 'do' : 'does'} not exist, or you cannot see ${it}.`,
    tooLarge: `${what} ${be} too large for this view: open ${it} in the classic UI.`,
  };
}
