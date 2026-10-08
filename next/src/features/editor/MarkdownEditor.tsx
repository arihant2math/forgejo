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
// the document. ⌘↵ submits, Esc cancels.

import {defaultKeymap, history, historyKeymap, indentLess, insertTab} from '@codemirror/commands';
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
});

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
  ref?: Ref<MarkdownEditorHandle>;
}

export default function MarkdownEditor({value, onChange, label, placeholder, describedBy, invalid, autoFocus, rows = 4, onSubmit, onCancel, ref}: MarkdownEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  // The latest callbacks, read by the editor's handlers (created once).
  const cb = useRef({onChange, onSubmit, onCancel});
  useEffect(() => {
    cb.current = {onChange, onSubmit, onCancel};
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
          keymap.of([
            {key: 'Mod-Enter', run: () => {
              cb.current.onSubmit?.();
              return Boolean(cb.current.onSubmit);
            }},
            {key: 'Escape', run: () => {
              cb.current.onCancel?.();
              return Boolean(cb.current.onCancel);
            }},
            // Tab indents (lists); Esc then Tab leaves the editor (CodeMirror's tab-focus escape).
            {key: 'Tab', run: insertTab, shift: indentLess},
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
