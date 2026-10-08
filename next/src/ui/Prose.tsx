// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {MouseEventHandler, Ref} from 'react';

/**
 * The container of rendered markdown (server HTML: issue bodies, comments).
 * Its typography is styles/prose.css. The content is put in by the caller
 * through the Trusted Types policy (app/trusted.ts), never by React.
 */
export function Prose({ref, onClick}: {ref: Ref<HTMLDivElement>; onClick?: MouseEventHandler<HTMLDivElement>}) {
  return <div ref={ref} onClick={onClick} className="prose min-w-0 text-md text-fg"/>;
}
