// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The parts the new repository and organization forms share: a labelled
// field with its hint or error, a choice among a few described options
// (visibility), a picker for long lists (.gitignore templates, licenses),
// the live "is this name free" check, and going to what was created once
// the pool holds it.
//
// (Local to these forms: a settings Field/Select/Switch set for src/ui is
// under review separately; these move there once it lands.)

import {Check, ChevronDown, CircleAlert} from 'lucide-react';
import {useEffect, useState, type ReactNode} from 'react';
import {online, RequestFailed} from '../../app/api.ts';
import {ClassicLink} from '../../app/ClassicLink.tsx';
import type {App} from '../../app/store.ts';
import {Button, Callout, Code, CommandPick, CommandPopover, Icon, type LucideIcon, matchOptions, type PickOption} from '../../ui/index.ts';

/** The id of a field's hint or error (its control's aria-describedby). */
export const hintOf = (id: string) => `${id}-hint`;

/** A labelled control, with its hint — or its error in place of the hint. */
export function Field({id, label, required, optional, hint, error, children}: {
  id: string; label: string; required?: boolean; optional?: boolean; hint?: ReactNode; error?: string | undefined; children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-base font-medium text-fg">
        {label}{required && <span className="text-danger" aria-hidden> *</span>}
        {optional && <span className="font-normal text-fg-subtle"> (optional)</span>}
      </label>
      {children}
      {error ?
        <p id={hintOf(id)} role="alert" className="flex items-center gap-1 text-sm text-danger"><Icon icon={CircleAlert} size="sm"/>{error}</p> :
        hint && <div id={hintOf(id)} className="text-sm text-fg-muted">{hint}</div>}
    </div>
  );
}

