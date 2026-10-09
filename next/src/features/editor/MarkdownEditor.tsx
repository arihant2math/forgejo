// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The markdown editor (PLAN §5.1: CodeMirror 6, markdown fidelity over
// WYSIWYG). Its own chunk: loaded when a composer is about to show, never
// on the boot route. Markdown is parsed with @lezer/markdown (GFM) and
// highlighted with lezer's class highlighter (`tok-*` classes); every look
// comes from the design tokens (the theme below names variables only).
// The frame (border, focus outline) is the EditorFrame primitive.
//
// The text is the caller's state: typing reports it (onChange), and a new
// `value` from the caller (cleared after a save, a restored draft) replaces
// the document. ⌘↵ submits, Esc cancels. "@" suggests people and "#"
// issues (the caller's `complete`: Enter or Tab takes one, Esc closes the
// list first).

import {autocompletion, type CompletionContext, type CompletionResult, completionKeymap} from '@codemirror/autocomplete';

import {defaultKeymap, history, historyKeymap} from '@codemirror/commands';
import {defineLanguageFacet, Language, LanguageSupport, syntaxHighlighting} from '@codemirror/language';
import {Compartment, EditorState} from '@codemirror/state';
import {EditorView, keymap, placeholder as cmPlaceholder} from '@codemirror/view';
import {classHighlighter} from '@lezer/highlight';
import {GFM, parser} from '@lezer/markdown';
import {type Ref, useEffect, useImperativeHandle, useRef, useState} from 'react';
import {EditorFrame} from '../../ui/index.ts';

const markdown = new LanguageSupport(new Language(defineLanguageFacet(), parser.configure([GFM]), [], 'markdown'));

/** Tokens only (tokens.css): the frame draws the box; the editor draws text, caret and selection. */
const theme = EditorView.theme({
  '&': {color: 'var(--color-fg)', backgroundColor: 'transparent', borderRadius: 'var(--radius-md)'},
  '&.cm-focused': {outline: 'none'},
  '.cm-scroller': {fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', lineHeight: 'var(--text-md--line-height)', overflow: 'auto'},
  '.cm-content': {padding: 'calc(var(--spacing) * 1.5) calc(var(--spacing) * 2)', caretColor: 'var(--color-fg)'},
  '.cm-line': {padding: '0'},
  '.cm-cursor, .cm-dropCursor': {borderLeftColor: 'var(--color-fg)'},
  '.cm-placeholder': {color: 'var(--color-fg-subtle)'},
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {backgroundColor: 'var(--color-accent-subtle)'},
  '.tok-heading': {fontWeight: 'var(--font-weight-semibold)'},
  '.tok-strong': {fontWeight: 'var(--font-weight-semibold)'},
  '.tok-emphasis': {fontStyle: 'italic'},
  '.tok-link, .tok-url': {color: 'var(--color-accent-fg)'},
  '.tok-monospace, .tok-literal': {fontFamily: 'var(--font-mono)'},
  '.tok-meta, .tok-punctuation, .tok-processingInstruction': {color: 'var(--color-fg-subtle)'},
  '.tok-strikethrough': {textDecoration: 'line-through'},
  '.tok-quote, .tok-comment': {color: 'var(--color-fg-muted)'},
  // The suggestions: a menu's look (floating surface, menu rows) from the tokens.
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--color-raised)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)',
    boxShadow: 'var(--shadow-popover)', padding: 'var(--spacing)', zIndex: 'var(--z-popover)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)', maxHeight: 'calc(var(--spacing-row) * 8)'},
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    display: 'flex', alignItems: 'center', gap: 'calc(var(--spacing) * 2)', height: 'var(--spacing-control)',
    padding: '0 calc(var(--spacing) * 2)', borderRadius: 'var(--radius-sm)', color: 'var(--color-fg)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {backgroundColor: 'var(--color-raised-hover)', color: 'var(--color-fg)'},
  '.cm-completionDetail': {color: 'var(--color-fg-subtle)', fontStyle: 'normal', marginLeft: '0', overflow: 'hidden', textOverflow: 'ellipsis'},
  '.cm-completionIcon': {display: 'none'},
});

/** A suggestion for "@" (a person: login) or "#" (an issue: its number). */
export interface Suggestion {
  /** Inserted after the trigger. */
  label: string;
  /** Shown muted after it (a name, a title). */
  detail?: string | undefined;
}

