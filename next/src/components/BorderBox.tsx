// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// GitHub's Box: a bordered panel whose muted header names it; rows inside separate with muted borders.
import type {ReactNode, Ref} from 'react';
import {Text} from '@primer/react';
import {clsx} from 'clsx';

export interface BoxHeaderProps {
  /** Rendered as the box's heading; omit it to lay out `children` freely. */
  title?: ReactNode;
  headingLevel?: 2 | 3 | undefined;
  actions?: ReactNode;
  /** The highlighted tone of a linked comment. */
  accent?: boolean | undefined;
  children?: ReactNode;
}

/** One height with or without small buttons: vertical padding plus a small button fits the minimum. */
export function BoxHeader({title, headingLevel = 2, actions, accent = false, children}: BoxHeaderProps) {
  return (
    <header className={clsx('flex min-h-10 flex-wrap items-center gap-2 rounded-t-md border-b px-4 py-1', accent ? 'border-accent-emphasis bg-accent-muted' : 'border-default bg-muted')}>
      {title !== undefined && (
        <Text as={headingLevel === 3 ? 'h3' : 'h2'} size="medium" weight="semibold" className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">{title}</span>
        </Text>
      )}
      {children}
      {actions && <div className="ms-auto flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export interface BorderBoxProps extends Omit<BoxHeaderProps, 'accent' | 'children'> {
  /** The region's accessible name. */
  label?: string | undefined;
  /** Header content that is not a heading (a ref and its last commit); used when `title` is absent. */
  header?: ReactNode;
  padded?: boolean | undefined;
  as?: 'section' | 'article' | undefined;
  id?: string | undefined;
  ref?: Ref<HTMLElement> | undefined;
  children: ReactNode;
}

export function BorderBox({label, title, headingLevel, actions, header, padded = false, as: Tag = 'section', id, ref, children}: BorderBoxProps) {
  const hasHeader = title !== undefined || header !== undefined || actions !== undefined;
  return (
    <Tag ref={ref} id={id} aria-label={label} className="min-w-0 overflow-hidden rounded-md border border-default bg-default">
      {hasHeader && <BoxHeader title={title} headingLevel={headingLevel} actions={actions}>{title === undefined && header !== undefined && <div className="flex min-w-0 flex-1 items-center gap-2">{header}</div>}</BoxHeader>}
      {padded ? <div className="min-w-0 p-4">{children}</div> : children}
    </Tag>
  );
}
