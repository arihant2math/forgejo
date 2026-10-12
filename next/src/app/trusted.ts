// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Trusted Types policy stays private: server HTML is parsed only into inert templates, then allowlist-scrubbed.
// Move scrubbed nodes into the page without an HTML string sink.
// Never add a default policy: it would implicitly trust every sink.

interface Policy {
  createHTML(s: string): unknown;
  createScriptURL(s: string): unknown;
}

let policy: Policy | null | undefined;

const scriptUrls = new Set<string>();

function getPolicy(): Policy | null {
  if (policy !== undefined) return policy;
  const tt = (globalThis as {trustedTypes?: {createPolicy(name: string, rules: {createHTML(s: string): string; createScriptURL(s: string): string}): Policy}}).trustedTypes;
  policy = tt ? tt.createPolicy('forgejo-next', {
    createHTML: (s) => s,
    createScriptURL: (s) => {
      if (!scriptUrls.has(s)) throw new TypeError(`forgejo-next: script URL refused: ${s}`);
      return s;
    },
  }) : null;
  return policy;
}

/** Returns a TrustedScriptURL for the exact same-origin {base}sw.js path used by register(). */
export function workerScriptURL(base: string): string {
  const url = `${base}sw.js`;
  if (!url.startsWith('/') || url.startsWith('//')) throw new TypeError('forgejo-next: the service worker must be same-origin');
  scriptUrls.add(url);
  const p = getPolicy();
  return (p ? p.createScriptURL(url) : url) as string;
}

/** Trusts only build-module paths below base; development also permits source paths. */
export function appWorkerURL(base: string, url: string): string {
  const ok = url.startsWith(base) && !url.includes('..') && !url.includes('//') && (url.endsWith('.js') || import.meta.env.DEV);
  if (!ok && !(import.meta.env.DEV && url.startsWith('/'))) throw new TypeError(`forgejo-next: worker URL refused: ${url}`);
  scriptUrls.add(url);
  const p = getPolicy();
  return (p ? p.createScriptURL(url) : url) as string;
}

const DROP = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'select', 'textarea',
  'option', 'link', 'meta', 'base', 'template', 'noscript', 'svg', 'math', 'title', 'head', 'portal', 'dialog', 'slot',
]);

const KEEP = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div',
  'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p',
  'picture', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'source', 'span', 'strike', 'strong', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'video', 'wbr',
]);

// User content must not reach app classes, styles, roles or ids: prevent UI redress.
// Forgejo's user-content- anchors are the only id exception.
const GLOBAL_ATTRS = new Set(['title', 'lang', 'dir', 'align']);

const ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'rel', 'target', 'name']),
  img: new Set(['src', 'alt', 'width', 'height', 'loading']),
  video: new Set(['src', 'controls', 'poster', 'width', 'height', 'preload']),
  source: new Set(['src', 'srcset', 'type', 'media']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  ol: new Set(['start', 'reversed', 'type']),
  li: new Set(['value']),
  details: new Set(['open']),
  time: new Set(['datetime']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
};

const URL_ATTRS = new Set(['href', 'src', 'poster', 'srcset']);

export function safeUrl(attr: string, tag: string, value: string): boolean {
  const v = value.trim();
  if (attr === 'srcset') return v.split(',').every((part) => safeUrl('src', tag, part.trim().split(/\s+/)[0] ?? ''));
  if (v.startsWith('#')) return attr === 'href';
  let u: URL;
  try {
    u = new URL(v, document.baseURI);
  } catch {
    return false;
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') return true;
  if (u.protocol === 'mailto:') return attr === 'href' && tag === 'a';
  if (u.protocol === 'data:') return attr !== 'href' && /^data:image\/(?:png|gif|jpeg|webp|avif);/i.test(v);
  return false;
}

/** Removes everything outside the allowlists from a fragment (in place). */
export function scrub(root: DocumentFragment | Element): void {
  // Snapshot nodes before mutating the tree.
  for (const el of [...root.querySelectorAll('*')]) {
    if (!el.isConnected && !root.contains(el)) continue; // inside a dropped subtree
    const tag = el.localName;
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || DROP.has(tag)) {
      // Preserve task-list checkboxes only as inert controls.
      if (tag === 'input' && el.getAttribute('type') === 'checkbox') {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.disabled = true;
        box.checked = el.hasAttribute('checked');
        el.replaceWith(box);
        continue;
      }
      el.remove();
      continue;
    }
    if (!KEEP.has(tag)) {
      el.replaceWith(...el.childNodes);
      continue;
    }
    const allowed = ATTRS[tag];
    // Preserve code language for highlighting without retaining user-controlled classes.
    const lang = tag === 'code' ? /(?:^|\s)language-([\w+#.-]{1,32})(?:\s|$)/.exec(el.getAttribute('class') ?? '')?.[1] : undefined;
    for (const {name, value} of [...el.attributes]) {
      // Reject ARIA references that could point at the app's own elements.
      const ok = (GLOBAL_ATTRS.has(name) || (allowed?.has(name) ?? false) || (name === 'id' && value.startsWith('user-content-')) || name === 'aria-label' || name === 'aria-hidden') &&
        (!URL_ATTRS.has(name) || safeUrl(name, tag, value));
      if (!ok || (name === 'target' && value !== '_blank')) el.removeAttribute(name);
    }
    if (lang) el.setAttribute('data-lang', lang);
    if (tag === 'a' && el.hasAttribute('target')) el.setAttribute('rel', 'noopener noreferrer');
    if (tag === 'img' && !el.hasAttribute('loading')) el.setAttribute('loading', 'lazy');
    // Avoid cross-host video requests until playback.
    if (tag === 'video') el.setAttribute('preload', 'none');
  }
}

function inert(html: string): HTMLTemplateElement {
  const tpl = document.createElement('template');
  const p = getPolicy();
  (tpl as {innerHTML: unknown}).innerHTML = p ? p.createHTML(html) : html;
  return tpl;
}

/** Scrubs server HTML before replacing the element's content. */
export function setMarkup(el: Element, html: string): void {
  const tpl = inert(html);
  scrub(tpl.content);
  el.replaceChildren(tpl.content);
}

/** Returns text only, parsing server HTML inertly. */
export function textOfMarkup(html: string): string {
  return inert(html).content.textContent;
}

/** Returns inertly parsed text runs marked by membership in the given class. */
export function markedTextOfMarkup(html: string, marker: string): {text: string; marked: boolean}[] {
  const root = inert(html).content;
  const runs: {text: string; marked: boolean}[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent ?? '';
    if (!text) continue;
    let marked = false;
    for (let el = n.parentElement; el && !marked; el = el.parentElement) marked = el.classList.contains(marker);
    const last = runs.at(-1);
    if (last?.marked === marked) last.text += text;
    else runs.push({text, marked});
  }
  return runs;
}
