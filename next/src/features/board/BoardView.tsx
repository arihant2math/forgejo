// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A project board (PLAN §7.3: Linear's board), at /-/next/projects/{id}:
// the project's columns side by side, each a virtualized listbox of cards.
// Cards move by drag and drop (dnd.ts), by keyboard (Shift+H/J/K/L) or from
// their menu; every move is an offline-capable intent shown at once.
// Columns are added, renamed, reordered, made the default and deleted
// online (columns.ts). G B comes back to the last board opened.
//
// Rendering: the board re-renders when its columns change; a column when
// its own card order changes (BoardModel.cards); a card when its issue's
// fields do. Dragging touches no React state but the dragged card's flag.

import {Link, useNavigate, useParams} from '@tanstack/react-router';
import {useVirtualizer} from '@tanstack/react-virtual';
import {ArrowLeft, ArrowRight, Columns3, ExternalLink, KanbanSquare, MoreHorizontal, Pencil, Plus, Star, Trash2} from 'lucide-react';
import {autorun, runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type KeyboardEvent, useEffect, useMemo, useRef, useState} from 'react';
import {connectivity, onlineOnly} from '../../app/online.ts';
import {useHold} from '../../app/repo.ts';
import {PageBody} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {type PickerKind, useApp, useSession} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import type {ProjectColumn} from '../../protocol/types.gen.ts';
import {
  Badge, BoardCard, BoardColumn, Button, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSub, ContextMenuTrigger, Dialog, DropIndicator,
  EmptyState, IconButton, Input, LabelDot, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Skeleton,
} from '../../ui/index.ts';
import {openPicker} from '../issues/actions.ts';
import {AssigneesCell, LabelsCell, PendingCell, PriorityCell, StatusCell, TitleCell, usePool} from '../issues/cells.tsx';
import {issuePath} from '../issues/edits.ts';
import {KeyedFlags} from '../issues/flags.ts';
import {findCard} from './board.ts';
import {createColumn, deleteColumn, editColumn, orderColumns} from './columns.ts';
import {BoardDnd, SLOT} from './dnd.ts';
import {rememberBoard} from '../../app/lastBoard.ts';
import {BoardModel} from './model.ts';

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
  // A repository's project: its issues (the cards) are in the repository's group.
  useHold(data, repoId ? `repo:${String(repoId)}` : undefined);
  useEffect(() => {
    if (project) rememberBoard(userId, projectId);
  }, [project, userId, projectId]);
  if (!project) {
    const loading = data.status.loading > 0;
    return (
      <>
        <PageHeader icon={KanbanSquare} title="Board"/>
        <PageBody>
          {loading ?
            <div className="flex gap-3 p-4" aria-busy>{[0, 1, 2].map((i) => <Skeleton key={i} className="h-72 w-column"/>)}</div> :
            <EmptyState icon={KanbanSquare} title="Board not found" description="This board does not exist, you cannot see it, or it is not on this device yet."
              action={<Button asChild size="sm"><Link to="/-/next/boards">All boards</Link></Button>}/>}
        </PageBody>
      </>
    );
  }
  return <Board project={project}/>;
});

const ProjectContext = observer(function ProjectContext({project}: {project: Entity<'Project'>}) {
  const pool = usePool();
  const repo = pool.model('Repository').get(project.get('repo_id'));
  const owner = pool.model('User').get(project.get('owner_id'));
  const name = repo?.get('full_name') ?? owner?.get('login');
  return (
    <>
      <Link to="/-/next/boards" className="hover:text-fg">Boards</Link>
      {name && <><span aria-hidden>/</span><span className="truncate">{name}</span></>}
    </>
  );
});

interface ColumnHandle {
  focus(): void;
  scrollTo(index: number): void;
}

