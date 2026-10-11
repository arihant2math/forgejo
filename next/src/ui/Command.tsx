// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The command palette's parts (cmdk inside a Radix dialog). cmdk only does
// the keyboard and selection here: callers filter and rank themselves
// (shouldFilter is off), so the list renders only what is shown.
// CommandPopover is a picker (CommandPick, its own listbox) in a popover
// under a button: every picker that chooses from more than a handful of
// values (a branch, a label, a person) filters as you type and takes the
// first match on Enter.

import {Command as K} from 'cmdk';
import {Dialog as D} from 'radix-ui';
import {type KeyboardEvent, type ReactElement, type ReactNode, type Ref, useId, useLayoutEffect, useRef, useState} from 'react';
import {cx} from './cx.ts';
import {Icon, type LucideIcon} from './Icon.tsx';
import {ItemBody} from './ItemBody.tsx';
import {Popover, PopoverContent, PopoverTrigger} from './Popover.tsx';
import {dialogPanel, iconSlot, menuRow, overlay, sectionLabel} from './recipes.ts';
import {useReturnFocus} from './returnFocus.ts';
import {CheckIcon, DashIcon, SearchIcon} from '@primer/octicons-react';

export interface CommandDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name of the dialog and the list. */
  label: string;
  /** The children render their own CommandRoot (a caller that controls the selection). */
  bare?: boolean | undefined;
  /** Whether closing gives the focus back to what had it (false after a command that navigated). */
  restoreFocus?: (() => boolean) | undefined;
  children: ReactNode;
}

/**
 * A modal command menu near the top of the viewport. Esc and the overlay close it.
 *
 * Modal to the user (aria-modal, the overlay takes the pointer, Tab stays in it: its only tab stop is the input) but
 * not to Radix: a Radix modal sets `pointer-events: none` on the body (inherited: every element's style is
 * recomputed) and hides the page's other elements from assistive technology one by one, which made opening ⌘K a
 * 60–70 ms task at 4× CPU (QA verify3); the palette is opened by a key and must open within a frame or two.
 */
export function CommandDialog({open, onOpenChange, label, bare = false, restoreFocus, children}: CommandDialogProps) {
  const focus = useReturnFocus(restoreFocus);
  return (
    <D.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <D.Portal>
        <div className={overlay} data-state={open ? 'open' : 'closed'}>
          <D.Content {...focus} aria-describedby={undefined} aria-modal className={cx(dialogPanel, 'max-w-md overflow-hidden')}
            onKeyDown={(e) => {
              // Tab never leaves the menu (nothing behind it is reachable while it is open).
              if (e.key === 'Tab') e.preventDefault();
            }}>
            <D.Title className="sr-only">{label}</D.Title>
            {bare ? children : <K label={label} shouldFilter={false} loop vimBindings={false}>{children}</K>}
          </D.Content>
        </div>
      </D.Portal>
    </D.Root>
  );
}

/**
 * The command list's root inside a `bare` CommandDialog, with the selection controlled: `value` is the
 * selected item's value (the caller picks the first one whenever the results change).
 */
export function CommandRoot({label, value, onValueChange, children, manualSelection = false}: {label: string; value: string; onValueChange: (v: string) => void; children: ReactNode; manualSelection?: boolean}) {
  // No vim bindings: Ctrl+K is the palette's own key (it must close and reopen it, never move the selection).
  const interacting = useRef(false);
  const [reset, setReset] = useState(false);
  useLayoutEffect(() => {
    if (reset) queueMicrotask(() => { setReset(false); });
  }, [reset]);
  const interaction = () => {
    interacting.current = true;
    queueMicrotask(() => { interacting.current = false; });
  };
  return <K label={label} shouldFilter={false} loop vimBindings={false} value={manualSelection ? reset ? 'none:reset' : value || 'none' : value}
    onKeyDownCapture={(e) => {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(e.key)) interaction();
    }} onPointerMoveCapture={interaction} onClickCapture={interaction}
    onValueChange={(v) => {
      if (!manualSelection || interacting.current) onValueChange(v);
      // cmdk also selects the first item after an input change or item mount. Restore the caller's choice.
      else if (v !== value) setReset(true);
    }}>{children}</K>;
}

export interface CommandInputProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  ref?: Ref<HTMLInputElement>;
}

// The parts' looks, shared by the cmdk lists (the palette) and CommandPick's own listbox.
const inputRow = 'flex h-header items-center gap-2 border-b border-border px-3';
const inputField = 'h-full min-w-0 flex-1 bg-transparent text-md text-fg outline-none placeholder:text-fg-subtle';
const listBox = 'max-h-96 scroll-py-1 overflow-y-auto p-1';
const emptyBox = 'px-2 py-6 text-center text-base text-fg-muted';

