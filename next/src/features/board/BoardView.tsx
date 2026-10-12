// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {ArrowLeftIcon, ArrowRightIcon, ChevronRightIcon, ColumnsIcon, DashIcon, LinkExternalIcon, PencilIcon, PlusIcon, ProjectIcon} from '@primer/octicons-react';
import {ActionList, ActionMenu, Button, Label, Tooltip} from '@primer/react';
import {SkeletonBox} from '@primer/react/experimental';
import {useParams} from '@tanstack/react-router';
import {useVirtualizer} from '@tanstack/react-virtual';
import {autorun, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type MouseEvent, useEffect, useRef, useState} from 'react';
import {canEditBoard, confirmAccess} from '../../app/access.ts';
import {sitePath} from '../../app/config.ts';
import {rememberBoard} from '../../app/lastBoard.ts';
import {Missing} from '../../app/Missing.tsx';
import {useHold} from '../../app/repo.ts';
import {PageBody} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {activeHint, formatKeys, shortcutHint} from '../../app/shortcuts/index.ts';
import {useApp, useSession} from '../../app/store.ts';
import {count} from '../../app/words.ts';
import {Crumbs} from '../../components/Crumbs.tsx';
import {EmptyState} from '../../components/EmptyState.tsx';
import type {Entity} from '../../data/entity.ts';
import {groupName, repoGroup} from '../../data/models.ts';
import type {ProjectColumn} from '../../protocol/types.gen.ts';
import {issueActions} from '../issues/actions.ts';
import {AssigneesCell, LabelsCell, PendingCell, PriorityCell, StatusCell, TitleCell, usePool} from '../issues/cells.tsx';
import {closedPager} from '../issues/closed.ts';
import {issuePath} from '../issues/edits.ts';
import type {KeyedFlags} from '../issues/flags.ts';
import {AddExisting} from './AddExisting.tsx';
import {findCard} from './board.ts';
import {BoardCard, BoardColumn, BoardLanes, DropIndicator} from './BoardParts.tsx';
import {type ColumnDialogState, AddColumn, ColumnDialog, ColumnMenu} from './ColumnControls.tsx';
import {newIssueIn} from './create.ts';
import {SLOT} from './geometry.ts';
import {BoardModel} from './model.ts';
import {BoardSettings} from './ProjectDialogs.tsx';
import {useBoardDrag} from './useBoardDrag.ts';
import {type ColumnHandle, useBoardKeys} from './useBoardKeys.ts';

/** Preserve the active card across navigation, per tab. */
const CLOSED_PAGES = 4;

export function BoardPage() {
  const {id: raw = ''} = useParams({strict: false});
  const id = /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : 0;
  return <ProjectPage key={id} projectId={id}/>;
}

const ProjectPage = observer(function ProjectPage({projectId}: {projectId: number}) {
  const {data, userId} = useSession();
  const pool = usePool();
  const project = pool.model('Project').get(projectId);
  const repoId = project?.get('repo_id') ?? 0;
  useHold(data, repoId ? repoGroup(repoId) : undefined);
  // ProjectRef boards live in the owner's group, not the repository's group.
  const ref = project ? undefined : pool.model('ProjectRef').get(projectId)?.data;
  useHold(data, ref ? groupName(ref.type === 3 ? 'org' : 'profile', ref.owner_id) : undefined);
  // Closed issues must load before their cards can be positioned; cap pages to bound device storage.
  useEffect(() => {
    if (!repoId) return undefined;
    const pager = closedPager(data, repoGroup(repoId));
    return autorun(() => {
      if (!pager.done && !pager.loading && pager.pages < CLOSED_PAGES) pager.more();
    });
  }, [data, repoId]);
  useEffect(() => {
    if (project) rememberBoard(userId, projectId);
  }, [project, userId, projectId]);
  if (!project) {
    const loading = data.status.loading > 0;
    return (
      <>
        <PageHeader icon={ProjectIcon} title="Board"/>
        <PageBody>
          {loading ?
            <div className="flex gap-4 p-4" aria-busy>{[0, 1, 2].map((i) => <SkeletonBox className="h-72 w-column" key={i}/>)}</div> :
            <Missing icon={ProjectIcon} what="This board"/>}
        </PageBody>
      </>
    );
  }
  return <Board project={project}/>;
});

/** Boards / owner [/ repository] */
const ProjectContext = observer(function ProjectContext({project}: {project: Entity<'Project'>}) {
  const pool = usePool();
  const repo = pool.model('Repository').get(project.get('repo_id'));
  const login = pool.model('User').get(project.get('owner_id'))?.get('login');
  const owner = repo?.get('owner_name') ?? login;
  return <Crumbs crumbs={[
    {label: 'Boards', link: {to: '/-/next/boards'}},
    ...(owner ? [{label: owner, link: {to: '/$owner', params: {owner}}} as const] : []),
    ...(repo ? [{label: repo.get('name'), link: {to: '/$owner/$repo', params: {owner: repo.get('owner_name'), repo: repo.get('name')}}} as const] : []),
  ]}/>;
});

