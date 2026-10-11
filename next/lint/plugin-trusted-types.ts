// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The page enforces Trusted Types (CSP require-trusted-types-for): an HTML sink outside app/trusted.ts throws
// at run time, only where that code runs (QA 2026-10-09: a commit reference in a timeline). Caught here instead.

import type * as ESTree from 'estree';
import type {RuleModule} from './eslint-plugin-tokens.ts';

const name = (n: ESTree.Node): string | undefined =>
  n.type === 'Identifier' ? n.name : n.type === 'MemberExpression' && n.property.type === 'Identifier' ? n.property.name : undefined;

const noHtmlSinks: RuleModule = {
  meta: {type: 'problem', schema: []},
  create(context) {
    return {
      NewExpression(node: ESTree.NewExpression) {
        if (name(node.callee) === 'DOMParser') context.report({node, message: 'Parse server HTML with app/trusted.ts (setMarkup, textOfMarkup): the page enforces Trusted Types.'});
      },
      AssignmentExpression(node: ESTree.AssignmentExpression) {
        const p = node.left.type === 'MemberExpression' ? name(node.left) : undefined;
        if (p === 'innerHTML' || p === 'outerHTML') context.report({node, message: 'Set markup with app/trusted.ts setMarkup: the page enforces Trusted Types.'});
      },
      CallExpression(node: ESTree.CallExpression) {
        const p = node.callee.type === 'MemberExpression' ? name(node.callee) : undefined;
        if (p === 'insertAdjacentHTML' || p === 'createContextualFragment') context.report({node, message: 'Use app/trusted.ts: the page enforces Trusted Types.'});
      },
    };
  },
};

export default {meta: {name: 'trusted-types'}, rules: {'no-html-sinks': noHtmlSinks}};
