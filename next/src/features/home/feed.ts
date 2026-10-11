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

export function feedEntry(a: FeedAction): {path: string; text: string} {
  const repo = `/${a.repo.full_name.split('/').map(encodeURIComponent).join('/')}`;
  let path = repo;
  let detail = '';
  if (/issue|pull/.test(a.op_type)) {
    let parts: string[];
    try { parts = JSON.parse(a.content) as string[]; } catch { parts = a.content.split('|'); }
    if (Array.isArray(parts) && /^\d+$/.test(parts[0] ?? '')) {
      // /issues/:number resolves pull requests as well (comment_issue includes PR comments).
      path = `${repo}/${a.op_type.includes('issue') ? 'issues' : 'pulls'}/${parts[0]}`;
      detail = ` #${parts[0]}${parts[1] ? ` — ${parts[1]}` : ''}`;
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
