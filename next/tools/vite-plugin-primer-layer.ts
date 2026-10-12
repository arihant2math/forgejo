// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Unlayered Primer CSS beats all Tailwind utilities; wrap it between base and utilities.

import type {Plugin} from 'vite';

const primerCss = /[\\/]node_modules[\\/]@primer[\\/]react[\\/].*\.css(?:\?.*)?$/;

export function primerLayer(): Plugin {
  return {
    name: 'forgejo-next:primer-layer',
    enforce: 'pre',
    transform(code, id) {
      if (!primerCss.test(id) || id.includes('?raw') || code.startsWith('@layer primer')) return null;
      // @import and @charset must precede layers; reject @import rather than silently misordering it.
      if (/@import\b/.test(code)) this.error(`${id}: @import in a Primer stylesheet; cannot wrap it in a layer`);
      return {code: `@layer primer {\n${code.replace(/\/\*# sourceMappingURL=.*?\*\/\s*$/, '')}\n}\n`, map: null};
    },
  };
}
