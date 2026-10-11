// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The settings pages' forms ⇄ API v1's payloads (pure): what a form sends
// (only what changed, trimmed, within Forgejo's limits), and where an
// answer's validation error belongs.

import {RequestFailed} from '../../app/api.ts';

/** API v1's UserSettings (GET / PATCH /user/settings; modules/structs UserSettings). */
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

/** UserSettingsOptions: every field optional (what is not sent is not changed). */
export type SettingsPatch = Partial<UserSettings>;

/** The profile form's text fields, in the form's order. */
export const PROFILE_FIELDS = ['full_name', 'pronouns', 'website', 'location', 'description'] as const;

export type ProfileField = typeof PROFILE_FIELDS[number];

export type Profile = Record<ProfileField, string>;

/** Forgejo's limits (UserSettingsOptions' binding: MaxSize counts characters). */
export const PROFILE_LIMITS: Record<ProfileField, number> = {full_name: 100, pronouns: 50, website: 255, location: 50, description: 255};

/** The Go field names of UserSettingsOptions, as a 422's message names them ("[Website]: …"). */
const GO_FIELDS: Record<string, keyof UserSettings> = {
  FullName: 'full_name', Website: 'website', Description: 'description', Location: 'location', Pronouns: 'pronouns',
  Language: 'language', Theme: 'theme', DiffViewStyle: 'diff_view_style',
};

/** The profile's values as shown before the settings arrive: the pool's User (what every viewer sees). */
export function profileOf(s: Pick<UserSettings, ProfileField>): Profile {
  return {full_name: s.full_name, pronouns: s.pronouns, website: s.website, location: s.location, description: s.description};
}

/** What the form shows: the draft where it was edited, the current value elsewhere. */
export function shownProfile(draft: Partial<Profile>, current: Profile): Profile {
  return {...current, ...draft};
}

/**
 * The PATCH body of a profile form: the edited fields whose trimmed value differs from the current one (an
 * edit back to the current value sends nothing). Undefined when nothing changed.
 */
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

/** Whether a website is one Forgejo takes (binding ValidSiteUrl: an http(s) URL with a host). */
export function validWebsite(s: string): boolean {
  if (!s) return true;
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '';
  } catch {
    return false;
  }
}

/** What is wrong with the shown values before sending them, by field (empty: nothing). */
export function profileProblems(p: Profile): Partial<Record<ProfileField, string>> {
  const out: Partial<Record<ProfileField, string>> = {};
  for (const f of PROFILE_FIELDS) {
    const n = Array.from(p[f].trim()).length;
    if (n > PROFILE_LIMITS[f]) out[f] = `At most ${String(PROFILE_LIMITS[f])} characters (${String(n)} now).`;
  }
  if (!out.website && !validWebsite(p.website.trim())) out.website = 'A website is an http:// or https:// address.';
  return out;
}

/** A validation error of API v1 (422 "[Website]: Website is not a valid URL"): the field it names and why. */
export interface FieldError {
  field: keyof UserSettings | undefined;
  message: string;
}

/** Where an error of a settings write belongs: a field (a 422 naming one), else the form. */
export function fieldError(err: unknown): FieldError {
  const message = err instanceof Error ? err.message : String(err);
  if (!(err instanceof RequestFailed) || err.status !== 422) return {field: undefined, message};
  const m = /^\[(\w+)(?:\s\w+)*\]:\s*(.*)$/s.exec(message);
  if (!m) return {field: undefined, message};
  const why = m[2]?.trim() ?? '';
  return {field: GO_FIELDS[m[1] ?? ''], message: why !== '' ? why : message};
}

/** Whether a write failed because the session's token may not change the account (no write:user scope). */
export function scopeRefused(err: unknown): boolean {
  return err instanceof RequestFailed && err.status === 403 && /scope/i.test(err.message);
}

/** The draft after a save of `saved`: the fields saved as they are typed leave it, an edit typed meanwhile stays. */
export function keepUnsaved(draft: Partial<Profile>, saved: SettingsPatch): Partial<Profile> {
  const out: Partial<Profile> = {};
  for (const f of PROFILE_FIELDS) {
    const v = draft[f];
    if (v !== undefined && v.trim() !== saved[f]) out[f] = v;
  }
  return out;
}

/** The settings with a patch applied (the optimistic copy). */
export function applyPatch(s: UserSettings, patch: SettingsPatch): UserSettings {
  return {...s, ...patch};
}

