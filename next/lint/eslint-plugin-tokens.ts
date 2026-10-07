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
const spacingUtility = /^-?(?:indent|p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy]|[wh]|size|min-[wh]|max-[wh]|inset(?:-[xy])?|top|right|bottom|left|start|end|translate-[xy]|basis|scroll-[mp][xytrblse]?)-(\d+(?:\.\d+)?)$/;
// Bare numeric values that bypass a token namespace (z-10, leading-5, opacity-50, border-2, …).
const colourUtility = /^(?:bg|text|border(?:-[xytrblse])?|outline|ring|fill|stroke|decoration|shadow|from|via|to|accent|caret|placeholder|divide)-/;
const fraction = /^-?(?:[wh]|size|inset(?:-[xy])?|top|right|bottom|left|basis|translate-[xy])-\d+\/\d+$/;
const bareNumber = /^-?(?:z|leading|opacity|border(?:-[xytrblse])?|outline|ring(?:-offset)?|outline-offset|divide-[xy]|scale(?:-[xy])?|rotate|skew-[xy]|tracking|grid-cols|grid-rows|col-span|row-span|order|columns|line-clamp|stroke|duration|delay|decoration|underline-offset|zoom)-[1-9]/;
// Ad hoc colour shifts, gradients and extra rings/shadows: colours and elevation come from tokens.
const bannedUtility = /^-?(?:brightness|contrast|saturate|hue-rotate|grayscale|invert|sepia|blur|drop-shadow|backdrop-[a-z-]+|bg-(?:linear|radial|conic)|from|via|to|inset-ring|inset-shadow|ring|shadow(?!-popover$|-dialog$))(?:-|$)/;

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
  if (bannedUtility.test(u)) return `"${token}": colours, gradients and elevation come from tokens (tokens.css)`;
  if (bareNumber.test(u)) return `"${token}": hard-coded value; use a token (tokens.css)`;
  const spacing = spacingUtility.exec(u);
  if (spacing && !spacingSteps.has(spacing[1] ?? '')) return `"${token}": off the spacing scale; use a step from lint/eslint-plugin-tokens.ts spacingSteps or a size token`;
  // Opacity / colour modifiers (bg-accent/50) mix ad hoc colours; fractions (w-1/2) are fine.
  if (u.includes('/') && colourUtility.test(u) && !fraction.test(u)) return `"${token}": colour/opacity modifier; add a colour token`;
  return undefined;
}

