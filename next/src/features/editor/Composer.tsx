// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A markdown field with Write and Preview (descriptions, comments, new
// issues). Write is the CodeMirror editor (its own chunk; a plain text area
// stands in for the moment it takes to load, with the same text, so nothing
// typed is lost). Preview is Forgejo's own rendering of the text — exactly
// the HTML the issue will show (B9: the materializer's renderer) — fetched
// online through the batch endpoint (previews asked for together share one
// request), put in through the Trusted Types gate and scrubbed (Markdown).
// Offline, the preview says so and shows the source.

import {observer} from 'mobx-react-lite';
import {type KeyboardEvent, type ReactNode, useEffect, useRef, useState} from 'react';
import {online, RequestFailed} from '../../app/api.ts';
import {connectivity} from '../../app/online.ts';
import {shortcutHint, type ShortcutId, useShortcut} from '../../app/shortcuts/index.ts';
import {type App, useApp} from '../../app/store.ts';
import type {APIMarkdownRequest, APIMarkdownResponse} from '../../protocol/types.gen.ts';
import {Button, ProseSource, SkeletonText, TextArea} from '../../ui/index.ts';
import {Markdown} from '../issue/Markdown.tsx';
import type {MarkdownEditorHandle, MarkdownEditorProps} from './MarkdownEditor.tsx';

type Editor = (props: MarkdownEditorProps) => ReactNode;
let Loaded: Editor | undefined;
let loading: Promise<void> | undefined;

/** Starts loading the editor's chunk (a page with a composer calls it when idle). */
export function preloadEditor(): Promise<void> {
  loading ??= import('./MarkdownEditor.tsx').then((m) => {
    Loaded = m.default;
  }, (err: unknown) => {
    loading = undefined;
    throw err;
  });
  return loading;
}

// ── Batched previews (B9: up to 64 items per request) ─────────────────────

const MAX_ITEMS = 64;
const cache = new Map<string, string>();
interface Waiting {
  text: string;
  resolve: (html: string) => void;
  reject: (err: unknown) => void;
}
const queues = new Map<number, Waiting[]>();

function cacheKey(repoId: number, text: string): string {
  return `${String(repoId)}\0${text}`;
}

/** The server's rendering of `text` (in a repository's context when repoId > 0); batched with other previews of the same moment. */
export function renderPreview(app: App, repoId: number, text: string): Promise<string> {
  const hit = cache.get(cacheKey(repoId, text));
  if (hit !== undefined) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    let q = queues.get(repoId);
    if (!q) {
      queues.set(repoId, q = []);
      // One task: everything asked for meanwhile goes in the same request.
      setTimeout(() => {
        void flush(app, repoId);
      }, 0);
    }
    q.push({text, resolve, reject});
  });
}

async function flush(app: App, repoId: number): Promise<void> {
  const q = queues.get(repoId) ?? [];
  queues.delete(repoId);
  for (let i = 0; i < q.length; i += MAX_ITEMS) {
    const part = q.slice(i, i + MAX_ITEMS);
    const body: APIMarkdownRequest = {...(repoId > 0 ? {repo_id: repoId} : {}), items: part.map((w) => w.text)};
    try {
      const res = await online<APIMarkdownResponse>(app, {method: 'POST', api: 'sync', path: '/markdown', body});
      part.forEach((w, k) => {
        const html = res?.html[k] ?? '';
        if (cache.size > 200) cache.clear();
        cache.set(cacheKey(repoId, w.text), html);
        w.resolve(html);
      });
    } catch (err) {
      for (const w of part) w.reject(err);
    }
  }
}

// ── The field ─────────────────────────────────────────────────────────────

export interface MarkdownFieldProps extends Omit<MarkdownEditorProps, 'ref'> {
  /** The repository the text belongs to (references and links in the preview resolve there); 0 for none. */
  repoId: number;
  /** A shortcut that puts the caret here (R: comment). */
  focusShortcut?: ShortcutId | undefined;
}

/** Binds a shortcut to focusing a field while mounted. */
function FocusOn({id, focus}: {id: ShortcutId; focus: () => void}) {
  useShortcut(id, focus);
  return null;
}