/**
 * Undoes a failed patch: each field goes back to what it was before, unless it changed since (a later write
 * that succeeded, or Forgejo's answer).
 */
export function revertPatch(now: UserSettings, before: UserSettings, patch: SettingsPatch): UserSettings {
  const out = {...now} as Record<string, unknown>;
  for (const k of Object.keys(patch) as (keyof UserSettings)[]) {
    if (now[k] === patch[k]) out[k] = before[k];
  }
  return out as unknown as UserSettings;
}

// ---- Emails ----

/** API v1's Email (/user/emails). */
export interface ApiEmail {
  email: string;
  verified: boolean;
  primary: boolean;
}

/** Loosely an email address (Forgejo checks for real): something@host. */
export function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(s.trim());
}

/** The primary address first, then by address. */
export function sortEmails(list: readonly ApiEmail[]): ApiEmail[] {
  return [...list].sort((a, b) => Number(b.primary) - Number(a.primary) || a.email.localeCompare(b.email));
}

/** The list with `email` primary (the optimistic copy of "Set as primary"). */
export function withPrimary(list: readonly ApiEmail[], email: string): ApiEmail[] {
  const lower = email.toLowerCase();
  return list.map((e) => ({...e, primary: e.email.toLowerCase() === lower}));
}

/** The list with `added` merged in (an address already listed is replaced). */
export function mergeEmails(list: readonly ApiEmail[], added: readonly ApiEmail[]): ApiEmail[] {
  const seen = new Set(added.map((e) => e.email.toLowerCase()));
  return [...list.filter((e) => !seen.has(e.email.toLowerCase())), ...added];
}

// ---- Keys ----

/** API v1's PublicKey (/user/keys). */
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

/** API v1's GPGKey (/user/gpg_keys). */
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

/** An SSH public key as pasted: its type, its base64 body and its comment (the title it suggests). */
export function parseSshKey(text: string): {type: string; comment: string} | undefined {
  const [type = '', body = '', ...comment] = text.trim().split(/\s+/);
  if (!SSH_TYPES.test(type) || !/^[A-Za-z0-9+/]+={0,3}$/.test(body)) return undefined;
  return {type, comment: comment.join(' ')};
}

/** What is wrong with a pasted SSH key before sending it (Forgejo checks it for real), or undefined. */
export function sshKeyProblem(text: string): string | undefined {
  const t = text.trim();
  if (!t) return 'Paste a public key.';
  if (t.includes('PRIVATE KEY')) return 'This is a private key: paste the public one (the .pub file).';
  if (t.startsWith('---- BEGIN SSH2 PUBLIC KEY')) return undefined; // RFC 4716: Forgejo converts it
  return parseSshKey(t) ? undefined : 'This does not look like an SSH public key (ssh-ed25519 AAAA…).';
}

/** The title an SSH key is added with: the one typed, else the key's comment, else its type. */
export function sshKeyTitle(title: string, key: string): string {
  const t = title.trim();
  if (t) return t;
  const parsed = parseSshKey(key);
  if (parsed?.comment) return parsed.comment;
  return parsed?.type ?? 'SSH key';
}

/** What is wrong with a pasted GPG key before sending it, or undefined. */
export function gpgKeyProblem(text: string): string | undefined {
  const t = text.trim();
  if (!t) return 'Paste a public key.';
  if (t.includes('BEGIN PGP PRIVATE KEY')) return 'This is a private key: paste the public one (gpg --armor --export).';
  return t.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----') ? undefined : 'An armored public key starts with -----BEGIN PGP PUBLIC KEY BLOCK-----.';
}

/** A GPG key id as GPG shows it: groups of four. */
export function spacedKeyId(id: string): string {
  return id.toUpperCase().replace(/(.{4})(?=.)/g, '$1 ');
}

/** Whether a key expired (a zero time is "never"). */
export function expired(iso: string, now = Date.now()): boolean {
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t > 0 && t < now;
}

// ---- Avatar ----

/** The largest picture sent (Forgejo's [picture] AVATAR_MAX_FILE_SIZE is 1 MiB by default; it answers why for more). */
export const AVATAR_MAX = 5 * 1024 * 1024;

/** Bytes as base64 (UpdateUserAvatarOption.image). */
export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(bin);
}

// ---- Appearance ----

/** Forgejo's diff views (diff_view_style; empty is unified). */
export type DiffStyle = 'unified' | 'split';

export function diffStyleOf(s: string): DiffStyle {
  return s === 'split' ? 'split' : 'unified';
}
