// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {apiRepoPath} from '../../app/paths.ts';
import {useEffect, useRef, useState} from 'react';
import {observer} from 'mobx-react-lite';
import {useNavigate} from '@tanstack/react-router';
import {EditorState, Compartment, RangeSetBuilder, StateEffect, StateField, type Text} from '@codemirror/state';
import {EditorView, Decoration, type DecorationSet, keymap, lineNumbers} from '@codemirror/view';
import {defaultKeymap, history, historyKeymap} from '@codemirror/commands';
import {highlightSelectionMatches, openSearchPanel, search, searchKeymap} from '@codemirror/search';
import {useApp, useSession} from '../../app/store.ts';
import {repoGroup} from '../../data/models.ts';
import {settleWrite} from '../../sync/data.ts';
import {failureText, onlineWrite, RequestFailed} from '../../app/api.ts';
import {reach} from '../../app/online.ts';
import {notify} from '../../app/notices.ts';
import {editing} from '../../intents/editing.ts';
import {eachToken, type TokenSpans} from '../../code/parts.tsx';
import {langOf} from '../../code/shiki.ts';
import {codeSplat, type Resolved, shortSha} from '../../code/refs.ts';
import {encodePath} from '../../code/source.ts';
import {SegmentedControl} from '@primer/react';
import {CommitDialog, type CommitFields} from './CommitDialog.tsx';
import {proposalTarget, useUpstream} from './upstream.ts';
import {refTable, useSource} from './hooks.ts';
import {usePool} from '../../app/store.ts';
import {MarkdownPreview} from '../editor/Composer.tsx';
import {branchProtected} from './refOps.ts';
import {refNameProblem} from './refWrite.ts';
import {codeTo} from './nav.tsx';
import {editableText, updateFileBody} from './fileWrite.ts';
import {Button} from '@primer/react';

function openReplace(view: EditorView): boolean {
  openSearchPanel(view);
  const field = view.dom.querySelector<HTMLInputElement>('.cm-search input[name="replace"]');
  field?.focus();
  field?.select();
  return true;
}

const setTokens = StateEffect.define<DecorationSet>();

/** The syntax marks of the last highlighted version, moved along with the edits made since. */
const tokens = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setTokens)) return e.value;
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const marks = new Map<string, Decoration>();

function tokenMarks(doc: Text, hl: TokenSpans): DecorationSet {
  const out = new RangeSetBuilder<Decoration>();
  for (let i = 0; i < doc.lines && i < hl.starts.length - 1; i++) {
    const line = doc.line(i + 1);
    eachToken(hl, i, line.length, (from, to, cls) => {
      if (!cls) return;
      let mark = marks.get(cls);
      if (!mark) marks.set(cls, mark = Decoration.mark({class: cls}));
      out.add(line.from + from, line.from + to, mark);
    });
  }
  return out.finish();
}

