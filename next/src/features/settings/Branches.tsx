// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {apiRepoPath} from '../../app/paths.ts';
import {ResourceRow} from '../../components/ResourceRow.tsx';
import {ConfirmByName} from '../../components/ConfirmByName.tsx';
import {useRemoval} from './removal.ts';
import {FormSection} from '../usersettings/form.tsx';
import {Banner, Button, IconButton, Label, Checkbox, FormControl, Dialog, Radio, RadioGroup, TextInput, Textarea} from '@primer/react';

import {observer} from 'mobx-react-lite';
import {useState} from 'react';
import {ClassicLink} from '../../app/ClassicLink.tsx';
import {online} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {useApp} from '../../app/store.ts';
import {refTable} from '../code/hooks.ts';
import {usePool} from '../../app/store.ts';
import {ResourceList} from './bits.tsx';
import {OfflineBanner} from '../../components/OfflineBanner.tsx';
import {useReach} from '../../app/online.ts';
import type {FieldErrors} from './forms.ts';
import {problemOf} from './problems.ts';
import {fetchRules, ruleApi} from './requests.ts';
import {useResource} from '../../app/resource.ts';
import {settingsKey} from './resource.ts';
import {type BranchProtection, globMatch, type PushMode, ruleCreate, type RuleForm, ruleFormOf, rulePatch, ruleSummary, validateRule} from './rules.ts';
import {PencilIcon, ShieldCheckIcon, TrashIcon} from '@primer/octicons-react';

