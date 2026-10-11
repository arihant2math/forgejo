// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {lazy, Suspense, useEffect, useState, type ReactNode} from 'react';
import {observer} from 'mobx-react-lite';
import {useNavigate} from '@tanstack/react-router';
import {useApp, useSession} from '../../app/store.ts';
import {canWrite} from '../../app/access.ts';
import {failureText, onlineWrite, RequestFailed} from '../../app/api.ts';
import {reach} from '../../app/online.ts';
import {useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {editing} from '../../intents/session.ts';
import {codeSplat, parentPath, type Resolved} from '../../code/refs.ts';
import {Button, Dialog, Input, ListRow, Menu, MenuContent, MenuItem, MenuTrigger} from '../../ui/index.ts';
import {usePool} from '../issues/cells.tsx';
import {CommitDialog, type CommitFields} from './CommitDialog.tsx';
import {proposalTarget, useUpstream} from './upstream.ts';
const CodeEditor = lazy(() => import('./FileEditor.tsx').then((module) => ({default: module.CodeEditor})));
import {refTable, useSource} from './hooks.ts';
import {branchProtected} from './refOps.ts';
import {refNameProblem} from './refWrite.ts';
import {codeTo} from './nav.tsx';
import {formatSize} from './tree.tsx';
import {filePathProblem, UPLOAD_LIMIT, type FileOperation} from './operations.ts';

export const FileOperations = observer(function FileOperations({owner, repo, repoId, at, target, children}: {
  owner: string; repo: string; repoId: number; at: Resolved; target?: {sha: string; folder: boolean} | undefined; children?: ReactNode;
}) {
  const app = useApp();
  const session = useSession();
  const pool = usePool();
  const source = useSource();
  const navigate = useNavigate();
  const repository = pool.model('Repository').get(repoId)?.data;
  const up = useUpstream(owner, repo, repoId);
  const refs = refTable(pool, repoId);
  const intents = editing(app).intents;
  const key = `text:new-file:${String(repoId)}:${at.ref}:${at.path}`;
  const saved = intents.drafts.get(key)?.text;
  const pathKey = `${key}:path`;
  const [mode, setMode] = useState<'create' | 'upload' | 'delete'>();
  const [path, setPath] = useState(() => intents.drafts.get(pathKey)?.text ?? '');
  const [text, setText] = useState(saved ?? '');
  const [files, setFiles] = useState<{file: File; path: string}[]>([]);
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [protectedBranch, setProtected] = useState<boolean>();
  const allowed = canWrite(session, repoId) && at.kind === 'branch' && !repository?.archived && !repository?.mirror;
  const online = reach(session.data.status.connection) === 'online';
  const blocked = !online ? 'Offline: file changes need a connection. Your new file draft is kept.' : undefined;
  useEffect(() => {
    if (!mode || !online) return;
    let active = true;
    if (repository?.empty) {setProtected(false); return;}
    void branchProtected(app, {id: repoId, owner, name: repo}, at.ref).then((v) => {if (active) setProtected(v);}).catch((err: unknown) => {if (active) setError(failureText(err));});
    return () => {active = false;};
  }, [mode, online, repository?.empty, app, repoId, owner, repo, at.ref]);
  const start = (value: 'create' | 'upload' | 'delete') => {setError(''); setMode(value); setDialog(value === 'delete');};
  useShortcutScope('code');
  useShortcut('code.newFile', () => {start('create');}, allowed && online);
  useShortcut('code.uploadFiles', () => {start('upload');}, allowed && online);
  useShortcut('code.deletePath', () => {start('delete');}, allowed && online && Boolean(target));
  const dir = target && !target.folder ? parentPath(at.path) : at.path;
  const fullPath = (name: string) => dir ? `${dir}/${name}` : name;
  const add = (incoming: File[]) => {
    const next = [...files];
    for (const file of incoming) {
      const name = file.webkitRelativePath || file.name;
      if (next.some((item) => item.path === name)) {setError(`Duplicate upload path: ${name}`); return;}
      next.push({file, path: name});
    }
    if (next.reduce((sum, item) => sum + item.file.size, 0) > UPLOAD_LIMIT) {setError('Uploads are limited to 10 MB total per commit.'); return;}
    setFiles(next); setError(''); start('upload');
  };
  const problem = mode === 'create' ? filePathProblem(fullPath(path)) : mode === 'upload' ? !files.length ? 'Choose files to upload.' : files.map((item) => filePathProblem(fullPath(item.path))).find(Boolean) : undefined;
  const commit = async (fields: CommitFields) => {
    if (busy || blocked || problem || protectedBranch === undefined) return;
    setBusy(true); setError('');
    try {
      let operations: FileOperation[] = [];
      if (mode === 'create') {
        const blob = new File([text], path);
        if (blob.size > UPLOAD_LIMIT) throw new Error('New files are limited to 10 MB.');
        operations = [{operation: 'create', path: fullPath(path), content: await readBase64(blob)}];
      } else if (mode === 'upload') {
        for (let i = 0; i < files.length; i++) {
          const item = files[i];
          if (!item) continue;
          setProgress(`Reading ${String(i + 1)} of ${String(files.length)}…`);
          operations.push({operation: 'create', path: fullPath(item.path), content: await readBase64(item.file)});
        }
      } else if (target) {
        const collect = async (folder: string) => {
          const tree = await source.tree(repoId, at.sha, folder);
          for (const entry of tree.entries) {
            const name = `${folder}/${entry.name}`;
            if (entry.type === 'tree') await collect(name);
            else operations.push({operation: 'delete', path: name, sha: entry.sha});
          }
        };
        if (target.folder) await collect(at.path);
        else operations.push({operation: 'delete', path: at.path, sha: target.sha});
      }
      if (!operations.length) throw new Error('There are no files to commit.');
      const result = await onlineWrite<{commit?: {sha?: string}}>(app, {api: 'v1', method: 'POST', path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents`, body: {
        branch: at.ref, ...(fields.newBranch ? {new_branch: fields.newBranch} : {}), message: [fields.message.trim(), fields.description.trim()].filter(Boolean).join('\n\n'), files: operations,
      }});
      const sha = result.value?.commit?.sha;
      if (!sha) throw new Error('Forgejo did not return the commit. Check the branch before retrying.');
      if (mode === 'create') {await intents.discardDraft(key); await intents.discardDraft(pathKey);}
      setMode(undefined); setDialog(false); setFiles([]);
      if (fields.newBranch && fields.openPull && !repository?.empty) {
        if (result.syncId !== undefined) await session.data.whenSynced(`repo:${String(repoId)}`, result.syncId, AbortSignal.timeout(4000)).catch(() => undefined);
        // A fork's new branch is proposed to its upstream (the form there), not inside the fork.
        await navigate({...proposalTarget(owner, repo, at.ref, fields.newBranch, up).to, search: {expand: '1'} as never});
      } else await navigate(codeTo(owner, repo, codeSplat('src', {kind: 'commit', ref: sha}, mode === 'delete' ? parentPath(at.path) : mode === 'create' ? fullPath(path) : dir)));
    } catch (err) {
      if (err instanceof RequestFailed && err.status === 403) {setProtected(true); setError('Forgejo refused this commit. Try a new branch, or check permission and storage quota.');}
      else setError(failureText(err));
    } finally {setBusy(false); setProgress('');}
  };
  if (!allowed) return children;
  return <div onDragOver={(event) => {if (online && event.dataTransfer.types.includes('Files')) event.preventDefault();}} onDrop={(event) => {if (!online || !event.dataTransfer.files.length) return; event.preventDefault(); add(Array.from(event.dataTransfer.files));}}>
    <Menu><MenuTrigger asChild><Button size="sm" variant="ghost" disabled={!online} title={blocked}>Add file</Button></MenuTrigger><MenuContent>
      <MenuItem onSelect={() => {start('create');}}>Create new file</MenuItem>
      <MenuItem onSelect={() => {start('upload');}}>Upload files</MenuItem>
      {target && <MenuItem onSelect={() => {start('delete');}}>Delete {target.folder ? 'folder' : 'file'}</MenuItem>}
    </MenuContent></Menu>
    {blocked && <p className="text-sm text-fg-muted">{blocked}</p>}
    {children}
    {mode && !dialog && <Dialog open title={mode === 'create' ? 'Create new file' : 'Upload files'} size="lg" onOpenChange={(open) => {if (!open) setMode(undefined);}} footer={<Button disabled={Boolean(problem) || Boolean(blocked)} onClick={() => {setDialog(true);}}>Commit changes…</Button>}>
      {mode === 'create' ? <><Input aria-label="File path" placeholder="dir/name.ext" value={path} onChange={(event) => {setPath(event.target.value); void intents.keepText({key: pathKey, title: 'New file path', issueId: 0, repoId, text: event.target.value});}}/><Suspense fallback={<p>Loading editor…</p>}><CodeEditor value={text} path={path} wrap onChange={(value) => {setText(value); void intents.keepText({key, title: `New file in ${dir || repo}`, issueId: 0, repoId, text: value});}}/></Suspense></> : <div className="flex flex-col gap-3">
        <p className="text-sm text-fg-muted">Drop files here or over the tree. Maximum 10 MB total per commit.</p>
        <input aria-label="Choose files" type="file" multiple onChange={(event) => {add(Array.from(event.target.files ?? [])); event.target.value = '';}}/>
        <input aria-label="Choose folder" type="file" multiple {...{webkitdirectory: ''}} onChange={(event) => {add(Array.from(event.target.files ?? [])); event.target.value = '';}}/>
        {files.map((item) => <ListRow role={undefined} key={item.path} trailing={<Button size="sm" variant="ghost" onClick={() => {setFiles(files.filter((f) => f !== item));}}>Remove</Button>}>{item.path} · {formatSize(item.file.size)}</ListRow>)}
      </div>}
      {problem && <p className="text-sm text-fg-muted">{problem}</p>}{error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </Dialog>}
    {mode && dialog && <CommitDialog allowPull={!repository?.empty} branch={at.ref} defaultMessage={mode === 'delete' ? `Delete ${at.path}` : mode === 'create' ? `Create ${fullPath(path)}` : `Upload ${String(files.length)} files`} protectedBranch={protectedBranch === true} busy={busy} error={error} blocked={blocked ?? problem ?? (protectedBranch === undefined ? 'Checking branch protection…' : undefined)} branchProblem={(name) => refNameProblem(name, 'branch', refs)} pullInto={up?.defaultBranch ? `${up.owner}/${up.name}:${up.defaultBranch}` : undefined} onClose={() => {setDialog(false); if (mode === 'delete') setMode(undefined);}} onCommit={(fields) => {void commit(fields);}}/>}
    {progress && <p role="status" className="text-sm text-fg-muted">{progress}</p>}
  </div>;
});

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {resolve(typeof reader.result === 'string' ? reader.result.split(',')[1] ?? '' : '');};
    reader.onerror = () => {reject(new Error(`Could not read ${file.name}`));};
    reader.readAsDataURL(file);
  });
}
