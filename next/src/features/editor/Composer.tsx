// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Preview uses server-rendered HTML through the Trusted Types and Markdown sanitization gates.
// A textarea preserves input while the lazy editor loads.

import {count} from '../../app/words.ts';
import {observer} from 'mobx-react-lite';
import {type KeyboardEvent, type ReactNode, useEffect, useEffectEvent, useRef, useState} from 'react';
import {failureText, online, RequestFailed} from '../../app/api.ts';
import {connectivity, onlineOnly, reach} from '../../app/online.ts';
import {canWrite} from '../../app/access.ts';
import {notify} from '../../app/notices.ts';
import {uuid} from '../../intents/intents.ts';
import {attachmentMarkdown, hasPendingUploads, replaceUpload, stripUploadPlaceholders, uploadPlaceholder} from './attachments.ts';
import {type ShortcutId, useShortcut} from '../../app/shortcuts/index.ts';
import {type App, useApp} from '../../app/store.ts';
import type {APIAttachmentPermission, APIMarkdownRequest, APIMarkdownResponse, APIUploadedAttachment} from '../../protocol/types.gen.ts';
import {whenIdle} from '../../app/lazy.tsx';
import {type EditMaker, type Format, formatEdit} from './format.ts';
import {Markdown} from '../issue/Markdown.tsx';
import type {MarkdownEditorHandle, MarkdownEditorProps, Suggestion} from './MarkdownEditor.tsx';
import {untracked} from 'mobx';
import {loadPeople, repoPeople} from '../issues/people.ts';
import {BoldIcon, ClockIcon, CodeIcon, HeadingIcon, ItalicIcon, LinkIcon, ListOrderedIcon, ListUnorderedIcon, PaperclipIcon, QuoteIcon, TasklistIcon} from '@primer/octicons-react';
import type {Icon as OcticonType} from '@primer/octicons-react';
import {Button, IconButton, SegmentedControl, Textarea, Tooltip} from '@primer/react';
import {SkeletonText} from '@primer/react/experimental';

type Editor = (props: MarkdownEditorProps) => ReactNode;
let Loaded: Editor | undefined;
let loading: Promise<void> | undefined;

/** Load the editor chunk ahead of use. */
export function preloadEditor(): Promise<void> {
  loading ??= import('./MarkdownEditor.tsx').then((m) => {
    Loaded = m.default;
  }, (err: unknown) => {
    loading = undefined;
    throw err;
  });
  return loading;
}


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
  tools?: readonly EditorTool[] | undefined;
}

/** A toolbar button of a field: an edit of the selection (applied as one change, like the formatting buttons). */
export interface EditorTool {
  id: string;
  icon: OcticonType;
  label: string;
  edit: EditMaker;
}

const SUGGESTIONS = 8;

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

function FocusOn({id, focus}: {id: ShortcutId; focus: () => void}) {
  useShortcut(id, focus);
  return null;
}