const Board = observer(function Board({project}: {project: Entity<'Project'>}) {
  const app = useApp();
  const projectId = project.id;
  const session = useSession();
  const editable = canEditBoard(session, project.data);
  const owner = session.data.pool.model('User').get(project.get('owner_id'))?.get('login');
  const readOnlyReason = project.get('repo_id') ? 'Changing this board needs write access to its repository.' :
    project.get('type') === 3 ? 'Changing this board needs a team with write access to the organization’s projects.' :
      `Only ${owner ?? 'the owner'} can change this board.`;
  const repoForAccess = boardRepo(session, project.get('repo_id'));
  useEffect(() => {
    if (repoForAccess) confirmAccess(app, repoForAccess.owner_name, repoForAccess.name, repoForAccess.id);
  }, [app, repoForAccess]);
  const [model] = useState(() => new BoardModel(app, projectId));
  const boardRef = useRef<HTMLDivElement>(null);
  const {register, activeColumn, open, onKeyDown, focusColumn, menuCard, setMenuCard, menuAnchor, menuReturnFocus, menuPoint,
    openCardMenu, columnDialog, setColumnDialog, adding, setAdding, addTo, setAddTo} = useBoardKeys({app, model, projectId, editable, readOnlyReason, boardRef});
  const {dragging, indicatorRef, cardHandlers} = useBoardDrag(model, boardRef, editable, open);
  const columns = model.columns;
  const closed = project.get('closed');
  const hidden = model.hiddenCount;
  return (
    <>
      <PageHeader icon={ProjectIcon} context={<ProjectContext project={project}/>} title={project.get('title')} leaf>
        {closed && <Label variant="done">Closed</Label>}
        {!editable && <span title={readOnlyReason}><Label>Read-only</Label></span>}
        {hidden > 0 && <Label>{count(hidden, 'card', 'cards')} not on this device</Label>}
        <ClosedTierBadge repoId={project.get('repo_id')}/>
        {editable && <BoardSettings project={project.data}/>}
      </PageHeader>
      <span ref={menuAnchor} aria-hidden className="pointer-events-none fixed" style={{left: menuPoint.x, top: menuPoint.y}}/>
      <BoardLanes ref={boardRef} onKeyDown={onKeyDown}
        onContextMenuCapture={(e) => {
          const target = e.target as HTMLElement;
          const card = target.closest('[data-card]');
          const id = card ? Number(card.getAttribute('data-card')) : target.getAttribute('role') === 'listbox' ? model.cursor.activeId : undefined;
          if (id === undefined) {
            if (!target.closest('input,textarea,[contenteditable="true"]') && !document.getSelection()?.toString()) e.preventDefault();
            return;
          }
          e.preventDefault();
          openCardMenu(id, target, e.clientX, e.clientY);
        }}>
        {columns.map((c, i) => (
          <Column key={c.id} model={model} column={c} index={i} count={columns.length} dragging={dragging} handlers={cardHandlers} register={register} editable={editable}
            onAdd={() => { setAddTo(c.id); }} onFocus={() => {
              activeColumn.current = c.id;
            }} onDialog={(kind) => {
              setColumnDialog({kind, columnId: c.id});
            }}/>
        ))}
        {columns.length === 0 && <EmptyState icon={ColumnsIcon} title="No columns yet" description="Add a column to start the board."/>}
        {editable && <AddColumn projectId={projectId} editing={adding} setEditing={setAdding}/>}
      </BoardLanes>
      <ActionMenu open={menuCard !== undefined} anchorRef={menuAnchor} onOpenChange={(open) => { if (!open) setMenuCard(undefined); }}>
        <ActionMenu.Overlay returnFocusRef={menuReturnFocus} side="outside-bottom">
          <ActionList>{menuCard !== undefined && <CardMenu model={model} issueId={menuCard} open={open} editable={editable} onClose={() => { setMenuCard(undefined); }}/>}</ActionList>
        </ActionMenu.Overlay>
      </ActionMenu>
      <DropIndicator ref={indicatorRef}/>
      {addTo !== undefined && <AddExisting model={model} project={project} columnId={addTo} onClose={() => { setAddTo(undefined); focusColumn(addTo); }} onCreate={(title) => {
        setAddTo(undefined);
        focusColumn(addTo);
        // Restore column focus first so the create dialog returns focus there on close.
        requestAnimationFrame(() => { newIssueIn(app, projectId, addTo, title); });
      }}/>}
      {columnDialog && <ColumnDialog model={model} state={columnDialog} onClose={(deleted) => {
        setColumnDialog(undefined);
        focusColumn(deleted ? undefined : columnDialog.columnId);
      }}/>}
    </>
  );
});

