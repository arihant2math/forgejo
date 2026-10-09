// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {MouseEventHandler, Ref} from 'react';

/**
 * The container of rendered markdown (server HTML: issue bodies, comments).
 * Its typography is styles/prose.css. The content is put in by the caller
 * through the Trusted Types policy (app/trusted.ts), never by React.
 */
export function Prose({ref, onClick}: {ref: Ref<HTMLDivElement>; onClick?: MouseEventHandler<HTMLDivElement>}) {
  return <div ref={ref} onClick={onClick} className={prose}/>;
}

const prose = 'prose min-w-0 text-md text-fg';

/**
 * Markdown source not rendered yet (an edit made offline: the server renders
 * it once it has it), shown as typed, in the same typography.
 */
export function ProseSource({text}: {text: string}) {
  return <div className={`${prose} whitespace-pre-wrap`}>{text}</div>;
}
