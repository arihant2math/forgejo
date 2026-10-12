// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Binding errors use "[FieldName]: Kind"; other API errors name fields in prose.

import {RequestFailed} from '../../app/api.ts';

export interface Problem {
  field?: string;
  message: string;
}

const KINDS: Record<string, string> = {
  Required: 'Required.',
  AlphaDash: 'Use only letters, digits, “-” and “_”.',
  AlphaDashDot: 'Use only letters, digits, “-”, “_” and “.”.',
  MaxSize: 'Too long.',
  MinSize: 'Too short.',
  Size: 'Not the right length.',
  Url: 'Not a valid URL.',
  ValidUrl: 'Not a valid URL.',
  ValidSiteUrl: 'Not a valid URL.',
  GlobPattern: 'Not a valid glob pattern.',
  RegexPattern: 'Not a valid regular expression.',
  In: 'Not one of the allowed values.',
  Email: 'Not a valid email address.',
};

const REWORDS: [RegExp, string][] = [
  [/repo name is already taken/i, 'A repository with this name already exists here.'],
  [/repo name is reserved/i, 'This name is reserved.'],
  [/repo name's pattern is not allowed/i, 'This name is not allowed.'],
  [/^Force Private enabled/i, 'This instance keeps every repository private.'],
  [/^Invalid url$/i, 'Not a valid URL.'],
  [/^Invalid content type$/i, 'Not a content type Forgejo knows.'],
  [/key content has been used as non-deploy key/i, 'This key is already a user’s key: a deploy key must be its own.'],
  [/^Key (?:already exists|title has been used)/i, 'A deploy key with this title or content already exists.'],
];

/** `fields` maps lower-case Go field names and API error phrases to form field names. */
export function problemOf(err: unknown, fields: Readonly<Record<string, string>> = {}): Problem {
  const raw = err instanceof Error ? err.message : String(err);
  const status = err instanceof RequestFailed ? err.status : undefined;
  const binding = /^\[([^\]]*)\]:\s*(\w+)/.exec(raw);
  if (binding) {
    const names = (binding[1] ?? '').split(/[\s,]+/).filter(Boolean).map((n) => n.toLowerCase());
    const field = names.map((n) => fields[n]).find((f) => f !== undefined);
    const kind = binding[2] ?? '';
    return {...(field ? {field} : {}), message: KINDS[kind] ?? `${kind}.`};
  }
  const lower = raw.toLowerCase();
  let field: string | undefined;
  for (const [words, f] of Object.entries(fields)) {
    if (lower.includes(words)) {
      field = f;
      break;
    }
  }
  const reworded = REWORDS.find(([re]) => re.test(raw))?.[1];
  // A bare write 404 means the target is absent or renamed.
  const message = reworded ?? (status === 404 && /^(?:not found\.?|forgejo answered 404\.)$/i.test(raw) ? 'Not found: it may have been deleted or renamed meanwhile.' : raw);
  return {...(field ? {field} : {}), message: message || 'Forgejo refused the change.'};
}
