// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Lazy-loaded CodeMirror editor; caller state owns the document.

import {autocompletion, type CompletionContext, type CompletionResult, completionKeymap} from '@codemirror/autocomplete';

import {defaultKeymap, history, historyKeymap} from '@codemirror/commands';
import {syntaxHighlighting} from '@codemirror/language';
import {Compartment, EditorState, Transaction} from '@codemirror/state';
import {Decoration, EditorView, keymap, MatchDecorator, placeholder as cmPlaceholder, ViewPlugin, type ViewUpdate, WidgetType} from '@codemirror/view';
import {classHighlighter} from '@lezer/highlight';
import {continueList, markdown} from './markdown.ts';
import {type Ref, useEffect, useImperativeHandle, useRef, useState} from 'react';
import {type EditMaker, type Format, formatEdit} from './format.ts';

const theme = EditorView.theme({
  '&': {color: 'var(--fgColor-default)', backgroundColor: 'transparent', borderRadius: 'var(--radius-md)'},
  '&.cm-focused': {outline: 'none'},
  '.cm-scroller': {fontFamily: 'inherit', fontSize: 'var(--text-base)', lineHeight: 'var(--text-base--line-height)', overflow: 'auto'},
  '.cm-content': {padding: 'calc(var(--spacing) * 3) calc(var(--spacing) * 4)', caretColor: 'var(--fgColor-default)'},
  '.cm-line': {padding: '0'},
  '.cm-cursor, .cm-dropCursor': {borderLeftColor: 'var(--fgColor-default)'},
  '.cm-placeholder': {color: 'var(--fgColor-muted)'},
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {backgroundColor: 'var(--bgColor-accent-muted)'},
  '.tok-heading': {fontWeight: 'var(--font-weight-semibold)'},
  '.tok-strong': {fontWeight: 'var(--font-weight-semibold)'},
  '.tok-emphasis': {fontStyle: 'italic'},
  '.tok-link, .tok-url': {color: 'var(--fgColor-accent)'},
  '.tok-monospace, .tok-literal': {fontFamily: 'var(--font-mono)'},
  '.tok-meta, .tok-punctuation, .tok-processingInstruction': {color: 'var(--fgColor-muted)'},
  '.tok-strikethrough': {textDecoration: 'line-through'},
  '.tok-quote, .tok-comment': {color: 'var(--fgColor-muted)'},
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--overlay-bgColor)', border: '1px solid var(--borderColor-default)', borderRadius: 'var(--radius-md)',
    boxShadow: 'var(--shadow-popover)', padding: 'var(--spacing)', zIndex: 'var(--z-popover)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {fontFamily: 'inherit', fontSize: 'var(--text-base)', maxHeight: 'calc(var(--spacing-row) * 8)'},
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    display: 'flex', alignItems: 'center', gap: 'calc(var(--spacing) * 2)', height: 'var(--spacing-control)',
    padding: '0 calc(var(--spacing) * 2)', borderRadius: 'var(--radius-md)', color: 'var(--fgColor-default)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {backgroundColor: 'var(--control-transparent-bgColor-hover)', color: 'var(--fgColor-default)'},
  '.cm-completionDetail': {color: 'var(--fgColor-muted)', fontStyle: 'normal', marginLeft: '0', overflow: 'hidden', textOverflow: 'ellipsis'},
  '.cm-completionIcon': {display: 'none'},
});

class UploadChip extends WidgetType {
  readonly name: string;
  constructor(name: string) { super(); this.name = name; }
  override eq(other: UploadChip) { return other.name === this.name; }
  toDOM() {
    const chip = document.createElement('span');
    chip.className = 'inline-flex text-sm text-muted';
    chip.textContent = `Uploading ${this.name}`;
    return chip;
  }
}

const uploadMatcher = new MatchDecorator({
  regexp: /<!-- uploading-attachment:[^\s]+ (.*?) -->/g,
  decoration: (match) => Decoration.replace({widget: new UploadChip(match[1] ?? 'file…')}),
});
const uploadChips = ViewPlugin.fromClass(class {
  decorations;
  constructor(view: EditorView) { this.decorations = uploadMatcher.createDeco(view); }
  update(update: ViewUpdate) { this.decorations = uploadMatcher.updateDeco(update, this.decorations); }
}, {decorations: (plugin) => plugin.decorations});

