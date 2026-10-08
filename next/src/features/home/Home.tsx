// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The dashboard (/): where the app starts. A calm starting point with the
// ways to get anywhere from the keyboard.

import {Command, Home as HomeIcon} from 'lucide-react';
import {runInAction} from 'mobx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {PageBody} from '../../app/shell/Frame.tsx';
import {shortcutHint} from '../../app/shortcuts/index.ts';
import {useApp} from '../../app/store.ts';
import {Button, EmptyState, Shortcut} from '../../ui/index.ts';

export default function Home() {
  const {ui, config} = useApp();
  return (
    <>
      <PageHeader icon={HomeIcon} title="Home"/>
      <PageBody>
        <EmptyState
          icon={Command}
          title={config.app_name}
          description={
            <>
              Jump anywhere with <Shortcut keys={shortcutHint('palette.open')}/>. <Shortcut keys={shortcutHint('go.issues')}/> opens your
              issues, <Shortcut keys={shortcutHint('go.pulls')}/> your pull requests, <Shortcut keys={shortcutHint('go.inbox')}/> the inbox.
            </>
          }
          action={
            <Button variant="primary" shortcut={shortcutHint('palette.open')} tooltip="Search repositories, issues and commands" onClick={() => {
              runInAction(() => {
                ui.paletteOpen = true;
              });
            }}>Open the command menu</Button>
          }
        />
      </PageBody>
    </>
  );
}
