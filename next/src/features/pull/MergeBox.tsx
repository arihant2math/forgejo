// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {ChevronDownIcon, GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestDraftIcon, TrashIcon, TriangleDownIcon} from '@primer/octicons-react';
import {ActionList, ActionMenu, Banner, BranchName, ButtonGroup, Checkbox, ConfirmationDialog, FormControl, IconButton, Button as PrimerButton, Dialog as PrimerDialog, Link as PrimerLink, Textarea, TextInput, Tooltip} from '@primer/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {createElement, Fragment, type ReactNode, type RefObject, useEffect, useRef, useState} from 'react';
import {canWrite} from '../../app/access.ts';
import {failureText, online, refused} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {onlineOnly, useReach} from '../../app/online.ts';
import {apiRepoPath} from '../../app/paths.ts';
import {RouterLink} from '../../app/routerLinks.tsx';
import {useApp, useSession} from '../../app/store.ts';
import {count, noun} from '../../app/words.ts';
import {poolHead, pullOf} from '../../code/pull.ts';
import {BoxHeader} from '../../components/BorderBox.tsx';
import {Sha} from '../../components/Sha.tsx';
import {TimeAgo} from '../../components/TimeAgo.tsx';
import type {Entity} from '../../data/entity.ts';
import {editing} from '../../intents/editing.ts';
import type {PullRequest} from '../../protocol/types.gen.ts';
import {CheckStatus} from '../code/CheckStatus.tsx';
import {CodeLink} from '../code/nav.tsx';
import {deleteBranch} from '../code/refOps.ts';
import {usePool} from '../../app/store.ts';
import {type MergeStyle, pullSettingsOf} from '../settings/forms.ts';
import {ApprovalPanel, useMergeCheck} from './Approval.tsx';
import {ConflictHelp} from './ConflictHelp.tsx';
import {ReadyForReview} from './DraftControl.tsx';
import {CHECK_SUMMARY, checksOf, latestStatuses, unfinishedChecks} from './checks.ts';
import {isDraftPull} from './draft.ts';
import {bumpMergeCheck, protectionWhy} from './mergeCheck.ts';
import {mergeOptions} from './mergeStyles.ts';
import {mergedMeanwhile} from './merged.ts';
import {reviewVerdicts} from './verdicts.ts';

/** GitHub's wording for each method: the menu item, the merge button, the confirm button. */
const METHOD: Record<MergeStyle, {item: string; button: string; confirm: string}> = {
  'merge': {item: 'Create a merge commit', button: 'Merge pull request', confirm: 'Confirm merge'},
  'squash': {item: 'Squash and merge', button: 'Squash and merge', confirm: 'Confirm squash and merge'},
  'rebase': {item: 'Rebase and merge', button: 'Rebase and merge', confirm: 'Confirm rebase and merge'},
  'rebase-merge': {item: 'Rebase and create a merge commit', button: 'Rebase and merge commit', confirm: 'Confirm rebase and merge commit'},
  'fast-forward-only': {item: 'Fast-forward only', button: 'Fast-forward merge', confirm: 'Confirm fast-forward merge'},
  'manually-merged': {item: 'Mark as merged manually', button: 'Mark as merged', confirm: 'Confirm marking as merged'},
};

/** GitHub lists its three methods first. */
const METHOD_ORDER = Object.keys(METHOD);

