// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {SettingsEntry} from './SettingsEntry.tsx';
import {RepositoryConfirmation} from './RepositoryConfirmation.tsx';
import {FormSection} from '../usersettings/form.tsx';
import {Banner, Tooltip, Select, SegmentedControl, Button, IconButton, LinkButton, Label, Checkbox, FormControl, Dialog, TextInput} from '@primer/react';

// A repository's webhooks (/{owner}/{repo}/settings/hooks): the hooks from
// API v1 (kept for the next visit, their authorization headers in memory
// only), a dialog that creates a Forgejo webhook or edits a Forgejo or
// Gitea one (other types — Slack, Matrix, … — are edited in the classic
// UI), a test delivery, and deletion after a confirmation.
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';
import {ClassicLink, classicHref} from '../../app/ClassicLink.tsx';
import {online} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {useApp} from '../../app/store.ts';
import {OfflineNote, ResourceList, useOffline} from './bits.tsx';
import type {FieldErrors} from './forms.ts';
import {problemOf} from './problems.ts';
import {fetchHook, fetchHooks, repoApi, storedHooks} from './requests.ts';
import {settingsKey, useResource} from './resource.ts';
import {editableHook, type EventsMode, type Hook, HOOK_EVENTS, hookCreate, type HookForm, hookFormOf, hookPatch, hookSummary, validateHook} from './rules.ts';
import {PencilIcon, PlusIcon, PaperAirplaneIcon, DotFillIcon, TrashIcon, WebhookIcon} from '@primer/octicons-react';

