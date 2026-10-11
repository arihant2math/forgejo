// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

export interface FeedAction {
  id: number;
  op_type: string;
  act_user: {login: string; avatar_url?: string};
  repo: {id: number; full_name: string};
  content: string;
  ref_name: string;
  created: string;
  /** The comment a comment or review action is about (API v1 loads it with the action; absent on older actions). */
  comment_id?: number;
  comment?: {id: number; body: string} | null;
}

/** Actions whose second content part is (the first line of) a comment, not a title. */
const COMMENTS = new Set(['comment_issue', 'comment_pull', 'approve_pull_request', 'reject_pull_request']);

/** A branch or tag name from an action's ref (Forgejo stores the full ref, older actions the short name). */
function shortRef(ref: string): string {
  return ref.replace(/^refs\/(?:heads|tags)\//, '');
}

/** A ref name as path segments (a name may have slashes: "release/1.0"). */
function refPath(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

/** Markdown markers a plain-text preview drops (a list item's bullet, a heading's hashes, emphasis, code ticks). */
function plainLine(line: string): string {
  return line.replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
    .replace(/(\*\*|__|~~|`)(.+?)\1/g, '$2')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ').trim();
}

/**
 * A one-line plain-text preview of a comment's markdown: its own words first — a reply that starts by quoting
 * someone shows what it says, not the quote — else the quote without its "> " markers. Fenced code is skipped.
 */
export function commentPreview(markdown: string, max = 200): string {
  let fence = false;
  let quoted = '';
  for (const raw of markdown.split(/\r?\n/)) {
    if (/^\s{0,3}(?:```|~~~)/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const quote = /^\s{0,3}>/.test(raw);
    const text = plainLine(quote ? raw.replace(/^(?:\s{0,3}>\s?)+/, '') : raw);
    if (!text) continue;
    if (!quote) return clip(text, max);
    quoted ||= text;
  }
  return clip(quoted, max);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const verbs: Record<string, string> = {
  create_repo: 'created', rename_repo: 'renamed', star_repo: 'starred', watch_repo: 'watched',
  commit_repo: 'pushed to', mirror_sync_push: 'synced', create_issue: 'opened an issue in',
  create_pull_request: 'opened a pull request in', comment_issue: 'commented in', comment_pull: 'commented on a pull request in',
  merge_pull_request: 'merged a pull request in', auto_merge_pull_request: 'enabled auto-merge in',
  close_issue: 'closed an issue in', reopen_issue: 'reopened an issue in', close_pull_request: 'closed a pull request in',
  reopen_pull_request: 'reopened a pull request in', approve_pull_request: 'approved a pull request in',
  reject_pull_request: 'requested changes in', publish_release: 'released', push_tag: 'created a tag in',
  delete_tag: 'deleted a tag in', delete_branch: 'deleted a branch in', transfer_repo: 'transferred',
  mirror_sync_create: 'synced a ref in', mirror_sync_delete: 'removed a ref in',
  pull_review_dismissed: 'dismissed a review in', pull_request_ready_for_review: 'requested review in',
};

/** Branch and tag actions: what the row says (with the ref's name) and where it links in the repository. */
const REFS: Record<string, ((ref: string, full: string) => [string, string]) | undefined> = {
  push_tag: (ref) => [`created tag ${ref} in`, `/src/tag/${refPath(ref)}`],
  delete_tag: (ref) => [`deleted tag ${ref} in`, '/tags'],
  delete_branch: (ref) => [`deleted branch ${ref} in`, '/branches'],
  mirror_sync_create: (ref, full) => full.startsWith('refs/tags/') ?
    [`synced tag ${ref} in`, `/src/tag/${refPath(ref)}`] : [`synced branch ${ref} in`, `/src/branch/${refPath(ref)}`],
  mirror_sync_delete: (ref, full) => full.startsWith('refs/tags/') ? [`removed tag ${ref} in`, '/tags'] : [`removed branch ${ref} in`, '/branches'],
};

export function feedEntry(a: FeedAction): {path: string; text: string} {
  const repo = `/${a.repo.full_name.split('/').map(encodeURIComponent).join('/')}`;
  let path = repo;
  let detail = '';
  const refAction = REFS[a.op_type];
  if (/issue|pull/.test(a.op_type)) {
    let parts: string[];
    try { parts = JSON.parse(a.content) as string[]; } catch { parts = a.content.split('|'); }
    if (Array.isArray(parts) && /^\d+$/.test(parts[0] ?? '')) {
      // /issues/:number resolves pull requests as well (comment_issue includes PR comments).
      path = `${repo}/${a.op_type.includes('issue') ? 'issues' : 'pulls'}/${parts[0]}`;
      let text = parts[1] ?? '';
      if (COMMENTS.has(a.op_type)) {
        // Forgejo keeps only the comment's first line with the action (a quote, when the reply starts with one):
        // the comment itself, when it came along, says more. Either way as plain text, opening at the comment.
        text = commentPreview(a.comment?.body ?? text);
        const id = a.comment?.id ?? a.comment_id ?? 0;
        if (id > 0) path += `#comment-${String(id)}`;
      }
      detail = ` #${parts[0]}${text ? ` — ${text}` : ''}`;
    }
  } else if (a.op_type === 'commit_repo' || a.op_type === 'mirror_sync_push') {
    try {
      const push = JSON.parse(a.content) as {HeadCommit?: {Sha1?: string}; Commits?: {Sha1?: string}[]};
      const sha = push.HeadCommit?.Sha1 ?? push.Commits?.[0]?.Sha1;
      if (sha && /^[a-f\d]{40,64}$/i.test(sha)) path = `${repo}/commit/${sha}`;
    } catch { /* Older or empty push metadata still links to the repository. */ }
    detail = a.ref_name ? ` (${a.ref_name.replace(/^refs\/heads\//, '')})` : '';
  } else if (a.op_type === 'publish_release') {
    path = `${repo}/releases`;
    detail = ` — ${a.content || a.ref_name}`;
  } else if (refAction && shortRef(a.ref_name)) {
    // Which branch or tag: named, and linked to it (a created tag) or to the list it was in (a deleted one).
    const ref = shortRef(a.ref_name);
    const [verb, link] = refAction(ref, a.ref_name);
    return {path: `${repo}${link}`, text: `${a.act_user.login} ${verb} ${a.repo.full_name}`};
  }
  return {path, text: `${a.act_user.login} ${verbs[a.op_type] ?? 'updated'} ${a.repo.full_name}${detail}`};
}

export function feedDays(actions: FeedAction[]): [string, FeedAction[]][] {
  const days = new Map<string, FeedAction[]>();
  for (const action of actions) {
    const day = new Date(action.created).toLocaleDateString(undefined, {year: 'numeric', month: 'long', day: 'numeric'});
    const rows = days.get(day) ?? [];
    rows.push(action);
    days.set(day, rows);
  }
  return [...days];
}
