// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {observer} from 'mobx-react-lite';
import {Banner} from '@primer/react';
import {Heading} from '@primer/react';
import {CodeRow} from './CodeRow.tsx';
import {useEffect, useRef, useState} from 'react';
import {canWrite} from '../../app/access.ts';
import {failureText, online} from '../../app/api.ts';
import {sitePath} from '../../app/config.ts';
import {connectivity} from '../../app/online.ts';
import {useApp, useSession} from '../../app/store.ts';
import {APIPrefix} from '../../protocol/types.gen.ts';

import {fullDate} from '../issues/format.ts';
import type {CodeViewProps} from './CodePage.tsx';
import {formatSize} from './tree.tsx';
import {Button, Dialog, Tooltip} from '@primer/react';

export interface Artifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
  expires_at: string;
}

export function artifactExpiry(artifact: Artifact, now = Date.now()): string {
  const expires = Date.parse(artifact.expires_at);
  if (artifact.expired || expires <= now) return 'Expired';
  if (!Number.isFinite(expires)) return 'Expiry unknown';
  const hours = Math.ceil((expires - now) / 3_600_000);
  return hours < 24 ? `Expires in ${String(hours)} h` : `Expires in ${String(Math.ceil(hours / 24))} d`;
}

export const Artifacts = observer(function Artifacts({owner, repo, repoId, runId, done, scroller}: CodeViewProps & {
  runId: number; done: boolean; scroller: HTMLDivElement | null;
}) {
  const app = useApp();
  const session = useSession();
  const root = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [items, setItems] = useState<Artifact[] | undefined>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<number | undefined>();
  const [deleting, setDeleting] = useState<Artifact | undefined>();
  const [deleteError, setDeleteError] = useState('');
  const onlineNow = connectivity.online;
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions`;
  useEffect(() => {
    if (!root.current || !scroller) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, {root: scroller, rootMargin: '200px'});
    observer.observe(root.current);
    return () => { observer.disconnect(); };
  }, [scroller]);
  useEffect(() => {
    if (!done || !visible || !onlineNow) return;
    const controller = new AbortController();
    setError('');
    void (async () => {
      const artifacts: Artifact[] = [];
      // API v1 may cap the requested page size below 50: stop only on an empty page.
      for (let page = 1; ; page++) {
        const batch = await online<Artifact[]>(app, {api: 'v1', path: `${path}/runs/${String(runId)}/artifacts?limit=50&page=${String(page)}`, signal: controller.signal});
        if (!batch?.length) break;
        artifacts.push(...batch);
      }
      if (!controller.signal.aborted) setItems(artifacts);
    })().catch((err: unknown) => {
      if (!controller.signal.aborted) setError(failureText(err));
    });
    return () => { controller.abort(); };
  }, [app, path, runId, done, visible, onlineNow, attempt]);

  async function download(artifact: Artifact) {
    setBusy(artifact.id);
    setError('');
    try {
      const result = await online<{ticket: string}>(app, {api: 'sync', path: `/repos/${String(repoId)}/artifacts/${String(artifact.id)}/ticket`});
      if (!result) throw new Error('Download could not be started.');
      // Browser download manager streams the archive to disk, not through the tab's JS heap.
      const link = document.createElement('a');
      link.href = sitePath(app.config, `${APIPrefix}/artifact-download?ticket=${encodeURIComponent(result.ticket)}`);
      link.download = `${artifact.name}.zip`;
      link.rel = 'noreferrer';
      document.body.append(link);
      link.click();
      link.remove();
    } catch (err) {
      setError(failureText(err));
    } finally {
      setBusy(undefined);
    }
  }
  async function remove() {
    if (!deleting) return;
    setBusy(deleting.id);
    setDeleteError('');
    try {
      await online(app, {api: 'v1', method: 'DELETE', path: `${path}/artifacts/${String(deleting.id)}`});
      setItems((old) => old?.filter((item) => item.id !== deleting.id));
      setDeleting(undefined);
    } catch (err) {
      setDeleteError(failureText(err));
    } finally {
      setBusy(undefined);
    }
  }
  return <section ref={root} aria-label="Artifacts">
    <Heading as="h2" variant="small">Artifacts</Heading>
    {!onlineNow && <p className="px-4 py-3 text-sm text-muted">Artifacts require a connection. Downloads and deletion are unavailable offline.</p>}
    {!done && <p className="px-4 py-3 text-sm text-muted">Artifacts will be available when this run finishes.</p>}
    {done && onlineNow && !items && !error && <p className="px-4 py-3 text-sm text-muted">Loading artifacts…</p>}
    {error && <Banner variant="critical" title="Artifacts not loaded" description={<>{error} <Button size="small" type="button" disabled={!onlineNow} onClick={() => { setAttempt((n) => n + 1); }}>Retry</Button></>}/>}
    {items?.length === 0 && <p className="px-4 py-3 text-sm text-muted">No artifacts for this run.</p>}
    {items?.map((artifact) => {
      const expiry = artifactExpiry(artifact);
      const disabled = !onlineNow || expiry === 'Expired' || busy !== undefined;
      return <CodeRow key={artifact.id} role="presentation" trailing={<>
        <span>{formatSize(artifact.size_in_bytes)}</span>
        <span title={fullDate(artifact.expires_at)}>{expiry}</span>
        <Tooltip text={!onlineNow ? 'Downloads require a connection' : expiry === 'Expired' ? 'This artifact has expired' : 'Download artifact' }><Button size="small" type="button" inactive={disabled} aria-disabled={disabled} onClick={() => { if (!disabled) void download(artifact); }}>Download</Button></Tooltip>
        {canWrite(session, repoId) && <Button variant="invisible" size="small" type="button" disabled={!onlineNow || busy !== undefined} onClick={() => { setDeleteError(''); setDeleting(artifact); }}>Delete</Button>}
      </>}>{artifact.name}</CodeRow>;
    })}
    {deleting && <Dialog title="Delete artifact?" onClose={() => { if (busy === undefined) setDeleting(undefined); }} footerButtons={[
      {content: 'Cancel', disabled: busy !== undefined, onClick: () => { setDeleting(undefined); }},
      {content: 'Delete artifact', buttonType: 'danger', disabled: busy !== undefined || !onlineNow, onClick: () => { void remove(); }},
    ]}><p>Delete {deleting.name}? This cannot be undone.</p>{deleteError && <p role="alert" className="text-danger">{deleteError}</p>}</Dialog>}
  </section>;
});
