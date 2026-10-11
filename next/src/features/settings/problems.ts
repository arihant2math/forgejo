// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A refused settings write → what to say, and next to which field (pure;
// problems.test.ts). API v1 answers a binding failure with
// "[FieldName]: Kind" (routers/api/v1/api.go bind) and its own checks with
// a sentence ("repo name is already taken [name: x]", "Invalid url",
// "Missing config option: url"): each form names the words that point at
// its fields.

import {RequestFailed} from '../../app/api.ts';

export interface Problem {
  /** The form field it is about, if the answer names one. */
  field?: string;
  message: string;
}

/** Binding failure kinds (code.forgejo.org/go-chi/binding and Forgejo's own rules), in words. */
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

/** Forgejo's sentences, said better. */
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

/**
 * What a failed request means for a form. `fields` maps words of the answer to the form's field names: Go
 * field names of a binding failure ("Name", "BranchFilter"), lower-cased, and phrases of Forgejo's own
 * messages ("repo name", "url", "content type").
 */
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
  // A bare 404 of a write: what it changes is gone (deleted meanwhile, or the repository was renamed).
  const message = reworded ?? (status === 404 && /^(?:not found\.?|forgejo answered 404\.)$/i.test(raw) ? 'Not found: it may have been deleted or renamed meanwhile.' : raw);
  return {...(field ? {field} : {}), message: message || 'Forgejo refused the change.'};
}