/** A part of the form under a hairline, with its heading. */
export function Section({title, description, children}: {title?: string; description?: ReactNode; children: ReactNode}) {
  return (
    <section className="flex min-w-0 flex-col gap-3 border-t border-border-subtle pt-4">
      {title && (
        <div className="flex flex-col gap-0.5">
          <h2 className="text-md font-semibold text-fg">{title}</h2>
          {description && <p className="text-sm text-fg-muted">{description}</p>}
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
  icon: LucideIcon;
  /** Why it cannot be chosen (forced private), or undefined. */
  disabled?: string | undefined;
}

/** One of a few described options (GitHub's visibility radios): a radio group, arrow keys move. */
export function Choice<V extends string>({name, label, value, options, onChange}: {
  name: string; label: string; value: V; options: readonly ChoiceOption<V>[]; onChange: (v: V) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-2">
      {options.map((o) => (
        <label key={o.value} className="flex items-start gap-3 has-disabled:opacity-disabled">
          <input type="radio" name={name} value={o.value} checked={value === o.value} disabled={Boolean(o.disabled)} className="mt-0.5 size-4 accent-accent"
            aria-describedby={`${name}-${o.value}-hint`}
            onChange={() => {
              onChange(o.value);
            }}/>
          <Icon icon={o.icon} className="mt-0.5 text-fg-muted"/>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-base font-medium text-fg">{o.label}</span>
            <span id={`${name}-${o.value}-hint`} className="text-sm text-fg-muted">{o.disabled ?? o.description}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** How many matches a long picker lists (type to narrow: there are hundreds of licenses). */
const LONG_LIST = 80;

/**
 * A choice from a long list of names, under a button that shows it ("None" first). `multi`: several (the
 * .gitignore templates Forgejo concatenates).
 */
export function NamePicker({id, label, placeholder, names, chosen, onChange, multi = false, empty, none = 'None'}: {
  id: string; label: string; placeholder: string; names: readonly string[]; chosen: readonly string[]; onChange: (names: string[]) => void;
  multi?: boolean; empty: string; none?: string;
}) {
  const shown = chosen.length > 2 ? `${chosen.slice(0, 2).join(', ')} +${String(chosen.length - 2)}` : chosen.join(', ');
  return (
    <CommandPopover label={label} placeholder={placeholder} width="md"
      render={(onClose) => <LongPick label={label} placeholder={placeholder} names={names} chosen={chosen} multi={multi} empty={empty} none={none} onChange={onChange} onClose={onClose}/>}
      options={[]}
      trigger={<Button id={id} variant="secondary" aria-describedby={hintOf(id)}>{shown || none}<Icon icon={ChevronDown} size="sm"/></Button>}/>
  );
}

function LongPick({label, placeholder, names, chosen, multi, empty, none, onChange, onClose}: {
  label: string; placeholder: string; names: readonly string[]; chosen: readonly string[]; multi: boolean; empty: string; none: string;
  onChange: (names: string[]) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const options: PickOption[] = [
    {value: '\u0000none', label: none, checked: chosen.length === 0, onSelect: () => {
      onChange([]);
    }},
    ...names.map((n) => ({value: n, label: n, checked: chosen.includes(n), keepOpen: multi, onSelect: () => {
      onChange(multi ? (chosen.includes(n) ? chosen.filter((c) => c !== n) : [...chosen, n]) : [n]);
    }})),
  ];
  const matches = matchOptions(options, query);
  // The chosen ones stay listed (to take them away), then the first matches.
  const shown = [...matches.filter((o) => o.checked === true), ...matches.filter((o) => o.checked !== true).slice(0, LONG_LIST)];
  return <CommandPick label={label} placeholder={placeholder} options={shown} empty={empty} onClose={onClose} query={query} onQueryChange={setQuery} filtered/>;
}

export type Availability = 'unknown' | 'checking' | 'free' | 'taken';

/**
 * Whether a name is free, as Forgejo answers GET `path` (404: free; found: taken) — asked a moment after the
 * typing stops, online only. `local`: taken on this device already (no request).
 */
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

/** The line under a name: free (a check), checking, or `idle` advice; taken and invalid names are errors (Field). */
export function NameStatus({availability, free, idle}: {availability: Availability; free: string; idle: string}) {
  if (availability === 'free') return <span className="flex items-center gap-1 text-success"><Icon icon={Check} size="sm"/>{free}</span>;
  if (availability === 'checking') return <span className="text-fg-subtle">Checking the name…</span>;
  return <span>{idle}</span>;
}

/**
 * The UI's sign-in lacks the scope API v1 wants for this creation (PLAN §4.9: the browser's token gets no write
 * access to the account or organizations, so a stolen one cannot add SSH keys or organization hooks): said before
 * anything is typed, with the classic form, which takes the same choices.
 */
export function ScopeNote({scope, what, classic}: {scope: string; what: string; classic: string}) {
  return (
    <Callout tone="warning" title={`Forgejo Next cannot create ${what} yet`} actions={<ClassicLink to={classic} size="sm" variant="secondary">Use the classic form</ClassicLink>}>
      Forgejo asks for the <Code>{scope}</Code> scope for this, and Forgejo Next’s sign-in does not have it: its token gets no write access to
      your account or organizations, so that one taken from the browser could not add SSH keys or organization hooks.
    </Callout>
  );
}

/** How long a created thing's page waits for its sync delta before it opens anyway (it then loads from API v1). */
const SYNC_WAIT_MS = 5000;

/**
 * Holds the new entity's group and waits (at most SYNC_WAIT_MS) until the pool holds Forgejo's write `v` there,
 * so its page paints from the pool at once; then runs `go`. The group is let go once `go` settled (the page
 * holds it itself by then).
 */
export async function openWhenSynced(app: App, group: string, v: number | undefined, go: () => Promise<unknown>): Promise<void> {
  const data = app.session?.data;
  if (!data) return;
  data.hold(group);
  try {
    if (v !== undefined && v > 0) {
      const signal = AbortSignal.timeout(SYNC_WAIT_MS);
      await Promise.race([
        data.whenSynced(group, v, signal).catch(() => undefined),
        new Promise((resolve) => {
          signal.addEventListener('abort', resolve);
        }),
      ]);
    }
    await go();
  } finally {
    data.release(group);
  }
}
