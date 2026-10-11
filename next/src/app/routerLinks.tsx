// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Primer's link-looking components made router-aware (TanStack Router's createLink): they take `to`/`params`/
// `search` like <Link>, navigate in place, and keep a real href (middle-click, copy link).

import {Link as PrimerLink, LinkButton as PrimerLinkButton} from '@primer/react';
import {createLink} from '@tanstack/react-router';

/** Primer's LinkButton (a link that looks like a button) for an app route. */
export const RouterLinkButton = createLink(PrimerLinkButton);

/** Primer's Link for an app route. */
export const RouterLink = createLink(PrimerLink);
