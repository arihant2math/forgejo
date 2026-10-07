// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {Config} from 'stylelint';

// Properties that trigger layout when animated (PLAN §5.6: animate transform
// and opacity only, occasionally colours). `all` includes them.
const side = '(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?';
const layoutProperties = [
  'all', '(?:min-|max-)?(?:width|height|inline-size|block-size)', 'top', 'right', 'bottom', 'left',
  `(?:margin|padding|inset)${side}`, `border${side}(?:-width)?`, 'flex(?:-basis|-grow|-shrink)?',
  'grid(?:-template-(?:columns|rows))?', '(?:row-|column-)?gap', 'font-size', 'font-weight', 'line-height',
  'letter-spacing', 'display',
];
// Matches one of them as a whole word in a transition / transition-property value.
const layoutTransition = new RegExp(`(?:^|[\\s,])(?:${layoutProperties.join('|')})(?=$|[\\s,])`);

// Values that must come from tokens.css outside of it.
const tokenized = [
  '/color$/', 'fill', 'stroke', 'background', 'font-size', 'font-family', 'line-height', 'z-index', 'border-radius',
  'box-shadow', 'transition-duration', 'animation-duration', '/^margin/', '/^padding/', 'gap', 'row-gap', 'column-gap',
];

const config: Config = {
  extends: ['stylelint-config-standard'],
  plugins: ['stylelint-declaration-strict-value'],
  rules: {
    'declaration-property-value-disallowed-list': {
      '/^transition(-property)?$/': [layoutTransition],
    },
    'property-disallowed-list': ['transition-delay'],
    'scale-unlimited/declaration-strict-value': [tokenized, {
      ignoreValues: ['inherit', 'initial', 'unset', 'transparent', 'currentcolor', 'none', '0', 'auto'],
      ignoreFunctions: false,
    }],
    'color-no-hex': true,
    'at-rule-no-unknown': [true, {ignoreAtRules: ['theme', 'source', 'utility', 'variant', 'custom-variant', 'apply', 'reference']}],
    'at-rule-no-deprecated': [true, {ignoreAtRules: ['apply']}],
    'import-notation': 'string',
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
  ],
};

export default config;