/** Merge actions are online-only, never queued, and require write access. */
export const MergeBox = observer(function MergeBox({issue}: {issue: Entity<'Issue'>}) {
  const app = useApp();
  const session = useSession();
  const pool = usePool();
  const pr = pullOf(pool, issue.id);
  const [busy, setBusy] = useState(false);
  const [rebaseConfirm, setRebaseConfirm] = useState(false);
  const [method, setMethod] = useState<MergeStyle>();
  const [confirming, setConfirming] = useState<'now' | 'auto'>();
  const mergeButton = useRef<HTMLButtonElement>(null);
  const withoutWaiting = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLElement>(null);
  /** The button that opened the inline confirmation; Cancel gives it the focus back. */
  const opener = useRef<RefObject<HTMLButtonElement | null>>(mergeButton);
  /** Where the focus goes once the confirmation, which held it, has closed. */
  const focusAfter = useRef<RefObject<HTMLElement | null>>(undefined);
  useEffect(() => {
    if (confirming || !focusAfter.current) return;
    (focusAfter.current.current ?? mergeButton.current)?.focus();
    focusAfter.current = undefined;
  }, [confirming]);
  const repository = pr ? pool.model('Repository').get(pr.base_repo_id)?.data : undefined;
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  // Protection rules are admin-only in API v1; use Forgejo's viewer-specific verdict.
  // Keep cached checks if it fails; Forgejo enforces eligibility when merging.
  const eligibility = useMergeCheck(issue, pr);
  const reachable = useReach() === 'online';
  const mergeOffline = reachable ? undefined : onlineOnly('Merging');
  const updateOffline = reachable ? undefined : onlineOnly('Updating the branch');
  const deleteOffline = reachable ? undefined : onlineOnly('Deleting the branch');
  const cancelOffline = reachable ? undefined : onlineOnly('Canceling the auto-merge');
  if (!pr) return null;
  const repo = repository;
  const config = [...pool.model('RepoUnit').by('repo_id', pr.base_repo_id)].find((u) => u.get('type') === 'pulls')?.data.config;
  const options = mergeOptions(config ?? {});
  const deleteDefault = pullSettingsOf(config ?? {}).deleteBranch;
  const chosen = options.styles.find((m) => m.style === method) ?? (config ? options.primary : undefined);
  const auto = [...pool.model('AutoMerge').by('pull_id', pr.id)][0];
  // Treat stalled connections as offline to avoid requests hanging until their deadline.
  const isOnline = mergeOffline === undefined;
  const closed = issue.get('state') === 'closed';
  const write = canWrite(session, pr.base_repo_id);
  const path = repo ? `${apiRepoPath(repo.owner_name, repo.name)}/pulls/${String(pr.number)}` : '';
  const run = (words: {done: string; failed: string; merging?: boolean}, req: Parameters<typeof online>[1]) => {
    setBusy(true);
    online(app, req).then(() => {
      notify(app, {tone: 'success', title: words.done});
    }, async (err: unknown) => {
      // A concurrent merge is success, not an error; sync will update the page.
      const merged = words.merging ? await mergedMeanwhile(app, err, path, () => pullOf(pool, issue.id)?.merged === true) : undefined;
      if (merged) {
        notify(app, {tone: 'neutral', title: 'Already merged', description: `${merged.by ?? 'Someone'} merged this pull request before your merge went through.`});
        bumpMergeCheck(issue.id);
        return;
      }
      // Do not offer retries for deterministic server refusals (4xx).
      notify(app, {tone: 'danger', title: words.failed, description: failureText(err), ...refused(err) ? {} : {action: {label: 'Retry', run: () => {
        run(words, req);
      }}}});
    }).finally(() => {
      setBusy(false);
    });
  };
  // Send the displayed head so Forgejo rejects merges of unseen pushes.
  const headSeen = poolHead(pool, pr);
  const seen = headSeen ? {head_commit_id: headSeen} : {};
  const sum = headSeen ? checksOf(pool, pr, headSeen) : undefined;
  const checks = sum?.summary ?? 'none';
  const unfinished = sum ? unfinishedChecks(pool, sum) : 0;
  const latest = reviewVerdicts([...pool.model('Review').by('issue_id', issue.id)].map((r) => r.data));
  const changesRequested = [...latest.values()].some((r) => r.state === 'REQUEST_CHANGES');
  const behind = pr.commits_behind > 0 ? ` · ${String(pr.commits_behind)} behind ${pr.base_branch}` : '';
  // A merge-based branch update has the same conflicts as merging the pull request.
  const conflict = pr.status === 'conflict';
  const conflictWhy = conflict ? `It conflicts with ${pr.base_branch}: resolve the conflicts in the branch first.` : undefined;
  const check = eligibility.state === 'ready' ? eligibility.value : undefined;
  const draft = isDraftPull(app, editing(app).overlay, issue);
  const statuses = headSeen ? latestStatuses(pool, pr, headSeen).map((st) => ({context: st.get('context'), state: st.get('state')})) : [];
  const mergeWhy = (draft ? 'Draft pull requests cannot be merged. Mark this ready for review first.' : undefined) ?? conflictWhy ??
    protectionWhy(check, pr.base_branch, statuses) ??
    (check?.mergeable === false ? 'Forgejo says this pull request cannot be merged yet. Check the branch protection rules.' : undefined);
  const waiting = checks === 'pending';
  const mainVariant = changesRequested || checks === 'failure' ? 'default' : 'primary';
  const waitingApproval = (sum?.awaitingApproval ?? 0) > 0 || check?.actions?.need_approval === true;
  const checksTab = repo ? <RouterLink to="/$owner/$repo/pulls/$index" params={{owner: repo.owner_name, repo: repo.name, index: String(pr.number)}} search={{tab: 'checks'}} muted className="min-w-0 truncate">View checks</RouterLink> : null;
  const checksWords = waitingApproval && checks !== 'failure' ? 'Checks are waiting for a maintainer’s approval' : CHECK_SUMMARY[checks].label;
  const headRef = check?.head_repo ? check.head_repo.split('/') : [];
  const removeHeadBranch = () => {
    if (!isOnline || busy || headRef.length !== 2) return;
    setDeleteConfirm(false);
    setBusy(true);
    deleteBranch(app, {id: pr.head_repo_id, owner: headRef[0] ?? '', name: headRef[1] ?? ''}, pr.head_branch).then(() => {
      notify(app, {tone: 'success', title: `Deleted ${pr.head_branch}`});
      bumpMergeCheck(issue.id);
    }, (err: unknown) => {
      notify(app, {tone: 'danger', title: 'Deleting the branch failed', description: failureText(err)});
    }).finally(() => {setBusy(false);});
  };
  const rebaseHead = () => {
    if (!isOnline || busy || conflict || !config || !options.rebaseUpdate) return;
    setRebaseConfirm(false);
    run({done: `Rebased onto ${pr.base_branch}`, failed: 'Updating the branch failed'}, {method: 'POST', api: 'v1', path: `${path}/update?style=rebase`});
  };
  const deletable = check ? check.branch_deletable : pr.head_repo_id === pr.base_repo_id;
  let state: ReactNode;
  if (pr.merged) {
    state = (
      <>
        <GitMergeIcon size={16} className="shrink-0 text-done"/> Merged{pr.merged_at ? <> <span className="text-sm font-normal text-muted"><TimeAgo at={pr.merged_at} variant="words"/></span></> : ''}
        {pr.merge_commit_sha && repo && <span className="text-sm font-normal text-muted">as <PrimerLink as={CodeLink} owner={repo.owner_name} repo={repo.name} to={`commit/${pr.merge_commit_sha}`}><Sha sha={pr.merge_commit_sha}/></PrimerLink></span>}
      </>
    );
  } else if (closed) state = 'Closed without merging';
  else if (conflict) state = <><CheckStatus tone="danger"/> Conflicts with {pr.base_branch}{pr.conflicted_files.length ? <>: {pr.conflicted_files.map((f, i) => <Fragment key={f}>{i > 0 && ', '}<code>{f}</code></Fragment>)}</> : ''}</>;
  else if (pr.status === 'checking') state = <><CheckStatus tone="warning"/> Checking whether it can be merged…</>;
  else if (mergeWhy) state = <><CheckStatus tone="warning"/> {mergeWhy}</>;
  else if (checks === 'pending') state = <><CheckStatus summary={checks}/> {checksWords}{behind}</>;
  else if (checks === 'failure') state = <><CheckStatus summary={checks}/> {checksWords}{behind}</>;
  else state = <>{checks === 'success' ? <CheckStatus summary={checks}/> : <CheckStatus tone="success"/>} {checks === 'success' ? `${checksWords} · can be merged` : 'Can be merged'}{behind}</>;
  // Keep CI results visible even when draft, conflict, or protection status takes the headline.
  const checksLine = !pr.merged && !closed && checks !== 'none' && (mergeWhy !== undefined || conflict || pr.status === 'checking');
  return (
    <div className="relative mt-4">
      <span aria-hidden className={clsx('absolute top-0 -left-14 hidden size-10 items-center justify-center rounded-md text-onEmphasis @md/conversation:flex',
        pr.merged ? 'bg-done-emphasis' : closed ? 'bg-danger-emphasis' : draft || conflict || mergeWhy ? 'bg-neutral-emphasis' : 'bg-success-emphasis')}>
        {createElement(pr.merged ? GitMergeIcon : closed ? GitPullRequestClosedIcon : draft ? GitPullRequestDraftIcon : GitMergeIcon, {size: 24})}
      </span>
      <section ref={box} tabIndex={-1} aria-label="Merge" className="overflow-hidden rounded-md border border-default bg-default text-base">
      <BoxHeader title={state} headingLevel={3}/>
      <div className="flex flex-col gap-2 px-4 py-3">
      {checksLine && <p className="flex flex-wrap items-center gap-2 text-default"><CheckStatus summary={checks}/> {checksWords}{checks === 'pending' && !waitingApproval && unfinished ? ` (${String(unfinished)} running)` : ''} {checksTab}</p>}
      {!checksLine && !pr.merged && !closed && (checks === 'failure' || waitingApproval) && <p>{checksTab}</p>}
      {!pr.merged && !closed && waitingApproval && <ApprovalPanel issueId={issue.id} actions={check?.actions ?? undefined} waiting={(sum?.awaitingApproval ?? 0) > 0}/>}
      {!pr.merged && !closed && !waitingApproval && check?.actions?.poster_trust === 'explicitly' && <ApprovalPanel issueId={issue.id} actions={check.actions} waiting={false}/>}
      {(pr.merged || closed) && check?.branch_deletable && headRef.length === 2 && (
        <p className="flex flex-wrap items-center gap-2 text-muted">
          The branch <BranchName as="span">{pr.head_branch}</BranchName> can be deleted{pr.merged ? ': its work is merged' : ''}.
          <Tooltip text={deleteOffline ?? ''}><PrimerButton size="small" leadingVisual={TrashIcon} type="button" inactive={!isOnline || busy} onClick={() => {
            setDeleteConfirm(true);
          }}>Delete branch</PrimerButton></Tooltip>
        </p>
      )}
      {deleteConfirm && headRef.length === 2 && <PrimerDialog title="Delete branch" subtitle={`Delete ${pr.head_branch} from ${check?.head_repo ?? ''}? Its commits stay in this pull request.`} width="large" onClose={() => {setDeleteConfirm(false);}}
        footerButtons={[{content: 'Cancel', onClick: () => {setDeleteConfirm(false);}}, {content: 'Delete branch', buttonType: 'danger', leadingVisual: TrashIcon, inactive: !isOnline || busy, onClick: removeHeadBranch}]}>
        {deleteOffline && <p className="text-muted">{deleteOffline}</p>}
      </PrimerDialog>}
      {!pr.merged && !closed && draft && <ReadyForReview issue={issue}/>}
      {!pr.merged && !closed && changesRequested && <p className="text-danger">Changes requested</p>}
      {auto && !pr.merged && <p className="text-sm text-muted">Merges automatically when the checks succeed ({auto.data.merge_style}).</p>}
      {!pr.merged && !closed && path && write && (
        <div className="flex flex-wrap items-center gap-2">
          {!draft && !confirming && !auto && <>
            <ButtonGroup>
              <Tooltip text={mergeOffline ?? mergeWhy ?? (waiting ? 'Merge when all checks succeed' : 'Merge changes')}>
                <PrimerButton ref={mergeButton} size="small" variant={mainVariant} inactive={!isOnline || busy || !!mergeWhy || !chosen} onClick={() => {
                  opener.current = mergeButton;
                  if (chosen) setConfirming(waiting ? 'auto' : 'now');
                }}>{waiting ? 'Enable auto-merge' : chosen ? METHOD[chosen.style].button : 'Merge pull request'}</PrimerButton>
              </Tooltip>
              <ActionMenu>
                <ActionMenu.Anchor><IconButton size="small" icon={TriangleDownIcon} variant={mainVariant} disabled={!isOnline || busy || !!mergeWhy || !chosen}
                  aria-label="Select merge method" description={mergeOffline ?? mergeWhy ?? 'Select merge method'}/></ActionMenu.Anchor>
                <ActionMenu.Overlay width="medium"><ActionList selectionVariant="single">
                  {[...options.styles].sort((a, b) => METHOD_ORDER.indexOf(a.style) - METHOD_ORDER.indexOf(b.style)).map((m) => (
                    <ActionList.Item key={m.style} selected={m.style === chosen?.style} onSelect={() => {
                      setMethod(m.style);
                    }}>{METHOD[m.style].item}<ActionList.Description variant="block">{m.description}</ActionList.Description></ActionList.Item>
                  ))}
                </ActionList></ActionMenu.Overlay>
              </ActionMenu>
            </ButtonGroup>
            {waiting && <PrimerButton ref={withoutWaiting} size="small" variant="invisible" type="button" inactive={!isOnline || busy || !!mergeWhy || !chosen} onClick={() => {
              opener.current = withoutWaiting;
              if (chosen) setConfirming('now');
            }}>Merge without waiting</PrimerButton>}
          </>}
          {auto && <Tooltip text={cancelOffline ?? ''}><PrimerButton size="small" type="button" inactive={!isOnline || busy} onClick={() => {
            run({done: 'Auto-merge canceled', failed: 'Canceling the auto-merge failed'}, {method: 'DELETE', api: 'v1', path: `${path}/merge`});
          }}>Disable auto-merge</PrimerButton></Tooltip>}
          {pr.commits_behind > 0 && <ButtonGroup>
            <Tooltip text={updateOffline ?? conflictWhy ?? `Merge ${pr.base_branch} into this branch`}><PrimerButton size="small" type="button" inactive={!isOnline || busy || conflict} onClick={() => {
              run({done: `Updated with ${pr.base_branch}`, failed: 'Updating the branch failed'}, {method: 'POST', api: 'v1', path: `${path}/update?style=merge`});
            }}>Update branch</PrimerButton></Tooltip>
          {config && <ActionMenu>
            <ActionMenu.Anchor><IconButton size="small" icon={ChevronDownIcon} aria-label="Choose branch update method" disabled={!isOnline || busy || conflict} description={updateOffline ?? conflictWhy ?? 'Choose branch update method'}/></ActionMenu.Anchor>
            <ActionMenu.Overlay><ActionList>
              <ActionList.Item onSelect={() => {
                run({done: `Updated with ${pr.base_branch}`, failed: 'Updating the branch failed'}, {method: 'POST', api: 'v1', path: `${path}/update?style=merge`});
              }}>Update with merge commit</ActionList.Item>
              {options.rebaseUpdate && <ActionList.Item onSelect={() => {
                setRebaseConfirm(true);
              }}>Update with rebase</ActionList.Item>}
            </ActionList></ActionMenu.Overlay>
          </ActionMenu>}
          </ButtonGroup>}
          {mergeOffline && <span className="text-sm text-muted">{mergeOffline}</span>}
          {isOnline && conflictWhy && <span className="text-sm text-muted">{conflictWhy}</span>}
        </div>
      )}
      {!pr.merged && !closed && conflict && repo && <ConflictHelp pr={pr} headRepo={[check?.head_repo, pool.model('Repository').get(pr.head_repo_id)?.get('full_name')].find((n) => !!n)}
        pullPath={`/${encodeURIComponent(repo.owner_name)}/${encodeURIComponent(repo.name)}/pulls/${String(pr.number)}`}
        canPush={pr.head_repo_id === pr.base_repo_id ? write : issue.get('poster_id') === session.userId || (pr.allow_maintainer_edit && write)}/>}
      {rebaseConfirm && <ConfirmationDialog title="Update with rebase" confirmButtonContent="Rebase and force-push" confirmButtonType="primary" overrideButtonFocus="cancel" confirmButtonLoading={busy} width="large" onClose={(gesture) => {
        // rebaseHead closes the dialog only when the update can run; otherwise the reason stays in view.
        if (gesture === 'confirm') rebaseHead();
        else setRebaseConfirm(false);
      }}>
        <p>{`Replay this branch onto ${pr.base_branch}. This rewrites commits and force-pushes the head branch.`}</p>
        {(updateOffline ?? conflictWhy) && <Banner className="mt-2" variant="warning" title="The branch cannot be updated now" description={updateOffline ?? conflictWhy}/>}
      </ConfirmationDialog>}
      {confirming && chosen && (
        <ConfirmMerge key={`${chosen.style}:${confirming}`} pr={pr} title={issue.get('title')} style={chosen.style} auto={confirming === 'auto'} checks={checks} unfinished={unfinished}
          deletable={deletable} deleteDefault={deleteDefault} reason={mergeOffline ?? mergeWhy} busy={busy} onCancel={() => {
            focusAfter.current = opener.current;
            setConfirming(undefined);
          }} onMerge={(body) => {
            // The merge may remove the buttons; the box stays and reports the outcome.
            focusAfter.current = box;
            setConfirming(undefined);
            if (confirming === 'auto') {
              run({done: `Merges into ${pr.base_branch} when the checks succeed`, failed: 'Scheduling the merge failed', merging: true},
                {method: 'POST', api: 'v1', path: `${path}/merge`, body: {Do: chosen.style, merge_when_checks_succeed: true, ...body, ...seen}});
            } else {
              run({done: `Merged into ${pr.base_branch}`, failed: 'Merging failed', merging: true}, {method: 'POST', api: 'v1', path: `${path}/merge`, body: {Do: chosen.style, ...body, ...seen}, timeout: 60_000});
            }
          }}/>
      )}
      </div>
      </section>
    </div>
  );
});

