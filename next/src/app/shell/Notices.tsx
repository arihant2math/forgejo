// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The notices the app posted (notices.ts), inside the shell's viewport. Its
// own chunk, loaded when the first notice shows.

import {observer} from 'mobx-react-lite';
import {Button, Notice} from '../../ui/index.ts';
import {dismiss, pauseNotice, removeNotice, resumeNotice} from '../notices.ts';
import {useApp} from '../store.ts';

export const Notices = observer(function Notices() {
  const app = useApp();
  return (
    <>
      {app.ui.notices.map((n) => (
        <Notice
          key={n.id}
          tone={n.tone}
          title={n.title}
          description={n.description}
          closing={n.closing}
          onDismiss={() => {
            dismiss(app, n.id);
          }}
          onClosed={() => {
            removeNotice(app, n.id);
          }}
          onHold={(held) => {
            if (held) pauseNotice(n.id);
            else resumeNotice(app, n.id);
          }}
          action={n.action && (
            <Button size="sm" onClick={() => {
              n.action?.run();
              dismiss(app, n.id);
            }}>{n.action.label}</Button>
          )}
        />
      ))}
    </>
  );
});
