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
import {type KeyboardEvent, type ReactNode, useEffect, useEffectEvent, useRef, useState} from 'react';
import {failureText, online, RequestFailed} from '../../app/api.ts';
import {connectivity, onlineOnly, reach} from '../../app/online.ts';
import {canWrite} from '../../app/access.ts';
import {notify} from '../../app/notices.ts';
import {uuid} from '../../intents/intents.ts';
import {attachmentMarkdown, hasPendingUploads, replaceUpload, stripUploadPlaceholders, uploadPlaceholder} from './attachments.ts';
import {formatKeys, type ShortcutId, useShortcut} from '../../app/shortcuts/index.ts';
import {type App, useApp} from '../../app/store.ts';
import type {APIAttachmentPermission, APIMarkdownRequest, APIMarkdownResponse, APIUploadedAttachment} from '../../protocol/types.gen.ts';
import {whenIdle} from '../../app/lazy.tsx';
import {Bold, Code2, Italic, Link2, Paperclip} from 'lucide-react';
import {Button, EditorFrame, IconButton, type LucideIcon, PendingIcon, ProseSource, SegmentedControl, SkeletonText, TextArea} from '../../ui/index.ts';
import type {EditMaker, Format} from './format.ts';
import {Markdown} from '../issue/Markdown.tsx';
import type {MarkdownEditorHandle, MarkdownEditorProps, Suggestion} from './MarkdownEditor.tsx';
import {untracked} from 'mobx';
import {loadPeople, repoPeople} from '../issues/people.ts';

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
  attachmentIssueId?: number | undefined;
  /** Wiki and release notes use different asset lifecycles. */
  attachments?: boolean | undefined;
  insertion?: {text: string} | undefined;
  /** A shortcut that puts the caret here (R: comment). */
  focusShortcut?: ShortcutId | undefined;
  /** How Preview renders the text (default: as an issue's text in the repository; a wiki page renders as one). */
  render?: ((text: string) => Promise<string>) | undefined;
  /** More toolbar buttons after the formatting ones (a review comment's suggestion, …). */
  tools?: readonly EditorTool[] | undefined;
}

/** A toolbar button of a field: an edit of the selection (applied as one change, like the formatting buttons). */
export interface EditorTool {
  id: string;
  icon: LucideIcon;
  label: string;
  edit: EditMaker;
}

/** Suggestions per trigger at most. */
const SUGGESTIONS = 8;

/**
 * What "@" and "#" suggest in a repository's text: its people (the pool's, then API v1's assignees) by login or
 * name, and its issues and pull requests by number or title, most recently updated first.
 */
function useSuggestions(repoId: number): (trigger: '@' | '#', query: string) => Suggestion[] {
  const app = useApp();
  useEffect(() => {
    if (repoId > 0) loadPeople(app, repoId);
  }, [app, repoId]);
  return (trigger, query) => untracked(() => {
    const s = app.session;
    if (!s || repoId <= 0) return [];
    const q = query.toLowerCase();
    if (trigger === '@') {
      return repoPeople(s.data.pool, repoId, s.userId).filter((p) => p.login.toLowerCase().startsWith(q) || p.name.toLowerCase().includes(q))
        .slice(0, SUGGESTIONS).map((p) => ({label: p.login, detail: p.name === p.login ? undefined : p.name}));
    }
    return [...s.data.pool.model('Issue').by('repo_id', repoId)].map((e) => e.data)
      .filter((i) => !q || String(i.number).startsWith(q) || i.title.toLowerCase().includes(q))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, SUGGESTIONS)
      .map((i) => ({label: String(i.number), detail: i.title}));
  });
}

/** Binds a shortcut to focusing a field while mounted. */
function FocusOn({id, focus}: {id: ShortcutId; focus: () => void}) {
  useShortcut(id, focus);
  return null;
}

