// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// motion/keyframes-transform-opacity: @keyframes may only animate transform and
// opacity (PLAN §5.6), the same rule the transition allowlist applies.

import stylelint from 'stylelint';

const ruleName = 'motion/keyframes-transform-opacity';
const messages = stylelint.utils.ruleMessages(ruleName, {
  rejected: (prop: string) => `"${prop}" in @keyframes: animate only transform and opacity`,
});
const allowed = new Set(['opacity', 'transform', 'translate', 'scale', 'rotate', 'animation-timing-function']);

const rule: stylelint.Rule = (enabled) => (root, result) => {
  if (!enabled) return;
  root.walkAtRules(/^keyframes$/i, (atRule) => {
    atRule.walkDecls((decl) => {
      if (allowed.has(decl.prop.toLowerCase())) return;
      stylelint.utils.report({ruleName, result, node: decl, message: messages.rejected(decl.prop)});
    });
  });
};
rule.ruleName = ruleName;
rule.messages = messages;

export default stylelint.createPlugin(ruleName, rule);
