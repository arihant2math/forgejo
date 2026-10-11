// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useEffect, useRef, useState} from 'react';
import {observer} from 'mobx-react-lite';
import {useNavigate} from '@tanstack/react-router';
import {EditorState, Compartment} from '@codemirror/state';
import {EditorView, Decoration, keymap, lineNumbers} from '@codemirror/view';
import {defaultKeymap, history, historyKeymap} from '@codemirror/commands';
import {highlightSelectionMatches, openSearchPanel, search, searchKeymap} from '@codemirror/search';
import {useApp, useSession} from '../../app/store.ts';
import {failureText, onlineWrite, RequestFailed} from '../../app/api.ts';
import {reach} from '../../app/online.ts';
import {notify} from '../../app/notices.ts';
import {editing} from '../../intents/session.ts';
import {langOf} from '../../code/lang.ts';
import {codeSplat, type Resolved, shortSha} from '../../code/refs.ts';
import {encodePath} from '../../code/source.ts';
import {Button, CodeFileHeader, SegmentedControl} from '../../ui/index.ts';
import {CommitDialog, type CommitFields} from './CommitDialog.tsx';
import {proposalTarget, useUpstream} from './upstream.ts';
import {refTable, useSource} from './hooks.ts';
import {usePool} from '../issues/cells.tsx';
import {MarkdownPreview} from '../editor/Composer.tsx';
import {branchProtected} from './refOps.ts';
import {refNameProblem} from './refWrite.ts';
import {codeTo} from './nav.tsx';
import {editableText, updateFileBody} from './fileWrite.ts';

/** Ctrl H (⌘ ⌥ F on a Mac), as in VS Code and Monaco: the search panel with the focus in its replace field. */
function openReplace(view: EditorView): boolean {
  openSearchPanel(view);
  const field = view.dom.querySelector<HTMLInputElement>('.cm-search input[name="replace"]');
  field?.focus();
  field?.select();
  return true;
}

export function CodeEditor({value, path, wrap, onChange}: {value: string; path: string; wrap: boolean; onChange: (text: string) => void}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const source = useSource();
  const [paint] = useState(() => new Compartment());
  const [wrapping] = useState(() => new Compartment());
  const callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({parent: host.current, state: EditorState.create({doc: value, extensions: [
      // Find and replace in the file (Ctrl/⌘ F opens the panel at the top; Enter / Shift Enter: next / previous; the
      // panel's replace field and buttons; Escape closes it), as in GitHub's and the classic editor.
      history(), search({top: true}), highlightSelectionMatches(), keymap.of([...searchKeymap, {key: 'Mod-h', mac: 'Mod-Alt-f', run: openReplace, preventDefault: true}, ...defaultKeymap, ...historyKeymap]), lineNumbers(), paint.of([]), wrapping.of([]),
      EditorView.contentAttributes.of({'aria-label': 'File contents'}),
      EditorView.theme({
        '&': {color: 'var(--color-fg)', backgroundColor: 'var(--color-canvas)'}, '.cm-scroller': {fontFamily: 'var(--font-mono)', fontSize: 'var(--text-code)', lineHeight: 'var(--text-code--line-height)', maxHeight: '65vh', overflow: 'auto'}, '.cm-content': {minHeight: '45vh', tabSize: 'var(--code-tab-size)'},
        '.cm-panels': {backgroundColor: 'var(--color-surface)', color: 'var(--color-fg)'}, '.cm-panels-top': {borderBottom: '1px solid var(--color-border)'},
        '.cm-panel.cm-search input, .cm-panel.cm-search button': {color: 'var(--color-fg)', backgroundColor: 'var(--color-canvas)', border: '1px solid var(--color-border)', borderRadius: '4px'},
        '.cm-searchMatch': {backgroundColor: 'var(--color-accent-subtle)', outline: '1px solid var(--color-accent)'}, '.cm-searchMatch.cm-searchMatch-selected': {backgroundColor: 'var(--color-canvas-selected)'},
      }),
      EditorView.updateListener.of((u) => { if (u.docChanged) callback.current(u.state.doc.toString()); }),
    ]})});
    view.current = v;
    v.focus();
    return () => {v.destroy(); view.current = undefined;};
    // The document is owned by CodeMirror for this mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {view.current?.dispatch({effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : [])});}, [wrap, wrapping]);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      const lang = langOf(path);
      if (!lang) return;
      void source.snippet(lang, value).then((hl) => {
        const v = view.current;
        if (!active || !v || !hl || v.state.doc.toString() !== value) return;
        const classes = ['', 'text-syn-keyword', 'text-syn-string', 'text-syn-comment', 'text-syn-function', 'text-syn-constant', 'text-syn-parameter', 'text-fg-muted', 'text-accent-fg'];
        const marks = [];
        for (let line = 0; line < hl.starts.length - 1 && line < v.state.doc.lines; line++) {
          let pos = v.state.doc.line(line + 1).from;
          for (let k = hl.starts[line] ?? 0; k < (hl.starts[line + 1] ?? 0); k++) {
            const length = hl.spans[2 * k] ?? 0;
            const cls = classes[hl.spans[2 * k + 1] ?? 0];
            if (length && cls) marks.push(Decoration.mark({class: cls}).range(pos, pos + length));
            pos += length;
          }
        }
        v.dispatch({effects: paint.reconfigure(EditorView.decorations.of(Decoration.set(marks)))});
      });
    }, 250);
    return () => {active = false; clearTimeout(timer);};
  }, [value, path, source, paint]);
  return <div ref={host}/>;
}