export const BranchSettings = observer(function BranchSettings({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const app = useApp();
  const offline = useReach() !== 'online';
  const res = useResource(settingsKey(repoId, 'protections'), (signal) => fetchRules(app, owner, repo, signal));
  const [editing, setEditing] = useState<BranchProtection | 'new' | undefined>(undefined);
  const removal = useRemoval(res, {path: (rule) => ruleApi(owner, repo, rule.rule_name), same: (a, b) => a.rule_name === b.rule_name, done: (rule) => `Removed the rule for ${rule.rule_name}`});
  const names = (res.value ?? []).map((r) => r.rule_name);
  return (
    <FormSection id="settings-branches" title="Branch protection" description="Rules for branches whose name matches: who may push, what a pull request needs before it is merged."
      actions={<Button variant="primary" size="small" leadingVisual={ShieldCheckIcon} type="button" disabled={offline || res.value === undefined} onClick={() => {
        setEditing('new');
      }}>Add rule</Button>}>
      <ResourceList res={res} what="The branch protection rules" empty={{icon: ShieldCheckIcon, title: 'No protected branches', description: 'Add a rule to protect a branch (or every branch matching a pattern) from force pushes and unreviewed merges.'}}>
        {(rules) => rules.map((r) => (
          <ResourceRow key={r.rule_name} leading={<ShieldCheckIcon size={16} className="shrink-0"/>} title={<code>{r.rule_name}</code>}
            description={<span className="flex flex-wrap gap-1">{ruleSummary(r).map((s) => <Label key={s}>{s}</Label>)}</span>}
            actions={<>
              <IconButton icon={PencilIcon} variant="invisible" size="small" aria-label={`Edit the rule for ${r.rule_name}`} type="button" disabled={offline} onClick={() => {
                setEditing(r);
              }}/>
              <IconButton icon={TrashIcon} variant="invisible" size="small" aria-label={`Remove the rule for ${r.rule_name}`} type="button" disabled={offline} onClick={() => {
                removal.ask(r);
              }}/>
            </>}/>
        ))}
      </ResourceList>
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
        Team allowlists and approval allowlists are set in the classic UI.
        <ClassicLink size="small" to={`/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/settings/branches`}>Branch rules</ClassicLink>
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
      <ConfirmByName {...removal.dialog} title={`Remove the rule for ${removal.target?.rule_name ?? ''}?`} description="The branch can then be pushed to and merged into without its requirements."
        confirmLabel="Remove rule"/>
    </FormSection>
  );
});

const PUSH: readonly {value: PushMode; label: string; caption: string}[] = [
  {value: 'writers', label: 'Anyone with write access', caption: 'Everyone who can write to the repository may push to matching branches.'},
  {value: 'listed', label: 'Only some people', caption: 'Only the people listed here may push; everyone else goes through pull requests.'},
  {value: 'none', label: 'No one', caption: 'Changes reach matching branches only by merging pull requests.'},
];

const RULE_FIELDS: Record<string, keyof RuleForm> = {rulename: 'name', branchname: 'name', 'user does not exist': 'pushUsers', requiredapprovals: 'approvals'};

const RuleDialog = observer(function RuleDialog({owner, repo, repoId, rule, others, onClose, onSaved}: {
  owner: string; repo: string; repoId: number; rule: BranchProtection | undefined; others: readonly string[];
  onClose: () => void; onSaved: (rule: BranchProtection) => void;
}) {
  const app = useApp();
  const pool = usePool();
  const offline = useReach() !== 'online';
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
    if (busy || offline) return;
    const errs = validateRule(form, others, creating);
    setErrors(errs);
    setFailure(undefined);
    if (Object.values(errs).some(Boolean)) return;
    setBusy(true);
    try {
      const saved = creating ?
        await online<BranchProtection>(app, {method: 'POST', api: 'v1', path: `${apiRepoPath(owner, repo)}/branch_protections`, body: ruleCreate(form)}) :
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
    <FormControl><Checkbox checked={form[k]} onChange={(event) => { const v = event.target.checked; set(k, v); }}/><FormControl.Label>{label}</FormControl.Label></FormControl>
  );
  return (
    <Dialog title={creating ? 'Protect a branch' : `Rule for ${rule.rule_name}`} width="xlarge" onClose={() => { if (!busy) onClose(); }} footerButtons={[
      {content: 'Cancel', disabled: busy, onClick: onClose},
      {content: busy ? 'Saving…' : creating ? 'Create rule' : 'Save rule', buttonType: 'primary', disabled: busy || offline, onClick: () => void save()},
    ]}>
      <form className="flex flex-col gap-4" noValidate onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}>
        <OfflineBanner action="Changing settings">What this device knows is shown.</OfflineBanner>
        {creating && (
          <FormControl id="rule-name"><FormControl.Label>Branch name or pattern</FormControl.Label>
            <TextInput className="w-full" value={form.name} autoFocus autoComplete="off" spellCheck={false} onChange={(e) => {
                set('name', e.target.value);
              }} {...(errors.name ? {validationStatus: 'error' as const} : {})} monospace/>
          <FormControl.Caption>{matches.length ? `Matches ${matches.slice(0, 3).join(', ')}${matches.length > 3 ? ` and ${String(matches.length - 3)} more` : ''}.` : 'A branch name, or a glob pattern such as release/* (no branch matches yet).'}</FormControl.Caption>{errors.name && <FormControl.Validation variant="error">{errors.name}</FormControl.Validation>}</FormControl>
        )}
        <div className="flex flex-col gap-2">
          <RadioGroup name="rule-push" onChange={(value) => {
            const choice = PUSH.find((p) => p.value === value);
            if (choice) set('push', choice.value);
          }}>
            <RadioGroup.Label>Who may push</RadioGroup.Label>
            {PUSH.map((choice) => (
              <FormControl key={choice.value}><Radio value={choice.value} checked={form.push === choice.value}/><FormControl.Label>{choice.label}</FormControl.Label><FormControl.Caption>{choice.caption}</FormControl.Caption></FormControl>
            ))}
          </RadioGroup>
          {form.push === 'listed' && <>
            <FormControl id="rule-push-users"><FormControl.Label>People who may push</FormControl.Label>
              <TextInput className="w-full" value={form.pushUsers} autoComplete="off" spellCheck={false} onChange={(e) => {
                  set('pushUsers', e.target.value);
                }} {...(errors.pushUsers ? {validationStatus: 'error' as const} : {})}/>
            <FormControl.Caption>Logins, separated by commas.</FormControl.Caption>{errors.pushUsers && <FormControl.Validation variant="error">{errors.pushUsers}</FormControl.Validation>}</FormControl>
            {check('pushDeployKeys', 'Deploy keys with write access may push too')}
          </>}
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="pb-2 text-base font-semibold text-default">Before merging</legend>
          <FormControl id="rule-approvals"><FormControl.Label>Required approvals</FormControl.Label>
            <TextInput className="w-24" inputMode="numeric" value={form.approvals} onChange={(e) => {
                set('approvals', e.target.value);
              }} {...(errors.approvals ? {validationStatus: 'error' as const} : {})}/>
          <FormControl.Caption>Approving reviews a pull request needs (0: none).</FormControl.Caption>{errors.approvals && <FormControl.Validation variant="error">{errors.approvals}</FormControl.Validation>}</FormControl>
          {check('dismissStale', 'Dismiss approvals when new commits are pushed')}
          {check('blockRejected', 'Block merging while changes are requested')}
          {check('blockOfficial', 'Block merging while official reviews are pending')}
          {check('blockOutdated', 'Require the branch to be up to date with its base')}
          {check('statusCheck', 'Require status checks to pass')}
          {form.statusCheck && (
            <FormControl id="rule-checks"><FormControl.Label>Status checks</FormControl.Label>
              <Textarea rows={3} value={form.statusContexts} onChange={(e) => {
                  set('statusContexts', e.target.value);
                }} block {...(errors.statusContexts ? {validationStatus: 'error' as const} : {})}/>
            <FormControl.Caption>One check per line; glob patterns (ci/*) match several.</FormControl.Caption>{errors.statusContexts && <FormControl.Validation variant="error">{errors.statusContexts}</FormControl.Validation>}</FormControl>
          )}
          {check('mergeList', 'Only some people may merge')}
          {form.mergeList && (
            <FormControl id="rule-merge-users"><FormControl.Label>People who may merge</FormControl.Label>
              <TextInput className="w-full" value={form.mergeUsers} autoComplete="off" spellCheck={false} onChange={(e) => {
                  set('mergeUsers', e.target.value);
                }}/>
            <FormControl.Caption>Logins, separated by commas.</FormControl.Caption></FormControl>
          )}
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="pb-2 text-base font-semibold text-default">Commits and files</legend>
          {check('signed', 'Require signed commits')}
          <FormControl id="rule-protected"><FormControl.Label>Protected files</FormControl.Label>
            <TextInput className="w-full" value={form.protectedFiles} spellCheck={false} onChange={(e) => {
                set('protectedFiles', e.target.value);
              }} monospace/>
          <FormControl.Caption>Glob patterns separated by “;” (docs/**; *.lock): changes to them are refused even from people who may push.</FormControl.Caption></FormControl>
          <FormControl id="rule-unprotected"><FormControl.Label>Unprotected files</FormControl.Label>
            <TextInput className="w-full" value={form.unprotectedFiles} spellCheck={false} onChange={(e) => {
                set('unprotectedFiles', e.target.value);
              }} monospace/>
          <FormControl.Caption>Glob patterns separated by “;”: pushing changes only to these is allowed even when pushing is not.</FormControl.Caption></FormControl>
          {check('applyToAdmins', 'Apply these rules to administrators too')}
        </fieldset>
        {failure && <Banner variant="critical" title="Not saved" description={<>{failure}</>}/>}
      </form>
    </Dialog>
  );
});
