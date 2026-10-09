// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// ANSI escapes in Actions logs: SGR colours become one of a few token
// colours (rendered as classes on text nodes: never HTML), everything else
// (cursor movement, OSC titles and links, …) is dropped. Pure.

/** A colour slot: index into the renderer's class table (0 = default). */
export type AnsiColor = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface AnsiSpan {
  text: string;
  color: AnsiColor;
  bold: boolean;
}

// SGR colour number (0–7) → slot: black, red, green, yellow, blue, magenta, cyan, white.
const SLOTS: readonly AnsiColor[] = [7, 1, 2, 3, 4, 5, 6, 0];

// eslint-disable-next-line no-control-regex -- matching escape sequences is the point
const ESC = /\x1b(?:\[([0-9;:?]*)([A-Za-z])|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[()*+][0-9A-Za-z]|[@-Z\\-_])/g;

/** Splits a log line into styled spans. */
export function parseAnsi(raw: string): AnsiSpan[] {
  // A progress line redrawn with carriage returns shows its last state, as a terminal would.
  const cr = raw.lastIndexOf('\r', raw.length - 2);
  const line = cr >= 0 ? raw.slice(cr + 1) : raw;
  if (!line.includes('\x1b')) return line ? [{text: stripControls(line), color: 0, bold: false}] : [];
  const out: AnsiSpan[] = [];
  let color: AnsiColor = 0;
  let bold = false;
  let last = 0;
  const emit = (text: string) => {
    const t = stripControls(text);
    if (!t) return;
    const prev = out.at(-1);
    if (prev?.color === color && prev.bold === bold) prev.text += t;
    else out.push({text: t, color, bold});
  };
  for (const m of line.matchAll(ESC)) {
    emit(line.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] !== 'm') continue; // not SGR
    const codes = (m[1] ?? '').split(/[;:]/).map((c) => (c === '' ? 0 : Number(c)));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i] ?? 0;
      if (c === 0) {
        color = 0;
        bold = false;
      } else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c >= 30 && c <= 37) color = SLOTS[c - 30] ?? 0;
      else if (c >= 90 && c <= 97) color = SLOTS[c - 90] ?? 0;
      else if (c === 39) color = 0;
      else if (c === 38 || c === 48) {
        // 256-colour / RGB: skip their arguments (foreground falls back to the default).
        i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
        if (c === 38) color = 0;
      }
    }
  }
  emit(line.slice(last));
  return out;
}

// Other C0 controls (bell, backspace, carriage returns inside a line) are not shown.
// eslint-disable-next-line no-control-regex -- see above
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;

function stripControls(s: string): string {
  return s.replace(CONTROLS, '');
}
