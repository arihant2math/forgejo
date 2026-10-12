// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useState} from 'react';
import {sitePath} from '../../app/config.ts';
import {notify} from '../../app/notices.ts';
import {useApp} from '../../app/store.ts';
import {ARCHIVE_FORMATS, archivePath, httpsCloneUrl, sshCloneUrl} from '../../code/clone.ts';
import {ChevronDownIcon, CodeIcon, FileZipIcon, CopyIcon} from '@primer/octicons-react';
import {Button, Heading, TextInput, IconButton, ActionList, SegmentedControl, AnchoredOverlay} from '@primer/react';

type Protocol = 'https' | 'ssh';

const HINTS: Record<Protocol, string> = {
  https: 'Clone using the web URL.',
  ssh: 'Use a password-protected SSH key.',
};

const ARCHIVE_LABELS = {'zip': 'Download ZIP', 'tar.gz': 'Download TAR.GZ'} as const;

export interface CodeMenuPanelProps {
  https: string;
  /** Undefined disables SSH and the protocol tabs. */
  ssh?: string | undefined;
  archives: readonly {format: keyof typeof ARCHIVE_LABELS; href: string}[];
  onCopy: (url: string) => void;
}

export function CodeMenuPanel({https, ssh, archives, onCopy}: CodeMenuPanelProps) {
  const [protocol, setProtocol] = useState<Protocol>('https');
  const shown: Protocol = ssh === undefined ? 'https' : protocol;
  const url = shown === 'ssh' && ssh !== undefined ? ssh : https;
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <Heading as="h2" variant="small">Clone</Heading>
          {ssh !== undefined && (
            <SegmentedControl size="small" aria-label="Clone over" onChange={(index) => { setProtocol(index === 1 ? 'ssh' : 'https'); }}><SegmentedControl.Button selected={shown === 'https'}>HTTPS</SegmentedControl.Button><SegmentedControl.Button selected={shown === 'ssh'}>SSH</SegmentedControl.Button></SegmentedControl>
          )}
        </div>
        <div className="flex items-center gap-2"><TextInput size="small" readOnly monospace block value={url} aria-label={`Clone URL (${shown === 'ssh' ? 'SSH' : 'HTTPS'})`}/><IconButton size="small" icon={CopyIcon} aria-label="Copy the clone URL" onClick={() => { onCopy(url); }}/></div>
        <p className="text-sm text-muted">{HINTS[shown]}</p>
      </div>
      {archives.length > 0 && (
        <div className="border-t border-default pt-4">
          <ActionList aria-label="Download">
            {archives.map((a) => (
              <ActionList.LinkItem key={a.format} href={a.href} download><ActionList.LeadingVisual><FileZipIcon/></ActionList.LeadingVisual>{ARCHIVE_LABELS[a.format]}</ActionList.LinkItem>
            ))}
          </ActionList>
        </div>
      )}
    </div>
  );
}

/** An empty default branch disables source archives. */
export function CodeMenu({owner, repo, branch}: {owner: string; repo: string; branch: string}) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const archives = branch ? ARCHIVE_FORMATS.map((format) => ({format, href: sitePath(app.config, archivePath(owner, repo, branch, format))})) : [];
  return (
    <AnchoredOverlay open={open} onOpen={() => { setOpen(true); }} onClose={() => { setOpen(false); }} align="end" width="medium" overlayProps={{role: 'dialog', 'aria-label': 'Clone repository'}} renderAnchor={(props) => <Button {...props} variant="primary" size="small" leadingVisual={CodeIcon} trailingVisual={ChevronDownIcon}>Code</Button>}>
        <CodeMenuPanel https={httpsCloneUrl(app.config.app_url, owner, repo)} ssh={sshCloneUrl(app.config.ssh_clone_prefix, owner, repo)} archives={archives}
          onCopy={(url) => {
            void navigator.clipboard.writeText(url).then(() => {
              notify(app, {tone: 'success', title: 'Copied', description: url});
            }, () => {
              notify(app, {tone: 'neutral', title: 'Could not copy', description: 'Select the URL and copy it.'});
            });
          }}/>
      </AnchoredOverlay>
  );
}
