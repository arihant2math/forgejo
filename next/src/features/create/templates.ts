// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {online} from '../../app/api.ts';
import type {App} from '../../app/store.ts';
import {codeSource} from '../../code/source.ts';

export interface FormOption {label: string; required?: boolean; visible?: string[]}
export interface TemplateField {
  type: 'markdown' | 'input' | 'textarea' | 'dropdown' | 'checkboxes';
  id: string;
  attributes: {label?: string; description?: string; value?: string; placeholder?: string; options?: (string | FormOption)[]; multiple?: boolean; list?: boolean; render?: string; hide_label?: boolean; default?: number | number[]};
  validations?: {required?: boolean};
  visible?: string[];
}
export interface IssueTemplate {
  name: string; about: string; title: string; content: string; file_name: string;
  labels: string[]; assignees?: string[]; body?: TemplateField[];
}
export interface TemplateSet {
  templates: IssueTemplate[];
  people?: {id: number; login: string}[];
  config: {blank_issues_enabled: boolean; contact_links: {name: string; about: string; url: string}[]};
  note?: string;
}
export type FormValues = Record<string, string | number[]>;
export const visible = (item: {visible?: string[]}, where: string) => !item.visible?.length || item.visible.includes(where);
export const optionLabel = (option: string | FormOption) => typeof option === 'string' ? option : option.label;
export const optionVisible = (option: string | FormOption, where: string) => typeof option === 'string' || !option.visible || option.visible.includes(where);

export function initialValues(fields: TemplateField[]): FormValues {
  return Object.fromEntries(fields.map((f) => [f.id, f.type === 'dropdown' ? (typeof f.attributes.default === 'number' ? [f.attributes.default] : f.attributes.default ?? []) : f.type === 'checkboxes' ? [] : f.attributes.value ?? '']));
}

export function missingFields(fields: TemplateField[], values: FormValues): string[] {
  return fields.filter((f) => visible(f, 'form') && f.type !== 'markdown').filter((f) => {
    const value = values[f.id];
    if (f.type === 'checkboxes') return (f.attributes.options ?? []).some((o, i) => typeof o !== 'string' && optionVisible(o, 'form') && o.required && !(Array.isArray(value) && value.includes(i)));
    return f.validations?.required && !(Array.isArray(value) ? value.length : value?.trim());
  }).map((f) => f.id);
}

/** Match modules/issue/template.RenderToMarkdown, including hidden content and fenced textareas. */
export function formBody(fields: TemplateField[], values: FormValues): string {
  return fields.filter((f) => f.id && visible(f, 'content') && (f.type !== 'markdown' || f.visible?.includes('content'))).map((f) => {
    const a = f.attributes;
    const selected = Array.isArray(values[f.id]) ? values[f.id] as number[] : [];
    const text = typeof values[f.id] === 'string' ? (values[f.id] as string).trim() : '';
    let body: string;
    if (f.type === 'markdown') body = `${a.value ?? ''}\n`;
    else if (f.type === 'checkboxes') body = (a.options ?? []).flatMap((o, i) => optionVisible(o, 'content') ? [`- [${selected.includes(i) ? 'x' : ' '}] ${optionLabel(o)}\n`] : []).join('');
    else if (f.type === 'dropdown') {
      const labels = (a.options ?? []).filter((_, i) => selected.includes(i)).map(optionLabel);
      body = !labels.length ? '_No response_\n' : a.list ? labels.map((l) => `- ${l}\n`).join('') : `${labels.join(', ')}\n`;
    } else if (!text) body = '_No response_\n';
    else if (f.type === 'textarea' && a.render) {
      const runs = /^`{3,}/.exec(text) ?? [];
      const fence = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
      body = `${fence}${a.render}\n${text}\n${fence}\n`;
    } else body = `${text}\n`;
    return `${f.type === 'markdown' || a.hide_label ? '' : `### ${a.label ?? ''}\n\n`}${body}\n`;
  }).join('');
}

const requests = new WeakMap<App, Map<number, Promise<TemplateSet>>>();
const fresh = new WeakMap<App, Map<number, {time: number; value: TemplateSet}>>();
export function loadTemplates(app: App, repoId: number): Promise<TemplateSet> {
  const hit = fresh.get(app)?.get(repoId);
  if (hit && Date.now() - hit.time < 30_000) return Promise.resolve(hit.value);
  let pending = requests.get(app);
  if (!pending) requests.set(app, pending = new Map<number, Promise<TemplateSet>>());
  const existing = pending.get(repoId);
  if (existing) return existing;
  const promise = fetchTemplates(app, repoId).then((value) => {
    let map = fresh.get(app);
    if (!map) fresh.set(app, map = new Map<number, {time: number; value: TemplateSet}>());
    map.set(repoId, {time: Date.now(), value});
    return value;
  }).finally(() => pending.delete(repoId));
  pending.set(repoId, promise);
  return promise;
}

async function fetchTemplates(app: App, repoId: number): Promise<TemplateSet> {
  const repo = app.session?.data.pool.model('Repository').get(repoId)?.data;
  const cache = codeSource(app)?.cache;
  const latest = `issue-templates:${String(repoId)}:latest`;
  const oldKey = await cache?.get<string>(latest);
  const old = oldKey ? await cache?.get<TemplateSet>(oldKey) : undefined;
  const fallback: TemplateSet = {templates: [], config: {blank_issues_enabled: true, contact_links: []}, note: 'Templates are unavailable on this device. You can still create a blank issue offline.'};
  if (!repo || !navigator.onLine) return old ?? fallback;
  const base = `/repos/${encodeURIComponent(repo.owner_name)}/${encodeURIComponent(repo.name)}`;
  try {
    const branch = await online<{commit: {id: string}}>(app, {api: 'v1', path: `${base}/branches/${encodeURIComponent(repo.default_branch)}`});
    const key = `issue-templates:${String(repoId)}:${branch?.commit?.id ?? repo.default_branch}`;
    const [templates, config, people] = await Promise.all([
      online<IssueTemplate[]>(app, {api: 'v1', path: `${base}/issue_templates`}),
      online<TemplateSet['config']>(app, {api: 'v1', path: `${base}/issue_config`}),
      online<{id: number; login: string}[]>(app, {api: 'v1', path: `${base}/assignees`}).catch(() => []),
    ]);
    const result = {templates: templates ?? [], people: (people ?? []).map(({id, login}) => ({id, login})), config: {blank_issues_enabled: config?.blank_issues_enabled !== false, contact_links: config?.contact_links ?? []}};
    cache?.put(key, result);
    cache?.put(latest, key);
    return result;
  } catch {
    return old ?? {...fallback, note: 'Could not load issue templates. A blank issue is available; reopen to retry.'};
  }
}