function GroupHeading({children}: {children: ReactNode}) {
  return <span className={cx(sectionLabel, 'block px-2 pt-2 pb-1')}>{children}</span>;
}

export function CommandInput({value, onValueChange, placeholder, ref}: CommandInputProps) {
  return (
    <div className={inputRow}>
      <Icon icon={SearchIcon} className="text-fg-subtle"/>
      <K.Input ref={ref} value={value} onValueChange={onValueChange} placeholder={placeholder} className={inputField}/>
    </div>
  );
}

export function CommandList({children}: {children: ReactNode}) {
  return <K.List className={listBox}>{children}</K.List>;
}

export function CommandEmpty({children}: {children: ReactNode}) {
  return <K.Empty className={emptyBox}>{children}</K.Empty>;
}

export function CommandGroup({heading, children}: {heading: string; children: ReactNode}) {
  return (
    <K.Group heading={<GroupHeading>{heading}</GroupHeading>}>
      {children}
    </K.Group>
  );
}

export interface CommandItemProps {
  /** Unique and stable within the list (cmdk tracks the selection by it). */
  value: string;
  onSelect: () => void;
  icon?: LucideIcon | undefined;
  /** Instead of an icon (an avatar). */
  leading?: ReactNode;
  /** Muted text after the title (a repository name, a state). */
  meta?: ReactNode;
  shortcut?: string | undefined;
  /** A choice that is on (true), on for some (mixed) or off (false): a check slot and aria-checked. */
  checked?: boolean | 'mixed' | undefined;
  /** Listed but cannot run now (its meta says why): shown as disabled, still selectable so that Enter can say why. */
  muted?: boolean | undefined;
  children: ReactNode;
}

// cmdk writes data-selected / data-disabled as "true" or "false".
const item = cx(menuRow, 'text-fg data-muted:text-fg-subtle data-[selected=true]:bg-raised-hover data-[disabled=true]:pointer-events-none data-[disabled=true]:text-fg-subtle');
// CommandPick's options: the cursor is data-highlighted.
const pickItem = cx(menuRow, 'text-fg data-highlighted:bg-raised-hover');

export function CommandItem({value, onSelect, icon, leading, meta, shortcut, checked, muted, children}: CommandItemProps) {
  return (
    <K.Item value={value} onSelect={onSelect} className={item} aria-checked={checked} data-muted={muted ? true : undefined}>
      <ItemContent icon={icon} leading={leading} meta={meta} shortcut={shortcut} checked={checked}>{children}</ItemContent>
    </K.Item>
  );
}

/** A command row's inside: the check slot (a choice), then icon, label, detail and shortcut. */
function ItemContent({icon, leading, meta, shortcut, checked, children}: Omit<CommandItemProps, 'value' | 'onSelect' | 'muted'>) {
  return (
    <>
      {checked !== undefined && (
        <span className={iconSlot}>{checked && <Icon icon={checked === 'mixed' ? DashIcon : CheckIcon}/>}</span>
      )}
      <ItemBody icon={icon} leading={leading} meta={meta ?? ''} shortcut={shortcut}>{children}</ItemBody>
    </>
  );
}

/** One choice of a CommandPopover. */
export interface PickOption {
  /** Unique within the popover. */
  value: string;
  /** Shown, and matched by the query. */
  label: string;
  /** Matched by the query besides the label (a login, a description). */
  words?: string | undefined;
  /** The heading of its group; groups appear in the order of their first option. */
  group?: string | undefined;
  icon?: LucideIcon | undefined;
  leading?: ReactNode;
  meta?: ReactNode;
  /** On (true), on for some (mixed), off (false); undefined: an action, no check slot. */
  checked?: boolean | 'mixed' | undefined;
  /** Stays open after choosing (multi-value fields: labels). */
  keepOpen?: boolean | undefined;
  onSelect: () => void;
}

export interface CommandPopoverProps {
  /** The button that opens it (rendered as the trigger). */
  trigger: ReactElement;
  /** Accessible name of the list. */
  label: string;
  placeholder: string;
  options: readonly PickOption[];
  /** Said when there is nothing at all to choose from. */
  empty?: ReactNode;
  width?: 'sm' | 'md';
  onOpenChange?: ((open: boolean) => void) | undefined;
  /**
   * The list, rendered only while open (instead of `options`): a caller whose choices are costly to compute or
   * change while it is open (an observer) renders its own CommandPick.
   */
  render?: ((onClose: () => void) => ReactNode) | undefined;
}