// A whole-string colour value: '#fff', 'rgb(0 0 0)', 'oklch(…)' (strings such as 'Fixes #123' are fine).
const rawColor = /^\s*(?:#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})|(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color-mix)\(.*\))\s*$/i;

/** Files whose every string is a class list or class table (the primitives). */
const isUiFile = (filename: string) => /[\\/]src[\\/]ui[\\/][^\\/]+\.tsx?$/.test(filename);

interface ClassValues {
  strings: [ESTree.Node, string][];
  /** Parts whose value cannot be followed statically. */
  opaque: ESTree.Node[];
}

/**
 * The strings a class expression can evaluate to: literals, templates,
 * conditionals, cx(…) arguments, arrays, and same-file consts (also through
 * `arr[i]` and `arr.map((x) => …)` parameters).
 */
function classValues(context: Rule.RuleContext, expr: ESTree.Node, out: ClassValues = {strings: [], opaque: []}, seen = new Set<ESTree.Node>()): ClassValues {
  if (seen.has(expr)) return out;
  seen.add(expr);
  const recurse = (n: ESTree.Node | null | undefined) => {
    if (n) classValues(context, n, out, seen);
  };
  switch (expr.type) {
    case 'Literal':
      if (typeof expr.value === 'string') out.strings.push([expr, expr.value]);
      else if (expr.value !== null && typeof expr.value !== 'boolean') out.opaque.push(expr);
      break;
    case 'TemplateLiteral':
      for (const q of expr.quasis) out.strings.push([q, q.value.cooked ?? q.value.raw]);
      expr.expressions.forEach(recurse);
      break;
    case 'ConditionalExpression':
      recurse(expr.consequent);
      recurse(expr.alternate);
      break;
    case 'LogicalExpression':
      if (expr.operator !== '&&') recurse(expr.left);
      recurse(expr.right);
      break;
    case 'ArrayExpression':
      for (const e of expr.elements) if (e && e.type !== 'SpreadElement') recurse(e);
      break;
    case 'ObjectExpression':
      for (const p of expr.properties) if (p.type === 'Property') recurse(p.value);
      break;
    case 'MemberExpression':
      recurse(expr.object); // table[key], list[i]
      break;
    case 'CallExpression':
      if (expr.callee.type === 'Identifier' && expr.callee.name === 'cx') expr.arguments.forEach((a) => {
        if (a.type !== 'SpreadElement') recurse(a);
      });
      else out.opaque.push(expr);
      break;
    case 'Identifier': {
      if (expr.name === 'undefined') break;
      let scope: ReturnType<typeof context.sourceCode.getScope> | null = context.sourceCode.getScope(expr);
      let variable;
      while (scope && !variable) {
        variable = scope.set.get(expr.name);
        scope = scope.upper;
      }
      const def = variable?.defs[0];
      if (def?.type === 'Variable' && def.parent.kind === 'const' && def.node.init) recurse(def.node.init);
      else if (def?.type === 'Parameter') {
        // (x) => … passed to list.map(…): follow the list.
        const fn = def.node as Rule.Node;
        const call = fn.parent as ESTree.Node | null;
        if (call?.type === 'CallExpression' && call.callee.type === 'MemberExpression' && call.arguments[0] === fn) recurse(call.callee.object);
        else out.opaque.push(expr);
      } else out.opaque.push(expr);
      break;
    }
    default: {
      // TS wrappers (`x as const`, `x satisfies T`) and JSX containers.
      const inner = (expr as unknown as {expression?: ESTree.Node}).expression;
      if (inner) recurse(inner);
      else out.opaque.push(expr);
    }
  }
  return out;
}

function classProblems(context: Rule.RuleContext, node: ESTree.Node, value: string) {
  for (const token of value.split(/\s+/)) {
    const problem = token && classProblem(token);
    if (problem) context.report({node, message: problem});
  }
}

// JSX nodes are not part of ESTree's types; these are the parts the rules read.
interface JSXName {type: string; name?: string; object?: JSXName; property?: JSXName}
interface JSXAttr {type: 'JSXAttribute'; name: {name: string}; value: ESTree.Literal | {type: 'JSXExpressionContainer'; expression: ESTree.Node} | null}
interface JSXSpread {type: 'JSXSpreadAttribute'; argument: ESTree.Node}
interface JSXOpening {name: JSXName; attributes: (JSXAttr | JSXSpread)[]}

const attrExpression = (attr: JSXAttr): ESTree.Node | undefined => {
  if (!attr.value) return undefined;
  return attr.value.type === 'Literal' ? attr.value : attr.value.expression;
};

const tokensOnly: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {description: 'Disallow raw colours anywhere, and arbitrary/off-scale values, dark: variants and transitions in class lists'},
    schema: [],
  },
  create(context) {
    const ui = isUiFile(context.filename);
    const checked = new Set<ESTree.Node>();
    const checkClasses = (expr: ESTree.Node) => {
      for (const [n, v] of classValues(context, expr).strings) {
        if (checked.has(n)) continue;
        checked.add(n);
        classProblems(context, n, v);
      }
    };
    return {
      Literal(node) {
        const parent = (node as Partial<Rule.Node>).parent?.type ?? '';
        if (parent === 'ImportDeclaration' || parent === 'ImportExpression' || parent.startsWith('Export')) return;
        if (typeof node.value !== 'string') return;
        if (rawColor.test(node.value)) context.report({node, message: `Raw colour "${node.value.trim()}": use a colour token (tokens.css)`});
        else if (ui && !checked.has(node)) classProblems(context, node, node.value);
      },
      TemplateElement(node) {
        if (ui && !checked.has(node)) classProblems(context, node, node.value.cooked ?? node.value.raw);
      },
      // Outside src/ui only class contexts are class lists: prose such as '- [ ] ' or 'transition' is fine.
      'JSXAttribute[name.name="className"]'(node: ESTree.Node) {
        const expr = attrExpression(node as unknown as JSXAttr);
        if (expr && !ui) checkClasses(expr);
      },
      CallExpression(node) {
        if (!ui && node.callee.type === 'Identifier' && node.callee.name === 'cx') checkClasses(node);
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
      'JSXAttribute[name.name="style"] > JSXExpressionContainer > ObjectExpression > Property'(node: ESTree.Property) {
        const v = node.value;
        if (v.type === 'Literal' || (v.type === 'TemplateLiteral' && v.expressions.length === 0)) {
          context.report({node, message: 'Literal style value: use a token utility class; style is only for computed values (positions, CSS variables)'});
        }
      },
    };
  },
};

