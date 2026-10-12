// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment node


import stylelint from 'stylelint';
import {describe, expect, test} from 'vitest';
import {classProblem} from './eslint-plugin-tokens.ts';

const root = new URL('..', import.meta.url).pathname;
const fixtures = `${root}src/test/lint-fixtures/`;

describe('classProblem', () => {
  test.each([
    'bg-surface', 'h-row', 'data-[state=closed]:animate-exit', 'group-data-[state=open]:text-fg', 'hover:bg-hover',
    'w-1/2', 'aria-invalid:border-danger', 'interactive', 'size-3.5', 'h-4.5', '-mx-1', 'shrink-0', 'outline-offset-0',
    'z-popover', 'disabled:opacity-disabled', 'react-dom/client', 'var(--color-danger)', 'image/png',
  ])('allows %s', (c) => {
    expect(classProblem(c)).toBeUndefined();
  });
  test.each([
    'bg-[#fff]', 'p-[13px]', 'bg-(--x)', '[mask-type:alpha]', 'hover:w-[3px]', 'transition', 'transition-all',
    'dark:bg-canvas', 'md:dark:text-fg', 'duration-150', 'delay-75', '[&_svg]:size-4', '-mt-[2px]', '!p-[1px]',
    'transition-colors', 'transition-opacity', 'ease-linear', 'z-10', 'leading-5', 'opacity-50', 'border-2', 'ring-2',
    'scale-95', 'p-3.25', 'w-37', 'bg-accent/50', 'text-fg/[0.37]', '*:p-1', '**:bg-hover', '@[600px]:flex', '@md:p-[13px]',
  ])('rejects %s', (c) => {
    expect(classProblem(c)).toBeDefined();
  });
});

describe('stylelint (stylelint.config.ts)', () => {
  test('bad.css: transition: all, layout transitions, raw values', async () => {
    const {results} = await stylelint.lint({files: [`${fixtures}bad.css`], cwd: root});
    const warnings = results.flatMap((r) => r.warnings).map((w) => `${w.rule}: ${w.text}`);
    const has = (re: RegExp) => {
      expect(warnings.some((w) => re.test(w)), `${String(re)} in\n${warnings.join('\n')}`).toBe(true);
    };
    has(/declaration-property-value-allowed-list: Disallowed value "all 0.2s" for property "transition"/);
    has(/declaration-property-value-allowed-list: Disallowed value "width var/);
    has(/declaration-property-value-allowed-list: Disallowed value "margin-top"/);
    has(/declaration-property-value-allowed-list: Disallowed value "0.2s" for property "transition"/);
    has(/property-disallowed-list: Disallowed property "transition-duration"/);
    has(/color-no-hex/);
    has(/color-named/);
    has(/declaration-strict-value: Expected variable or keyword for "13px"/);
    has(/declaration-strict-value: Expected variable or keyword for "spin"/);
    has(/declaration-strict-value: Expected variable or keyword for "3px" of "border"/);
    has(/declaration-strict-value: Expected variable or keyword for "15px\/22px" of "font"/);
    has(/declaration-strict-value: Expected variable or keyword for "13px" of "width"/);
    has(/declaration-strict-value: Expected variable or keyword for "brightness\(1.3\)" of "filter"/);
    has(/motion\/keyframes-transform-opacity: "height" in @keyframes/);
  });

  test('good.css and the allowed transition form pass', async () => {
    const {results} = await stylelint.lint({files: [`${fixtures}good.css`], cwd: root});
    expect(results.flatMap((r) => r.warnings)).toEqual([]);
    const ok = await stylelint.lint({code: '.a {\n  transition: opacity var(--speed-out) var(--ease-out), transform var(--speed-out);\n}\n', codeFilename: `${root}src/styles/app.css`, cwd: root});
    expect(ok.results.flatMap((r) => r.warnings)).toEqual([]);
  });
});
