// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Columns observe their own card order; cards observe their issue fields.
// Dragging updates only the dragged card's flag, not React state.

import {groupName, repoGroup} from '../../data/models.ts';
import {count} from '../../app/words.ts';
import {useNavigate, useParams, useSearch} from '@tanstack/react-router';
import {useVirtualizer} from '@tanstack/react-virtual';
import {autorun, runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type KeyboardEvent, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {canEditBoard, confirmAccess} from '../../app/access.ts';
import {sitePath} from '../../app/config.ts';
import {Missing} from '../../app/Missing.tsx';
import {connectivity, onlineOnly} from '../../app/online.ts';
import {notify} from '../../app/notices.ts';
import {useHold} from '../../app/repo.ts';
import {PageBody} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {activeHint, formatKeys, shortcutHint, useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {type PickerKind, useApp, useSession} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import type {ProjectColumn} from '../../protocol/types.gen.ts';
import {BoardCard, BoardColumn, BoardColumnDraft, BoardLanes, DropIndicator} from './BoardParts.tsx';
import {closedPager} from '../issues/closed.ts';
import {issueActions, openPicker} from '../issues/actions.ts';
import {AssigneesCell, LabelsCell, PendingCell, PriorityCell, StatusCell, TitleCell, usePool} from '../issues/cells.tsx';
import {issuePath} from '../issues/edits.ts';
import {KeyedFlags} from '../issues/flags.ts';
import {findCard} from './board.ts';
import {createColumn, deleteColumn, editColumn, orderColumns} from './columns.ts';
import {BoardDnd} from './dnd.ts';
import {SLOT} from './geometry.ts';
import {rememberBoard} from '../../app/lastBoard.ts';
import {openCreate} from '../../app/create.ts';
import {BoardModel} from './model.ts';
import {BoardSettings} from './ProjectDialogs.tsx';
import {AddExisting} from './AddExisting.tsx';
import {ArrowLeftIcon, ArrowRightIcon, ColumnsIcon, LinkExternalIcon, ProjectIcon, KebabHorizontalIcon, PencilIcon, PlusIcon, ChevronRightIcon, DashIcon, StarIcon, TrashIcon} from '@primer/octicons-react';
import {Button, IconButton, ActionMenu, ActionList, Label, ConfirmationDialog, Dialog, FormControl, TextInput, Tooltip} from '@primer/react';
import {SkeletonBox} from '@primer/react/experimental';
import {Crumbs} from '../../components/Crumbs.tsx';
import {EmptyState} from '../../components/EmptyState.tsx';

/** Preserve the active card across navigation, per tab. */
const lastCard = new Map<number, number>();

/** Closed-tier pages to load; each holds up to 500 issues by default. */
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

interface ColumnHandle {
  focus(): void;
  scrollTo(index: number): void;
}

const Board = observer(function Board({project}: {project: Entity<'Project'>}) {
  const app = useApp();
  const navigate = useNavigate();
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
  const [dragging] = useState(() => new KeyedFlags());
  const boardRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const handles = useRef(new Map<number, ColumnHandle>());
  const activeColumn = useRef<number | undefined>(undefined);
  const register = useCallback((id: number, h: ColumnHandle | undefined) => {
    if (h) handles.current.set(id, h);
    else handles.current.delete(id);
  }, []);
  const [dnd] = useState(() => new BoardDnd({
    board: () => boardRef.current,
    indicator: () => indicatorRef.current,
    count: (column) => untracked(() => model.cards(column).length),
    dragging: (id) => {
      dragging.replace(id === undefined ? [] : [id]);
    },
    drop: (issueId, target) => {
      model.move(issueId, target.column, target.gap);
    },
  }));
  useEffect(() => () => {
    dnd.dispose();
    model.dispose();
  }, [dnd, model]);
  const [menuCard, setMenuCard] = useState<number | undefined>();
  const menuAnchor = useRef<HTMLSpanElement>(null);
  const menuReturnFocus = useRef<HTMLElement>(null);
  const [menuPoint, setMenuPoint] = useState({x: 0, y: 0});
  const openCardMenu = (id: number, target: HTMLElement, x = 0, y = 0) => {
    const list = target.closest('[data-column]')?.querySelector<HTMLElement>('[role="listbox"]');
    menuReturnFocus.current = list ?? target;
    const rect = target.closest('[data-card]')?.getBoundingClientRect() ?? target.getBoundingClientRect();
    setMenuPoint(x || y ? {x, y} : {x: rect.left, y: rect.top});
    model.cursor.setActive(id);
    setMenuCard(id);
  };
  const columns = model.columns;
  const closed = project.get('closed');

  useEffect(() => autorun(() => {
    const target = model.cursor.active.values();
    if (target[0] !== undefined) lastCard.set(projectId, target[0]);
    runInAction(() => {
      app.ui.issueTarget = target;
    });
  }), [app, model, projectId]);
  // Wait for on-demand cards before restoring the requested or remembered cursor.
  const asked = useSearch({strict: false, select: (s: {card?: number}) => s.card});
  const placed = useRef(false);
  useEffect(() => autorun(() => {
    if (placed.current) return;
    const layout = model.layout.get();
    const id = asked ?? lastCard.get(projectId) ?? layout.columns.map((c) => layout.cards.get(c.id)?.[0]).find((card) => card !== undefined);
    if (id === undefined) {
      if (layout.columns[0]) {
        placed.current = true;
        focusColumn(layout.columns[0].id);
      }
      return;
    }
    if (model.cursor.activeId !== undefined) return;
    if (findCard(model.layout.get(), id)) {
      placed.current = true;
      untracked(() => {
        show(id);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the card is there
  }), [asked]);
  useEffect(() => () => {
    runInAction(() => {
      app.ui.issueTarget = [];
    });
  }, [app]);

  const open = (issueId: number, newTab = false) => {
    const issue = untracked(() => app.session?.data.pool.model('Issue').get(issueId));
    const path = issue && issuePath(app, issue);
    if (!path) return;
    if (newTab) window.open(`${app.config.app_sub_url}${path}`, '_blank', 'noopener');
    else void navigate({to: path});
  };
  const show = (issueId: number) => {
    activeColumn.current = findCard(untracked(() => model.layout.get()), issueId)?.column;
    model.cursor.setActive(issueId);
    // Wait for the moved card's column to render before focusing it.
    requestAnimationFrame(() => {
      const at = findCard(untracked(() => model.layout.get()), issueId);
      if (!at) return;
      const h = handles.current.get(at.column);
      h?.scrollTo(at.index);
      h?.focus();
      boardRef.current?.querySelector(`[data-column="${String(at.column)}"]`)?.scrollIntoView({block: 'nearest', inline: 'nearest'});
    });
  };
  const here = () => {
    const id = model.cursor.activeId;
    const layout = untracked(() => model.layout.get());
    return id === undefined ? undefined : {id, at: findCard(layout, id), layout};
  };
  const step = (dCol: number, dRow: number) => {
    const layout = untracked(() => model.layout.get());
    const cur = here();
    if (!cur?.at && activeColumn.current === undefined) {
      const first = layout.columns.map((c) => layout.cards.get(c.id)?.[0]).find((x) => x !== undefined);
      if (first !== undefined) show(first);
      return;
    }
    const column = cur?.at?.column ?? activeColumn.current;
    const ci = layout.columns.findIndex((c) => c.id === column);
    if (dCol) {
      const target = layout.columns[ci + dCol];
      if (!target) return;
      const list = layout.cards.get(target.id) ?? [];
      const next = list[Math.min(cur?.at?.index ?? 0, list.length - 1)];
      if (next !== undefined) show(next);
      else {
        model.cursor.setActive(undefined);
        focusColumn(target.id);
      }
      return;
    }
    const list = layout.cards.get(column ?? 0) ?? [];
    const next = list[Math.max(0, Math.min(list.length - 1, (cur?.at?.index ?? -1) + dRow))];
    if (next !== undefined) show(next);
  };
  const shift = (dCol: number, dRow: number) => {
    if (!editable) {
      notify(app, {tone: 'neutral', title: 'You can view this board, not change it', description: readOnlyReason, series: 'board.readonly'});
      return;
    }
    const cur = here();
    if (!cur?.at) return;
    const {layout, at} = cur;
    if (dCol) {
      const ci = layout.columns.findIndex((c) => c.id === at.column);
      const col = layout.columns[ci + dCol];
      if (!col) return;
      model.move(cur.id, col.id, model.rankIn(cur.id, col.id));
    } else {
      // Gaps: one below the card is index + 2, one above is index - 1.
      model.move(cur.id, at.column, dRow > 0 ? at.index + 2 : at.index - 1);
    }
    show(cur.id);
  };
  const pick = (kind: PickerKind) => () => {
    const id = model.cursor.activeId;
    if (id !== undefined) openPicker(app, kind, [id]);
  };
  // Register the board innermost so H/L override issue-label shortcuts.
  useShortcutScope('list');
  useShortcutScope('issue');
  useShortcutScope('board');
  useShortcut('list.next', () => {
    step(0, 1);
  });
  useShortcut('list.prev', () => {
    step(0, -1);
  });
  useShortcut('board.left', () => {
    step(-1, 0);
  });
  useShortcut('board.right', () => {
    step(1, 0);
  });
  const canShift = (dCol: number, dRow: number) => () => {
    const cur = untracked(here);
    if (!cur?.at) return false;
    if (!editable) return true; // the key says why it moves nothing
    const {layout, at} = cur;
    if (dCol) {
      const ci = layout.columns.findIndex((c) => c.id === at.column);
      return layout.columns[ci + dCol] !== undefined;
    }
    const n = layout.cards.get(at.column)?.length ?? 0;
    return dRow > 0 ? at.index < n - 1 : at.index > 0;
  };
  useShortcut('board.moveDown', () => {
    shift(0, 1);
  }, true, canShift(0, 1));
  useShortcut('board.moveUp', () => {
    shift(0, -1);
  }, true, canShift(0, -1));
  useShortcut('board.moveLeft', () => {
    shift(-1, 0);
  }, true, canShift(-1, 0));
  useShortcut('board.moveRight', () => {
    shift(1, 0);
  }, true, canShift(1, 0));
  useShortcut('issue.state', pick('status'));
  useShortcut('issue.labels', pick('labels'));
  useShortcut('issue.assignee', pick('assignees'));
  useShortcut('issue.milestone', pick('milestone'));
  useShortcut('issue.priority', pick('priority'));
  const [columnDialog, setColumnDialog] = useState<ColumnDialogState | undefined>();
  const [adding, setAdding] = useState(false);
  const [addTo, setAddTo] = useState<number>();
  useShortcut('board.removeCard', () => {
    const id = model.cursor.activeId;
    if (id !== undefined) model.setProject(id, 0, 0);
  }, editable, () => untracked(here)?.at !== undefined);
  const cursorColumn = () => untracked(here)?.at?.column ?? activeColumn.current;
  const columnOf = (id: number | undefined) => (id === undefined ? undefined : untracked(() => model.columns.find((c) => c.id === id)));
  useShortcut('board.addColumn', () => {
    setAdding(true);
  }, editable, () => connectivity.online);
  useShortcut('board.renameColumn', () => {
    const c = cursorColumn();
    if (c !== undefined) setColumnDialog({kind: 'rename', columnId: c});
  }, editable, () => connectivity.online && cursorColumn() !== undefined);
  useShortcut('board.deleteColumn', () => {
    const c = cursorColumn();
    if (c !== undefined) setColumnDialog({kind: 'delete', columnId: c});
  }, editable, () => connectivity.online && columnOf(cursorColumn())?.default === false);
  const focusColumn = (id: number | undefined) => {
    requestAnimationFrame(() => {
      const target = id ?? untracked(() => model.columns.find((c) => c.default)?.id ?? model.columns[0]?.id);
      if (target !== undefined) {
        activeColumn.current = target;
        handles.current.get(target)?.focus();
        boardRef.current?.querySelector(`[data-column="${String(target)}"]`)?.scrollIntoView({block: 'nearest', inline: 'nearest'});
      }
    });
  };
  useShortcut('create', () => {
    const layout = untracked(() => model.layout.get());
    const column = cursorColumn() ?? layout.columns.find((c) => c.default)?.id ?? layout.columns[0]?.id;
    if (column === undefined || !editable) openCreate(app);
    else newIssueIn(app, projectId, column);
  });

  // Cards call back through a ref: their props stay the same objects across renders.
  const actions = useRef({open, dnd, editable});
  actions.current = {open, dnd, editable};
  const [cardHandlers] = useState(() => ({
    click: (id: number, e: MouseEvent<HTMLElement>) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && actions.current.dnd.click()) return;
      e.preventDefault();
      if (!actions.current.dnd.click()) return;
      model.cursor.setActive(id);
      actions.current.open(id);
    },
    down: (id: number, e: PointerEvent) => {
      if (actions.current.editable) actions.current.dnd.down(e, id);
    },
  }));
  const onKeyDown = (e: KeyboardEvent) => {
    // Only a column's own keys (not Enter in the new column's name field, or in a menu).
    if ((e.target as Element).getAttribute('role') !== 'listbox') return;
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      if (model.cursor.activeId !== undefined) {
        e.preventDefault();
        openCardMenu(model.cursor.activeId, e.target as HTMLElement);
      }
      return;
    }
    const arrows: Record<string, [number, number]> = {ArrowDown: [0, 1], ArrowUp: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0]};
    const dir = arrows[e.key];
    if (dir && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) shift(dir[0], dir[1]);
      else step(dir[0], dir[1]);
    } else if (e.key === 'Enter' && model.cursor.activeId !== undefined) {
      e.preventDefault();
      open(model.cursor.activeId, e.metaKey || e.ctrlKey);
    }
  };
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

interface ColumnDialogState {
  kind: 'rename' | 'delete';
  columnId: number;
}

function ColumnDialog({model, state, onClose}: {model: BoardModel; state: ColumnDialogState; onClose: (deleted: boolean) => void}) {
  const app = useApp();
  const projectId = model.projectId;
  const column = untracked(() => model.columns.find((c) => c.id === state.columnId));
  const [title, setTitle] = useState(column?.title ?? '');
  const field = useRef<HTMLInputElement>(null);
  if (!column) return null;
  const close = () => { onClose(false); };
  const save = () => {
    const name = title.trim();
    if (!name) return;
    close();
    if (name !== column.title) void editColumn(app, projectId, column.id, {title: name});
  };
  if (state.kind === 'rename') {
    return <Dialog title="Rename the column" initialFocusRef={field} onClose={close} footerButtons={[
      {content: 'Cancel', onClick: close},
      {content: 'Save', buttonType: 'primary', disabled: !title.trim(), onClick: save},
    ]}>
      <form onSubmit={(e) => { e.preventDefault(); save(); }}>
        <FormControl>
          <FormControl.Label>Column name</FormControl.Label>
          <TextInput ref={field} block value={title} maxLength={100} onFocus={(e) => { e.currentTarget.select(); }}
            onChange={(e) => { setTitle(e.target.value); }}/>
        </FormControl>
      </form>
    </Dialog>;
  }
  return <ConfirmationDialog title={`Delete “${column.title}”?`} confirmButtonContent="Delete" confirmButtonType="danger" onClose={(gesture) => {
    onClose(gesture === 'confirm');
    if (gesture === 'confirm') void deleteColumn(app, projectId, column.id);
  }}>Its cards move to the default column.</ConfirmationDialog>;
}

const ColumnMenu = observer(function ColumnMenu({model, column, index, count, onDialog}: {
  model: BoardModel; column: ProjectColumn; index: number; count: number; onDialog: (kind: ColumnDialogState['kind']) => void;
}) {
  const app = useApp();
  const projectId = model.projectId;
  const order = () => untracked(() => model.columns.map((c) => c.id));
  const offline = !connectivity.online;
  const reorder = (by: number) => {
    const ids = order();
    const [moved] = ids.splice(index, 1);
    if (moved === undefined) return;
    ids.splice(index + by, 0, moved);
    void orderColumns(app, projectId, ids);
  };
  return (
    <>
      <ActionMenu>
        <ActionMenu.Anchor><IconButton icon={KebabHorizontalIcon} variant="invisible" size="small" aria-label={`Column “${column.title}”`} type="button"/></ActionMenu.Anchor>
        <ActionMenu.Overlay align="end"><ActionList>
          {offline && <ActionList.Item disabled>{onlineOnly('Changing columns')}</ActionList.Item>}
          <ActionList.Item disabled={offline} onSelect={() => {
            onDialog('rename');
          }}><ActionList.LeadingVisual><PencilIcon/></ActionList.LeadingVisual>Rename…</ActionList.Item>
          <ActionList.Item disabled={offline || column.default} onSelect={() => {
            const before = untracked(() => model.columns.find((c) => c.default));
            void editColumn(app, projectId, column.id, {default: true}).then((ok) => {
              if (!ok) return;
              notify(app, {tone: 'neutral', title: `“${column.title}” is the default column`, description: 'New cards go there.',
                ...(before ? {action: {label: 'Undo', run: () => {
                  void editColumn(app, projectId, before.id, {default: true});
                }}} : {})});
            });
          }}><ActionList.LeadingVisual><StarIcon/></ActionList.LeadingVisual>{column.default ? 'The default column' : 'Make it the default'}</ActionList.Item>
          <ActionList.Item disabled={offline || index === 0} onSelect={() => {
            reorder(-1);
          }}><ActionList.LeadingVisual><ArrowLeftIcon/></ActionList.LeadingVisual>Move left</ActionList.Item>
          <ActionList.Item disabled={offline || index === count - 1} onSelect={() => {
            reorder(1);
          }}><ActionList.LeadingVisual><ArrowRightIcon/></ActionList.LeadingVisual>Move right</ActionList.Item>
          <ActionList.Divider/>
          <ActionList.Item onSelect={() => {
            newIssueIn(app, model.projectId, column.id);
          }}><ActionList.LeadingVisual><PencilIcon/></ActionList.LeadingVisual>New issue in this column…</ActionList.Item>
          <ActionList.Divider/>
          <ActionList.Item variant="danger" disabled={offline || column.default} onSelect={() => {
            onDialog('delete');
          }}><ActionList.LeadingVisual><TrashIcon/></ActionList.LeadingVisual>Delete…</ActionList.Item>
        </ActionList></ActionMenu.Overlay>
      </ActionMenu>
    </>
  );
});

/** Prefer the board's repository, or the repository supplying most of its cards. */
function newIssueIn(app: ReturnType<typeof useApp>, projectId: number, columnId: number, title?: string): void {
  const repoId = untracked(() => {
    const pool = app.session?.data.pool;
    if (!pool) return 0;
    const own = pool.model('Project').get(projectId)?.get('repo_id') ?? 0;
    if (own) return own;
    const count = new Map<number, number>();
    for (const card of pool.model('ProjectIssue').by('project_id', projectId)) {
      const r = pool.model('Issue').get(card.get('issue_id'))?.get('repo_id');
      if (r) count.set(r, (count.get(r) ?? 0) + 1);
    }
    return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  });
  openCreate(app, repoId, {projectId, columnId}, title);
}

const AddColumn = observer(function AddColumn({projectId, editing, setEditing}: {projectId: number; editing: boolean; setEditing: (on: boolean) => void}) {
  const app = useApp();
  const [title, setTitle] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // Keep keyboard focus on the add button rather than losing it to <body>.
  const refocus = useRef(false);
  const close = () => {
    refocus.current = true;
    setEditing(false);
  };
  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    button.current?.focus({preventScroll: true});
  }, [editing]);
  const offline = !connectivity.online;
  const submit = () => {
    const t = title.trim();
    if (!t) return;
    void createColumn(app, projectId, t).then((ok) => {
      if (ok) {
        setTitle('');
        close();
      }
    });
  };
  useEffect(() => {
    const el = field.current;
    if (!editing || !el) return;
    el.focus({preventScroll: true});
    el.closest('section')?.scrollIntoView({block: 'nearest', inline: 'nearest'});
  }, [editing]);
  const tip = useMemo(() => (offline ? onlineOnly('Adding a column') : 'Add a column at the end'), [offline]);
  if (editing) {
    return (
      <BoardColumnDraft>
        <TextInput size="small" ref={field} aria-label="New column name" placeholder="Column name" value={title} className="w-full" maxLength={100} onChange={(e) => {
            setTitle(e.target.value);
          }} onBlur={() => {
            if (!title.trim()) setEditing(false);
          }} onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}/>
        <p className="px-1 text-sm text-muted">Enter adds it, Esc cancels.</p>
      </BoardColumnDraft>
    );
  }
  return (
    <div className="flex w-column shrink-0 flex-col">
      <Tooltip text={tip}><Button size="small" variant="invisible" leadingVisual={PlusIcon} type="button" ref={button} inactive={offline} aria-disabled={offline} onClick={() => {
        if (!offline) setEditing(true);
      }}>Add column</Button></Tooltip>
    </div>
  );
});