// Classes a feature may put on a primitive: placement and size, never its look.
const layoutClass = /^(?:-?m[xytrblse]?-|[wh]-|size-|min-[wh]-|max-[wh]-|flex-|grow|shrink|basis-|self-|justify-self-|order-|col-|row-|hidden$|block$|inline-block$|sr-only$|truncate$|absolute$|relative$|sticky$|-?inset(?:-[xy])?-(?:\d|px$|auto$|full$)|-?(?:top|right|bottom|left)-)/;
// Sizes a primitive owns (its size prop decides them); className may not override them.
const ownedSize: Partial<Record<string, RegExp>> = {
  Button: /^(?:h|size)-/, IconButton: /^(?:h|w|size)-/, Input: /^(?:h|size)-/, Avatar: /^(?:h|w|size)-/, Icon: /^(?:h|w|size)-/,
};
// Icons are tinted by their context, so text colours are fine on <Icon>.
const iconTint = /^text-(?!xs$|sm$|base$|md$|lg$|xl$)/;
const uiModule = /(?:^|\/)ui(?:\/index\.ts|\/[A-Z]\w*\.tsx)?$/;

const noRestyle: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {description: 'Disallow restyling src/ui primitives (look classes, style, spreads) and bare icons outside src/ui'},
    schema: [],
  },
  create(context) {
    const primitives = new Set<string>();
    const namespaces = new Set<string>();
    const icons = new Set<string>();
    const componentName = (name: JSXName): string | undefined => {
      if (name.type === 'JSXIdentifier') return name.name !== undefined && primitives.has(name.name) ? name.name : undefined;
      if (name.type === 'JSXMemberExpression' && name.object?.type === 'JSXIdentifier' && name.object.name && namespaces.has(name.object.name)) return name.property?.name;
      return undefined;
    };
    const checkClass = (node: ESTree.Node, component: string, value: string) => {
      for (const cls of value.split(/\s+/).filter(Boolean)) {
        const {utility} = splitClass(cls);
        if (ownedSize[component]?.test(utility)) {
          context.report({node, message: `"${cls}": <${component}> owns its size; use its size prop`});
        } else if (!layoutClass.test(utility) && !(component === 'Icon' && iconTint.test(utility))) {
          context.report({node, message: `"${cls}" restyles <${component}>: add a variant or prop to the primitive in src/ui instead`});
        }
      }
    };
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source !== 'string') return;
        if (source === 'lucide-react') for (const s of node.specifiers) icons.add(s.local.name);
        if (!uiModule.test(source)) return;
        for (const s of node.specifiers) (s.type === 'ImportNamespaceSpecifier' ? namespaces : primitives).add(s.local.name);
      },
      JSXOpeningElement(node: ESTree.Node) {
        const el = node as unknown as JSXOpening;
        if (el.name.type === 'JSXIdentifier' && el.name.name && icons.has(el.name.name)) {
          context.report({node, message: `Render icons through <Icon icon={${el.name.name}}/> (standard sizes and stroke)`});
          return;
        }
        const component = componentName(el.name);
        if (!component) return;
        for (const attr of el.attributes) {
          if (attr.type === 'JSXSpreadAttribute') {
            const props = attr.argument.type === 'ObjectExpression' ? attr.argument.properties : [];
            if (props.some((p) => p.type === 'Property' && p.key.type === 'Identifier' && (p.key.name === 'className' || p.key.name === 'style'))) {
              context.report({node: attr.argument, message: `Spreading className/style onto <${component}> restyles it`});
            }
            continue;
          }
          if (attr.name.name === 'style') {
            context.report({node, message: `style on <${component}> restyles it: add a variant or prop to the primitive`});
            continue;
          }
          if (attr.name.name !== 'className') continue;
          const expr = attrExpression(attr);
          if (!expr) continue;
          const {strings, opaque} = classValues(context, expr);
          for (const [n, v] of strings) checkClass(n, component, v);
          for (const n of opaque) context.report({node: n, message: `className on <${component}> must be literal classes (or same-file consts of them)`});
        }
      },
    };
  },
};

export default {
  meta: {name: 'tokens'},
  rules: {'tokens-only': tokensOnly, 'no-literal-style': noLiteralStyle, 'no-restyle': noRestyle},
};
