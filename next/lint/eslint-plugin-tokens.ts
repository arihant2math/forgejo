// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Local ESLint rules that keep every visual value in src/styles/tokens.css and
// every look in src/ui (IMPLEMENTATION.md §2.4):
//   tokens/tokens-only      raw colours, arbitrary values, off-scale numbers, dark:, transitions
//   tokens/no-literal-style literal values in style={{…}}
//   tokens/no-restyle       look-changing classes on a src/ui primitive
// Classes that do not exist at all are caught by src/styles/classes.test.ts,
// which compiles every class used in src/ against the theme.

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
const arbitrary = /-[[(]|^\[/;
// The spacing scale (multiples of --spacing = 4px) that layouts may use.
const spacingSteps = new Set(['0', '0.5', '1', '1.5', '2', '2.5', '3', '3.5', '4', '4.5', '5', '6', '7', '8', '9', '10', '12', '14', '16', '20', '24', '28', '32', '36', '40', '44', '48', '52', '56', '60', '64', '72', '80', '96']);
const spacingUtility = /^-?(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy]|[wh]|size|min-[wh]|max-[wh]|inset(?:-[xy])?|top|right|bottom|left|start|end|translate-[xy]|basis|scroll-[mp][xytrblse]?)-(\d+(?:\.\d+)?)$/;
// Bare numeric values that bypass a token namespace (z-10, leading-5, opacity-50, border-2, …).
const colourUtility = /^(?:bg|text|border(?:-[xytrblse])?|outline|ring|fill|stroke|decoration|shadow|from|via|to|accent|caret|placeholder|divide)-/;
const fraction = /^-?(?:[wh]|size|inset(?:-[xy])?|top|right|bottom|left|basis|translate-[xy])-\d+\/\d+$/;
const bareNumber = /^-?(?:z|leading|opacity|border(?:-[xytrblse])?|outline|ring(?:-offset)?|outline-offset|divide-[xy]|scale(?:-[xy])?|rotate|skew-[xy]|tracking|grid-cols|grid-rows|col-span|row-span|order|columns|line-clamp|stroke|duration|delay)-[1-9]/;

/** Returns why a class token is not allowed, or undefined. */
export function classProblem(token: string): string | undefined {
  // Only class-like tokens: lowercase utilities with optional variants, negatives, !important.
  if (!/^[!*@a-z[-]/.test(token) || token.startsWith('--')) return undefined;
  const {variants, utility} = splitClass(token);
  for (const v of variants) {
    if (v === 'dark') return `"${token}": no dark: variants, themes swap tokens (tokens.css)`;
    if (v === '*' || v === '**') return `"${token}": child-selector variant; style the child (or its primitive) instead`;
    if (v.includes('[') && !allowedBracketVariant.test(v)) return `"${token}": arbitrary variant; add a @custom-variant`;
  }
  const u = utility.replace(/^!/, '');
  if (arbitrary.test(u)) return `"${token}": arbitrary value; use a token utility or add a token`;
  if (/^transition(?:-|$)/.test(u)) return `"${token}": use the interactive utility (instant in, --speed-out fade); no other transitions`;
  if (u.startsWith('ease-')) return `"${token}": use the interactive utility (motion tokens)`;
  if (bareNumber.test(u)) return `"${token}": hard-coded value; use a token (tokens.css)`;
  const spacing = spacingUtility.exec(u);
  if (spacing && !spacingSteps.has(spacing[1] ?? '')) return `"${token}": off the spacing scale; use a step from lint/eslint-plugin-tokens.ts spacingSteps or a size token`;
  // Opacity / colour modifiers (bg-accent/50) mix ad hoc colours; fractions (w-1/2) are fine.
  if (u.includes('/') && colourUtility.test(u) && !fraction.test(u)) return `"${token}": colour/opacity modifier; add a colour token`;
  return undefined;
}

// A whole-string colour value: '#fff', 'rgb(0 0 0)', 'oklch(…)' (strings such as 'Fixes #123' are fine).
const rawColor = /^\s*(?:#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})|(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color-mix)\(.*\))\s*$/i;

function checkString(context: Rule.RuleContext, node: ESTree.Node, value: string) {
  if (rawColor.test(value)) {
    context.report({node, message: `Raw colour "${value.trim()}": use a colour token (tokens.css)`});
    return;
  }
  for (const token of value.split(/\s+/)) {
    const problem = token && classProblem(token);
    if (problem) context.report({node, message: problem});
  }
}

const tokensOnly: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {description: 'Disallow raw colours, Tailwind arbitrary/off-scale values, dark: variants and transitions in source strings'},
    schema: [],
  },
  create(context) {
    return {
      Literal(node) {
        const parent = (node as Partial<Rule.Node>).parent?.type ?? '';
        if (parent === 'ImportDeclaration' || parent === 'ImportExpression' || parent.startsWith('Export')) return;
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

// Classes a feature may put on a primitive: placement and size, never its look.
const layoutClass = /^(?:-?m[xytrblse]?-|[wh]-|size-|min-[wh]-|max-[wh]-|flex-|grow|shrink|basis-|self-|justify-self-|order-|col-|row-|hidden$|block$|inline-block$|sr-only$|truncate$|absolute$|relative$|sticky$|inset|top-|right-|bottom-|left-)/;
// Icons are tinted by their context, so text colours are fine on <Icon>.
const iconTint = /^text-(?!xs$|sm$|base$|md$|lg$|xl$)/;
const uiModule = /(?:^|\/)ui(?:\/index\.ts|\/[A-Z]\w*\.tsx)?$/;

// The JSX parts of a className attribute (JSX nodes are not in ESTree's types).
interface JSXAttribute {
  value: ESTree.Literal | {type: 'JSXExpressionContainer'; expression: ESTree.Node} | null;
  parent: {name: {type: string; name?: string}};
}

const noRestyle: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {description: 'Disallow look-changing classes (colour, padding, radius, type, …) on src/ui primitives outside src/ui'},
    schema: [],
  },
  create(context) {
    const primitives = new Set<string>();
    const check = (node: ESTree.Node, component: string, value: string) => {
      for (const cls of value.split(/\s+/).filter(Boolean)) {
        const {utility} = splitClass(cls);
        if (layoutClass.test(utility) || (component === 'Icon' && iconTint.test(utility))) continue;
        context.report({node, message: `"${cls}" restyles <${component}>: add a variant or prop to the primitive in src/ui instead`});
      }
    };
    const strings = (node: ESTree.Node | undefined, out: [ESTree.Node, string][] = []): [ESTree.Node, string][] => {
      if (!node) return out;
      if (node.type === 'Literal' && typeof node.value === 'string') out.push([node, node.value]);
      else if (node.type === 'TemplateLiteral') for (const q of node.quasis) out.push([q, q.value.cooked ?? q.value.raw]);
      else if (node.type === 'ConditionalExpression') strings(node.alternate, strings(node.consequent, out));
      else if (node.type === 'LogicalExpression') strings(node.right, out);
      else if (node.type === 'CallExpression') for (const a of node.arguments) strings(a, out);
      return out;
    };
    return {
      ImportDeclaration(node) {
        if (typeof node.source.value !== 'string' || !uiModule.test(node.source.value)) return;
        for (const s of node.specifiers) primitives.add(s.local.name);
      },
      'JSXAttribute[name.name="className"]'(node: ESTree.Node) {
        const attr = node as unknown as JSXAttribute;
        const component = attr.parent.name.type === 'JSXIdentifier' ? attr.parent.name.name : undefined;
        if (!component || !primitives.has(component) || !attr.value) return;
        const expr = attr.value.type === 'Literal' ? attr.value : attr.value.expression;
        for (const [n, v] of strings(expr)) check(n, component, v);
      },
    };
  },
};

export default {
  meta: {name: 'tokens'},
  rules: {'tokens-only': tokensOnly, 'no-literal-style': noLiteralStyle, 'no-restyle': noRestyle},
};
