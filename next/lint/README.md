# Linting Forgejo Next

| Command (in `next/`) | Runs |
|---|---|
| `pnpm run lint` | `lint:js` then `lint:css` |
| `pnpm run lint:js` | Oxlint, type-aware through `oxlint-tsgolint` (`lint/tsconfig.json`), `--deny-warnings`, unused disable directives reported. Config: `.oxlintrc.json` |
| `pnpm run lint:css` | Stylelint on `src/**/*.css` (not the lint fixtures). Config: `stylelint.config.ts` |
| `pnpm run typecheck` | `tsgo` on `tsconfig.json` and `tsconfig.node.json` (separate from lint) |

`lint/lint.test.ts` (part of `pnpm test`) unit-tests the class checks and runs the real Stylelint config on
`src/test/lint-fixtures/`.

## Local rules

Oxlint loads the ESLint-style plugins in this directory (`jsPlugins`). They apply to `src/**` except tests and
`src/test/**`.

| Rule | Plugin | Rejects |
|---|---|---|
| `tokens/tokens-only` | `eslint-plugin-tokens.ts` | Raw colour strings anywhere (`'#fff'`, `'rgb(…)'`). In class contexts (`className`, `cx(…)`/`clsx(…)`, following same-file consts, `table[key]` and `.map` parameters): arbitrary values and properties, arbitrary variants other than `data-[…]`/`aria-[…]`, `dark:`, `*:`/`**:`, `transition*`/`ease-*`, bare numbers that bypass a token (`z-10`, `opacity-50`, `border-2`, …), spacing off the 4 px scale (`spacingSteps`), colour `/` modifiers, filters, gradients, rings and shadows other than `shadow-popover`/`shadow-dialog` |
| `tokens/no-literal-style` | `eslint-plugin-tokens.ts` | Literal values in `style={{…}}`: `style` is only for computed values (positions, CSS variables) |
| `tokens/no-restyle` | `eslint-plugin-tokens.ts` | On components imported from `@primer/react` (and `/experimental`, `/next`): `className` other than layout (margins, sizes, flex/grid placement, position, `hidden`, `sr-only`, `truncate`), size classes the component owns through its size prop, non-literal `className`, `style`, and spreads that are not object literals or that carry `className`/`style` (a `renderAnchor` callback may spread its own parameter: Primer's anchor props carry neither; the allowance goes by the name `renderAnchor` only, whatever the parameter's type, so type it `AnchorProps` from `LocalSelectPanel.tsx`) |
| `trusted-types/no-html-sinks` | `plugin-trusted-types.ts` | `new DOMParser`, `innerHTML`/`outerHTML` assignment, `insertAdjacentHTML`, `createContextualFragment` outside `src/app/trusted.ts` |

Classes that do not exist in the theme are caught by `src/styles/classes.test.ts`, not by lint.

## Stylelint

`stylelint-config-standard`, plus:

* `scale-unlimited/declaration-strict-value`: colours, fonts, line height, letter spacing, z-index, borders,
  outlines, shadows, opacity, animation, durations, margin, padding, gap, inset, widths/heights (except `%` and
  viewport units), filters and text decoration must use tokens (`var(--…)`). Shorthands are expanded. Off in
  `src/styles/tokens.css`, the one place raw values live.
* `color-no-hex`, `color-named: never`.
* `transition`, `transition-property` and friends are banned outside `src/styles/app.css` (home of the `interactive`
  utility); there they may only name opacity, transform and colour properties with `var()` durations (so
  `transition: all` and `transition: .2s` fail).
* `motion/keyframes-transform-opacity` (`stylelint-plugin-motion.ts`): `@keyframes` may animate only transform and
  opacity.
* Tailwind at-rules (`@theme`, `@source`, `@utility`, `@custom-variant`, …) are allowed.
