// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {BellSlashIcon, GitCommitIcon, InboxIcon, KebabHorizontalIcon, LinkExternalIcon, MailIcon, PinIcon, PinSlashIcon, ReadIcon, RepoIcon} from '@primer/octicons-react';
import {ActionList, ActionMenu, Checkbox, CounterLabel, IconButton} from '@primer/react';
import {KeybindingHint} from '@primer/react/experimental';
import {useNavigate} from '@tanstack/react-router';
import {useVirtualizer} from '@tanstack/react-virtual';
import {clsx} from 'clsx';
import {autorun, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type KeyboardEvent, type MouseEvent, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {rememberListRows} from '../../app/boot.ts';
import {sitePath} from '../../app/config.ts';
import {useSiteLink} from '../../app/links.ts';
import {focusList, rememberedRow, rememberRow} from '../../app/listReturn.ts';
import {afterPaint} from '../../app/paint.ts';
import {pageListRect} from '../../app/shell/Frame.tsx';
import {formatKeys, shortcutHint, useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {useApp, useSession} from '../../app/store.ts';
import {IssueReference} from '../../components/IssueReference.tsx';
import {ListRow, NORMAL_ROW_HEIGHT} from '../../components/ListRow.tsx';
import type {Entity} from '../../data/entity.ts';
import {notificationStatus} from '../../intents/view.ts';
import {AgoCell, StateGlyph, StateIcon, stateLook, TitleCell, useUser} from '../issues/cells.tsx';
import {useOverlay} from '../../intents/editing.ts';
import {usePool} from '../../app/store.ts';
import {issuePath} from '../issues/edits.ts';
import {setStatus, type StatusTo, triage, unsubscribe, unsubscribeReason} from './actions.ts';
import {activityOf, noteHash, togglePin} from './inbox.ts';
import type {InboxModel} from './InboxModel.ts';
import {reasonOf} from './reason.ts';
import {serverReasons} from './serverReasons.ts';
import {knownSubject, type Subject, subjectOf, subjectPath} from './subject.ts';

const ROW = NORMAL_ROW_HEIGHT;

const rowId = (id: number) => `inbox-row-${String(id)}`;

/** Share one return cursor across inbox filters. */
const INBOX = '/notifications';

export const InboxList = observer(function InboxList({model, scroller, byRepo}: {model: InboxModel; scroller: HTMLDivElement | null; byRepo: boolean}) {
  const app = useApp();
  const navigate = useNavigate();
  const {rows, ids} = model.result.get();
  const {cursor} = model;
  const listRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller,
    ...pageListRect(),
    estimateSize: (index) => rows[index]?.type === 'note' ? ROW : 40,
    // Avoid synchronous virtualizer work on every scroll event.
    useFlushSync: false,
    overscan: 4,
    getItemKey: (i) => {
      const r = rows[i];
      return r ? (r.type === 'note' ? r.id : `g:${r.key}`) : i;
    },
  });
  const visible = Math.min(rows.length, 40);
  useEffect(() => {
    rememberListRows(visible);
  }, [visible]);
  // Preserve the next row as cursor when triage removes the active row.
  const prevIds = useRef<readonly number[]>(ids);
  useLayoutEffect(() => {
    const listed = new Set(ids);
    const active = cursor.activeId;
    if (active !== undefined && !listed.has(active)) {
      const old = prevIds.current;
      const at = old.indexOf(active);
      const next = [...old.slice(at + 1), ...old.slice(0, Math.max(0, at)).reverse()].find((id) => listed.has(id));
      cursor.setActive(next);
    }
    cursor.keep(listed);
    prevIds.current = ids;
  }, [ids, cursor]);
  useEffect(() => autorun(() => {
    const [id] = cursor.active.values();
    if (id !== undefined) rememberRow(INBOX, id);
    const el = listRef.current;
    if (!el) return;
    if (id === undefined) el.removeAttribute('aria-activedescendant');
    else el.setAttribute('aria-activedescendant', rowId(id));
  }), [cursor]);
  useLayoutEffect(() => {
    const back = rememberedRow(INBOX);
    if (typeof back !== 'number' || cursor.activeId !== undefined) return;
    const at = untracked(() => model.result.get().rows.findIndex((r) => r.type === 'note' && r.id === back));
    if (at < 0) return;
    cursor.setActive(back);
    virtualizer.scrollToIndex(at, {align: 'auto'});
    focusList(listRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the list mounts
  }, []);

  const open = (id: number, newTab = false) => {
    const s = app.session;
    const n = s && untracked(() => s.data.pool.model('Notification').get(id));
    if (!n) return;
    const issue = untracked(() => s.data.pool.model('Issue').get(n.data.issue_id));
    const subject = issue ? undefined : untracked(() => knownSubject(app, id));
    const path = issue ? issuePath(app, issue) : subject && subjectPath(subject);
    setStatus(app, [id], (st) => (st === 'unread' ? 'read' : undefined));
    if (!path) return;
    const hash = noteHash(n.data);
    if (newTab) window.open(`${app.config.app_sub_url}${path}${hash ? `#${hash}` : ''}`, '_blank', 'noopener');
    else void navigate({to: path, ...(hash ? {hash} : {})});
  };
  const move = (delta: number) => {
    if (!ids.length) return;
    const at = cursor.activeId === undefined ? -1 : ids.indexOf(cursor.activeId);
    const next = ids[at < 0 ? (delta > 0 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, at + delta))];
    if (next === undefined) return;
    cursor.setActive(next);
    virtualizer.scrollToIndex(rows.findIndex((r) => r.type === 'note' && r.id === next), {align: 'auto'});
    listRef.current?.focus({preventScroll: true});
  };
  const triageKey = (to: StatusTo, said?: 'read' | 'unread' | 'pin') => () => {
    let targets = cursor.targets();
    if (!targets.length && ids[0] !== undefined) {
      cursor.setActive(ids[0]);
      targets = [ids[0]];
    }
    triage(app, targets, to, said);
  };
  const clear = () => {
    cursor.clearSelection();
  };
  const clearable = () => untracked(() => cursor.selected.size > 0);
  useShortcutScope('list');
  useShortcut('list.next', () => {
    move(1);
  });
  useShortcut('list.prev', () => {
    move(-1);
  });
  useShortcut('list.select', () => {
    if (cursor.activeId === undefined && ids[0] !== undefined) cursor.setActive(ids[0]);
    if (cursor.activeId !== undefined) cursor.toggle(cursor.activeId);
  });
  useShortcut('list.open', () => {
    if (cursor.activeId !== undefined) open(cursor.activeId);
  }, true, () => cursor.activeId !== undefined);
  useShortcut('list.clear', clear, true, clearable);
  useShortcut('inbox.read', triageKey((st) => (st === 'unread' ? 'read' : undefined), 'read'));
  useShortcut('inbox.unread', triageKey(() => 'unread', 'unread'));
  useShortcut('inbox.pin', triageKey(togglePin, 'pin'));
  useShortcut('inbox.unsubscribe', () => {
    const targets = cursor.targets();
    unsubscribe(app, targets.length ? targets : ids.slice(0, 1));
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' && cursor.activeId !== undefined) {
      e.preventDefault();
      open(cursor.activeId, e.metaKey || e.ctrlKey);
    } else if (e.key === 'Escape' && clearable()) {
      e.preventDefault();
      clear();
    }
  };
  const handlers = useRef({open, cursor, ids});
  handlers.current = {open, cursor, ids};
  const [click] = useState(() => (id: number, e: {shiftKey: boolean; metaKey: boolean; ctrlKey: boolean}) => {
    const h = handlers.current;
    if (e.shiftKey) {
      h.cursor.selectRange(id, h.ids);
      return;
    }
    h.cursor.setActive(id);
    h.open(id, e.metaKey || e.ctrlKey);
  });

  const items = virtualizer.getVirtualItems();
  const refocus = () => {
    focusList(listRef.current);
  };
  const [menuIds, setMenuIds] = useState<number[]>([]);
  const contextAnchor = useRef<HTMLElement>(null);
  const showContextMenu = (id: number, anchor: HTMLElement | null) => {
    const selected = untracked(() => cursor.selected.values());
    contextAnchor.current = anchor ?? listRef.current;
    setMenuIds(selected.includes(id) ? selected : [id]);
    if (!selected.includes(id)) cursor.setActive(id);
  };
  return (
    <>
        <div
          ref={listRef}
          role="listbox"
          aria-label="Notifications"
          aria-multiselectable
          data-shortcuts
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
              event.preventDefault();
              const id = cursor.activeId ?? ids[0];
              if (id !== undefined) showContextMenu(id, document.getElementById(rowId(id)));
            } else onKeyDown(event);
          }}
          onFocus={(e) => {
            if (e.target !== e.currentTarget || cursor.activeId !== undefined) return;
            const first = items.map((it) => rows[it.index]).find((r) => r?.type === 'note');
            if (first?.type === 'note') cursor.setActive(first.id);
          }}
          onPointerLeave={() => {
            if (model.menuFor === undefined) model.hover.clear();
          }}
          onContextMenuCapture={(e) => {
            const el = (e.target as Element).closest('[data-note]');
            const id = el ? Number(el.getAttribute('data-note')) : cursor.activeId;
            if (id === undefined) {
              e.preventDefault();
              return;
            }
            e.preventDefault();
            showContextMenu(id, el instanceof HTMLElement ? el : document.getElementById(rowId(id)));
          }}
          className="relative w-full outline-none"
          style={{height: virtualizer.getTotalSize()}}
        >
          {items.map((it) => {
            const r = rows[it.index];
            if (!r) return null;
            return (
              <div key={it.key} className="absolute inset-x-0 top-0 hover:bg-control-transparent-hover" style={{transform: `translateY(${String(it.start)}px)`}} onPointerEnter={r.type === 'note' ? (e) => {
                if (e.pointerType === 'mouse' && model.menuFor === undefined) model.hover.replace([r.id]);
              } : undefined}>
                {r.type === 'note' ?
                  <>
                    <NoteRow id={r.id} model={model} onClick={click} byRepo={byRepo}/>
                    <RowCheck id={r.id} model={model} onClick={click}/>
                    <RowActions id={r.id} model={model} open={open} refocus={refocus}/>
                  </> :
                  <div role="presentation" className="flex min-h-10 items-center gap-2 border-b border-default bg-muted px-4 py-2">
                    {r.key === 'pinned' ? <PinIcon size={16}/> : r.key.startsWith('repo:') ? <RepoIcon size={16}/> : null}
                    <span className="min-w-0 truncate font-semibold">{r.label}</span><CounterLabel>{r.count}</CounterLabel>
                  </div>}
              </div>
            );
          })}
        </div>
      <ActionMenu anchorRef={contextAnchor} open={menuIds.length > 0} onOpenChange={(isOpen) => {
        if (!isOpen) { setMenuIds([]); afterPaint(refocus); }
      }}>
        <ActionMenu.Overlay><ActionList>
          <NoteMenu ids={menuIds} open={open}/>
        </ActionList></ActionMenu.Overlay>
      </ActionMenu>
    </>
  );
});