const ClosedTierBadge = observer(function ClosedTierBadge({repoId}: {repoId: number}) {
  const {data} = useSession();
  if (!repoId) return null;
  const pager = closedPager(data, repoGroup(repoId));
  if (pager.done) return null;
  if (pager.pages < CLOSED_PAGES) return pager.loading ? <Label>Loading older closed cards…</Label> : null;
  return <Label variant="attention">Older closed cards may be missing</Label>;
});

function boardRepo(s: ReturnType<typeof useSession>, repoId: number) {
  return repoId ? s.data.pool.model('Repository').get(repoId)?.data : undefined;
}

function CardMenu({model, issueId, open, editable, onClose}: {model: BoardModel; issueId: number; open: (id: number, newTab?: boolean) => void; editable: boolean; onClose: () => void}) {
  const app = useApp();
  const layout = untracked(() => model.layout.get());
  const at = findCard(layout, issueId);
  const issue = untracked(() => app.session?.data.pool.model('Issue').get(issueId));
  const ci = layout.columns.findIndex((c) => c.id === at?.column);
  const actions = issue ? issueActions(app, [issue]).filter((a) => a.id !== 'open') : [];
  const moveTo = (columnId: number) => {
    model.move(issueId, columnId, model.rankIn(issueId, columnId));
    onClose();
  };
  const moveBy = (d: number) => {
    const col = layout.columns[ci + d];
    if (col) moveTo(col.id);
  };
  return (
    <>
      <ActionList.Item onSelect={() => { open(issueId); }}>
        <ActionList.LeadingVisual><LinkExternalIcon/></ActionList.LeadingVisual>
        Open<ActionList.TrailingVisual>{formatKeys('enter')}</ActionList.TrailingVisual>
      </ActionList.Item>
      {editable && <>
        <ActionList.Divider/>
        <ActionList.Item disabled={ci <= 0} onSelect={() => { moveBy(-1); }}>
          <ActionList.LeadingVisual><ArrowLeftIcon/></ActionList.LeadingVisual>
          Move to the previous column<ActionList.TrailingVisual>{shortcutHint('board.moveLeft')}</ActionList.TrailingVisual>
        </ActionList.Item>
        <ActionList.Item disabled={ci < 0 || ci >= layout.columns.length - 1} onSelect={() => { moveBy(1); }}>
          <ActionList.LeadingVisual><ArrowRightIcon/></ActionList.LeadingVisual>
          Move to the next column<ActionList.TrailingVisual>{shortcutHint('board.moveRight')}</ActionList.TrailingVisual>
        </ActionList.Item>
        <ActionMenu>
          <ActionMenu.Anchor><ActionList.Item>
            <ActionList.LeadingVisual><ColumnsIcon/></ActionList.LeadingVisual>Move to
            <ActionList.TrailingVisual><ChevronRightIcon/></ActionList.TrailingVisual>
          </ActionList.Item></ActionMenu.Anchor>
          <ActionMenu.Overlay side="outside-right"><ActionList>
            {layout.columns.map((c) => <ActionList.Item key={c.id} disabled={c.id === at?.column} onSelect={() => { moveTo(c.id); }}>{c.title}</ActionList.Item>)}
          </ActionList></ActionMenu.Overlay>
        </ActionMenu>
      </>}
      {actions.length > 0 && <ActionList.Divider/>}
      {actions.map((a) => <ActionList.Item key={a.id} onSelect={() => { a.run(); }}>
        <ActionList.LeadingVisual><a.icon/></ActionList.LeadingVisual>{a.label}
        {a.shortcut && <ActionList.TrailingVisual>{activeHint(a.shortcut)}</ActionList.TrailingVisual>}
      </ActionList.Item>)}
      {issue && editable && <>
        <ActionList.Divider/>
        <ActionList.Item onSelect={() => { model.setProject(issueId, 0, 0); }}>
          <ActionList.LeadingVisual><DashIcon/></ActionList.LeadingVisual>Remove from board
          <ActionList.TrailingVisual>{shortcutHint('board.removeCard')}</ActionList.TrailingVisual>
        </ActionList.Item>
      </>}
    </>
  );
}

interface CardHandlers {
  click(id: number, e: MouseEvent<HTMLElement>): void;
  down(id: number, e: PointerEvent): void;
}

const cardDomId = (id: number) => `card-${String(id)}`;

