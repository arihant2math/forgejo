// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Local ESLint rules that keep every visual value in src/styles/tokens.css
// (IMPLEMENTATION.md §2.4). They look at every string in a source file, so
// class lists in className, cx(…) arguments and recipe constants are all covered.

import type {Rule} from 'eslint';
import type * as ESTree from 'estree';

/** Splits a Tailwind class into its variants and the utility (last segment), respecting brackets. */
export function splitClass(token: string): {variants: string[]; utility: string} {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === ':' && depth === 0) {
      parts.push(token.slice(start, i));
      start = i + 1;
    }
  }
  return {variants: parts, utility: token.slice(start)};
}

// Attribute-selector variants Radix state styling needs: data-[state=open]:, aria-[sort=ascending]:, group-data-[…]:.
const allowedBracketVariant = /^(?:group-|peer-)?(?:data|aria)-\[[\w-]+(?:=[\w-]+)?\]$/;
// A utility with an arbitrary value or property: bg-[#fff], p-[13px], bg-(--x), [mask-type:alpha].
const arbitraryUtility = /^!?-?(?:[a-z][\w-]*-[[(]|\[[a-z-]+:)/;

/** Returns why a class token is not allowed, or undefined. */
export function classProblem(token: string): string | undefined {
  if (!/^[!a-z[-]/.test(token) || !/[[(:]|^transition|^duration|^delay/.test(token)) return undefined;
  const {variants, utility} = splitClass(token);
  for (const v of variants) {
    if (v === 'dark') return `"${token}": no dark: variants, themes swap tokens (tokens.css)`;
    if (v.includes('[') && !allowedBracketVariant.test(v)) return `"${token}": arbitrary variant; add a @custom-variant`;
  }
  if (arbitraryUtility.test(utility)) return `"${token}": arbitrary value; use a token utility or add a token`;
  if (utility === 'transition' || utility === 'transition-all') {
    return `"${token}": animates layout properties; use the interactive utility or transition-colors/opacity/transform`;
  }
  if (/^(?:duration|delay)-\d/.test(utility)) return `"${token}": hard-coded timing; use the motion tokens (speed-*)`;
  return undefined;
}

// Raw colours: #rgb, #rgba, #rrggbb, #rrggbbaa, or a colour function.
const rawColor = /(?:^|[\s(,:'"])#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})(?![\w-])|\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color-mix)\(/i;

function checkString(context: Rule.RuleContext, node: ESTree.Node, value: string) {
  if (rawColor.test(value)) {
    context.report({node, message: `Raw colour in "${value.slice(0, 60)}": use a colour token (tokens.css)`});
  }
  for (const token of value.split(/\s+/)) {
    const problem = token && classProblem(token);
    if (problem) context.report({node, message: problem});
  }
}

const tokensOnly: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {description: 'Disallow raw colours, Tailwind arbitrary values, dark: variants and layout transitions in source strings'},
    schema: [],
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value === 'string') checkString(context, node, node.value);
      },
      TemplateElement(node) {
        checkString(context, node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};

const noLiteralStyle: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {description: 'Disallow literal values in style={{…}}: visual values come from token utilities'},
    schema: [],
  },
  create(context) {
    return {
      // JSX nodes are not part of ESTree's types; match the attribute by shape.
      'JSXAttribute[name.name="style"] > JSXExpressionContainer > ObjectExpression > Property'(node: ESTree.Property) {
        if (node.value.type === 'Literal') {
          context.report({node, message: 'Literal style value: use a token utility class; style is only for computed values (positions, CSS variables)'});
        }
      },
    };
  },
};

export default {
  meta: {name: 'tokens'},
  rules: {'tokens-only': tokensOnly, 'no-literal-style': noLiteralStyle},
};