const NoteMenu = observer(function NoteMenu({ids, open}: {ids: readonly number[]; open: (id: number) => void}) {
  const app = useApp();
  const pool = usePool();
  const overlay = useOverlay();
  const one = ids.length === 1 ? ids[0] : undefined;
  const n = one === undefined ? undefined : pool.model('Notification').get(one);
  const status = n ? notificationStatus(overlay, n) : undefined;
  const cannotUnsubscribe = unsubscribeReason(app, ids);
  const many = ids.length > 1 ? ` (${String(ids.length)})` : '';
  return (
    <>
      {one !== undefined && <>
        <ActionList.Item onSelect={() => {
          open(one);
        }}><ActionList.LeadingVisual><LinkExternalIcon size={16}/></ActionList.LeadingVisual>Open<ActionList.TrailingVisual><KeybindingHint keys={formatKeys('enter')}/></ActionList.TrailingVisual></ActionList.Item>
        <ActionList.Divider/>
      </>}
      <ActionList.Item disabled={status !== undefined && status !== 'unread'} onSelect={() => {
        triage(app, ids, (st) => (st === 'unread' ? 'read' : undefined), 'read');
      }}><ActionList.LeadingVisual><ReadIcon size={16}/></ActionList.LeadingVisual>{`Mark as read${many}`}<ActionList.TrailingVisual><KeybindingHint keys={shortcutHint('inbox.read')}/></ActionList.TrailingVisual></ActionList.Item>
      <ActionList.Item disabled={status === 'unread'} onSelect={() => {
        triage(app, ids, () => 'unread', 'unread');
      }}><ActionList.LeadingVisual><MailIcon size={16}/></ActionList.LeadingVisual>{`Mark as unread${many}`}<ActionList.TrailingVisual><KeybindingHint keys={shortcutHint('inbox.unread')}/></ActionList.TrailingVisual></ActionList.Item>
      <ActionList.Item onSelect={() => {
        triage(app, ids, togglePin, 'pin');
      }}><ActionList.LeadingVisual>{status === 'pinned' ? <PinSlashIcon size={16}/> : <PinIcon size={16}/>} </ActionList.LeadingVisual>{status === 'pinned' ? 'Unpin' : `Pin${many}`}<ActionList.TrailingVisual><KeybindingHint keys={shortcutHint('inbox.pin')}/></ActionList.TrailingVisual></ActionList.Item>
      <ActionList.Divider/>
      <ActionList.Item disabled={!!cannotUnsubscribe} onSelect={() => {
        unsubscribe(app, ids);
      }}><ActionList.LeadingVisual><BellSlashIcon size={16}/></ActionList.LeadingVisual>{`Unsubscribe${many}`}<ActionList.TrailingVisual><KeybindingHint keys={shortcutHint('inbox.unsubscribe')}/></ActionList.TrailingVisual></ActionList.Item>
      <ActionList.Item disabled={!!cannotUnsubscribe} onSelect={() => {
        unsubscribe(app, ids, true);
      }}><ActionList.LeadingVisual><BellSlashIcon size={16}/></ActionList.LeadingVisual>{`Unsubscribe and mark read${many}`}</ActionList.Item>
      {cannotUnsubscribe && <div className="px-2 py-1 text-xs text-muted">{cannotUnsubscribe}</div>}
    </>
  );
});

