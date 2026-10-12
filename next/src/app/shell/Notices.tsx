// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {observer} from 'mobx-react-lite';
import {useRef} from 'react';
import {Banner, Button} from '@primer/react';
import {dismiss, pauseNotice, resumeNotice} from '../notices.ts';
import {useApp, type App} from '../store.ts';

type NoticeRecord = App['ui']['notices'][number];
const NoticeBanner = observer(function NoticeBanner({app, notice}: {app: App; notice: NoticeRecord}) {
  const hovered = useRef(false);
  const focused = useRef(false);
  const hold = (held: boolean) => {
    if (held) pauseNotice(notice.id);
    else resumeNotice(app, notice.id);
  };
  return (
    <div className="pointer-events-auto"
      onPointerEnter={() => { hovered.current = true; hold(true); }}
      onPointerLeave={() => { hovered.current = false; if (!focused.current) hold(false); }}
      onFocus={() => { focused.current = true; hold(true); }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        focused.current = false;
        if (!hovered.current) hold(false);
      }}>
      <Banner variant={notice.tone === 'danger' ? 'critical' : notice.tone === 'neutral' ? 'info' : notice.tone}
        title={notice.title} description={notice.description} onDismiss={() => { dismiss(app, notice.id); }}
        primaryAction={notice.action && <Button size="small" onClick={() => { notice.action?.run(); dismiss(app, notice.id); }}>{notice.action.label}</Button>}/>
    </div>
  );
});

export const Notices = observer(function Notices() {
  const app = useApp();
  return <>{app.ui.notices.map((notice) => <NoticeBanner key={notice.id} app={app} notice={notice}/>)}</>;
});
