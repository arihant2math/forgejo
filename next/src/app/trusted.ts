// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Server-rendered markdown into the DOM, under Trusted Types (B8's CSP:
// `require-trusted-types-for 'script'; trusted-types forgejo-next`).
//
// The HTML is Forgejo's markup renderer's output (bodies, comments), which
// the server sanitizes. It still goes through two more gates here:
//
//   1. The only use of the `forgejo-next` policy is parsing it into an
//      inert <template> (nothing runs or loads there). The policy is private
//      to this module, so no other code can turn a string into TrustedHTML.
//   2. An allowlist walk (`scrub`) keeps only document elements and plain
//      attributes, drops event handlers, classes, styles, scripts, frames,
//      forms and SVG, and checks every URL's scheme. The scrubbed nodes are then moved
//      into the page (`replaceChildren`): no HTML string sink is involved.
//
// Never add a `default` policy (B8): it would apply to every sink implicitly.

interface Policy {
  createHTML(s: string): unknown;
  createScriptURL(s: string): unknown;
}

let policy: Policy | null | undefined;

/** The script URLs the policy lets through: the service worker's (app/sw.ts) and the app's own workers, set before use. */
const scriptUrls = new Set<string>();

function getPolicy(): Policy | null {
  if (policy !== undefined) return policy;
  const tt = (globalThis as {trustedTypes?: {createPolicy(name: string, rules: {createHTML(s: string): string; createScriptURL(s: string): string}): Policy}}).trustedTypes;
  // Without Trusted Types (older browsers, tests) the template takes the string as is.
  policy = tt ? tt.createPolicy('forgejo-next', {
    createHTML: (s) => s,
    createScriptURL: (s) => {
      if (!scriptUrls.has(s)) throw new TypeError(`forgejo-next: script URL refused: ${s}`);
      return s;
    },
  }) : null;
  return policy;
}

/**
 * The service worker's URL as a TrustedScriptURL (`register` is a Trusted
 * Types sink). Only this exact same-origin path below the app's base is
 * allowed: `{base}sw.js`.
 */
export function workerScriptURL(base: string): string {
  const url = `${base}sw.js`;
  if (!url.startsWith('/') || url.startsWith('//')) throw new TypeError('forgejo-next: the service worker must be same-origin');
  scriptUrls.add(url);
  const p = getPolicy();
  return (p ? p.createScriptURL(url) : url) as string;
}

/**
 * A dedicated worker's URL as a TrustedScriptURL (`new Worker` is a sink):
 * only a module of this build — a same-origin path below the app's base
 * ending in ".js" (a dev server's source path in development).
 */
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

// No `class`, `style`, `role` or `id` (except Forgejo's user-content- anchors): the app's own
// utility classes and roles must not be reachable from user content (UI redress).
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

/** Whether a URL attribute's value may stay (http(s), mailto, same-document; raster data images). */
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
  // Copy first: the walk mutates the tree.
  for (const el of [...root.querySelectorAll('*')]) {
    if (!el.isConnected && !root.contains(el)) continue; // inside a dropped subtree
    const tag = el.localName;
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || DROP.has(tag)) {
      // Task-list checkboxes are the one input Forgejo renders: keep them inert.
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
    // A code block's language (class="language-go", dropped with the classes): kept as data-lang for highlighting.
    const lang = tag === 'code' ? /(?:^|\s)language-([\w+#.-]{1,32})(?:\s|$)/.exec(el.getAttribute('class') ?? '')?.[1] : undefined;
    for (const {name, value} of [...el.attributes]) {
      // ARIA: names and hiding only — references (aria-labelledby, -owns, …) could point at the app's own elements.
      const ok = (GLOBAL_ATTRS.has(name) || (allowed?.has(name) ?? false) || (name === 'id' && value.startsWith('user-content-')) || name === 'aria-label' || name === 'aria-hidden') &&
        (!URL_ATTRS.has(name) || safeUrl(name, tag, value));
      if (!ok || (name === 'target' && value !== '_blank')) el.removeAttribute(name);
    }
    if (lang) el.setAttribute('data-lang', lang);
    if (tag === 'a' && el.hasAttribute('target')) el.setAttribute('rel', 'noopener noreferrer');
    if (tag === 'img' && !el.hasAttribute('loading')) el.setAttribute('loading', 'lazy');
    // A video's source loads when played, not when the page renders (it may be on another host).
    if (tag === 'video') el.setAttribute('preload', 'none');
  }
}

/** Server HTML parsed inertly into a template (the policy's one use: see the header). */
function inert(html: string): HTMLTemplateElement {
  const tpl = document.createElement('template');
  const p = getPolicy();
  (tpl as {innerHTML: unknown}).innerHTML = p ? p.createHTML(html) : html;
  return tpl;
}

/** Parses server HTML inertly, scrubs it, and makes it the element's content. */
export function setMarkup(el: Element, html: string): void {
  const tpl = inert(html);
  scrub(tpl.content);
  el.replaceChildren(tpl.content);
}

/** The text of server HTML (a rendered commit message's words, never its markup), parsed inertly. */
export function textOfMarkup(html: string): string {
  return inert(html).content.textContent;
}
