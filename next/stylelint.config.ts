// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {Config} from 'stylelint';

// Motion (PLAN §5.6): only transform, opacity and colours may transition, and
// only with token durations. `transition: .2s` (no property) means `all`, so
// every comma-separated part must name an allowed property first.
const animatable = [
  'opacity', 'transform', 'translate', 'scale', 'rotate', 'color', 'background-color', 'border-color', 'outline-color',
  'fill', 'stroke', 'text-decoration-color',
].join('|');
const token = String.raw`var\(--[\w-]+\)`;
const item = String.raw`(?:${animatable})(?:\s+${token})*`;
const transitionShorthand = new RegExp(String.raw`^${item}(?:\s*,\s*${item})*$`);
const transitionProperty = new RegExp(String.raw`^(?:${animatable})(?:\s*,\s*(?:${animatable}))*$`);

// Values that must come from tokens.css outside of it.
const tokenized = [
  '/color$/', 'fill', 'stroke', 'background', 'font-size', 'font-family', 'font-weight', 'line-height', 'letter-spacing',
  'z-index', 'border-radius', 'border-width', 'outline-width', 'outline-offset', 'box-shadow', 'opacity', 'animation',
  'animation-duration', 'transition-duration', '/^margin/', '/^padding/', 'gap', 'row-gap', 'column-gap',
];

const config: Config = {
  extends: ['stylelint-config-standard'],
  plugins: ['stylelint-declaration-strict-value'],
  rules: {
    'declaration-property-value-allowed-list': {
      transition: [transitionShorthand],
      'transition-property': [transitionProperty],
    },
    // Transitions live in one place: the `interactive` utility in app.css.
    'property-disallowed-list': ['transition', 'transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay'],
    'scale-unlimited/declaration-strict-value': [tokenized, {
      ignoreValues: ['inherit', 'initial', 'unset', 'transparent', 'currentcolor', 'none', '0', 'auto', 'solid'],
      ignoreFunctions: false,
    }],
    'color-no-hex': true,
    // Longhands keep each part checkable by declaration-strict-value.
    'declaration-block-no-redundant-longhand-properties': [true, {ignoreShorthands: ['outline']}],
    'color-named': 'never',
    'at-rule-no-unknown': [true, {ignoreAtRules: ['theme', 'source', 'utility', 'variant', 'custom-variant', 'apply', 'reference']}],
    'at-rule-no-deprecated': [true, {ignoreAtRules: ['apply']}],
    'import-notation': 'string',
    // Tailwind's @import … source(none) / layer(…) must come before @reference.
    'no-invalid-position-at-import-rule': null,
    'custom-property-pattern': null,
    'value-keyword-case': ['lower', {camelCaseSvgKeywords: true}],
    'selector-class-pattern': null,
    'comment-empty-line-before': null,
    // Tailwind's @utility / @custom-variant bodies use `&`.
    'nesting-selector-no-missing-scoping-root': null,
  },
  overrides: [
    {
      // The one place raw values live.
      files: ['src/styles/tokens.css'],
      rules: {
        'color-no-hex': null,
        'scale-unlimited/declaration-strict-value': null,
        'custom-property-empty-line-before': null,
      },
    },
    {
      // Home of the `interactive` utility.
      files: ['src/styles/app.css'],
      rules: {'property-disallowed-list': null},
    },
  ],
};

export default config;
