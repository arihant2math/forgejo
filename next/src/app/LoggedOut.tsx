// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {LogIn} from 'lucide-react';
import {Button, EmptyState} from '../ui/index.ts';

/**
 * The logged-out screen. The boot shell renders it too, so the first frame
 * and React's first commit are identical. The sign-in flow arrives with F3.
 */
export function LoggedOut() {
  return <EmptyState icon={LogIn} title="Forgejo" description="Sign in to continue." action={<Button variant="primary" disabled>Sign in</Button>}/>;
}