export default observer(function FileEditor({owner, repo, repoId, at, sha, original, onCancel}: {owner: string; repo: string; repoId: number; at: Resolved; sha: string; original: string; onCancel: () => void}) {
  const app = useApp();
  const session = useSession();
  const pool = usePool();
  const refs = refTable(pool, repoId);
  const repository = pool.model('Repository').get(repoId)?.data;
  const intents = editing(app).intents;
  const key = `text:file:${String(repoId)}:${at.ref}:${at.path}:${sha}`;
  const [text, setText] = useState(() => intents.drafts.get(key)?.text ?? original);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [wrap, setWrap] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [protectedBranch, setProtected] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const up = useUpstream(owner, repo, repoId);
  const online = reach(session.data.status.connection) === 'online';
  useEffect(() => {
    if (!online) return;
    let active = true;
    void branchProtected(app, {id: repoId, owner, name: repo}, at.ref).then((protectedValue) => {
      if (!active) return;
      setProtected(protectedValue);
    }).catch(() => {if (active) setError('Could not check branch protection. Reconnect and reopen the editor.');});
    return () => {active = false;};
  }, [app, repoId, owner, repo, at.ref, online]);
  const change = (value: string) => {
    setText(value);
    void intents.keepText({key, title: `Edit ${at.path}`, issueId: 0, repoId, text: value});
  };
  const why = repository?.archived || repository?.mirror ? 'Archived and mirror repositories cannot be edited.' : !online ? 'Offline: committing changes needs a connection.' : protectedBranch === undefined ? 'Checking branch protection…' : !editableText(text) ? 'File exceeds the editor size limit or is an LFS pointer.' : undefined;
  const commit = async ({message, description, newBranch, openPull}: CommitFields) => {
    if (why || busy) return;
    setBusy(true); setError('');
    try {
      const result = await onlineWrite<{commit?: {sha?: string}}>(app, {api: 'v1', method: 'PUT', path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(at.path)}`, body: updateFileBody(text, sha, at.ref, message, description, newBranch)});
      const commitSha = result.value?.commit?.sha;
      if (!commitSha) throw new Error('Forgejo did not return the new commit. Check the branch before retrying.');
      await intents.discardDraft(key);
      // The pool has the commit's branch once its sync arrives (the compare form and the branch's view resolve it).
      if (result.syncId !== undefined) await session.data.whenSynced(`repo:${String(repoId)}`, result.syncId, AbortSignal.timeout(4000)).catch(() => undefined);
      const branch = newBranch ?? at.ref;
      // A fork's new branch is proposed to its upstream (the form there), not inside the fork.
      const proposal = newBranch ? proposalTarget(owner, repo, at.ref, newBranch, up) : undefined;
      if (proposal && openPull) {
        await navigate({...proposal.to, search: {expand: '1'} as never});
        return;
      }
      // Where the change went, said (a new branch is no longer the branch the file was opened on), and the file there:
      // on its branch once the pool has the commit as the branch's head, else at the commit itself.
      const landed = refTable(pool, repoId).branches.get(branch) === commitSha;
      await navigate(codeTo(owner, repo, codeSplat('src', landed ? {kind: 'branch', ref: branch} : {kind: 'commit', ref: commitSha}, at.path)));
      notify(app, {
        tone: 'success', title: `Committed to ${branch}`, description: `${shortSha(commitSha)} · ${message}`,
        ...(proposal ? {action: {label: up ? `Open a pull request into ${proposal.into}` : 'Open a pull request', run: () => { void navigate({...proposal.to, search: {expand: '1'} as never}); }}} : {}),
      });
    } catch (err) {
      if (err instanceof RequestFailed && err.status === 409) setError('The file changed since you opened it. Your draft is safe. Reload the file and merge your changes before retrying.');
      else if (err instanceof RequestFailed && err.status === 403) {setProtected(true); setError('Forgejo refused a direct commit. Create a new branch instead, or check your write permission.');}
      else setError(failureText(err));
    } finally {setBusy(false);}
  };
  return <>
    <CodeFileHeader path={at.path}>
      <Button size="sm" variant="ghost" onClick={() => {setWrap(!wrap);}}>{wrap ? 'Disable soft wrap' : 'Soft wrap'}</Button>
      {/\.(md|markdown)$/i.test(at.path) && <SegmentedControl label="Editor mode" value={mode} onChange={setMode} options={[{value: 'edit', label: 'Edit'}, {value: 'preview', label: 'Preview'}]}/>}
      <Button size="sm" variant="ghost" onClick={onCancel}>Close editor</Button>
      <Button size="sm" onClick={() => {setDialog(true);}}>Commit changes…</Button>
    </CodeFileHeader>
    {mode === 'edit' ? <CodeEditor value={text} path={at.path} wrap={wrap} onChange={change}/> : <MarkdownPreview repoId={repoId} text={text}/>}
    {dialog && <CommitDialog branch={at.ref} defaultMessage={`Update ${at.path.split('/').at(-1) ?? at.path}`} protectedBranch={protectedBranch === true} busy={busy} error={error} blocked={why} branchProblem={(name) => refNameProblem(name, 'branch', refs)} pullInto={up?.defaultBranch ? `${up.owner}/${up.name}:${up.defaultBranch}` : undefined} onClose={() => {setDialog(false);}} onCommit={(fields) => {void commit(fields);}}/>}
  </>;
});