/**
 * A pointer checkbox over the row's leading space, outside its link; X and the option's selected state serve the
 * keyboard and assistive tech. The whole leading space, the row's height, is its target, so a touch that misses the
 * box selects instead of opening the row.
 */
const RowCheck = observer(function RowCheck({id, model, onClick}: {id: number; model: InboxModel; onClick: RowClick}) {
  const checked = model.cursor.selected.has(id);
  return (
    <div aria-hidden className="absolute inset-y-0 left-0 flex w-10 cursor-pointer items-center ps-4" onMouseDown={(e) => { e.preventDefault(); }} onClick={(e) => {
      if (e.shiftKey) onClick(id, e);
      else model.cursor.toggle(id);
    }}>
      <Checkbox tabIndex={-1} checked={checked} aria-label="Select" onChange={() => undefined}/>
    </div>
  );
});

/** Mouse-only actions are hidden from assistive tech and tab order; keys and the row menu provide equivalents. */
const RowActions = observer(function RowActions({id, model, open, refocus}: {id: number; model: InboxModel; open: (id: number) => void; refocus: () => void}) {
  const app = useApp();
  const pool = usePool();
  const overlay = useOverlay();
  const shown = model.hover.has(id);
  const n = pool.model('Notification').get(id);
  if (!shown || !n) return null;
  const status = notificationStatus(overlay, n);
  const unread = status === 'unread';
  const keepFocus = (e: MouseEvent) => {
    e.preventDefault();
  };
  return (
    <div data-note={id} aria-hidden className="absolute inset-y-0 right-0 flex items-center pe-2">
      <div className="flex items-center gap-1 rounded-md border border-default bg-overlay">
        <IconButton icon={unread ? ReadIcon : MailIcon} variant="invisible" size="small" aria-label={unread ? 'Mark as read' : 'Mark as unread'} keybindingHint={shortcutHint(unread ? 'inbox.read' : 'inbox.unread')} type="button" tabIndex={-1} onMouseDown={keepFocus} onClick={() => {
          triage(app, [id], unread ? (st) => (st === 'unread' ? 'read' : undefined) : () => 'unread', unread ? 'read' : 'unread');
        }}/>
        <IconButton icon={status === 'pinned' ? PinSlashIcon : PinIcon} variant="invisible" size="small" aria-label={status === 'pinned' ? 'Unpin' : 'Pin, to keep it for later'} keybindingHint={shortcutHint('inbox.pin')} type="button" tabIndex={-1} onMouseDown={keepFocus} onClick={() => {
          triage(app, [id], togglePin, 'pin');
        }}/>
        <ActionMenu onOpenChange={(isOpen) => {
          model.menuFor = isOpen ? id : undefined;
          if (!isOpen) { model.hover.clear(); afterPaint(refocus); }
        }}>
          <ActionMenu.Anchor><IconButton icon={KebabHorizontalIcon} variant="invisible" size="small" aria-label="More actions" type="button" tabIndex={-1}/></ActionMenu.Anchor>
          <ActionMenu.Overlay align="end"><ActionList>
            <NoteMenu ids={[id]} open={open}/>
          </ActionList></ActionMenu.Overlay>
        </ActionMenu>
      </div>
    </div>
  );
});

