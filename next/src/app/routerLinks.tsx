// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Link as PrimerLink, LinkButton as PrimerLinkButton, NavList} from '@primer/react';
import {createLink} from '@tanstack/react-router';

export const RouterLinkButton = createLink(PrimerLinkButton);

export const RouterLink = createLink(PrimerLink);

export const RouterNavItem = createLink(NavList.Item);