/** Merging is not undone: the commit message and whether the branch goes are confirmed in the box first, as on GitHub. */
function ConfirmMerge({pr, title, style, auto, checks, unfinished, deletable, deleteDefault, reason, busy, onCancel, onMerge}: {
  pr: PullRequest; title: string; style: MergeStyle; auto: boolean; checks: string; unfinished: number; deletable: boolean; deleteDefault: boolean;
  reason: string | undefined; busy: boolean; onCancel: () => void; onMerge: (body: Record<string, unknown>) => void;
}) {
  const commit = style === 'merge' || style === 'squash' || style === 'rebase-merge';
  const [head, setHead] = useState(style === 'squash' ? `${title} (#${String(pr.number)})` : `Merge pull request '${title}' (#${String(pr.number)}) from ${pr.head_branch} into ${pr.base_branch}`);
  const [message, setMessage] = useState('');
  const [drop, setDrop] = useState(deletable && deleteDefault);
  const titleField = useRef<HTMLInputElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  // The confirmation replaces the focused button: the commit message, or Confirm when there is none, takes the focus as on GitHub.
  useEffect(() => {
    (titleField.current ?? confirmButton.current)?.focus();
  }, []);
  const merge = () => {
    onMerge({...(commit ? {MergeTitleField: head, MergeMessageField: message} : {}), delete_branch_after_merge: deletable && drop});
  };
  return (
    <section aria-label={auto ? 'Confirm auto-merge' : 'Confirm merge'} className="flex flex-col gap-3" onKeyDown={(e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onCancel();
    }}>
      {reason && <Banner variant="warning" title={reason}/>}
      {!auto && checks === 'pending' && (
        <Banner variant="warning" title={`${count(unfinished, 'check has', 'checks have')} not finished`} description={<>
          Merging now does not wait for {noun(unfinished, 'it', 'them')}. Auto-merge waits.
        </>}/>
      )}
      {!auto && checks === 'failure' && <Banner variant="critical" title="Some checks failed" description={<>Merging now merges changes whose checks did not pass.</>}/>}
      {commit && <FormControl><FormControl.Label>Commit message</FormControl.Label><TextInput ref={titleField} block value={head} onChange={(e) => {
        setHead(e.target.value);
      }}/></FormControl>}
      {commit && <FormControl><FormControl.Label>Extended description</FormControl.Label><Textarea placeholder="Add an optional extended description…" rows={4} value={message} onChange={(e) => {
        setMessage(e.target.value);
      }} block/></FormControl>}
      {deletable && <FormControl><Checkbox checked={drop} onChange={(event) => { setDrop(event.target.checked); }}/><FormControl.Label>{`Delete the branch ${pr.head_branch} afterwards`}</FormControl.Label></FormControl>}
      <div className="flex flex-wrap items-center gap-2">
        <PrimerButton ref={confirmButton} size="small" variant="primary" type="button" inactive={!!reason || busy} onClick={() => {
          if (!reason && !busy) merge();
        }}>{auto ? 'Confirm auto-merge' : METHOD[style].confirm}</PrimerButton>
        <PrimerButton size="small" type="button" onClick={onCancel}>Cancel</PrimerButton>
      </div>
    </section>
  );
}