type RowClick = (id: number, e: {shiftKey: boolean; metaKey: boolean; ctrlKey: boolean}) => void;

const NoteRow = observer(function NoteRow({id, model, onClick, byRepo}: {id: number; model: InboxModel; onClick: RowClick; byRepo: boolean}) {
  const pool = usePool();
  const n = pool.model('Notification').get(id);
  if (!n) return <ListRow role="presentation"> </ListRow>;
  return <NoteRowBody n={n} model={model} onClick={onClick} byRepo={byRepo}/>;
});

const NoteRowBody = observer(function NoteRowBody({n, model, onClick, byRepo}: {n: Entity<'Notification'>; model: InboxModel; onClick: RowClick; byRepo: boolean}) {
  const pool = usePool();
  const app = useApp();
  const link = useSiteLink();
  const {userId} = useSession();
  const {cursor} = model;
  const status = notificationStatus(useOverlay(), n);
  const issue = pool.model('Issue').get(n.get('issue_id'));
  const subject = issue ? undefined : subjectOf(app, n.data);
  const repo = pool.model('Repository').get(n.get('repo_id'))?.get('full_name') ?? (subject ? `${subject.owner}/${subject.repo}` : '');
  const unread = status === 'unread';
  const at = activityOf(n.data, issue?.get('updated_at') ?? subject?.updated);
  const path = issue ? issuePath(app, issue) : subject && subjectPath(subject);
  const hash = noteHash(n.data);
  const reason = reasonOf(pool, n.data, userId, pool.model('User').get(userId)?.get('login'), serverReasons(app));
  const number = issue ? issue.get('number') : subject?.number;
  const selected = cursor.selected.has(n.id);
  const href = path ? `${sitePath(app.config, path)}${hash ? `#${hash}` : ''}` : undefined;
  const intent = href === undefined ? undefined : link(href);
  return (
    <ListRow
      role="option"
      id={rowId(n.id)}
      data-note={n.id}
      active={cursor.active.has(n.id)}
      selected={selected}
      href={href}
      tabIndex={-1}
      onPointerEnter={intent?.onPointerEnter}
      onPointerLeave={intent?.onPointerLeave}
      onClick={(e) => {
        if (path && (e.metaKey || e.ctrlKey) && !e.shiftKey) return;
        e.preventDefault();
        onClick(n.id, e);
      }}
      leading={<>
        <span aria-hidden className="size-4 shrink-0"/>
        <span aria-hidden className={clsx("size-2 shrink-0 rounded-full", unread ? "bg-accent-emphasis" : "bg-transparent")}/>
        {issue ? <StateIcon issue={issue}/> : subject ? <SubjectIcon s={subject}/> : n.get('subject') === 'commit' ? <GitCommitIcon size={16}/> : <InboxIcon size={16}/>}
      </>}
      trailing={<>
        {status === 'pinned' && <PinIcon size={12} className="shrink-0"/>}
        <IssueReference repo={byRepo ? '' : repo} number={number}/>
        <AgoCell at={at}/>
      </>}
    >
      {/* Bound secondary metadata and let it shrink first, preserving the title on phones. */}
      <span className="flex min-w-0 items-center">
        {(unread || status === 'pinned') && <span className="sr-only">{unread ? 'Unread: ' : 'Pinned: '}</span>}
        <span className={clsx('min-w-0 truncate', unread ? 'font-semibold text-default' : 'text-default')}>
          {issue ? <TitleCell issue={issue}/> : subject ? subject.title : subjectWords(n.get('subject'))}
        </span>
        {reason && <Why why={reason.why} actor={reason.actor}/>}
      </span>
    </ListRow>
  );
});

function Why({why, actor}: {why: string; actor: number}) {
  const user = useUser(actor);
  const description = actor && user.name ? `· ${why} · ${user.name}` : `· ${why}`;
  return <span title={description} className="ms-2 min-w-8 max-w-2/5 shrink-4 truncate text-sm text-muted max-md:max-w-1/4">{description}</span>;
}

function SubjectIcon({s}: {s: Subject}) {
  return <StateGlyph look={stateLook(s.state === 'open' ? 'open' : 'closed', s.pull, s.state === 'merged')}/>;
}

function subjectWords(subject: string): string {
  switch (subject) {
    case 'commit':
      return 'A commit (not on this device)';
    case 'repository':
      return 'Repository activity';
    case 'pull':
      return 'A pull request (not on this device)';
    default:
      return 'An issue (not on this device)';
  }
}
