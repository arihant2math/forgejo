// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {when} from 'mobx';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';
import {failureText, online} from '../../app/api.ts';
import {connectivity} from '../../app/online.ts';
import {useApp} from '../../app/store.ts';
import {Button, Dialog, Field, Input, Select, Switch} from '../../ui/index.ts';
import {usePool} from '../issues/cells.tsx';
import {refTable} from './hooks.ts';
import {RefPicker} from './RefMenu.tsx';
import type {RefChoice} from './refWrite.ts';

export interface WorkflowFile {file: string; dispatchable: boolean}
export interface WorkflowList {workflows: WorkflowFile[]; can_dispatch: boolean}
export interface DispatchInput {name: string; description: string; type: string; required: boolean; default: string; options: string[] | null}
interface DispatchSchema extends WorkflowFile {inputs?: DispatchInput[]}

export function dispatchDefaults(inputs: DispatchInput[]): Record<string, string> {
  return Object.fromEntries(inputs.map((input) => [input.name, input.default || (input.type === 'boolean' ? 'false' : '')]));
}

export function dispatchProblem(inputs: DispatchInput[], values: Record<string, string>): string | undefined {
  for (const input of inputs) {
    const value = values[input.name] ?? '';
    if (input.required && !value) return `${input.name} is required.`;
    if (value && input.type === 'number' && !Number.isFinite(Number(value))) return `${input.name} must be a number.`;
    if (value && input.type === 'choice' && !input.options?.includes(value)) return `Choose a value for ${input.name}.`;
  }
  return undefined;
}

export function useWorkflowList(repoId: number) {
  const app = useApp();
  const connected = connectivity.online;
  const [loaded, setLoaded] = useState<{repoId: number; list: WorkflowList | undefined}>();
  const list = loaded?.repoId === repoId ? loaded.list : undefined;
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    void online<WorkflowList>(app, {api: 'sync', path: `/repos/${String(repoId)}/workflows`, signal: controller.signal}).then((result) => {
      if (!controller.signal.aborted) { setLoaded({repoId, list: result}); setError(undefined); }
    }, (err: unknown) => {
      if (!controller.signal.aborted) setError(failureText(err));
    });
    return () => { controller.abort(); };
  }, [app, repoId, connected, retry]);
  return {list, error, retry: () => { setError(undefined); setRetry((n) => n + 1); }};
}

export const DispatchWorkflowDialog = observer(function DispatchWorkflowDialog({repoId, owner, repo, file, onClose, onRun}: {
  repoId: number; owner: string; repo: string; file: string; onClose: () => void; onRun: (number: number) => void;
}) {
  const app = useApp();
  const pool = usePool();
  const [ref, setRef] = useState<RefChoice>({kind: 'branch', ref: refTable(pool, repoId).defaultBranch});
  const [schema, setSchema] = useState<DispatchSchema>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const connected = connectivity.online;
  const block = !connected ? 'Running a workflow requires a connection.' : undefined;
  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    const gitRef = `refs/${ref.kind === 'tag' ? 'tags' : 'heads'}/${ref.ref}`;
    void online<DispatchSchema>(app, {api: 'sync', path: `/repos/${String(repoId)}/workflows/${encodeURIComponent(file)}/dispatch?ref=${encodeURIComponent(gitRef)}`, signal: controller.signal}).then((result) => {
      if (controller.signal.aborted) return;
      setError(undefined);
      setSchema(result);
      setValues(dispatchDefaults(result?.inputs ?? []));
    }, (err: unknown) => {
      if (!controller.signal.aborted) setError(failureText(err));
    });
    return () => { controller.abort(); };
  }, [app, repoId, file, ref.kind, ref.ref, connected, retry]);
  const submit = () => {
    if (busy || block || !schema?.dispatchable) return;
    const problem = dispatchProblem(schema.inputs ?? [], values);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(undefined);
    void online<{run_number: number}>(app, {
      api: 'v1', method: 'POST', path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(file)}/dispatches`,
      body: {ref: `refs/${ref.kind === 'tag' ? 'tags' : 'heads'}/${ref.ref}`, inputs: values, return_run_info: true},
    }).then(async (result) => {
      if (!result?.run_number) throw new Error('Forgejo did not return the workflow run.');
      await when(() => [...pool.model('ActionRun').by('repo_id', repoId)].some((run) => run.get('run_number') === result.run_number), {timeout: 10_000}).catch(() => undefined);
      onRun(result.run_number);
    }).catch((err: unknown) => {
      setError(failureText(err));
    }).finally(() => { setBusy(false); });
  };
  return <Dialog open size="md" title="Run workflow" description={file} onOpenChange={(open) => { if (!open && !busy) onClose(); }} footer={<>
    <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
    <Button variant="primary" disabled={busy || Boolean(block) || !schema?.dispatchable} tooltip={block} onClick={submit}>{busy ? 'Starting…' : 'Run workflow'}</Button>
  </>}>
    <div className="flex flex-col gap-3">
      <RefPicker repoId={repoId} label="Run on" value={ref} onChange={(value) => { if (!busy && (value.kind !== ref.kind || value.ref !== ref.ref)) { setSchema(undefined); setError(undefined); setRef(value); } }}/>
      {!schema && !error && !block && <p className="text-sm text-fg-muted">Loading inputs…</p>}
      {schema && !schema.dispatchable && <p className="text-sm text-fg-muted">This workflow does not support manual runs at this ref.</p>}
      {schema?.inputs?.map((input) => {
        const id = `dispatch-${input.name}`;
        const change = (value: string) => { setValues((prev) => ({...prev, [input.name]: value})); };
        return <Field key={input.name} label={input.name} htmlFor={id} hint={input.description} optional={!input.required}>
          {input.type === 'boolean' ? <Switch id={id} label={input.name} checked={values[input.name] === 'true'} disabled={busy} onCheckedChange={(checked) => { change(String(checked)); }}/> :
            input.type === 'choice' ? <Select id={id} value={values[input.name] ?? ''} disabled={busy} onValueChange={change} options={[{value: '', label: 'Choose…'}, ...(input.options ?? []).map((value) => ({value, label: value}))]}/> :
              <Input id={id} className="w-full" type={input.type === 'number' ? 'number' : 'text'} step="any" required={input.required} disabled={busy} value={values[input.name] ?? ''} onChange={(event) => { change(event.target.value); }}/>}
        </Field>;
      })}
      {block && <p className="text-sm text-fg-muted">{block}</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {error && !schema && connected && <Button size="sm" onClick={() => { setRetry((n) => n + 1); }}>Retry loading inputs</Button>}
    </div>
  </Dialog>;
});
