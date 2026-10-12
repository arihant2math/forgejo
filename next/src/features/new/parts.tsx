// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {cloneElement, useEffect, useState, type ReactNode} from 'react';
import {online, RequestFailed} from '../../app/api.ts';
import {ClassicLink} from '../../app/ClassicLink.tsx';
import type {App} from '../../app/store.ts';
import {settleWrite} from '../../sync/data.ts';
import {FilteredSelect} from '../create/FilteredSelect.tsx';
import {CheckIcon, ChevronDownIcon} from '@primer/octicons-react';
import type {Icon as OcticonType} from '@primer/octicons-react';
import {Banner, Button, FormControl, Heading, Radio, RadioGroup, type ButtonProps} from '@primer/react';

export const hintOf = (id: string) => `${id}-hint`;

export function Field({id, label, required, optional, hint, error, children}: {
  id: string; label: string; required?: boolean; optional?: boolean; hint?: ReactNode; error?: string | undefined; children: ReactNode;
}) {
  return (
    <FormControl id={id} required={Boolean(required)} className="min-w-0">
      <FormControl.Label>{label}{optional ? ' (optional)' : ''}</FormControl.Label>
      {children}
      {error ? <FormControl.Validation id={hintOf(id)} variant="error">{error}</FormControl.Validation> :
        hint && <FormControl.Caption id={hintOf(id)}>{hint}</FormControl.Caption>}
    </FormControl>
  );
}

export function Section({title, description, children}: {title?: string; description?: ReactNode; children: ReactNode}) {
  return (
    <section className="flex min-w-0 flex-col gap-4 border-t border-muted pt-4">
      {title && (
        <div className="flex flex-col gap-1">
          <Heading as="h2" variant="small">{title}</Heading>
          {description && <p className="text-sm text-muted">{description}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

export interface ChoiceOption<V extends string> {
  value: V;
  label: string;
  description: string;
  icon: OcticonType;
  /** Why it cannot be chosen (forced private), or undefined. */
  disabled?: string | undefined;
}

export function Choice<V extends string>({name, label, value, options, onChange, hideLabel = false}: {
  name: string; label: string; value: V; options: readonly ChoiceOption<V>[]; onChange: (v: V) => void; hideLabel?: boolean;
}) {
  return (
    <RadioGroup name={name} onChange={(selected) => { if (selected) onChange(selected as V); }}>
      <RadioGroup.Label visuallyHidden={hideLabel}>{label}</RadioGroup.Label>
      {options.map((o) => <FormControl key={o.value} disabled={Boolean(o.disabled)}>
        <Radio value={o.value} checked={value === o.value}/>
        <FormControl.LeadingVisual><span className="flex items-center justify-center"><o.icon size={16}/></span></FormControl.LeadingVisual>
        <FormControl.Label>{o.label}</FormControl.Label>
        <FormControl.Caption>{o.disabled ?? o.description}</FormControl.Caption>
      </FormControl>)}
    </RadioGroup>
  );
}

export function NamePicker({id, label, placeholder, names, chosen, onChange, multi = false, empty, none = 'None'}: {
  id: string; label: string; placeholder: string; names: readonly string[]; chosen: readonly string[]; onChange: (names: string[]) => void;
  multi?: boolean; empty: string; none?: string;
}) {
  const shown = chosen.length > 2 ? `${chosen.slice(0, 2).join(', ')} +${String(chosen.length - 2)}` : chosen.join(', ');
  const items = [{id: '\u0000none', text: none}, ...names.map((n) => ({id: n, text: n}))];
  const selected = items.filter((item) => chosen.length ? chosen.includes(item.id) : item.id === '\u0000none');
  const update = (ids: (string | number | undefined)[]) => {
    onChange(ids.includes('\u0000none') && chosen.length ? [] : ids.filter((id) => id !== '\u0000none').map(String));
  };
  const common = {
    id, title: label, placeholderText: placeholder, items,
    message: {title: empty, body: '', variant: 'empty' as const},
    renderAnchor: (props: ButtonProps) => cloneElement(<Button type="button" id={id} aria-describedby={hintOf(id)} trailingVisual={ChevronDownIcon}>{shown || none}</Button>, props),
  };
  return multi ? <FilteredSelect {...common} selected={selected} onSelectedChange={(next) => { update(next.map((item) => item.id)); }}/> :
    <FilteredSelect {...common} selected={selected[0]} onSelectedChange={(next) => { if (next) update([next.id]); }}/>;
}

export type Availability = 'unknown' | 'checking' | 'free' | 'taken';

/** Debounced online check: 404 means free; local=true means taken without a request. */
export function useAvailability(app: App, path: string | undefined, local: boolean, isOnline: boolean): Availability {
  const [answer, setAnswer] = useState<{path: string; a: Availability} | undefined>(undefined);
  useEffect(() => {
    if (!path || local || !isOnline) return undefined;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      setAnswer({path, a: 'checking'});
      online(app, {api: 'v1', path, signal: ctl.signal, timeout: 8000}).then(() => {
        setAnswer({path, a: 'taken'});
      }, (err: unknown) => {
        if (ctl.signal.aborted) return;
        setAnswer({path, a: err instanceof RequestFailed && err.status === 404 ? 'free' : 'unknown'});
      });
    }, 300);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [app, path, local, isOnline]);
  if (local) return 'taken';
  return answer && answer.path === path ? answer.a : 'unknown';
}

export function NameStatus({availability, free, idle}: {availability: Availability; free: string; idle: string}) {
  if (availability === 'free') return <span className="flex items-center gap-1 text-success"><CheckIcon size={12} className="shrink-0"/>{free}</span>;
  if (availability === 'checking') return <span className="text-muted">Checking the name…</span>;
  return <span>{idle}</span>;
}

/** Browser tokens lack account/organization write scopes to prevent adding SSH keys or hooks if stolen. */
export function ScopeNote({scope, what, classic}: {scope: string; what: string; classic: string}) {
  return (
    <Banner variant="warning" title={`Forgejo Next cannot create ${what} yet`} primaryAction={<ClassicLink to={classic} size="small" variant="default">Use the classic form</ClassicLink>}
      description={<>Forgejo asks for the <code>{scope}</code> scope for this, and Forgejo Next’s sign-in does not have it: its token gets no write access to
      your account or organizations, so that one taken from the browser could not add SSH keys or organization hooks.</>}/>
  );
}

/**
 * Wait for the write delta so navigation paints from the pool; on timeout the page loads from API v1.
 * Hold the group until go settles so the destination can take over its subscription.
 */
export async function openWhenSynced(app: App, group: string, v: number | undefined, go: () => Promise<unknown>): Promise<void> {
  const data = app.session?.data;
  if (!data) return;
  data.hold(group);
  try {
    await settleWrite(data, group, v);
    await go();
  } finally {
    data.release(group);
  }
}
