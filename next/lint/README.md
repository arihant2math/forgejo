# Linting Next

`pnpm run lint:js` is Oxlint only (with type-aware rules through tsgolint), configured in `.oxlintrc.json`. The custom rules run as Oxlint JS plugins: `eslint-plugin-tokens.ts` (tokens-only, no-literal-style, no-restyle) and `plugin-trusted-types.ts` (no HTML sinks outside `app/trusted.ts`). `tsgo` is the type checker. Stylelint lints the CSS.

`pnpm run check:cheap` runs lint, typecheck and build. `pnpm run check` runs it and then the tests and the budget.