export const MarkdownField = observer(function MarkdownField({repoId, attachmentIssueId, attachments = true, focusShortcut, render, insertion, tools, ...props}: MarkdownFieldProps) {
  const [preview, setPreview] = useState(false);
  // Defer editor construction until idle to avoid delaying page opening.
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
      // Preview retains focus so the same shortcut can toggle back.
      requestAnimationFrame(() => {
        if (preview) editor.current?.focus();
        else previewRef.current?.focus();
      });
    }
  };
  const complete = useSuggestions(repoId);
  const Editor = ready ? Loaded : undefined;
  /** Applies an edit of the selection; before the editor has loaded, to the plain field. */
  const edit = (make: EditMaker) => {
    if (editor.current) {
      editor.current.edit(make);
      return;
    }
    const a = area.current;
    const from = a?.selectionStart ?? text.current.length;
    const e = make(text.current, from, a?.selectionEnd ?? from);
    const next = text.current.slice(0, e.from) + e.insert + text.current.slice(e.to);
    text.current = next;
    callbacks.current.onChange(next);
    requestAnimationFrame(() => {
      a?.focus();
      a?.setSelectionRange(e.anchor, e.head);
    });
  };
  const header = <>
    <SegmentedControl aria-label="Editor mode" size="small" onChange={(index) => {
      setPreview(index === 1);
      if (index === 0) requestAnimationFrame(() => editor.current?.focus());
    }}>
      <SegmentedControl.Button selected={!preview}>Write</SegmentedControl.Button>
      <SegmentedControl.Button selected={preview}>Preview</SegmentedControl.Button>
    </SegmentedControl>
    <span className="ml-auto flex flex-wrap items-center">
      {FORMATS.map((group, g) => (
        <span key={g} className="flex items-center">
          {g > 0 && <span aria-hidden className="mx-1 h-4 border-l border-default"/>}
          {group.map(([kind, icon, label, key]) => (
            <IconButton icon={icon} variant="invisible" size="small" aria-label={label} description={label} {...key ? {keybindingHint: `Mod+${key}`} : {}} type="button" key={kind} disabled={preview} onClick={() => {
              edit((doc, from, to) => formatEdit(doc, from, to, kind));
            }}/>
          ))}
        </span>
      ))}
      {tools && tools.length > 0 && <span className="flex items-center">
        <span aria-hidden className="mx-1 h-4 border-l border-default"/>
        {tools.map((tool) => (
          <IconButton icon={tool.icon} variant="invisible" size="small" aria-label={tool.label} description={tool.label} type="button" key={tool.id} disabled={preview} onClick={() => {
            edit(tool.edit);
          }}/>
        ))}
      </span>}
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
      <div className={props.invalid ? 'rounded-md border border-danger-emphasis focus-ring-within' : 'rounded-md border border-default focus-ring-within'}>
        <div className="flex flex-wrap items-center gap-2 rounded-t-md border-b border-default bg-muted px-4 py-2">{header}</div>
        {preview ?
          <div ref={previewRef} tabIndex={-1} aria-label={`${props.label} preview`} role="region" className="outline-none"
            style={{minHeight: `calc(var(--text-base) * var(--text-base--line-height) * ${String(props.rows ?? 4)} + var(--spacing) * 6)`}}>
            <MarkdownPreview repoId={repoId} text={props.value} render={render}/>
          </div> :
          Editor ?
            <Editor {...props} ref={editor} onFiles={attach} onSubmit={props.onSubmit ? () => { if (!hasPendingUploads(text.current)) props.onSubmit?.(); } : undefined} complete={complete} autoFocus={props.autoFocus === true || hadFocus.current}/> :
            <Textarea block ref={area} aria-label={props.label} aria-describedby={props.describedBy} placeholder={props.placeholder ?? props.label}
              value={props.value} rows={props.rows ?? 4} autoFocus={props.autoFocus} {...(props.invalid ? {validationStatus: 'error' as const} : {})}
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
        {allowed && <div className="flex items-center border-t border-dashed border-default px-2 py-1">
          <Tooltip text={!isOnline ? onlineOnly('Attaching files') : 'Attach files'}><Button variant="invisible" size="small" leadingVisual={PaperclipIcon} type="button" inactive={preview || !isOnline} aria-disabled={preview || !isOnline} onClick={() => { if (!preview && isOnline) picker.current?.click(); }}>
            Paste, drop, or click to add files
          </Button></Tooltip>
        </div>}
      </div>
      {pending > 0 && <span role="status" className="flex items-center gap-2 px-2 py-1 text-sm text-muted"><ClockIcon aria-label="Uploading attachments" size={16}/>Uploading {count(pending, 'file', 'files')}… Wait before posting.</span>}
    </div>
  );
});

/** GitHub's toolbar groups. Link has no hint: Mod-K opens the command menu, also while writing. */
const FORMATS: [Format, OcticonType, string, string?][][] = [
  [['heading', HeadingIcon, 'Heading'], ['bold', BoldIcon, 'Bold', 'B'], ['italic', ItalicIcon, 'Italic', 'I'], ['quote', QuoteIcon, 'Quote'], ['code', CodeIcon, 'Code', 'E'], ['link', LinkIcon, 'Link']],
  [['number', ListOrderedIcon, 'Numbered list'], ['bullet', ListUnorderedIcon, 'Unordered list'], ['task', TasklistIcon, 'Task list']],
];

/** Show server-rendered Markdown online and source text offline. */
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
  if (!text.trim()) return <p className="min-h-16 px-4 py-3 text-base text-muted">Nothing to preview.</p>;
  if (offline) {
    return (
      <div className="flex flex-col gap-2 px-4 py-3">
        <p className="text-sm text-muted">The preview needs a connection (Forgejo renders it). Your text as written:</p>
        <div className="conversation-markdown"><div className="markdown-body whitespace-pre-wrap">{text}</div></div>
      </div>
    );
  }
  if (state.text !== text) {
    return <div className="flex flex-col gap-2 px-4 py-3" aria-busy><SkeletonText lines={2}/></div>;
  }
  if (state.error !== undefined) return <p role="alert" className="px-4 py-3 text-sm text-danger">{state.error}</p>;
  return <div className="conversation-markdown min-h-16 px-4 py-3"><Markdown html={state.html ?? ''}/></div>;
});
