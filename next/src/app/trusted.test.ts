// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {describe, expect, test} from 'vitest';
import {safeUrl, setMarkup} from './trusted.ts';

function render(html: string): HTMLDivElement {
  const el = document.createElement('div');
  setMarkup(el, html);
  return el;
}

describe('markdown into the DOM', () => {
  test('keeps document markup: headings, lists, code, tables, links, images, task lists', () => {
    const el = render('<h2 id="user-content-x">Title</h2><p>Some <strong>bold</strong> and <code>code</code> <a href="https://example.com/a" rel="nofollow">link</a> <a href="/dev/big/issues/3" class="ref-issue">#3</a></p>' +
      '<ul><li><input type="checkbox" checked="" disabled=""/> done</li></ul><table><tr><td colspan="2">x</td></tr></table><img src="/attachments/a.png" alt="a"/>');
    expect(el.querySelector('h2')?.id).toBe('user-content-x');
    expect(el.querySelector('a[href="https://example.com/a"]')?.textContent).toBe('link');
    expect(el.querySelector('a.ref-issue')).toBeNull(); // classes are dropped…
    expect(el.querySelector('a[href="/dev/big/issues/3"]')?.textContent).toBe('#3'); // …the link stays
    const box = el.querySelector('input');
    expect(box?.type).toBe('checkbox');
    expect(box?.disabled).toBe(true);
    expect(box?.checked).toBe(true);
    expect(el.querySelector('td')?.getAttribute('colspan')).toBe('2');
    expect(el.querySelector('img')?.getAttribute('loading')).toBe('lazy');
  });

  test('drops scripts, handlers, styles, frames, forms, SVG and dangerous URLs', () => {
    const el = render('<p onclick="alert(1)" style="position:fixed" class="fixed inset-0 z-tooltip">hi</p><script>alert(1)</script>' +
      '<img src="x" onerror="alert(1)"/><a href="javascript:alert(1)">j</a><a href=" JaVaScRiPt:alert(1)">j2</a><a href="data:text/html,<script>x</script>">d</a>' +
      '<iframe src="https://evil"></iframe><form action="/x"><input name="a"/><button>b</button></form><svg><script>alert(1)</script></svg>' +
      '<math><mi xlink:href="javascript:alert(1)">x</mi></math><style>body{display:none}</style><object data="x"></object><embed src="x"/>' +
      '<div role="dialog" id="root">r</div><img src="data:image/svg+xml,<svg onload=alert(1)>"/><img src="data:image/png;base64,iVBOR"/>' +
      '<a href="https://ok" aria-labelledby="root" aria-owns="root" aria-label="named">t</a><video src="https://x/v.mp4" controls></video>' +
      '<a href="https://ok" target="_blank">t</a><meta http-equiv="refresh" content="0;url=https://evil"><base href="https://evil/">');
    const html = el.innerHTML;
    expect(html).not.toMatch(/script|onclick|onerror|style=|javascript|iframe|<form|<button|<svg|<math|<object|<embed|<meta|<base|class=|role=|id="root"|svg\+xml|text\/html/i);
    expect(el.querySelector('p')?.textContent).toBe('hi');
    expect([...el.querySelectorAll('img')].map((i) => i.getAttribute('src')?.slice(0, 15) ?? null)).toEqual(['x', null, 'data:image/png;']);
    expect(el.querySelector('img[src^="data:image/png"]')).not.toBeNull();
    expect(el.querySelector('a[target]')?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(el.querySelector('[aria-labelledby], [aria-owns]')).toBeNull();
    expect(el.querySelector('a[aria-label="named"]')).not.toBeNull();
    expect(el.querySelector('video')?.getAttribute('preload')).toBe('none');
    expect(el.textContent).toContain('r'); // the dialog div's text stays, as a plain div
  });

  test('unknown elements are unwrapped, their content kept', () => {
    const el = render('<custom-tag><b>kept</b></custom-tag><font color="red">old</font>');
    expect(el.innerHTML).toBe('<b>kept</b>old');
  });

  test('URLs', () => {
    expect(safeUrl('href', 'a', 'https://x')).toBe(true);
    expect(safeUrl('href', 'a', 'mailto:a@b')).toBe(true);
    expect(safeUrl('src', 'img', 'mailto:a@b')).toBe(false);
    expect(safeUrl('href', 'a', '#frag')).toBe(true);
    expect(safeUrl('src', 'img', '#frag')).toBe(false);
    expect(safeUrl('href', 'a', 'vbscript:x')).toBe(false);
    expect(safeUrl('srcset', 'source', 'https://a 1x, javascript:x 2x')).toBe(false);
    expect(safeUrl('srcset', 'source', 'https://a 1x, /b.png 2x')).toBe(true);
  });
});