/** The options matching every word of the query (in the label or the extra words). */
export function matchOptions(options: readonly PickOption[], query: string): readonly PickOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return options;
  return options.filter((o) => {
    const text = `${o.label} ${o.words ?? ''}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** A filterable list of choices under a button (Linear's pickers): type to narrow, Enter takes the first match. */
export function CommandPopover({trigger, label, placeholder, options, empty = 'No choices here.', width = 'sm', onOpenChange, render}: CommandPopoverProps) {
  const [open, setOpen] = useState(false);
  const onClose = () => {
    setOpen(false);
    onOpenChange?.(false);
  };
  return (
    <Popover open={open} onOpenChange={(o) => {
      setOpen(o);
      onOpenChange?.(o);
    }}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent width={width}>
        {render ? render(onClose) : <CommandPick label={label} placeholder={placeholder} options={options} empty={empty} onClose={onClose}/>}
      </PopoverContent>
    </Popover>
  );
}

export interface CommandPickProps {
  label: string;
  placeholder: string;
  options: readonly PickOption[];
  empty: ReactNode;
  onClose: () => void;
  /** What the choice applies to, above the field (a picker opened by a key: "#12 Fix the login"). */
  target?: ReactNode;
  /** The query, when the caller searches itself (`filtered`: the options are the query's matches already). */
  query?: string | undefined;
  onQueryChange?: ((query: string) => void) | undefined;
  filtered?: boolean | undefined;
}

/**
 * The list of a picker (in a CommandPopover, or a CommandDialog's `bare` content): type to narrow, Enter takes the
 * first match; it opens on the current choice, so Enter right away keeps it.
 *
 * Its own listbox, not cmdk's (QA #179): cmdk marks the keyboard cursor `aria-selected` (and finds its cursor by
 * that attribute), so a screen reader heard the highlighted row as selected and could not tell which labels or
 * reviewers were applied. Here the applied options are `aria-selected` (the listbox is multi-selectable when the
 * choices stay open for more), and the cursor is only the combobox's `aria-activedescendant` and `data-highlighted`
 * (`data-selected` too: cmdk's name for it, kept for its callers). The keys are cmdk's: ↑/↓ (looping), Home/End,
 * ⌘↑/⌘↓ (first, last), Alt+↑/↓ (the previous or next group), Enter.
 */
export function CommandPick({label, placeholder, options, empty, onClose, target, query: outer, onQueryChange, filtered}: CommandPickProps) {
  const [own, setOwn] = useState('');
  const query = outer ?? own;
  const setQuery = (q: string) => {
    setOwn(q);
    onQueryChange?.(q);
  };
  const shown = filtered ? options : matchOptions(options, query);
  const first = shown[0]?.value ?? '';
  // Opens on the current choice; the first match is selected whenever the query changes (Enter takes it).
  // The current value of a one-value field (status, priority, milestone); a multi-value field (labels) opens on its first
  // option, never on one that Enter would take away.
  const [selected, setSelected] = useState(() => options.find((o) => o.checked === true && !o.keepOpen)?.value ?? first);
  const [seen, setSeen] = useState(query);
  if (seen !== query) {
    setSeen(query);
    setSelected(first);
  }
  const groups = new Map<string, PickOption[]>();
  for (const o of shown) {
    const g = groups.get(o.group ?? '');
    if (g) g.push(o);
    else groups.set(o.group ?? '', [o]);
  }
  // The rows in the order they are shown (by group), which the keys follow.
  const rows = [...groups.values()].flat();
  // The cursor stays on its option while that is listed, else it goes to the first one (as cmdk's did).
  const cursor = rows.some((o) => o.value === selected) ? selected : rows[0]?.value ?? '';
  const at = rows.findIndex((o) => o.value === cursor);
  const id = useId();
  const optionId = (i: number) => `${id}o${String(i)}`;
  // The cursor's row in view (and its group's heading, for a group's first row), on opening and as it moves.
  const scrolled = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (scrolled.current === cursor) return;
    scrolled.current = cursor;
    const el = at < 0 ? null : document.getElementById(optionId(at));
    if (!el) return;
    const group = el.parentElement;
    const heading = group?.firstElementChild === el ? group.getAttribute('aria-labelledby') : null;
    if (heading) document.getElementById(heading)?.scrollIntoView?.({block: 'nearest'});
    el.scrollIntoView?.({block: 'nearest'});
  });
  // A choice that stays open (labels, assignees) makes the list one of several choices.
  const multi = shown.some((o) => o.keepOpen && o.checked !== undefined);
  const choose = (o: PickOption) => {
    setSelected(o.value);
    o.onSelect();
    if (!o.keepOpen) onClose();
  };
  const go = (i: number) => {
    const o = rows[i];
    if (o) setSelected(o.value);
  };
  // Where each group's rows start in `rows` (Alt+↑/↓).
  const groupStarts: number[] = [];
  let start = 0;
  for (const os of groups.values()) {
    groupStarts.push(start);
    start += os.length;
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.nativeEvent.isComposing || !rows.length) return;
    const last = rows.length - 1;
    const step = (d: 1 | -1) => {
      if (e.metaKey) {
        go(d > 0 ? last : 0);
        return;
      }
      if (e.altKey) {
        // The first row of the next (previous) group; without one, a plain step.
        const g = groupStarts.findLastIndex((s) => s <= Math.max(at, 0));
        const next = groupStarts[g + d];
        if (next !== undefined) {
          go(next);
          return;
        }
      }
      go(at < 0 ? (d > 0 ? 0 : last) : (at + d + rows.length) % rows.length);
    };
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        step(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        step(-1);
        break;
      case 'Home':
        e.preventDefault();
        go(0);
        break;
      case 'End':
        e.preventDefault();
        go(last);
        break;
      case 'Enter': {
        e.preventDefault();
        const o = rows[at];
        if (o) choose(o);
        break;
      }
    }
  };
  let n = 0;
  const row = (o: PickOption) => {
    const i = n++;
    return <PickRow key={o.value} option={o} id={optionId(i)} highlighted={i === at} onPoint={() => {
      if (o.value !== cursor) setSelected(o.value);
    }} onChoose={() => {
      choose(o);
    }}/>;
  };
  return (
    <div tabIndex={-1} onKeyDown={onKeyDown} className="outline-none">
      <label htmlFor={`${id}input`} id={`${id}label`} className="sr-only">{label}</label>
      {target && <p className="truncate px-3 pt-2 text-sm text-fg-muted">{target}</p>}
      <div className={inputRow}>
        <Icon icon={SearchIcon} className="text-fg-subtle"/>
        <input id={`${id}input`} type="text" role="combobox" aria-expanded aria-controls={`${id}list`} aria-labelledby={`${id}label`}
          aria-autocomplete="list" aria-activedescendant={at < 0 ? undefined : optionId(at)} autoComplete="off" autoCorrect="off" spellCheck={false}
          value={query} placeholder={placeholder} className={inputField} onChange={(e) => {
            setQuery(e.target.value);
          }}/>
      </div>
      <div id={`${id}list`} role="listbox" aria-label={label} aria-multiselectable={multi || undefined} tabIndex={-1} className={listBox}>
        {!shown.length && <div role="presentation" className={emptyBox}>{options.length ? 'Nothing matches.' : empty}</div>}
        {[...groups].map(([g, os], gi) => (g ?
          <div key={`g:${g}`} role="presentation">
            <div aria-hidden id={`${id}g${String(gi)}`}><GroupHeading>{g}</GroupHeading></div>
            <div role="group" aria-labelledby={`${id}g${String(gi)}`}>{os.map(row)}</div>
          </div> :
          os.map(row)))}
      </div>
    </div>
  );
}

/**
 * One option of a CommandPick: applied (checked) is `aria-selected` (some of several issues: not selected, said as
 * "on some"); the keyboard cursor is `data-highlighted` only. The pointer moves the cursor; a press keeps the focus
 * in the field.
 */
function PickRow({option: o, id, highlighted, onPoint, onChoose}: {
  option: PickOption; id: string; highlighted: boolean; onPoint: () => void; onChoose: () => void;
}) {
  // An action (no check slot: "Add 2 selected issues", "Clear all filters") is not a choice that can be on.
  return (
    <div id={id} role="option" aria-selected={o.checked === undefined ? undefined : o.checked === true}
      data-highlighted={highlighted ? '' : undefined} data-selected={highlighted ? 'true' : undefined} className={pickItem}
      onPointerMove={onPoint} onMouseDown={(e) => {
        e.preventDefault();
      }} onClick={onChoose}>
      <ItemContent icon={o.icon} leading={o.leading} meta={o.meta} checked={o.checked}>
        {o.label}{o.checked === 'mixed' && <span className="sr-only"> (on some)</span>}
      </ItemContent>
    </div>
  );
}
