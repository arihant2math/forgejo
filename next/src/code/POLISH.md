# Code-surfaces polish report

## Result and security limitation

Both Pierre worker factories now use `appWorkerURL` from the app's existing `forgejo-next` Trusted Types policy, with deployment-base-relative Vite worker URLs. The parser's construction failure also stays inside the existing safe fallback instead of escaping to the route error boundary.

Screenshot iteration uncovered two additional failures beyond the requested worker URL bug:

1. Importing Pierre's worker for side effects from `src/workers/diffs.worker.ts` produced a **zero-byte worker**: the package only declares its web-components module side-effectful. The highlighter now imports the library worker directly as a Vite `?worker&url` bundle entry. The unused wrapper was removed.
2. Once initialized, Pierre 1.5.2 fails under the SPA's CSP on its **TrustedHTML** sinks (`ensureSpriteSVG`, code columns, headers). It exposes no TrustedHTML factory option. `pierreSupport.ts` therefore selects the existing text-node file/review renderer in Trusted Types browsers, without weakening CSP, adding a default policy, changing the app policy, or patching DOM prototypes. Pierre remains available in non-Trusted-Types browsers; its theme and `unsafeCSS` now map typography, functional colours, word backgrounds and radii to Primer.

**The TrustedScriptURL bug is fixed and the pages render, but using Pierre itself under enforced Trusted Types remains an upstream integration limitation.** The safe renderer keeps existing keyboard navigation, line/range links, comments, collapsing, viewed state and offline flows. Its syntax colouring remains the existing worker's token palette. Pierre's revised CSS could not be visually verified in the enforced-Trusted-Types screenshot browser.

## Iteration

All nine assigned screenshots were taken and inspected at full size in rounds 1, 2, 3, final, final2 and final3. Round 1 exposed empty diffs/worker initialization timeout; round 2 exposed the subsequent TrustedHTML failure; round 3 restored safe rendering; later rounds fixed hunk toolbar height, dark-theme text overlap and continuous blame-cell backgrounds. Final2 light shots were affected by a concurrent scratch sign-in; final3 recaptured all pages cleanly. No source changes were made to resolve another area's temporary build failure.

**Final screenshot directory:** `/home/ubuntu/qa/shots-code-final3/` — 9 screenshots, **0 failed, 0 warnings**.

| Page / screenshot in that directory | Changed | Still off / intentionally retained |
| --- | --- | --- |
| `07-file-go.png` | 28px toolbar controls, default-coloured breadcrumb links, proper file-actions IconButton, 40px muted metadata bar; 14px code with 20px fixed lines and aligned gutters. | The separate Edit row still consumes space; retained its location as requested. Pierre limitation above. |
| `08-file-markdown.png` | Same header craft; small Preview/Markup segmented control aligned with metadata. README panel headers also use the shared 40px muted-header idiom. | Shared rendered markdown body remains 16px with larger headings; its styles are outside this ownership. |
| `09-blame.png` | 14px primary blame text, muted 12px dates, default-coloured commit links, 16px history icon, continuous muted blame background and centred cells. | Commit summaries truncate heavily in the existing 240px column; column width/layout deliberately unchanged. |
| `11-commit.png` | Working diff; 40px semibold file header, 14px changed-file links/code, 32px centred hunk bars accommodating small controls, consistent diff statistics. | Commit/check metadata and clickable check names above the diff remain small; `History.tsx`/`commitChecks.tsx` are outside ownership. |
| `24-pr-files.png` | Working review diff, aligned collapse/file-action headers, same file/code/hunk craft, Primer line-comment actions and consistent thread-slot spacing. | The review toolbar's primary “All changes” text is still small; toolbar and comment-card internals are owned by pull/issue features. |
| `44-compare.png` | Working diff; same changed-file links, file headers, code sizing and hunk controls as commit/PR pages. | Branch references still have their existing accent-tinted treatment in `Compare.tsx`/`RefMenu.tsx`, outside ownership. |
| `dark-07-file-go.png` | Same source/header craft with functional dark-theme surfaces and syntax tokens. | Same separate Edit row and Pierre limitation as light file view. |
| `dark-24-pr-files.png` | Same review craft; opaque muted hunk action region prevents underlying long hunk text bleeding through in dark mode. | Same small review-toolbar text and shared card internals as light PR. |
| `phone-24-pr-files.png` | Working horizontally scrollable diff, pinned 40px headers, small actions, readable code and non-overlapping hunk controls. | Shared page header lays breadcrumbs beside a heavily wrapped title at 390px; filenames truncate and long code scrolls horizontally as before. Header layout is outside ownership. |

Additional live review-thread inspection (through runq) successfully jumped to `contrib/nushell/fzf.nu`, showed both posted threads and Reply/Resolve controls, and produced **no page errors**. Screenshot: `/home/ubuntu/qa/shots-code-final2/24-pr-files-threads.png`. Shared comment bodies remain 16px; card/avatar sizing belongs to the issue/pull area.

## Changed files

- `src/code/{FileSurface.tsx,PierreProvider.tsx,ReviewSurface.tsx,parts.tsx}`
- New `src/code/{pierreWorker.ts,pierreSupport.ts}`
- `src/features/code/{Src.tsx,DiffView.tsx,DiffSettings.tsx,tree.tsx,Rendered.tsx,ImageDiff.tsx}`
- Removed unused `src/workers/diffs.worker.ts`
- Tests: new `src/code/{pierreWorker.test.ts,parts.test.tsx}`; updated `src/code/ReviewSurface.test.tsx` and `src/features/code/sizes.test.ts`

No legacy `src/ui` or OptionalTooltip imports remain in owned paths. No unowned source files edited, dependencies added, or commits made. FilesPanel/README/file/diff headers now share the app's `bg-muted`, `px-4 py-2`, 40px header rhythm rather than an independent custom look.

Test changes cover TrustedScriptURL objects (including non-root deployment base), safe review fallback under Trusted Types, fixed line/hunk/header geometry, metadata typography, and preserved line-action tab stops. The virtualizer's file-header estimate was updated from 40px total to 48px (40px header + 8px inter-file gap); hunk rows are 32px so 28px controls no longer overlap code.

## Validation

- `check-mine` for all owned prefixes/files and `sizes.test.ts`: **lint + typecheck clean**.
- `/home/ubuntu/qa/runq -C /home/ubuntu/primer/next pnpm exec vitest run src/code src/workers src/features/code/Src.test.ts src/features/code/codeBrowse.test.tsx src/features/code/ImageDiff.test.ts src/features/code/sizes.test.ts`: **24 test files passed; 100 tests passed**. Only existing jsdom `Window.scrollTo` notices.
- `/home/ubuntu/qa/check-cheap /home/ubuntu/primer/next`: **exit 0**, lint, CSS lint, typecheck and build passed. Build emitted advisory large-chunk/plugin-timing warnings.
- Final shoot: **9 screenshots, 0 failures, 0 warnings**.

## Requests outside ownership

- Pierre needs a scoped TrustedHTML factory/hook covering its SVG sprite, file/diff headers and generated code-column HTML before the Trusted Types compatibility gate can be removed. Do not add a default policy or weaken the SPA's CSP.
- Shell/pull owners: review the 390px PR title/breadcrumb arrangement and the small primary text in the review toolbar.
- Issue/pull owners: consider consistent 14px body type for shared rendered markdown/comment cards if required by the global polish pass.
- Code-history owner: primary clickable check names on the commit page still appear metadata-sized.
