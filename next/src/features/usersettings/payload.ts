// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {RequestFailed} from '../../app/api.ts';

export interface UserSettings {
  full_name: string;
  website: string;
  description: string;
  location: string;
  pronouns: string;
  language: string;
  theme: string;
  diff_view_style: string;
  enable_repo_unit_hints: boolean;
  hide_email: boolean;
  hide_pronouns: boolean;
  hide_activity: boolean;
}

/** Omitted fields remain unchanged. */
export type SettingsPatch = Partial<UserSettings>;

export const PROFILE_FIELDS = ['full_name', 'pronouns', 'website', 'location', 'description'] as const;

export type ProfileField = typeof PROFILE_FIELDS[number];

export type Profile = Record<ProfileField, string>;

/** Forgejo's MaxSize limits count Unicode characters, not UTF-16 units. */
export const PROFILE_LIMITS: Record<ProfileField, number> = {full_name: 100, pronouns: 50, website: 255, location: 50, description: 255};

/** The profile form's fields by Forgejo's lower-case binding names, for problemOf. */
export const PROFILE_API_FIELDS: Readonly<Record<string, ProfileField>> = {
  fullname: 'full_name', website: 'website', description: 'description', location: 'location', pronouns: 'pronouns',
};

export function profileOf(s: Pick<UserSettings, ProfileField>): Profile {
  return {full_name: s.full_name, pronouns: s.pronouns, website: s.website, location: s.location, description: s.description};
}

export function shownProfile(draft: Partial<Profile>, current: Profile): Profile {
  return {...current, ...draft};
}

/** Send only edited values that differ after trimming; undefined means no changes. */
export function profilePayload(draft: Partial<Profile>, current: Profile): SettingsPatch | undefined {
  const out: SettingsPatch = {};
  let any = false;
  for (const f of PROFILE_FIELDS) {
    const v = draft[f];
    if (v === undefined) continue;
    const t = v.trim();
    if (t === current[f]) continue;
    out[f] = t;
    any = true;
  }
  return any ? out : undefined;
}

export function validWebsite(s: string): boolean {
  if (!s) return true;
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '';
  } catch {
    return false;
  }
}

export function profileProblems(p: Profile): Partial<Record<ProfileField, string>> {
  const out: Partial<Record<ProfileField, string>> = {};
  for (const f of PROFILE_FIELDS) {
    const n = Array.from(p[f].trim()).length;
    if (n > PROFILE_LIMITS[f]) out[f] = `At most ${String(PROFILE_LIMITS[f])} characters (${String(n)} now).`;
  }
  if (!out.website && !validWebsite(p.website.trim())) out.website = 'A website is an http:// or https:// address.';
  return out;
}

export function scopeRefused(err: unknown): boolean {
  return err instanceof RequestFailed && err.status === 403 && /scope/i.test(err.message);
}

/** Clear saved draft values only if they still match, preserving in-flight edits. */
export function keepUnsaved(draft: Partial<Profile>, saved: SettingsPatch): Partial<Profile> {
  const out: Partial<Profile> = {};
  for (const f of PROFILE_FIELDS) {
    const v = draft[f];
    if (v !== undefined && v.trim() !== saved[f]) out[f] = v;
  }
  return out;
}

export function applyPatch(s: UserSettings, patch: SettingsPatch): UserSettings {
  return {...s, ...patch};
}

/** Revert failed fields only if unchanged since the patch, preserving later writes. */
export function revertPatch(now: UserSettings, before: UserSettings, patch: SettingsPatch): UserSettings {
  const out = {...now} as Record<string, unknown>;
  for (const k of Object.keys(patch) as (keyof UserSettings)[]) {
    if (now[k] === patch[k]) out[k] = before[k];
  }
  return out as unknown as UserSettings;
}


export interface ApiEmail {
  email: string;
  verified: boolean;
  primary: boolean;
}

export function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(s.trim());
}

/** Primary first, then alphabetical. */
export function sortEmails(list: readonly ApiEmail[]): ApiEmail[] {
  return [...list].sort((a, b) => Number(b.primary) - Number(a.primary) || a.email.localeCompare(b.email));
}

export function withPrimary(list: readonly ApiEmail[], email: string): ApiEmail[] {
  const lower = email.toLowerCase();
  return list.map((e) => ({...e, primary: e.email.toLowerCase() === lower}));
}

/** Replace a matching address rather than duplicating it. */
export function mergeEmails(list: readonly ApiEmail[], added: readonly ApiEmail[]): ApiEmail[] {
  const seen = new Set(added.map((e) => e.email.toLowerCase()));
  return [...list.filter((e) => !seen.has(e.email.toLowerCase())), ...added];
}


export interface ApiPublicKey {
  id: number;
  key: string;
  title?: string;
  fingerprint?: string;
  created_at: string;
  updated_at?: string;
  key_type?: string;
  read_only?: boolean;
  verified?: boolean;
}

export interface ApiGPGKey {
  id: number;
  key_id: string;
  primary_key_id: string;
  emails: {email: string; verified: boolean}[] | null;
  subkeys: {key_id: string}[] | null;
  can_sign: boolean;
  verified: boolean;
  created_at: string;
  expires_at: string;
}

const SSH_TYPES = /^(?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-nistp(?:256|384|521)|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)$/;

export function parseSshKey(text: string): {type: string; comment: string} | undefined {
  const [type = '', body = '', ...comment] = text.trim().split(/\s+/);
  if (!SSH_TYPES.test(type) || !/^[A-Za-z0-9+/]+={0,3}$/.test(body)) return undefined;
  return {type, comment: comment.join(' ')};
}

export function sshKeyProblem(text: string): string | undefined {
  const t = text.trim();
  if (!t) return 'Paste a public key.';
  if (t.includes('PRIVATE KEY')) return 'This is a private key: paste the public one (the .pub file).';
  if (t.startsWith('---- BEGIN SSH2 PUBLIC KEY')) return undefined; // RFC 4716: Forgejo converts it
  return parseSshKey(t) ? undefined : 'This does not look like an SSH public key (ssh-ed25519 AAAA…).';
}

/** Title fallback: typed title, key comment, then key type. */
export function sshKeyTitle(title: string, key: string): string {
  const t = title.trim();
  if (t) return t;
  const parsed = parseSshKey(key);
  if (parsed?.comment) return parsed.comment;
  return parsed?.type ?? 'SSH key';
}

export function gpgKeyProblem(text: string): string | undefined {
  const t = text.trim();
  if (!t) return 'Paste a public key.';
  if (t.includes('BEGIN PGP PRIVATE KEY')) return 'This is a private key: paste the public one (gpg --armor --export).';
  return t.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----') ? undefined : 'An armored public key starts with -----BEGIN PGP PUBLIC KEY BLOCK-----.';
}

/** Format key IDs in groups of four, as GPG displays them. */
export function spacedKeyId(id: string): string {
  return id.toUpperCase().replace(/(.{4})(?=.)/g, '$1 ');
}

/** A zero expiration time means never. */
export function expired(iso: string, now = Date.now()): boolean {
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t > 0 && t < now;
}


/** Client ceiling; the server enforces its own limit (1 MiB by default). */
export const AVATAR_MAX = 5 * 1024 * 1024;

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(bin);
}


/** An empty diff_view_style means unified. */
export type DiffStyle = 'unified' | 'split';

export function diffStyleOf(s: string): DiffStyle {
  return s === 'split' ? 'split' : 'unified';
}