/** "@login" and "#12" at a word boundary: the caller's suggestions for what follows the trigger. */
function suggestions(complete: (trigger: '@' | '#', query: string) => Suggestion[]) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/(?:^|[\s([{])[@#][\w.-]*$/);
    if (!m) return null;
    const at = m.text.search(/[@#]/);
    const trigger = m.text[at] as '@' | '#';
    const from = m.from + at + 1;
    const query = ctx.state.sliceDoc(from, ctx.pos);
    const options = complete(trigger, query).map((o) => ({label: o.label, ...(o.detail ? {detail: o.detail} : {}), type: trigger === '@' ? 'user' : 'issue'}));
    return options.length ? {from, options, validFor: /^[\w.-]*$/, filter: false} : null;
  };
}

export interface MarkdownEditorHandle {
  focus(): void;
}

export interface MarkdownEditorProps {
  value: string;
  onChange: (text: string) => void;
  /** The accessible name (and the placeholder). */
  label: string;
  placeholder?: string | undefined;
  describedBy?: string | undefined;
  invalid?: boolean | undefined;
  autoFocus?: boolean | undefined;
  /** The minimum height in lines (it grows with the text). */
  rows?: number | undefined;
  onSubmit?: (() => void) | undefined;
  onCancel?: (() => void) | undefined;
  /** Suggestions after "@" (people) and "#" (issues). */
  complete?: ((trigger: '@' | '#', query: string) => Suggestion[]) | undefined;
  ref?: Ref<MarkdownEditorHandle>;
}

export default function MarkdownEditor({value, onChange, label, placeholder, describedBy, invalid, autoFocus, rows = 4, onSubmit, onCancel, complete, ref}: MarkdownEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  // The latest callbacks, read by the editor's handlers (created once).
  const cb = useRef({onChange, onSubmit, onCancel, complete});
  useEffect(() => {
    cb.current = {onChange, onSubmit, onCancel, complete};
  });
  useImperativeHandle(ref, () => ({focus: () => view.current?.focus()}), []);
  const [attrs] = useState(() => new Compartment());
  const contentAttrs = () => EditorView.contentAttributes.of({
    'aria-label': label,
    'aria-multiline': 'true',
    ...(describedBy ? {'aria-describedby': describedBy} : {}),
    ...(invalid ? {'aria-invalid': 'true'} : {}),
  });

  useEffect(() => {
    const parent = host.current;
    if (!parent) return undefined;
    const v = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          autocompletion({override: [suggestions((t, q) => cb.current.complete?.(t, q) ?? [])], icons: false, activateOnTyping: true}),
          // Before the editor's own keys: with the list open, Enter and Esc are the list's.
          keymap.of(completionKeymap),
          keymap.of([
            {key: 'Mod-Enter', run: () => {
              cb.current.onSubmit?.();
              return Boolean(cb.current.onSubmit);
            }},
            {key: 'Escape', run: () => {
              cb.current.onCancel?.();
              return Boolean(cb.current.onCancel);
            }},
            // Tab moves the focus on (as in a text area: no keyboard trap); lists indent with ⌘] / ⌘[ (defaultKeymap).
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.lineWrapping,
          markdown,
          syntaxHighlighting(classHighlighter),
          theme,
          EditorView.theme({'.cm-content': {minHeight: `calc(var(--text-md--line-height) * ${String(rows)} + var(--spacing) * 3)`}}),
          ...(placeholder ?? label ? [cmPlaceholder(placeholder ?? label)] : []),
          attrs.of(contentAttrs()),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    if (autoFocus) v.focus();
    return () => {
      v.destroy();
      view.current = undefined;
    };
    // Created once; value changes are applied below, the rest is fixed for the editor's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The accessible name, description and validity follow the props.
  useEffect(() => {
    view.current?.dispatch({effects: attrs.reconfigure(contentAttrs())});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label, describedBy, invalid, attrs]);

  // A value from the caller that is not what the editor holds (cleared, restored): replaces the text.
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === value) return;
    v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: value}, selection: {anchor: value.length}});
  }, [value]);

  return (
    <EditorFrame invalid={invalid}>
      <div ref={host}/>
    </EditorFrame>
  );
}