const Column = observer(function Column({model, column, index, count, dragging, handlers, register, editable, onDialog, onFocus, onAdd}: {
  model: BoardModel; column: ProjectColumn; index: number; count: number; dragging: KeyedFlags; handlers: CardHandlers;
  onAdd: () => void;
  register: (id: number, h: ColumnHandle | undefined) => void; editable: boolean; onFocus: () => void; onDialog: (kind: ColumnDialogState['kind']) => void;
}) {
  const app = useApp();
  const cards = model.cards(column.id);
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: cards.length,
    getScrollElement: () => body,
    estimateSize: () => SLOT,
    overscan: 4,
    getItemKey: (i) => cards[i] ?? i,
  });
  useEffect(() => {
    register(column.id, {
      focus: () => listRef.current?.focus({preventScroll: true}),
      scrollTo: (i) => {
        virtualizer.scrollToIndex(i, {align: 'auto'});
      },
    });
    return () => {
      register(column.id, undefined);
    };
  }, [register, virtualizer, column.id]);
  useEffect(() => autorun(() => {
    const [id] = model.cursor.active.values();
    const el = listRef.current;
    if (!el) return;
    if (id !== undefined && model.cards(column.id).includes(id)) el.setAttribute('aria-activedescendant', cardDomId(id));
    else el.removeAttribute('aria-activedescendant');
  }), [model, column.id]);
  const items = virtualizer.getVirtualItems();
  return (
    <BoardColumn columnId={column.id} title={column.title} count={cards.length} bodyRef={setBody}
      leading={column.color ? <span aria-hidden className="size-2 shrink-0 rounded-full border border-default" style={{backgroundColor: /^(?:#?[\da-f]{6})$/i.test(column.color) ? `#${column.color.replace(/^#/, '')}` : 'var(--fgColor-muted)'}}/> : null}
      badge={column.default ? <Label>Default</Label> : undefined}
      actions={editable ? <ColumnMenu model={model} column={column} index={index} count={count} onDialog={onDialog}/> : undefined}>
      <div ref={listRef} role="listbox" aria-label={column.title} data-shortcuts tabIndex={0} className="relative min-h-12 w-full outline-none"
        style={{height: virtualizer.getTotalSize()}}
        onFocus={(e) => {
          if (e.target !== e.currentTarget) return;
          onFocus();
          const active = model.cursor.activeId;
          if (active === undefined || !cards.includes(active)) {
            const first = cards[0];
            model.cursor.setActive(first);
          }
        }}>
        {items.map((it) => {
          const id = cards[it.index];
          if (id === undefined) return null;
          return (
            <div key={it.key} className="absolute inset-x-0 top-0" style={{transform: `translateY(${String(it.start)}px)`}}>
              <CardItem issueId={id} model={model} dragging={dragging} handlers={handlers}/>
            </div>
          );
        })}
      </div>
      {editable && (
        <div className="flex flex-col items-start gap-1 pb-2">
          <Button size="small" variant="invisible" leadingVisual={PlusIcon} type="button" onClick={onAdd}>Add existing issue…</Button>
          <Tooltip text="Cards are issues: a board holds no notes. The new issue goes in this column."><Button size="small" variant="invisible" leadingVisual={PencilIcon} type="button" aria-label={`New issue in “${column.title}”`} onClick={() => { newIssueIn(app, model.projectId, column.id); }}>New issue</Button></Tooltip>
        </div>
      )}
    </BoardColumn>
  );
});

const CardItem = observer(function CardItem({issueId, model, dragging, handlers}: {issueId: number; model: BoardModel; dragging: KeyedFlags; handlers: CardHandlers}) {
  const app = useApp();
  const pool = usePool();
  const issue = pool.model('Issue').get(issueId);
  const path = issue && issuePath(app, issue);
  const project = pool.model('Project').get(model.projectId);
  const repoName = issue && project && project.get('repo_id') !== issue.get('repo_id') ? pool.model('Repository').get(issue.get('repo_id'))?.get('name') : undefined;
  const ref = useRef<HTMLElement>(null);
  // A native listener: React's synthetic pointer events are delegated (one more hop) and passive-agnostic.
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const down = (e: PointerEvent) => {
      handlers.down(issueId, e);
    };
    el.addEventListener('pointerdown', down);
    return () => {
      el.removeEventListener('pointerdown', down);
    };
  }, [handlers, issueId]);
  if (!issue) return null;
  return (
    <BoardCard ref={ref} id={cardDomId(issueId)} data-card={issueId} active={model.cursor.active.has(issueId)} dragging={dragging.has(issueId)}
      href={path ? sitePath(app.config, path) : undefined} tabIndex={-1}
      onClick={(e) => {
        handlers.click(issueId, e);
      }}
      meta={<>
        <StatusCell issue={issue}/>
        <span className="min-w-0 truncate">{repoName}#{issue.get('number')}</span>
        <PendingCell issueId={issueId}/>
        <span className="ml-auto flex items-center gap-1"><PriorityCell issue={issue}/><AssigneesCell issue={issue}/></span>
      </>}
      title={<TitleCell issue={issue}/>}
      footer={<LabelsCell issue={issue} max={2}/>}
    />
  );
});
