// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Branch protection rules (/{owner}/{repo}/settings/branches): the rules
// from API v1 (kept for the next visit), a dialog that creates or edits one
// (an edit sends only what changed, so what the form does not show — teams,
// approval allowlists — stays), and deletion after a confirmation.

import {Pencil, ShieldCheck, Trash2} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';
import {ClassicLink} from '../../app/ClassicLink.tsx';
import {online} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {useApp} from '../../app/store.ts';
import {
  Badge, Button, Callout, Checkbox, Code, ConfirmDialog, Dialog, Entry, Field, FormSection, hintId, Icon, IconButton, Input, SegmentedControl, TextArea,
} from '../../ui/index.ts';
import {refTable} from '../code/hooks.ts';
import {usePool} from '../issues/cells.tsx';
import {ResourceList, useOffline} from './bits.tsx';
import type {FieldErrors} from './forms.ts';
import {problemOf} from './problems.ts';
import {fetchRules, repoApi, ruleApi} from './requests.ts';
import {settingsKey, useResource} from './resource.ts';
import {type BranchProtection, globMatch, type PushMode, ruleCreate, type RuleForm, ruleFormOf, rulePatch, ruleSummary, validateRule} from './rules.ts';

export const BranchSettings = observer(function BranchSettings({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const app = useApp();
  const offline = useOffline();
  const res = useResource(settingsKey(repoId, 'protections'), (signal) => fetchRules(app, owner, repo, signal));
  const [editing, setEditing] = useState<BranchProtection | 'new' | undefined>(undefined);
  const [deleting, setDeleting] = useState<BranchProtection | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const names = (res.value ?? []).map((r) => r.rule_name);
  const remove = async (rule: BranchProtection) => {
    setBusy(true);
    setError(undefined);
    try {
      await online(app, {method: 'DELETE', api: 'v1', path: ruleApi(owner, repo, rule.rule_name)});
      res.update((list) => (list ?? []).filter((r) => r.rule_name !== rule.rule_name));
      setDeleting(undefined);
      notify(app, {tone: 'success', title: `Removed the rule for ${rule.rule_name}`});
    } catch (err) {
      setError(problemOf(err).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormSection id="settings-branches" title="Branch protection" description="Rules for branches whose name matches: who may push, what a pull request needs before it is merged."
      actions={<Button size="sm" variant="primary" icon={ShieldCheck} disabled={offline || res.value === undefined} onClick={() => {
        setEditing('new');
      }}>Add rule</Button>}>
      <ResourceList res={res} what="The branch protection rules" empty={{icon: ShieldCheck, title: 'No protected branches', description: 'Add a rule to protect a branch (or every branch matching a pattern) from force pushes and unreviewed merges.'}}>
        {(rules) => rules.map((r) => (
          <Entry key={r.rule_name} leading={<Icon icon={ShieldCheck} size="sm"/>} title={<Code>{r.rule_name}</Code>}
            description={<span className="flex flex-wrap gap-1">{ruleSummary(r).map((s) => <Badge key={s}>{s}</Badge>)}</span>}
            actions={<>
              <IconButton size="sm" icon={Pencil} label={`Edit the rule for ${r.rule_name}`} disabled={offline} onClick={() => {
                setEditing(r);
              }}/>
              <IconButton size="sm" icon={Trash2} label={`Remove the rule for ${r.rule_name}`} disabled={offline} onClick={() => {
                setError(undefined);
                setDeleting(r);
              }}/>
            </>}/>
        ))}
      </ResourceList>
      <p className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
        Team allowlists and approval allowlists are set in the classic UI.
        <ClassicLink size="sm" to={`/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/settings/branches`}>Branch rules</ClassicLink>
      </p>
      {editing && <RuleDialog key={editing === 'new' ? '' : editing.rule_name} owner={owner} repo={repo} repoId={repoId} rule={editing === 'new' ? undefined : editing}
        others={names} onClose={() => {
          setEditing(undefined);
        }} onSaved={(saved) => {
          res.update((list) => {
            const rest = (list ?? []).filter((r) => r.rule_name !== saved.rule_name);
            return [...rest, saved].sort((a, b) => a.rule_name.localeCompare(b.rule_name));
          });
          setEditing(undefined);
        }}/>}
      <ConfirmDialog open={deleting !== undefined} onOpenChange={(o) => {
        if (!o && !busy) setDeleting(undefined);
      }} title={`Remove the rule for ${deleting?.rule_name ?? ''}?`} description="The branch can then be pushed to and merged into without its requirements."
      confirmLabel="Remove rule" busy={busy} error={error} onConfirm={() => {
        if (deleting) void remove(deleting);
      }}/>
    </FormSection>
  );
});

const PUSH: readonly {value: PushMode; label: string}[] = [
  {value: 'writers', label: 'Anyone with write access'},
  {value: 'listed', label: 'Only some people'},
  {value: 'none', label: 'No one'},
];

const RULE_FIELDS: Record<string, keyof RuleForm> = {rulename: 'name', branchname: 'name', 'user does not exist': 'pushUsers', requiredapprovals: 'approvals'};

/** Creates or edits a rule. */
const RuleDialog = observer(function RuleDialog({owner, repo, repoId, rule, others, onClose, onSaved}: {
  owner: string; repo: string; repoId: number; rule: BranchProtection | undefined; others: readonly string[];
  onClose: () => void; onSaved: (rule: BranchProtection) => void;
}) {
  const app = useApp();
  const pool = usePool();
  const [form, setForm] = useState<RuleForm>(() => ruleFormOf(rule));
  const [errors, setErrors] = useState<FieldErrors<keyof RuleForm>>({});
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const creating = rule === undefined;
  const set = <K extends keyof RuleForm>(k: K, v: RuleForm[K]) => {
    setForm({...form, [k]: v});
    if (errors[k]) setErrors({...errors, [k]: undefined});
  };
  const name = form.name.trim();
  const matches = name ? [...refTable(pool, repoId).branches.keys()].filter((b) => globMatch(name, b)) : [];
  const save = async () => {
    const errs = validateRule(form, others, creating);
    setErrors(errs);
    setFailure(undefined);
    if (Object.values(errs).some(Boolean)) return;
    setBusy(true);
    try {
      const saved = creating ?
        await online<BranchProtection>(app, {method: 'POST', api: 'v1', path: `${repoApi(owner, repo)}/branch_protections`, body: ruleCreate(form)}) :
        await online<BranchProtection>(app, {method: 'PATCH', api: 'v1', path: ruleApi(owner, repo, rule.rule_name), body: rulePatch(rule, form)});
      if (saved) onSaved({...saved, rule_name: saved.rule_name || (saved.branch_name ?? '') || name});
      else onClose();
      notify(app, {tone: 'success', title: creating ? `${name} is protected` : `Saved the rule for ${rule.rule_name}`});
    } catch (err) {
      const p = problemOf(err, RULE_FIELDS);
      if (p.field) setErrors({[p.field]: p.message});
      else setFailure(p.message);
    } finally {
      setBusy(false);
    }
  };
  const check = (k: 'dismissStale' | 'blockRejected' | 'blockOfficial' | 'blockOutdated' | 'signed' | 'applyToAdmins' | 'pushDeployKeys' | 'statusCheck' | 'mergeList', label: string) => (
    <Checkbox label={label} checked={form[k]} onChange={(v) => {
      set(k, v);
    }}/>
  );
  return (
    <Dialog open size="lg" scroll title={creating ? 'Protect a branch' : `Rule for ${rule.rule_name}`} onOpenChange={(o) => {
      if (!o && !busy) onClose();
    }} footer={<>
      <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : creating ? 'Create rule' : 'Save rule'}</Button>
    </>}>
      <form className="flex flex-col gap-4" noValidate onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}>
        {creating && (
          <Field htmlFor="rule-name" errorId={hintId('rule-name')} label="Branch name or pattern" error={errors.name}
            hint={matches.length ? `Matches ${matches.slice(0, 3).join(', ')}${matches.length > 3 ? ` and ${String(matches.length - 3)} more` : ''}.` : 'A branch name, or a glob pattern such as release/* (no branch matches yet).'}>
            <Input id="rule-name" className="w-full" mono value={form.name} autoFocus autoComplete="off" spellCheck={false} invalid={Boolean(errors.name)}
              aria-describedby={hintId('rule-name')} onChange={(e) => {
                set('name', e.target.value);
              }}/>
          </Field>
        )}
        <fieldset className="flex flex-col gap-2">
          <legend className="pb-1 text-base font-medium text-fg">Who may push</legend>
          <SegmentedControl label="Who may push" value={form.push} options={PUSH} onChange={(v) => {
            set('push', v);
          }}/>
          {form.push === 'listed' && <>
            <Field htmlFor="rule-push-users" errorId={hintId('rule-push-users')} label="People who may push" error={errors.pushUsers} hint="Logins, separated by commas.">
              <Input id="rule-push-users" className="w-full" value={form.pushUsers} autoComplete="off" spellCheck={false} invalid={Boolean(errors.pushUsers)}
                aria-describedby={hintId('rule-push-users')} onChange={(e) => {
                  set('pushUsers', e.target.value);
                }}/>
            </Field>
            {check('pushDeployKeys', 'Deploy keys with write access may push too')}
          </>}
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="pb-1 text-base font-medium text-fg">Before merging</legend>
          <Field htmlFor="rule-approvals" errorId={hintId('rule-approvals')} label="Required approvals" error={errors.approvals} hint="Approving reviews a pull request needs (0: none).">
            <Input id="rule-approvals" className="w-24" inputMode="numeric" value={form.approvals} invalid={Boolean(errors.approvals)} aria-describedby={hintId('rule-approvals')}
              onChange={(e) => {
                set('approvals', e.target.value);
              }}/>
          </Field>
          {check('dismissStale', 'Dismiss approvals when new commits are pushed')}
          {check('blockRejected', 'Block merging while changes are requested')}
          {check('blockOfficial', 'Block merging while official reviews are pending')}
          {check('blockOutdated', 'Require the branch to be up to date with its base')}
          {check('statusCheck', 'Require status checks to pass')}
          {form.statusCheck && (
            <Field htmlFor="rule-checks" errorId={hintId('rule-checks')} label="Status checks" error={errors.statusContexts} hint="One check per line; glob patterns (ci/*) match several.">
              <TextArea id="rule-checks" rows={3} value={form.statusContexts} invalid={Boolean(errors.statusContexts)} aria-describedby={hintId('rule-checks')}
                onChange={(e) => {
                  set('statusContexts', e.target.value);
                }}/>
            </Field>
          )}
          {check('mergeList', 'Only some people may merge')}
          {form.mergeList && (
            <Field htmlFor="rule-merge-users" errorId={hintId('rule-merge-users')} label="People who may merge" hint="Logins, separated by commas.">
              <Input id="rule-merge-users" className="w-full" value={form.mergeUsers} autoComplete="off" spellCheck={false} aria-describedby={hintId('rule-merge-users')}
                onChange={(e) => {
                  set('mergeUsers', e.target.value);
                }}/>
            </Field>
          )}
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="pb-1 text-base font-medium text-fg">Commits and files</legend>
          {check('signed', 'Require signed commits')}
          <Field htmlFor="rule-protected" errorId={hintId('rule-protected')} label="Protected files" optional hint="Glob patterns separated by “;” (docs/**; *.lock): changes to them are refused even from people who may push.">
            <Input id="rule-protected" className="w-full" mono value={form.protectedFiles} spellCheck={false} aria-describedby={hintId('rule-protected')}
              onChange={(e) => {
                set('protectedFiles', e.target.value);
              }}/>
          </Field>
          <Field htmlFor="rule-unprotected" errorId={hintId('rule-unprotected')} label="Unprotected files" optional hint="Glob patterns separated by “;”: pushing changes only to these is allowed even when pushing is not.">
            <Input id="rule-unprotected" className="w-full" mono value={form.unprotectedFiles} spellCheck={false} aria-describedby={hintId('rule-unprotected')}
              onChange={(e) => {
                set('unprotectedFiles', e.target.value);
              }}/>
          </Field>
          {check('applyToAdmins', 'Apply these rules to administrators too')}
        </fieldset>
        {failure && <Callout tone="danger" title="Not saved">{failure}</Callout>}
      </form>
    </Dialog>
  );
});