export function CodeEditor({value, path, wrap, onChange}: {value: string; path: string; wrap: boolean; onChange: (text: string) => void}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const source = useSource();
  const [wrapping] = useState(() => new Compartment());
  const callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({parent: host.current, state: EditorState.create({doc: value, extensions: [
      history(), search({top: true}), highlightSelectionMatches(), keymap.of([...searchKeymap, {key: 'Mod-h', mac: 'Mod-Alt-f', run: openReplace, preventDefault: true}, ...defaultKeymap, ...historyKeymap]), lineNumbers(), tokens, wrapping.of([]),
      EditorView.contentAttributes.of({'aria-label': 'File contents'}),
      EditorView.theme({
        '&': {color: 'var(--fgColor-default)', backgroundColor: 'var(--bgColor-inset)'}, '.cm-scroller': {fontFamily: 'var(--font-mono)', fontSize: 'var(--text-code)', lineHeight: 'var(--text-code--line-height)', maxHeight: '65vh', overflow: 'auto'}, '.cm-content': {minHeight: '45vh', tabSize: 'var(--code-tab-size)'},
        '.cm-panels': {backgroundColor: 'var(--bgColor-default)', color: 'var(--fgColor-default)'}, '.cm-panels-top': {borderBottom: '1px solid var(--borderColor-default)'},
        '.cm-panel.cm-search input, .cm-panel.cm-search button': {color: 'var(--fgColor-default)', backgroundColor: 'var(--bgColor-inset)', border: '1px solid var(--borderColor-default)', borderRadius: '4px'},
        '.cm-searchMatch': {backgroundColor: 'var(--bgColor-accent-muted)', outline: '1px solid var(--bgColor-accent-emphasis)'}, '.cm-searchMatch.cm-searchMatch-selected': {backgroundColor: 'var(--control-transparent-bgColor-selected)'},
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
  // Highlight each version once typing pauses; a newer version drops the request for the older one.
  // Marks of a version that no longer highlights (a name without a grammar, text too large) would only mislead.
  useEffect(() => {
    const lang = langOf(path);
    if (!lang) {
      view.current?.dispatch({effects: setTokens.of(Decoration.none)});
      return undefined;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      const v = view.current;
      if (!v) return;
      const doc = v.state.doc;
      source.highlightText(lang, doc.toString(), ctl.signal).then((hl) => {
        if (view.current === v && v.state.doc === doc) v.dispatch({effects: setTokens.of(hl ? tokenMarks(doc, hl) : Decoration.none)});
      }, () => undefined);
    }, 250);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [value, path, source]);
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
      const result = await onlineWrite<{commit?: {sha?: string}}>(app, {api: 'v1', method: 'PUT', path: `${apiRepoPath(owner, repo)}/contents/${encodePath(at.path)}`, body: updateFileBody(text, sha, at.ref, message, description, newBranch)});
      const commitSha = result.value?.commit?.sha;
      if (!commitSha) throw new Error('Forgejo did not return the new commit. Check the branch before retrying.');
      await intents.discardDraft(key);
      // Wait for branch sync so the destination view can resolve the commit.
      await settleWrite(session.data, repoGroup(repoId), result.syncId, 4000);
      const branch = newBranch ?? at.ref;
      const proposal = newBranch ? proposalTarget(owner, repo, at.ref, newBranch, up) : undefined;
      if (proposal && openPull) {
        await navigate({...proposal.to, search: {expand: '1'} as never});
        return;
      }
      // Until the branch head is synced, navigate by commit SHA.
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
    <div className="flex flex-wrap items-center gap-2 border-y border-default bg-inset px-3 py-2"><span className="mr-auto truncate font-mono">{at.path}</span>
      <Button variant="invisible" size="small" type="button" aria-pressed={wrap} onClick={() => {setWrap(!wrap);}}>{wrap ? 'Disable soft wrap' : 'Soft wrap'}</Button>
      {/\.(md|markdown)$/i.test(at.path) && <SegmentedControl aria-label="Editor mode" size="small" onChange={(index) => { setMode(index === 1 ? 'preview' : 'edit'); }}>
        <SegmentedControl.Button selected={mode === 'edit'}>Edit</SegmentedControl.Button><SegmentedControl.Button selected={mode === 'preview'}>Preview</SegmentedControl.Button>
      </SegmentedControl>}
      <Button variant="invisible" size="small" type="button" onClick={onCancel}>Close editor</Button>
      <Button size="small" type="button" onClick={() => {setDialog(true);}}>Commit changes…</Button>
    </div>
    {mode === 'edit' ? <CodeEditor value={text} path={at.path} wrap={wrap} onChange={change}/> : <MarkdownPreview repoId={repoId} text={text}/>}
    {dialog && <CommitDialog branch={at.ref} defaultMessage={`Update ${at.path.split('/').at(-1) ?? at.path}`} protectedBranch={protectedBranch === true} busy={busy} error={error} blocked={why} branchProblem={(name) => refNameProblem(name, 'branch', refs)} pullInto={up?.defaultBranch ? `${up.owner}/${up.name}:${up.defaultBranch}` : undefined} onClose={() => {setDialog(false);}} onCommit={(fields) => {void commit(fields);}}/>}
  </>;
});