export const HookSettings = observer(function HookSettings({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const app = useApp();
  const offline = useOffline();
  const res = useResource(settingsKey(repoId, 'hooks'), (signal) => fetchHooks(app, owner, repo, signal), storedHooks);
  const [editing, setEditing] = useState<Hook | 'new' | undefined>(undefined);
  const [deleting, setDeleting] = useState<Hook | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const base = repoApi(owner, repo);
  const test = (h: Hook) => {
    online(app, {method: 'POST', api: 'v1', path: `${base}/hooks/${String(h.id)}/tests`}).then(() => {
      notify(app, {tone: 'success', title: 'Test delivery sent', description: `A push event to ${hookUrl(h)}. Its delivery is listed in the classic UI.`});
    }, (err: unknown) => {
      notify(app, {tone: 'danger', title: 'The test delivery was not sent', description: problemOf(err).message});
    });
  };
  const remove = async (h: Hook) => {
    if (busy || offline) return;
    setBusy(true);
    setError(undefined);
    try {
      await online(app, {method: 'DELETE', api: 'v1', path: `${base}/hooks/${String(h.id)}`});
      res.update((list) => (list ?? []).filter((x) => x.id !== h.id));
      setDeleting(undefined);
      notify(app, {tone: 'success', title: 'Webhook deleted'});
    } catch (err) {
      setError(problemOf(err).message);
    } finally {
      setBusy(false);
    }
  };
  const repoPath = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return (
    <FormSection id="settings-hooks" title="Webhooks" description="Forgejo sends a request to these addresses when something happens in the repository."
      actions={<Button variant="primary" size="small" leadingVisual={PlusIcon} type="button" disabled={offline} onClick={() => {
        setEditing('new');
      }}>Add webhook</Button>}>
      <ResourceList res={res} what="The webhooks" empty={{icon: WebhookIcon, title: 'No webhooks', description: 'Add one to tell another service about pushes, issues, pull requests and releases.'}}>
        {(hooks) => hooks.map((h) => (
          <SettingsEntry key={h.id} leading={<span className="flex size-4 items-center justify-center"><DotFillIcon className={h.active ? 'text-success' : 'text-muted'} aria-label={h.active ? 'Active' : 'Inactive'}/></span>}
            title={hookUrl(h)} meta={h.active ? undefined : 'inactive'}
            description={<span className="flex flex-wrap items-center gap-1"><Label>{h.type}</Label>{hookSummary(h)}{h.branch_filter && h.branch_filter !== '*' ? ` · branches ${h.branch_filter}` : ''}</span>}
            actions={<>
              <IconButton icon={PaperAirplaneIcon} variant="invisible" size="small" aria-label="Send a test delivery" type="button" disabled={offline} onClick={() => {
                test(h);
              }}/>
              {editableHook(h.type) ?
                <IconButton icon={PencilIcon} variant="invisible" size="small" aria-label="Edit the webhook" type="button" disabled={offline} onClick={() => {
                  setEditing(h);
                }}/> :
                <Tooltip text="Opens in the classic Forgejo UI"><LinkButton variant="invisible" size="small" href={classicHref(app, `${repoPath}/settings/hooks/${String(h.id)}`)} data-classic="">Edit</LinkButton></Tooltip>}
              <IconButton icon={TrashIcon} variant="invisible" size="small" aria-label="Delete the webhook" type="button" disabled={offline} onClick={() => {
                setError(undefined);
                setDeleting(h);
              }}/>
            </>}/>
        ))}
      </ResourceList>
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
        Other kinds of webhooks (Slack, Matrix, Discord, …), the delivery history and Git hooks are in the classic UI.
        <ClassicLink size="small" to={`${repoPath}/settings/hooks`}>Webhooks</ClassicLink>
      </p>
      {editing && <HookDialog key={editing === 'new' ? 0 : editing.id} owner={owner} repo={repo} hook={editing === 'new' ? undefined : editing} onClose={() => {
        setEditing(undefined);
      }} onSaved={(saved) => {
        res.update((list) => [...(list ?? []).filter((x) => x.id !== saved.id), saved].sort((a, b) => a.id - b.id));
        setEditing(undefined);
      }}/>}
      <RepositoryConfirmation open={deleting !== undefined} onOpenChange={(o) => {
        if (!o && !busy) setDeleting(undefined);
      }} title="Delete this webhook?" description={deleting ? `Forgejo stops sending events to ${hookUrl(deleting)}.` : undefined}
      confirmLabel="Delete webhook" busy={busy} error={error} onConfirm={() => {
        if (deleting) void remove(deleting);
      }}/>
    </FormSection>
  );
});

function hookUrl(h: Hook): string {
  return h.config.url ?? h.url ?? '';
}

const MODES: readonly {value: EventsMode; label: string}[] = [
  {value: 'push', label: 'Push only'},
  {value: 'all', label: 'Everything'},
  {value: 'choose', label: 'Choose'},
];

const GROUPS = ['Repository', 'Issues', 'Pull requests', 'Actions'] as const;

const HOOK_FIELDS: Record<string, keyof HookForm> = {url: 'url', 'content type': 'contentType', branchfilter: 'branchFilter', 'config option: url': 'url'};

/** Creates a Forgejo webhook, or edits one (its current authorization header is asked for first: an edit sends it back). */
const HookDialog = observer(function HookDialog({owner, repo, hook, onClose, onSaved}: {owner: string; repo: string; hook: Hook | undefined; onClose: () => void; onSaved: (h: Hook) => void}) {
  const app = useApp();
  const offline = useOffline();
  const creating = hook === undefined;
  const [form, setForm] = useState<HookForm>(() => hookFormOf(hook));
  const [current, setCurrent] = useState<Hook | undefined>(hook?.authorization_header === undefined ? undefined : hook);
  const [errors, setErrors] = useState<FieldErrors<keyof HookForm>>({});
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // The list kept on this device has no authorization headers: the hook as it is now, before an edit can be saved.
  useEffect(() => {
    if (!hook || current) return undefined;
    let live = true;
    fetchHook(app, owner, repo, hook.id).then((h) => {
      if (!live || !h) return;
      setCurrent(h);
      setForm((f) => ({...f, authorization: h.authorization_header ?? ''}));
    }, (err: unknown) => {
      if (live) setFailure(problemOf(err).message);
    });
    return () => {
      live = false;
    };
  }, [app, owner, repo, hook, current]);
  const set = <K extends keyof HookForm>(k: K, v: HookForm[K]) => {
    setForm({...form, [k]: v});
    if (errors[k]) setErrors({...errors, [k]: undefined});
  };
  const ready = creating || current !== undefined;
  const save = async () => {
    if (busy || offline) return;
    const errs = validateHook(form);
    setErrors(errs);
    setFailure(undefined);
    if (Object.values(errs).some(Boolean) || !ready) return;
    setBusy(true);
    try {
      const base = repoApi(owner, repo);
      const saved = creating ?
        await online<Hook>(app, {method: 'POST', api: 'v1', path: `${base}/hooks`, body: hookCreate(form)}) :
        await online<Hook>(app, {method: 'PATCH', api: 'v1', path: `${base}/hooks/${String(hook.id)}`, body: hookPatch(form, current ?? hook)});
      if (saved) onSaved(saved);
      else onClose();
      notify(app, {tone: 'success', title: creating ? 'Webhook added' : 'Webhook saved'});
    } catch (err) {
      const p = problemOf(err, HOOK_FIELDS);
      if (p.field) setErrors({[p.field]: p.message});
      else setFailure(p.message);
    } finally {
      setBusy(false);
    }
  };
  const toggleEvent = (name: string, on: boolean) => {
    set('events', on ? [...form.events, name] : form.events.filter((e) => e !== name));
  };
  return (
    <Dialog title={creating ? 'Add a webhook' : 'Edit the webhook'} width="xlarge" onClose={() => { if (!busy) onClose(); }} footerButtons={[
      {content: 'Cancel', disabled: busy, onClick: onClose},
      {content: busy ? 'Saving…' : creating ? 'Add webhook' : 'Save webhook', buttonType: 'primary', disabled: busy || offline || !ready, onClick: () => void save()},
    ]}>
      <form className="flex flex-col gap-4" noValidate onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}>
        <OfflineNote/>
        <FormControl id="hook-url"><FormControl.Label>Target URL</FormControl.Label>
          <TextInput type="url" className="w-full" placeholder="https://" value={form.url} autoFocus onChange={(e) => {
              set('url', e.target.value);
            }} {...(errors.url ? {validationStatus: 'error' as const} : {})}/>
        <FormControl.Caption>Forgejo sends a POST request here for each event.</FormControl.Caption>{errors.url && <FormControl.Validation variant="error">{errors.url}</FormControl.Validation>}</FormControl>
        <FormControl id="hook-content-type"><FormControl.Label>Content type</FormControl.Label>
          <Select size="small" id="hook-content-type" value={form.contentType} onChange={(event) => {
              set('contentType', event.target.value as HookForm['contentType']);
            }}><Select.Option value="json">application/json</Select.Option><Select.Option value="form">application/x-www-form-urlencoded</Select.Option></Select>
        {errors.contentType && <FormControl.Validation variant="error">{errors.contentType}</FormControl.Validation>}</FormControl>
        {creating && (
          <FormControl id="hook-secret"><FormControl.Label>Secret</FormControl.Label>
            <TextInput type="password" className="w-full" value={form.secret} autoComplete="new-password" onChange={(e) => {
                set('secret', e.target.value);
              }}/>
          <FormControl.Caption>Signs each delivery (the X-Forgejo-Signature header). It cannot be read back or changed here later.</FormControl.Caption></FormControl>
        )}
        <FormControl id="hook-authorization"><FormControl.Label>Authorization header</FormControl.Label>
          <TextInput className="w-full" value={form.authorization} autoComplete="off" spellCheck={false} disabled={!ready} onChange={(e) => {
              set('authorization', e.target.value);
            }} {...(errors.authorization ? {validationStatus: 'error' as const} : {})} monospace/>
        <FormControl.Caption>Sent as the Authorization header of each delivery (Bearer …).</FormControl.Caption>{errors.authorization && <FormControl.Validation variant="error">{errors.authorization}</FormControl.Validation>}</FormControl>
        <FormControl id="hook-branches"><FormControl.Label>Branch filter</FormControl.Label>
          <TextInput className="w-full" value={form.branchFilter} placeholder="*" spellCheck={false} onChange={(e) => {
              set('branchFilter', e.target.value);
            }} {...(errors.branchFilter ? {validationStatus: 'error' as const} : {})} monospace/>
        <FormControl.Caption>A glob pattern of the branches whose events are sent (empty or *: all).</FormControl.Caption>{errors.branchFilter && <FormControl.Validation variant="error">{errors.branchFilter}</FormControl.Validation>}</FormControl>
        <fieldset className="flex flex-col gap-2">
          <legend className="pb-1 text-base font-semibold text-default">Events</legend>
          <SegmentedControl size="small" aria-label="Events" onChange={(index) => {
            const choice = MODES[index ?? -1];
            if (choice) set('mode', choice.value);
          }}>{MODES.map((choice) => <SegmentedControl.Button key={choice.value} selected={form.mode === choice.value}>{choice.label}</SegmentedControl.Button>)}</SegmentedControl>
          {form.mode === 'choose' && GROUPS.map((g) => (
            <div key={g} role="group" aria-label={g} className="flex flex-col gap-1">
              <span className="text-sm text-muted">{g}</span>
              <div className="flex flex-col gap-1">
                {HOOK_EVENTS.filter((e) => e.group === g).map((e) => (
                  <FormControl key={e.name}><Checkbox checked={form.events.includes(e.name)} onChange={(event) => { const on = event.target.checked; toggleEvent(e.name, on); }}/><FormControl.Label>{e.label}</FormControl.Label></FormControl>
                ))}
              </div>
            </div>
          ))}
          {errors.events && <p className="text-sm text-danger">{errors.events}</p>}
        </fieldset>
        <FormControl><Checkbox checked={form.active} onChange={(event) => { const v = event.target.checked; set('active', v); }}/><FormControl.Label>Active (deliveries are sent)</FormControl.Label></FormControl>
        {failure && <Banner variant="critical" title={ready ? 'Not saved' : 'The webhook could not be loaded'} description={<>{failure}</>}/>}
      </form>
    </Dialog>
  );
});
