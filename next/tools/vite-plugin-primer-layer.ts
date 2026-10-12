// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// @primer/react ships one unlayered stylesheet per component, imported by the component's module. Unlayered
// CSS beats every cascade layer, so a Tailwind layout utility on a Primer component (mt-2, w-full, min-w-0)
// would lose to the component's own rules. This wraps each of those stylesheets in the `primer` layer, which
// app.css orders between the element defaults (base) and the utilities.

import type {Plugin} from 'vite';

const primerCss = /[\\/]node_modules[\\/]@primer[\\/]react[\\/].*\.css(?:\?.*)?$/;

export function primerLayer(): Plugin {
  return {
    name: 'forgejo-next:primer-layer',
    enforce: 'pre',
    transform(code, id) {
      if (!primerCss.test(id) || id.includes('?raw') || code.startsWith('@layer primer')) return null;
      // @import and @charset must stay first; the stylesheets have neither (checked: build fails loudly on @import).
      if (/@import\b/.test(code)) this.error(`${id}: @import in a Primer stylesheet; cannot wrap it in a layer`);
      return {code: `@layer primer {\n${code.replace(/\/\*# sourceMappingURL=.*?\*\/\s*$/, '')}\n}\n`, map: null};
    },
  };
}
