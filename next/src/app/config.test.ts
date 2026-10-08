// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {afterEach, expect, test} from 'vitest';
import {NextConfigElementID, type NextConfig} from '../protocol/types.gen.ts';
import {isLocalPath, readConfigBlock, redirectUri, sitePath, uiPath} from './config.ts';

const oauth = {client_id: 'c', redirect_uri: `${location.origin}/git/-/next/callback`, scope: 's', authorize_url: '/git/login/oauth/authorize', token_url: '/git/login/oauth/access_token'};
const sub: NextConfig = {app_url: 'https://code.example/git/', app_sub_url: '/git', base: '/git/-/next/', app_name: 'F', version: '1', protocol: 1, oauth};

afterEach(() => {
  document.getElementById(NextConfigElementID)?.remove();
});

function block(text: string, type = 'application/json') {
  const el = document.createElement('script');
  el.id = NextConfigElementID;
  el.type = type;
  el.textContent = text;
  document.head.append(el);
}

test('the config block is read from the document; a broken one is ignored', () => {
  expect(readConfigBlock()).toBeUndefined();
  block(JSON.stringify(sub));
  expect(readConfigBlock()).toEqual(sub);
  document.getElementById(NextConfigElementID)?.remove();
  block('{not json');
  expect(readConfigBlock()).toBeUndefined();
  document.getElementById(NextConfigElementID)?.remove();
  block(JSON.stringify({...sub, base: '/other/-/next/'}));
  expect(readConfigBlock()).toBeUndefined(); // base outside the sub-path
  document.getElementById(NextConfigElementID)?.remove();
  block(JSON.stringify(sub), 'text/plain');
  expect(readConfigBlock()).toBeUndefined();
});

test('URLs under a sub-path come from the config', () => {
  expect(sitePath(sub, '/api/v1/user')).toBe('/git/api/v1/user');
  expect(uiPath(sub, 'callback')).toBe('/git/-/next/callback');
  expect(redirectUri(sub)).toBe(`${location.origin}/git/-/next/callback`);
  // AppURL on another origin than the page (dev server): this origin's callback.
  expect(redirectUri({...sub, oauth: {...oauth, redirect_uri: 'https://code.example/git/-/next/callback'}})).toBe(`${location.origin}/git/-/next/callback`);
  expect(redirectUri({...sub, oauth: null})).toBeUndefined();
});

test('local paths: inside the sub-path, no other origin', () => {
  expect(isLocalPath(sub, '/git/acme/website/issues?state=open')).toBe(true);
  expect(isLocalPath(sub, '/git')).toBe(true);
  for (const p of ['/gitx/a', '/acme/website', '//evil.example/git/', '/git\\..\\x', 'https://evil.example/git/', 'git/a', '/\t/evil.example']) {
    expect(isLocalPath(sub, p), p).toBe(false);
  }
});
