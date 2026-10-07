// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// next/ is linted only by this config (`npm run lint` inside next/); see the
// F1 notes in IMPLEMENTATION.md for how the root config is kept out.

import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import {defineConfig} from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import tokens from './lint/eslint-plugin-tokens.ts';

export default defineConfig(
  // src/test/lint-fixtures hold deliberately bad code for lint/lint.test.ts.
  {ignores: ['dist/', 'test-results/', 'playwright-report/', 'src/protocol/types.gen.ts', 'src/test/lint-fixtures/']},
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      // Browser code (tsconfig.json) and Node-side code (tsconfig.node.json: tests, tools, configs).
      parserOptions: {project: ['./tsconfig.json', './tsconfig.node.json'], tsconfigRootDir: import.meta.dirname},
    },
    linterOptions: {reportUnusedDisableDirectives: 'error'},
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}],
      '@typescript-eslint/restrict-template-expressions': ['error', {allowNumber: true}],
      '@typescript-eslint/consistent-type-imports': ['error', {fixStyle: 'inline-type-imports'}],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      'eqeqeq': ['error', 'smart'],
      'no-console': ['error', {allow: ['warn', 'error']}],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat['recommended-latest'],
    languageOptions: {globals: globals.browser},
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}', 'src/test/*.ts'], // tests are not UI; src/test/lint-fixtures is
    plugins: {tokens},
    rules: {
      'tokens/tokens-only': 'error',
      'tokens/no-literal-style': 'error',
      'tokens/no-restyle': 'error',
    },
  },
  {
    // Features compose the shared primitives; only src/ui talks to Radix.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/ui/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{group: ['radix-ui', '@radix-ui/*'], message: 'Use the primitives in src/ui (extend them with a variant if needed).'}],
      }],
    },
  },
  {
    files: ['*.ts', 'tools/**/*.ts', 'lint/**/*.ts', 'e2e/**/*.ts', 'conformance/**/*.ts'],
    languageOptions: {globals: globals.node},
    rules: {'no-console': 'off'},
  },
);