export const MarkdownField = observer(function MarkdownField({repoId, focusShortcut, ...props}: MarkdownFieldProps) {
  const [preview, setPreview] = useState(false);
  const [ready, setReady] = useState(Boolean(Loaded));
  const editor = useRef<MarkdownEditorHandle>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ready) return;
    void preloadEditor().then(() => {
      setReady(true);
    }, () => undefined);
  }, [ready]);
  // The text area stood in and had the focus: the editor takes it over.
  const hadFocus = useRef(false);
  useEffect(() => {
    if (ready && hadFocus.current) editor.current?.focus();
  }, [ready]);
  const toggle = () => {
    setPreview((p) => !p);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() === 'p' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      toggle();
      // Back in Write: the caret where it was; in Preview the preview keeps the focus (and these keys) so they toggle back.
      requestAnimationFrame(() => {
        if (preview) editor.current?.focus();
        else previewRef.current?.focus();
      });
    }
  };
  const hint = shortcutHint('editor.preview');
  const Editor = Loaded;
  return (
    <div className="flex flex-col gap-1.5" onKeyDown={onKeyDown}>
      {focusShortcut && <FocusOn id={focusShortcut} focus={() => {
        setPreview(false);
        requestAnimationFrame(() => {
          if (editor.current) editor.current.focus();
          else area.current?.focus();
        });
      }}/>}
      <div className="flex items-center gap-1" role="group" aria-label="Editor mode">
        <Button size="sm" pressed={!preview} shortcut={hint} tooltip="Write" onClick={() => {
          setPreview(false);
          requestAnimationFrame(() => editor.current?.focus());
        }}>Write</Button>
        <Button size="sm" pressed={preview} shortcut={hint} tooltip="Preview as Forgejo renders it" onClick={() => {
          setPreview(true);
        }}>Preview</Button>
      </div>
      {preview ?
        <div ref={previewRef} tabIndex={-1} aria-label={`${props.label} preview`} role="region"><Preview repoId={repoId} text={props.value}/></div> :
        Editor ?
          <Editor {...props} ref={editor} autoFocus={props.autoFocus === true || hadFocus.current}/> :
          <TextArea ref={area} aria-label={props.label} aria-describedby={props.describedBy} placeholder={props.placeholder ?? props.label}
            value={props.value} rows={props.rows ?? 4} autoFocus={props.autoFocus} invalid={props.invalid}
            onFocus={() => {
              hadFocus.current = true;
            }}
            onChange={(e) => {
              props.onChange(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                props.onSubmit?.();
              } else if (e.key === 'Escape' && props.onCancel) {
                e.preventDefault();
                props.onCancel();
              }
            }}/>}
    </div>
  );
});

const Preview = observer(function Preview({repoId, text}: {repoId: number; text: string}) {
  const app = useApp();
  const [state, setState] = useState<{text: string; html?: string; error?: string}>({text: ''});
  const offline = !connectivity.online;
  useEffect(() => {
    if (!text.trim() || offline) return undefined;
    let live = true;
    renderPreview(app, repoId, text).then((html) => {
      if (live) setState({text, html});
    }, (err: unknown) => {
      if (live) setState({text, error: err instanceof RequestFailed ? err.message : 'The preview could not be rendered.'});
    });
    return () => {
      live = false;
    };
  }, [app, repoId, text, offline]);
  if (!text.trim()) return <p className="min-h-16 px-2 py-1.5 text-base text-fg-subtle">Nothing to preview.</p>;
  if (offline) {
    return (
      <div className="flex flex-col gap-2 px-2 py-1.5">
        <p className="text-sm text-fg-subtle">The preview needs a connection (Forgejo renders it). Your text as written:</p>
        <ProseSource text={text}/>
      </div>
    );
  }
  if (state.text !== text) {
    return <div className="flex flex-col gap-2 px-2 py-1.5" aria-busy><SkeletonText lines={2}/></div>;
  }
  if (state.error !== undefined) return <p role="alert" className="px-2 py-1.5 text-sm text-danger">{state.error}</p>;
  return <div className="min-h-16 px-2 py-1.5"><Markdown html={state.html ?? ''}/></div>;
});
