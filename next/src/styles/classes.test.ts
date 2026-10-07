// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment node

// Every class used in src/ must exist in the theme. Tailwind silently emits
// nothing for unknown classes (bg-white, text-red-500, font-bold: the default
// theme is not loaded), so a typo or a habit from stock Tailwind would ship as
// a missing style.

import {readFileSync, readdirSync} from 'node:fs';
import {join, relative} from 'node:path';
import {__unstable__loadDesignSystem, compile} from '@tailwindcss/node';
import {Scanner} from '@tailwindcss/oxide';
import {classProblem} from '../../lint/eslint-plugin-tokens.ts';
import ts from 'typescript';
import {describe, expect, test} from 'vitest';

const src = new URL('..', import.meta.url).pathname;
// Marker classes that only exist for variants (group-data-…).
const markers = new Set(['group', 'peer']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, {withFileTypes: true}).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'test' || e.name === 'protocol' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : [];
  });
}

/**
 * Class strings: className attributes and cx() arguments (following same-file
 * consts, `table[key]` and `list.map((x) => …)` parameters), and module-level
 * constants in src/ui (recipes, variant tables).
 */
export function classStrings(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const tables = relative(src, file).startsWith('ui/');
  const followed = new Set<string>();
  const topLevel = new Map<string, ts.Expression>();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) topLevel.set(d.name.text, d.initializer);
  }
  const out: string[] = [];
  // Collects the strings an expression can evaluate to (not those it merely compares against).
  const collect = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      // Drop the tokens glued to an interpolation (`h-3 ${w}` keeps "h-3").
      out.push(node.head.text.replace(/\S+$/, ''));
      node.templateSpans.forEach((span, i) => {
        const last = i === node.templateSpans.length - 1;
        const text = span.literal.text.replace(/^\S+/, '');
        out.push(last ? text : text.replace(/\S+$/, ''));
        collect(span.expression);
      });
    } else if (ts.isConditionalExpression(node)) {
      collect(node.whenTrue);
      collect(node.whenFalse);
    } else if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) collect(node.right);
      else if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.PlusToken) {
        collect(node.left);
        collect(node.right);
      }
    } else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isJsxExpression(node)) {
      if (node.expression) collect(node.expression);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const p of node.properties) if (ts.isPropertyAssignment(p)) collect(p.initializer);
    } else if (ts.isArrayLiteralExpression(node)) node.elements.forEach(collect);
    else if (ts.isCallExpression(node) && node.expression.getText(sf) === 'cx') node.arguments.forEach(collect);
    else if (ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) collect(node.expression);
    else if (ts.isIdentifier(node)) follow(node);
  };
  // A same-file const, or the list behind a `.map((x) => …)` parameter.
  const follow = (id: ts.Identifier) => {
    for (let n: ts.Node = id.parent; !ts.isSourceFile(n); n = n.parent) {
      if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
        const param = n.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === id.text);
        if (param) {
          const call = n.parent;
          if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'map') collect(call.expression.expression);
          return;
        }
      }
    }
    const init = topLevel.get(id.text);
    if (init && !followed.has(id.text)) {
      followed.add(id.text);
      collect(init);
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === 'className' && node.initializer) collect(node.initializer);
    else if (ts.isCallExpression(node) && node.expression.getText(sf) === 'cx') node.arguments.forEach(collect);
    else if (tables && ts.isVariableStatement(node) && ts.isSourceFile(node.parent)) {
      for (const d of node.declarationList.declarations) if (d.initializer) collect(d.initializer);
    } else ts.forEachChild(node, visit);
  };
  visit(sf);
  return out.filter((c) => c.trim());
}

describe('classes', () => {
  test('every class used in src/ compiles against the theme', async () => {
    const ds = await __unstable__loadDesignSystem(readFileSync(join(src, 'styles/app.css'), 'utf8'), {base: join(src, 'styles')});
    const used = new Map<string, string>();
    for (const file of sourceFiles(src)) {
      for (const s of classStrings(file, readFileSync(file, 'utf8'))) {
        for (const c of s.split(/\s+/).filter(Boolean)) used.set(c, relative(src, file));
      }
    }
    expect(used.size).toBeGreaterThan(100);
    const classes = [...used.keys()].filter((c) => !markers.has(c));
    const css = ds.candidatesToCss(classes);
    const unknown = classes.filter((_, i) => css[i] === null).map((c) => `${c} (${used.get(c) ?? ''})`);
    expect(unknown).toEqual([]);
  });

  test('every class that ships obeys the lint policy, however the code produced it', async () => {
    // Tailwind's own scanner over app.css's @source set finds every candidate that
    // becomes CSS (from functions, spreads, prose, anything): none may be banned.
    const css = readFileSync(join(src, 'styles/app.css'), 'utf8');
    const base = join(src, 'styles');
    const compiler = await compile(css, {base, onDependency: () => undefined});
    const candidates = new Scanner({sources: compiler.sources}).scan();
    const ds = await __unstable__loadDesignSystem(css, {base});
    const out = ds.candidatesToCss(candidates);
    const shipped = candidates.filter((_, i) => out[i] !== null);
    expect(shipped.length).toBeGreaterThan(100);
    expect(shipped.flatMap((c) => classProblem(c) ?? [])).toEqual([]);
  });

  test('interactive: every state primitives use appears instantly', async () => {
    const ds = await __unstable__loadDesignSystem(readFileSync(join(src, 'styles/app.css'), 'utf8'), {base: join(src, 'styles')});
    const [css = ''] = ds.candidatesToCss(['interactive']);
    for (const state of [':hover', ':focus-visible', '[data-highlighted]', '[data-selected]', '[data-active]', '[aria-pressed="true"]', '[data-state="open"]']) {
      expect(css).toContain(`&${state}`);
    }
  });

  test('unknown classes are detected', async () => {
    const ds = await __unstable__loadDesignSystem(readFileSync(join(src, 'styles/app.css'), 'utf8'), {base: join(src, 'styles')});
    expect(ds.candidatesToCss(['bg-white', 'text-red-500', 'font-bold', 'shadow-sm', 'bg-surface'])).toEqual([null, null, null, null, expect.any(String)]);
    expect(classStrings(join(src, 'ui/X.tsx'), 'const a = {x: "bg-x"}; <A className={cx("p-1", y ? "m-1" : `h-3 ${w}`)}/>')).toEqual(['bg-x', 'p-1', 'm-1', 'h-3 ']);
    // Outside src/ui: consts and map parameters reached from a class context.
    expect(classStrings(join(src, 'app/X.tsx'), 'const data = ["Sync log"]; const ws = ["w-big"]; const row = "h-row"; <>{ws.map((w) => <A className={`${row} ${w}`}/>)}</>')).toEqual(['h-row', 'w-big']);
  });
});