const Board = observer(function Board({project}: {project: Entity<'Project'>}) {
  const app = useApp();
  const navigate = useNavigate();
  const projectId = project.id;
  const [model] = useState(() => new BoardModel(app, projectId));
  const [dragging] = useState(() => new KeyedFlags());
  const boardRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const handles = useRef(new Map<number, ColumnHandle>());
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
  const columns = model.columns;
  const closed = project.get('closed');

  // The palette's issue actions and the pickers (S/L/A/M/P) act on the cursor's card.
  useEffect(() => autorun(() => {
    const target = model.cursor.active.values();
    runInAction(() => {
      app.ui.issueTarget = target;
    });
  }), [app, model]);
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
  /** Puts the cursor on a card and shows it. */
  const show = (issueId: number) => {
    model.cursor.setActive(issueId);
    // After the render that placed it (a move re-renders its column first).
    requestAnimationFrame(() => {
      const at = findCard(untracked(() => model.layout.get()), issueId);
      if (!at) return;
      const h = handles.current.get(at.column);
      h?.scrollTo(at.index);
      h?.focus();
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
    if (!cur?.at) {
      const first = layout.columns.map((c) => layout.cards.get(c.id)?.[0]).find((x) => x !== undefined);
      if (first !== undefined) show(first);
      return;
    }
    const ci = layout.columns.findIndex((c) => c.id === cur.at?.column);
    if (dCol) {
      // The nearest column that has cards in that direction.
      for (let i = ci + dCol; i >= 0 && i < layout.columns.length; i += dCol) {
        const list = layout.cards.get(layout.columns[i]?.id ?? 0) ?? [];
        const next = list[Math.min(cur.at.index, list.length - 1)];
        if (next !== undefined) {
          show(next);
          return;
        }
      }
      return;
    }
    const list = layout.cards.get(cur.at.column) ?? [];
    const next = list[Math.max(0, Math.min(list.length - 1, cur.at.index + dRow))];
    if (next !== undefined) show(next);
  };
  const shift = (dCol: number, dRow: number) => {
    const cur = here();
    if (!cur?.at) return;
    const {layout, at} = cur;
    if (dCol) {
      const ci = layout.columns.findIndex((c) => c.id === at.column);
      const col = layout.columns[ci + dCol];
      if (!col) return;
      const n = layout.cards.get(col.id)?.length ?? 0;
      model.move(cur.id, col.id, Math.min(at.index, n));
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
  useShortcutScope('list');
  useShortcutScope('board');
  useShortcutScope('issue');
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
  useShortcut('board.moveDown', () => {
    shift(0, 1);
  });
  useShortcut('board.moveUp', () => {
    shift(0, -1);
  });
  useShortcut('board.moveLeft', () => {
    shift(-1, 0);
  });
  useShortcut('board.moveRight', () => {
    shift(1, 0);
  });
  useShortcut('issue.state', pick('status'));
  useShortcut('issue.labels', pick('labels'));
  useShortcut('issue.assignee', pick('assignees'));
  useShortcut('issue.milestone', pick('milestone'));
  useShortcut('issue.priority', pick('priority'));

  // Cards call back through a ref: their props stay the same objects across renders.
  const actions = useRef({open, dnd});
  actions.current = {open, dnd};
  const [cardHandlers] = useState(() => ({
    click: (id: number, e: {metaKey: boolean; ctrlKey: boolean}) => {
      if (!actions.current.dnd.click()) return;
      model.cursor.setActive(id);
      actions.current.open(id, e.metaKey || e.ctrlKey);
    },
    down: (id: number, e: PointerEvent) => {
      actions.current.dnd.down(e, id);
    },
  }));
  const onKeyDown = (e: KeyboardEvent) => {
    // Only a column's own keys (not Enter in the new column's name field, or in a menu).
    if ((e.target as Element).getAttribute('role') !== 'listbox') return;
    if (e.key === 'Enter' && model.cursor.activeId !== undefined) {
      e.preventDefault();
      open(model.cursor.activeId, e.metaKey || e.ctrlKey);
    }
  };
  const hidden = model.hidden;
  return (
    <>
      <PageHeader icon={KanbanSquare} context={<ProjectContext project={project}/>} title={project.get('title')}>
        {closed && <Badge tone="done">Closed</Badge>}
        {hidden > 0 && <Badge>{hidden} {hidden === 1 ? 'card' : 'cards'} not on this device</Badge>}
      </PageHeader>
      <ContextMenu onOpenChange={(o) => {
        if (!o) setMenuCard(undefined);
      }}>
        <ContextMenuTrigger asChild>
          <div ref={boardRef} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto p-3"
            onContextMenuCapture={(e) => {
              const el = (e.target as Element).closest('[data-card]');
              const id = el ? Number(el.getAttribute('data-card')) : undefined;
              setMenuCard(id);
              if (id !== undefined) model.cursor.setActive(id);
            }}>
            {columns.map((c, i) => (
              <Column key={c.id} model={model} column={c} index={i} count={columns.length} dragging={dragging} handlers={cardHandlers}
                register={(h) => {
                  if (h) handles.current.set(c.id, h);
                  else handles.current.delete(c.id);
                }}/>
            ))}
            {columns.length === 0 && <EmptyState icon={Columns3} title="No columns yet" description="Add a column to start the board."/>}
            <AddColumn projectId={projectId}/>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {menuCard !== undefined && <CardMenu model={model} issueId={menuCard} open={open}/>}
        </ContextMenuContent>
      </ContextMenu>
      <DropIndicator ref={indicatorRef}/>
    </>
  );
});

/** A card's menu: open it, move it to another column (the pointer-free way, touch included). */
function CardMenu({model, issueId, open}: {model: BoardModel; issueId: number; open: (id: number, newTab?: boolean) => void}) {
  const layout = untracked(() => model.layout.get());
  const at = findCard(layout, issueId);
  return (
    <>
      <ContextMenuItem icon={ExternalLink} onSelect={() => {
        open(issueId);
      }}>Open</ContextMenuItem>
      <ContextMenuSub label="Move to" icon={Columns3}>
        {layout.columns.map((c) => (
          <ContextMenuItem key={c.id} disabled={c.id === at?.column} onSelect={() => {
            model.move(issueId, c.id, 0);
          }}>{c.title}</ContextMenuItem>
        ))}
      </ContextMenuSub>
    </>
  );
}

interface CardHandlers {
  click(id: number, e: {metaKey: boolean; ctrlKey: boolean}): void;
  down(id: number, e: PointerEvent): void;
}

const cardDomId = (id: number) => `card-${String(id)}`;

const Column = observer(function Column({model, column, index, count, dragging, handlers, register}: {
  model: BoardModel; column: ProjectColumn; index: number; count: number; dragging: KeyedFlags; handlers: CardHandlers;
  register: (h: ColumnHandle | undefined) => void;
}) {
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
    register({
      focus: () => listRef.current?.focus({preventScroll: true}),
      scrollTo: (i) => {
        virtualizer.scrollToIndex(i, {align: 'auto'});
      },
    });
    return () => {
      register(undefined);
    };
  }, [register, virtualizer]);
  // The listbox names the cursor's card when it is in this column.
  useEffect(() => autorun(() => {
    const [id] = model.cursor.active.values();
    const el = listRef.current;
    if (!el) return;
    if (id !== undefined && untracked(() => model.cards(column.id)).includes(id)) el.setAttribute('aria-activedescendant', cardDomId(id));
    else el.removeAttribute('aria-activedescendant');
  }), [model, column.id]);
  const items = virtualizer.getVirtualItems();
  return (
    <BoardColumn columnId={column.id} title={column.title} count={cards.length} bodyRef={setBody}
      leading={column.color ? <LabelDot color={column.color}/> : null}
      actions={<ColumnMenu projectId={model.projectId} column={column} index={index} count={count} order={() => untracked(() => model.columns.map((c) => c.id))}/>}>
      <div ref={listRef} role="listbox" aria-label={column.title} data-shortcuts tabIndex={0} className="relative w-full outline-none"
        style={{height: virtualizer.getTotalSize()}}
        onFocus={(e) => {
          if (e.target !== e.currentTarget) return;
          const active = model.cursor.activeId;
          if (active === undefined || !cards.includes(active)) {
            const first = cards[0];
            if (first !== undefined) model.cursor.setActive(first);
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
    </BoardColumn>
  );
});

const CardItem = observer(function CardItem({issueId, model, dragging, handlers}: {issueId: number; model: BoardModel; dragging: KeyedFlags; handlers: CardHandlers}) {
  const issue = usePool().model('Issue').get(issueId);
  const ref = useRef<HTMLDivElement>(null);
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
      onClick={(e) => {
        handlers.click(issueId, e);
      }}
      meta={<>
        <StatusCell issue={issue}/>
        <span>#{issue.get('number')}</span>
        <PendingCell issueId={issueId}/>
        <span className="ml-auto flex items-center gap-1"><PriorityCell issue={issue}/><AssigneesCell issue={issue}/></span>
      </>}
      title={<TitleCell issue={issue}/>}
      footer={<LabelsCell issue={issue} max={2}/>}
    />
  );
});

const ColumnMenu = observer(function ColumnMenu({projectId, column, index, count, order}: {
  projectId: number; column: ProjectColumn; index: number; count: number; order: () => number[];
}) {
  const app = useApp();
  const [dialog, setDialog] = useState<'rename' | 'delete' | undefined>();
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
      <Menu>
        <MenuTrigger asChild><IconButton size="sm" icon={MoreHorizontal} label={`Column “${column.title}”`}/></MenuTrigger>
        <MenuContent align="end">
          {offline && <MenuItem disabled>{onlineOnly('Changing columns')}</MenuItem>}
          <MenuItem icon={Pencil} disabled={offline} onSelect={() => {
            setDialog('rename');
          }}>Rename…</MenuItem>
          <MenuItem icon={Star} disabled={offline || column.default} onSelect={() => {
            void editColumn(app, projectId, column.id, {default: true});
          }}>{column.default ? 'The default column' : 'Make it the default'}</MenuItem>
          <MenuItem icon={ArrowLeft} disabled={offline || index === 0} onSelect={() => {
            reorder(-1);
          }}>Move left</MenuItem>
          <MenuItem icon={ArrowRight} disabled={offline || index === count - 1} onSelect={() => {
            reorder(1);
          }}>Move right</MenuItem>
          <MenuSeparator/>
          <MenuItem icon={Trash2} danger disabled={offline || column.default} onSelect={() => {
            setDialog('delete');
          }}>Delete…</MenuItem>
        </MenuContent>
      </Menu>
      {dialog === 'rename' && <RenameDialog initial={column.title} onClose={() => {
        setDialog(undefined);
      }} onSave={(title) => {
        void editColumn(app, projectId, column.id, {title});
      }}/>}
      {dialog === 'delete' && (
        <Dialog open title={`Delete “${column.title}”?`} description="Its cards move to the default column." onOpenChange={(o) => {
          if (!o) setDialog(undefined);
        }} footer={<>
          <Button variant="ghost" onClick={() => {
            setDialog(undefined);
          }}>Cancel</Button>
          <Button variant="danger" onClick={() => {
            setDialog(undefined);
            void deleteColumn(app, projectId, column.id);
          }}>Delete</Button>
        </>}/>
      )}
    </>
  );
});

function RenameDialog({initial, onClose, onSave}: {initial: string; onClose: () => void; onSave: (title: string) => void}) {
  const [title, setTitle] = useState(initial);
  const save = () => {
    const t = title.trim();
    if (!t) return;
    onClose();
    if (t !== initial) onSave(t);
  };
  return (
    <Dialog open size="sm" title="Rename the column" onOpenChange={(o) => {
      if (!o) onClose();
    }} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!title.trim()} onClick={save}>Save</Button>
    </>}>
      <Input aria-label="Column name" value={title} autoFocus className="w-full" maxLength={100} onChange={(e) => {
        setTitle(e.target.value);
      }} onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          save();
        }
      }}/>
    </Dialog>
  );
}

/** The lane after the last column: "Add column", then a name field (online only). */
const AddColumn = observer(function AddColumn({projectId}: {projectId: number}) {
  const app = useApp();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const offline = !connectivity.online;
  const submit = () => {
    const t = title.trim();
    if (!t) return;
    void createColumn(app, projectId, t).then((ok) => {
      if (ok) {
        setTitle('');
        setEditing(false);
      }
    });
  };
  const tip = useMemo(() => (offline ? onlineOnly('Adding a column') : 'Add a column at the end'), [offline]);
  return (
    <div className="flex w-column shrink-0 flex-col">
      {editing ?
        <Input aria-label="New column name" placeholder="Column name" value={title} autoFocus className="w-full" maxLength={100}
          onChange={(e) => {
            setTitle(e.target.value);
          }}
          onBlur={() => {
            if (!title.trim()) setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setEditing(false);
            }
          }}/> :
        <Button variant="ghost" icon={Plus} tooltip={tip} disabled={offline} onClick={() => {
          setEditing(true);
        }}>Add column</Button>}
    </div>
  );
});