export interface Suggestion {
  /** Inserted after the trigger. */
  label: string;
  /** Shown muted after it (a name, a title). */
  detail?: string | undefined;
}

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
  insert(text: string, position?: number): void;
  replace(placeholder: string, text: string): void;
  /** Applies an edit of the selection (a toolbar button), as one change. */
  edit(make: EditMaker): void;
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
  onFiles?: ((files: File[], position?: number) => void) | undefined;
  complete?: ((trigger: '@' | '#', query: string) => Suggestion[]) | undefined;
  ref?: Ref<MarkdownEditorHandle>;
}

export default function MarkdownEditor({value, onChange, label, placeholder, describedBy, invalid, autoFocus, rows = 4, onSubmit, onCancel, complete, onFiles, ref}: MarkdownEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  // The latest callbacks, read by the editor's handlers (created once).
  const cb = useRef({onChange, onSubmit, onCancel, complete, onFiles});
  useEffect(() => {
    cb.current = {onChange, onSubmit, onCancel, complete, onFiles};
  });
  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    insert: (text, position) => {
      const v = view.current;
      if (!v) return;
      const {from, to} = v.state.selection.main;
      const at = position ?? from;
      v.dispatch({changes: {from: at, to: position === undefined ? to : at, insert: text}, selection: {anchor: at + text.length}});
      v.focus();
    },
    replace: (placeholder, text) => {
      const v = view.current;
      if (!v) return;
      const from = v.state.doc.toString().indexOf(placeholder);
      if (from >= 0) v.dispatch({changes: {from, to: from + placeholder.length, insert: text}, annotations: Transaction.addToHistory.of(false)});
    },
    edit: (make) => {
      if (view.current) {
        applyEdit(view.current, make);
        view.current.focus();
      }
    },
  }), []);
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
        selection: {anchor: value.length},
        extensions: [
          history(),
          uploadChips,
          EditorView.domEventHandlers({
            paste: (event) => {
              const files = [...(event.clipboardData?.files ?? [])];
              if (!files.length || !cb.current.onFiles) return false;
              event.preventDefault();
              event.stopPropagation();
              cb.current.onFiles(files);
              return true;
            },
            dragover: (event) => {
              if (event.dataTransfer?.types.includes('Files') && cb.current.onFiles) event.preventDefault();
            },
            drop: (event, v) => {
              const files = [...(event.dataTransfer?.files ?? [])];
              if (!files.length || !cb.current.onFiles) return false;
              event.preventDefault();
              event.stopPropagation();
              cb.current.onFiles(files, v.posAtCoords({x: event.clientX, y: event.clientY}) ?? undefined);
              return true;
            },
          }),
          autocompletion({override: [suggestions((t, q) => cb.current.complete?.(t, q) ?? [])], icons: false, activateOnTyping: true}),
          // Completion keys must win over submit/cancel while suggestions are open.
          keymap.of(completionKeymap),
          keymap.of([
            {key: 'Mod-Enter', run: () => {
              cb.current.onSubmit?.();
              return Boolean(cb.current.onSubmit);
            }},
            {key: 'Escape', run: (v) => {
              if (cb.current.onCancel) cb.current.onCancel();
              else v.contentDOM.blur();
              return true;
            }},
            // Mod-K belongs to the global command menu, including while writing.
            {key: 'Mod-b', run: (v) => applyFormat(v, 'bold')},
            {key: 'Mod-i', run: (v) => applyFormat(v, 'italic')},
            {key: 'Mod-e', run: (v) => applyFormat(v, 'code')},
            // Leave Tab unbound to avoid trapping keyboard focus.
            {key: 'Enter', run: continueList},
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.lineWrapping,
          markdown,
          syntaxHighlighting(classHighlighter),
          theme,
          EditorView.theme({'.cm-content': {minHeight: `calc(var(--text-base) * var(--text-base--line-height) * ${String(rows)} + var(--spacing) * 6)`}}),
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
    // Construct once; callback refs and effects handle mutable props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({effects: attrs.reconfigure(contentAttrs())});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label, describedBy, invalid, attrs]);

  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === value) return;
    v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: value}, selection: {anchor: value.length}});
  }, [value]);

  return <div ref={host}/>;
}

function applyFormat(v: EditorView, kind: Format): boolean {
  return applyEdit(v, (doc, from, to) => formatEdit(doc, from, to, kind));
}

/** Apply selection edits as one undo step. */
function applyEdit(v: EditorView, make: EditMaker): boolean {
  const {from, to} = v.state.selection.main;
  const e = make(v.state.doc.toString(), from, to);
  v.dispatch({changes: {from: e.from, to: e.to, insert: e.insert}, selection: {anchor: e.anchor, head: e.head}, userEvent: 'input.format'});
  return true;
}