export const MarkdownField = observer(function MarkdownField({repoId, attachmentIssueId, attachments = true, focusShortcut, render, insertion, tools, ...props}: MarkdownFieldProps) {
  const [preview, setPreview] = useState(false);
  // The text area stands in until the editor's code is here and the page is idle (creating an editor costs a
  // frame or more on a slow device: not while the page opens), or at once when the field is wanted.
  const [ready, setReady] = useState(() => Boolean(Loaded) && props.autoFocus === true);
  const editor = useRef<MarkdownEditorHandle>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const text = useRef(props.value);
  text.current = props.value;
  const callbacks = useRef(props);
  callbacks.current = props;
  const uploads = useRef(new Map<string, AbortController>());
  const [pending, setPending] = useState(0);
  const [serverAllowed, setServerAllowed] = useState<boolean>();
  const app = useApp();
  const session = app.session;
  const limits = app.config.attachments;
  const repo = session?.data.pool.model('Repository').get(repoId)?.data;
  const issue = attachmentIssueId ? session?.data.pool.model('Issue').get(attachmentIssueId)?.data : undefined;
  const locallyAllowed = attachments && limits?.enabled === true && session !== undefined && repo !== undefined && !repo.archived &&
    (!issue?.is_locked || canWrite(session, repoId));
  const query = attachmentIssueId && attachmentIssueId > 0 ? `?issue_id=${String(attachmentIssueId)}` : '';
  const endpoint = `/repos/${String(repoId)}/attachments${query}`;
  const isOnline = reach(session?.data.status.connection) === 'online';
  useEffect(() => {
    if (!locallyAllowed || !isOnline) return undefined;
    const controller = new AbortController();
    setServerAllowed(undefined);
    void online<APIAttachmentPermission>(app, {api: 'sync', path: endpoint, signal: controller.signal}).then((result) => {
      if (!controller.signal.aborted) setServerAllowed(result?.allowed === true);
    }, () => { if (!controller.signal.aborted) setServerAllowed(false); });
    return () => { controller.abort(); };
  }, [app, endpoint, locallyAllowed, isOnline]);
  const allowed = locallyAllowed && (isOnline ? serverAllowed === true : serverAllowed !== false);
  const insert = (value: string, position?: number) => {
    if (editor.current) editor.current.insert(value, position);
    else {
      const from = position ?? area.current?.selectionStart ?? text.current.length;
      const to = position ?? area.current?.selectionEnd ?? from;
      const next = text.current.slice(0, from) + value + text.current.slice(to);
      text.current = next;
      callbacks.current.onChange(next);
    }
  };
  const replace = (placeholder: string, value: string) => {
    if (editor.current) editor.current.replace(placeholder, value);
    else {
      const next = replaceUpload(text.current, placeholder, value);
      text.current = next;
      callbacks.current.onChange(next);
    }
  };
  const attach = (files: File[], position?: number) => {
    if (!isOnline || !allowed) {
      notify(app, {tone: 'neutral', title: !isOnline ? onlineOnly('Attaching files') : 'Attachments are not available here.'});
      return;
    }
    if (limits.max_files > 0 && files.length + uploads.current.size + new Set(text.current.match(/\/attachments\/[0-9a-f-]{36}/g) ?? []).size > limits.max_files) {
      notify(app, {tone: 'danger', title: `Attach at most ${String(limits.max_files)} files.`});
      return;
    }
    const tasks = files.filter((file) => {
      if (file.size <= limits.max_size) return true;
      notify(app, {tone: 'danger', title: `${file.name} is too large`, description: `The maximum attachment size is ${String(Math.floor(limits.max_size / 1048576))} MiB.`});
      return false;
    }).map((file) => ({file, placeholder: uploadPlaceholder(uuid(), file.name), controller: new AbortController()}));
    if (!tasks.length) return;
    for (const task of tasks) uploads.current.set(task.placeholder, task.controller);
    insert(tasks.map((task) => task.placeholder).join('\n') + '\n', position);
    setPending(uploads.current.size);
    for (const {file, placeholder, controller} of tasks) {
      const form = new FormData();
      form.set('attachment', file);
      void online<APIUploadedAttachment>(app, {method: 'POST', api: 'sync', path: endpoint, form, timeout: 120_000, signal: controller.signal}).then((result) => {
        if (controller.signal.aborted) return;
        if (!result?.url) throw new Error('Forgejo did not return an attachment URL.');
        replace(placeholder, attachmentMarkdown(file, result.url));
      }).catch((err: unknown) => {
        if (controller.signal.aborted) return;
        replace(placeholder, '');
        notify(app, {tone: 'danger', title: `${file.name} was not attached`, description: failureText(err)});
      }).finally(() => {
        if (controller.signal.aborted) return;
        uploads.current.delete(placeholder);
        setPending(uploads.current.size);
      });
    }
  };
  useEffect(() => {
    if (!uploads.current.size && hasPendingUploads(props.value)) props.onChange(stripUploadPlaceholders(props.value));
  }, [props]);
  useEffect(() => () => {
    for (const controller of uploads.current.values()) controller.abort();
    uploads.current.clear();
  }, []);
  useEffect(() => {
    if (!insertion) return;
    setPreview(false);
    requestAnimationFrame(() => {
      if (editor.current) editor.current.insert(insertion.text);
      else if (area.current) {
        const a = area.current;
        const from = a.selectionStart;
        const text = a.value.slice(0, from) + insertion.text + a.value.slice(a.selectionEnd);
        props.onChange(text);
        requestAnimationFrame(() => {
          a.focus();
          a.setSelectionRange(from + insertion.text.length, from + insertion.text.length);
        });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- each insertion is a single user action
  }, [insertion]);
  useEffect(() => {
    if (ready) return undefined;
    let live = true;
    void preloadEditor().then(() => {
      whenIdle(() => {
        if (live) setReady(true);
      });
    }, () => undefined);
    return () => {
      live = false;
    };
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
  const complete = useSuggestions(repoId);
  const Editor = ready ? Loaded : undefined;
  const mod = formatKeys('mod+b').replace(/B$/, '');
  // The box stays the same between Write and Preview (the tabs on top, the text where it was): only its body
  // changes, at least as tall as the editor's rows.
  const header = <>
    <SegmentedControl label="Editor mode" value={preview ? 'preview' : 'write'} onChange={(v) => {
      setPreview(v === 'preview');
      if (v === 'write') requestAnimationFrame(() => editor.current?.focus());
    }} options={[{value: 'write', label: 'Write'}, {value: 'preview', label: 'Preview'}]}/>
    <span className="ml-auto flex items-center">
      {allowed && <Button size="sm" variant="ghost" icon={Paperclip} disabled={preview || !isOnline}
        tooltip={!isOnline ? onlineOnly('Attaching files') : 'Paste, drop, or choose files'} onClick={() => picker.current?.click()}>Attach files</Button>}
      {FORMATS.map(([kind, icon, label, key]) => (
        <IconButton key={kind} size="sm" icon={icon} label={label} shortcut={`${mod}${key}`} disabled={preview || !Editor} onClick={() => {
          editor.current?.format(kind);
        }}/>
      ))}
      {tools?.map((tool) => (
        <IconButton key={tool.id} size="sm" icon={tool.icon} label={tool.label} disabled={preview || !Editor} onClick={() => {
          editor.current?.edit(tool.edit);
        }}/>
      ))}
    </span>
  </>;
  return (
    <div onKeyDown={onKeyDown}>
      <input ref={picker} type="file" aria-label="Attach files" multiple hidden accept={limits?.allowed_types === '*/*' ? undefined : limits?.allowed_types} onChange={(e) => {
        attach([...e.target.files ?? []]);
        e.target.value = '';
      }}/>
      {focusShortcut && <FocusOn id={focusShortcut} focus={() => {
        setPreview(false);
        requestAnimationFrame(() => {
          if (editor.current) editor.current.focus();
          else area.current?.focus();
        });
      }}/>}
      <EditorFrame invalid={props.invalid} header={header}>
        {preview ?
          <div ref={previewRef} tabIndex={-1} aria-label={`${props.label} preview`} role="region" className="outline-none"
            style={{minHeight: `calc(var(--text-md--line-height) * ${String(props.rows ?? 4)} + var(--spacing) * 3)`}}>
            <MarkdownPreview repoId={repoId} text={props.value} render={render}/>
          </div> :
          Editor ?
            <Editor {...props} ref={editor} onFiles={attach} onSubmit={props.onSubmit ? () => { if (!hasPendingUploads(text.current)) props.onSubmit?.(); } : undefined} complete={complete} autoFocus={props.autoFocus === true || hadFocus.current}/> :
            <TextArea bare ref={area} aria-label={props.label} aria-describedby={props.describedBy} placeholder={props.placeholder ?? props.label}
              value={props.value} rows={props.rows ?? 4} autoFocus={props.autoFocus} invalid={props.invalid}
              onPaste={(e) => {
                const files = [...e.clipboardData.files];
                if (files.length) { e.preventDefault(); attach(files); }
              }}
              onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
              onDrop={(e) => {
                const files = [...e.dataTransfer.files];
                if (files.length) { e.preventDefault(); attach(files); }
              }}
              onFocus={() => {
                hadFocus.current = true;
                if (Loaded) setReady(true);
              }}
              onChange={(e) => {
                props.onChange(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (!hasPendingUploads(text.current)) props.onSubmit?.();
                } else if (e.key === 'Escape' && props.onCancel) {
                  e.preventDefault();
                  props.onCancel();
                }
              }}/>}
      </EditorFrame>
      {pending > 0 && <span role="status" className="flex items-center gap-2 px-2 py-1 text-sm text-fg-muted"><PendingIcon label="Uploading attachments" now/>Uploading {pending} {pending === 1 ? 'file' : 'files'}… Wait before posting.</span>}
    </div>
  );
});

/** The formatting buttons (the editor's keys: ⌘B, ⌘I, ⌘K, ⌘E). Code: inline for a selection in a line, else a fenced block. */
const FORMATS: [Format, LucideIcon, string, string][] = [
  ['bold', Bold, 'Bold', 'B'], ['italic', Italic, 'Italic', 'I'], ['link', Link2, 'Link', 'K'], ['code', Code2, 'Code', 'E'],
];

/**
 * Markdown as Forgejo renders it (in a repository's context): the server's rendering online (batched, cached), the
 * text as written offline. The editor's Preview, and drafts shown before they are posted.
 */
export const MarkdownPreview = observer(function MarkdownPreview({repoId, text, render}: {repoId: number; text: string; render?: ((text: string) => Promise<string>) | undefined}) {
  const app = useApp();
  const [state, setState] = useState<{text: string; html?: string; error?: string}>({text: ''});
  const offline = !connectivity.online;
  const rendered = useEffectEvent((t: string) => (render ? render(t) : renderPreview(app, repoId, t)));
  useEffect(() => {
    if (!text.trim() || offline) return undefined;
    let live = true;
    rendered(text).then((html) => {
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
