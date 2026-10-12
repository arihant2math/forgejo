// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// @pierre/diffs renders code as HTML strings serialised from its own syntax trees by hast-util-to-html, which escapes
// every text and attribute value. Its patched sinks (patches/@pierre__diffs@*.patch) are the only users of this
// policy: it is created once, at import, and never leaves this module, so no other code can mint TrustedHTML with it.

import {setTrustedHTML} from '@pierre/diffs';
import {TrustedTypesDiffsPolicy} from '../protocol/types.gen.ts';

interface Factory {
  createPolicy(name: string, rules: {createHTML(html: string): string}): {createHTML(html: string): unknown};
}

const tt = (globalThis as {trustedTypes?: Factory}).trustedTypes;
if (tt) {
  const policy = tt.createPolicy(TrustedTypesDiffsPolicy, {createHTML: (html) => html});
  setTrustedHTML((html) => policy.createHTML(html));
}
