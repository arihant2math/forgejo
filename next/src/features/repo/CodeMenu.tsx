// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// GitHub's green "Code" button (Button variant success) at the right of the overview's file bar: a
// popover with the clone URL over HTTPS or SSH (SSH only when the instance
// has it on: NextConfig.ssh_clone_prefix), each with a copy button, and the
// default branch's source archives. Everything is known at once (the
// configuration and the pool): no request until a download.

import {ChevronDown, Code2, FileArchive} from 'lucide-react';
import {useState} from 'react';
import {sitePath} from '../../app/config.ts';
import {notify} from '../../app/notices.ts';
import {useApp} from '../../app/store.ts';
import {ARCHIVE_FORMATS, archivePath, httpsCloneUrl, sshCloneUrl} from '../../code/clone.ts';
import {AsideLink, AsideLinks, Button, CopyField, Icon, Popover, PopoverContent, PopoverTrigger, SegmentedControl} from '../../ui/index.ts';

type Protocol = 'https' | 'ssh';

const HINTS: Record<Protocol, string> = {
  https: 'Clone using the web URL.',
  ssh: 'Use a password-protected SSH key.',
};

const ARCHIVE_LABELS = {'zip': 'Download ZIP', 'tar.gz': 'Download TAR.GZ'} as const;

export interface CodeMenuPanelProps {
  https: string;
  /** undefined: SSH is off on this instance (no tabs). */
  ssh?: string | undefined;
  /** The source archives' links (none for an empty repository). */
  archives: readonly {format: keyof typeof ARCHIVE_LABELS; href: string}[];
  onCopy: (url: string) => void;
}

/** What the popover shows (the gallery renders it with fixed values). */
export function CodeMenuPanel({https, ssh, archives, onCopy}: CodeMenuPanelProps) {
  const [protocol, setProtocol] = useState<Protocol>('https');
  const shown: Protocol = ssh === undefined ? 'https' : protocol;
  const url = shown === 'ssh' && ssh !== undefined ? ssh : https;
  return (
    <div className="flex flex-col gap-3 p-1">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-md font-semibold text-fg">Clone</h2>
          {ssh !== undefined && (
            <SegmentedControl label="Clone over" value={shown} onChange={setProtocol} options={[{value: 'https', label: 'HTTPS'}, {value: 'ssh', label: 'SSH'}]}/>
          )}
        </div>
        <CopyField value={url} label={`Clone URL (${shown === 'ssh' ? 'SSH' : 'HTTPS'})`} copyLabel="Copy the clone URL" onCopy={() => {
          onCopy(url);
        }}/>
        <p className="text-sm text-fg-subtle">{HINTS[shown]}</p>
      </div>
      {archives.length > 0 && (
        <div className="border-t border-border pt-3">
          <AsideLinks label="Download">
            {archives.map((a) => (
              <AsideLink key={a.format} icon={FileArchive}><a href={a.href} download>{ARCHIVE_LABELS[a.format]}</a></AsideLink>
            ))}
          </AsideLinks>
        </div>
      )}
    </div>
  );
}

/** The button and its popover, for a repository and its default branch ("" when it has none: no archives). */
export function CodeMenu({owner, repo, branch}: {owner: string; repo: string; branch: string}) {
  const app = useApp();
  const archives = branch ? ARCHIVE_FORMATS.map((format) => ({format, href: sitePath(app.config, archivePath(owner, repo, branch, format))})) : [];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="success" icon={Code2}>Code<Icon icon={ChevronDown} size="sm"/></Button>
      </PopoverTrigger>
      <PopoverContent width="md" align="end">
        <CodeMenuPanel https={httpsCloneUrl(app.config.app_url, owner, repo)} ssh={sshCloneUrl(app.config.ssh_clone_prefix, owner, repo)} archives={archives}
          onCopy={(url) => {
            void navigator.clipboard.writeText(url).then(() => {
              notify(app, {tone: 'success', title: 'Copied', description: url});
            }, () => {
              notify(app, {tone: 'neutral', title: 'Could not copy', description: 'Select the URL and copy it.'});
            });
          }}/>
      </PopoverContent>
    </Popover>
  );
}
