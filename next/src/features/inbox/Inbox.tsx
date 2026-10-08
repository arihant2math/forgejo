// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The inbox (/notifications). F3 provides the page; F6 renders the list.

import {Inbox as InboxIcon} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {PageBody} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {useSession} from '../../app/store.ts';
import {Badge, EmptyState} from '../../ui/index.ts';

const Unread = observer(function Unread() {
  const {data} = useSession();
  const n = data.pool.model('Notification').by('status', 'unread').size;
  return n ? <Badge tone="accent">{n} unread</Badge> : null;
});

export default function Inbox() {
  return (
    <>
      <PageHeader icon={InboxIcon} title="Inbox"><Unread/></PageHeader>
      <PageBody>
        <EmptyState icon={InboxIcon} title="Notifications show here" description="The inbox is on its way. Your unread count is already live."/>
      </PageBody>
    </>
  );
}
