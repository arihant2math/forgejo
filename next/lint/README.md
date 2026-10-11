# Linting Next

`pnpm run lint:js` runs Oxlint's native type-aware checks (via tsgolint), then syntax-only ESLint. ESLint keeps the strict/stylistic **untyped** TypeScript presets, React Hooks rules, token/UI rules, restricted imports and Trusted Types guards. `lint.test.ts` still exercises the real ESLint and Stylelint configs.

Oxlint deliberately enables only the promise and unsafe-value rules listed in `.oxlintrc.json`; the rest of typescript-eslint's type-aware strict/stylistic presets are no longer enforced. `tsgo` remains the type checker. `lint/tsconfig.json` covers both application and tooling/test files so tsgolint sees their types.

The unsafe-value checks are disabled only for `tools/budget.ts`: tsgolint currently reports an error type for its `Array.toSorted` chain, while tsgo and the previous ESLint type checker accept it. Remove that override when the native analyzer handles it correctly.

Vitest keeps isolation enabled. `unit` runs pure tests in Node; `unit-dom` runs JSX and browser-dependent tests in jsdom with the existing setup. Add browser-dependent `.test.ts` files to `domTests` in `vitest.config.ts`. `pnpm test` runs both projects.
