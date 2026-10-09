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

import {Link, useNavigate, useParams, useSearch} from '@tanstack/react-router';
import {useVirtualizer} from '@tanstack/react-virtual';
import {ArrowLeft, ArrowRight, Columns3, ExternalLink, KanbanSquare, MoreHorizontal, Pencil, Plus, Slash, SquareMinus, SquarePen, Star, Trash2} from 'lucide-react';
import {autorun, runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type KeyboardEvent, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {canEditBoard, confirmAccess} from '../../app/access.ts';
import {sitePath} from '../../app/config.ts';
import {classicHref} from '../../app/classic.ts';
import {ClassicLink} from '../../app/ClassicLink.tsx';
import {connectivity, onlineOnly} from '../../app/online.ts';
import {notify} from '../../app/notices.ts';
import {useHold} from '../../app/repo.ts';
import {PageBody} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {activeHint, formatKeys, shortcutHint, useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {classicOfHere} from '../../app/session.ts';
import {type PickerKind, useApp, useSession} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import type {ProjectColumn} from '../../protocol/types.gen.ts';
import {
  Badge, BoardCard, BoardColumn, BoardColumnDraft, BoardLanes, Button, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSub, ContextMenuTrigger, Dialog, DropIndicator,
  ContextMenuSeparator, EmptyState, Icon, IconButton, Input, LabelDot, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, PromptDialog, Skeleton,
  TextLink,
} from '../../ui/index.ts';
import {closedPager} from '../issues/closed.ts';
import {issueActions, openPicker} from '../issues/actions.ts';
import {AssigneesCell, LabelsCell, PendingCell, PriorityCell, StatusCell, TitleCell, usePool} from '../issues/cells.tsx';
import {issuePath} from '../issues/edits.ts';
import {KeyedFlags} from '../issues/flags.ts';
import {findCard} from './board.ts';
import {createColumn, deleteColumn, editColumn, orderColumns} from './columns.ts';
import {BoardDnd, SLOT} from './dnd.ts';
import {rememberBoard} from '../../app/lastBoard.ts';
import {openCreate} from '../../app/create.ts';
import {BoardModel} from './model.ts';

/** The card the cursor was on when a board was left (Back or Esc from a card finds it there). Per tab. */
const lastCard = new Map<number, number>();

/** Closed-tier pages a board loads at most (B6: ≤ 500 issues each by default). */
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
  // A repository's project: its issues (the cards) are in the repository's group.
  useHold(data, repoId ? `repo:${String(repoId)}` : undefined);
  // A user's or an organization's board that is not on this device (a collaborator who knows it from an issue:
  // its ProjectRef): its owner's group has the board, its columns and cards, for whoever may see the owner (classic
  // shows it to them too). Held while the page is open.
  const ref = project ? undefined : pool.model('ProjectRef').get(projectId)?.data;
  useHold(data, ref ? `${ref.type === 3 ? 'org' : 'profile'}:${String(ref.owner_id)}` : undefined);
  // Cards of older closed issues are in the repository's closed tier (B6), and B9 counts them in positions: the
  // board pages that tier in while it is open — at most CLOSED_PAGES pages (the device does not know whether a
  // closed issue is on the board until it has it; a repository with more old closed issues keeps the rest out).
  useEffect(() => {
    if (!repoId) return undefined;
    const pager = closedPager(data, `repo:${String(repoId)}`);
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
        <PageHeader icon={KanbanSquare} title="Board"/>
        <PageBody>
          {loading ?
            <div className="flex gap-3 p-3" aria-busy>{[0, 1, 2].map((i) => <Skeleton key={i} className="h-72 w-column"/>)}</div> :
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
  const login = owner?.get('login');
  return (
    <>
      <TextLink><Link to="/-/next/boards" activeOptions={{exact: true}}>Boards</Link></TextLink>
      {repo ? (
        <>
          <Icon icon={Slash} size="sm" className="text-fg-subtle"/>
          <TextLink><Link to="/$owner" params={{owner: repo.get('owner_name')}} activeOptions={{exact: true}}>{repo.get('owner_name')}</Link></TextLink>
          <Icon icon={Slash} size="sm" className="text-fg-subtle"/>
          <TextLink><Link to="/$owner/$repo" params={{owner: repo.get('owner_name'), repo: repo.get('name')}} activeOptions={{exact: true}}>{repo.get('name')}</Link></TextLink>
        </>
      ) : login && (
        <>
          <Icon icon={Slash} size="sm" className="text-fg-subtle"/>
          <TextLink><Link to="/$owner" params={{owner: login}} activeOptions={{exact: true}}>{login}</Link></TextLink>
        </>
      )}
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
  const session = useSession();
  // Readers see the board; only those who may change it get drag and drop, moves and column edits.
  const editable = canEditBoard(session, project.data);
  const repoForAccess = boardRepo(session, project.get('repo_id'));
  useEffect(() => {
    if (repoForAccess) confirmAccess(app, repoForAccess.owner_name, repoForAccess.name, repoForAccess.id);
  }, [app, repoForAccess]);
  const [model] = useState(() => new BoardModel(app, projectId));
  const [dragging] = useState(() => new KeyedFlags());
  const boardRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const handles = useRef(new Map<number, ColumnHandle>());
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
  const columns = model.columns;
  const closed = project.get('closed');

  // The palette's issue actions and the pickers (S/L/A/M/P) act on the cursor's card; the board remembers it.
  useEffect(() => autorun(() => {
    const target = model.cursor.active.values();
    if (target[0] !== undefined) lastCard.set(projectId, target[0]);
    runInAction(() => {
      app.ui.issueTarget = target;
    });
  }), [app, model, projectId]);
  // Opened from an issue (?card=): the cursor on its card. Back on the board (from a card's page): where it was,
  // its column focused (J/K go on from there). Waits for the cards to arrive (a board loaded on demand).
  const asked = useSearch({strict: false, select: (s: {card?: number}) => s.card});
  const placed = useRef(false);
  useEffect(() => autorun(() => {
    if (placed.current) return;
    const id = asked ?? lastCard.get(projectId);
    if (id === undefined || model.cursor.activeId !== undefined) return;
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
      // A column out of view comes into view (the board scrolls sideways as columns scroll down).
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
    if (!editable) {
      // Said, not ignored (QA verify3: a reader's Shift+L did nothing, silently).
      notify(app, {tone: 'neutral', title: 'You can view this board, not change it', description: 'Moving cards needs write access to its issues.', series: 'board.readonly'});
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
  // Board innermost: its H/L win over the issue scope's L (labels: the palette and the card menu offer them).
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
  // Moves apply to the card under the cursor, where it can go (the palette lists them only then).
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
  // Column commands (the palette): the cursor's column. Online only, as the column menu's.
  const [columnDialog, setColumnDialog] = useState<ColumnDialogState | undefined>();
  const [adding, setAdding] = useState(false);
  const cursorColumn = () => untracked(here)?.at?.column;
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
  /** After a column dialog: the focus back on the board (a column's cards), never on <body>. */
  const focusColumn = (id: number | undefined) => {
    requestAnimationFrame(() => {
      const target = id ?? untracked(() => model.columns.find((c) => c.default)?.id ?? model.columns[0]?.id);
      if (target !== undefined) handles.current.get(target)?.focus();
    });
  };
  // C on a board (Linear): the new issue goes on this board, in the cursor's column (else the default one).
  useShortcut('create', () => {
    const layout = untracked(() => model.layout.get());
    const at = here()?.at;
    const column = at?.column ?? layout.columns.find((c) => c.default)?.id ?? layout.columns[0]?.id;
    if (column === undefined || !editable) openCreate(app);
    else newIssueIn(app, projectId, column);
  });

  // Cards call back through a ref: their props stay the same objects across renders.
  const actions = useRef({open, dnd, editable});
  actions.current = {open, dnd, editable};
  const [cardHandlers] = useState(() => ({
    click: (id: number, e: MouseEvent<HTMLElement>) => {
      // A card is a link: ⌘/Ctrl-click and middle-click are the browser's (a new tab); a plain click opens it here.
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
      <PageHeader icon={KanbanSquare} context={<ProjectContext project={project}/>} title={project.get('title')}>
        {closed && <Badge tone="done">Closed</Badge>}
        {hidden > 0 && <Badge>{hidden} {hidden === 1 ? 'card' : 'cards'} not on this device</Badge>}
        <ClosedTierBadge repoId={project.get('repo_id')}/>
        {editable && <ClassicLink size="sm" to={`${classicOfHere(app, `/-/next/projects/${String(project.id)}`)}/edit`}>Edit board</ClassicLink>}
      </PageHeader>
      <ContextMenu onOpenChange={(o) => {
        if (!o) setMenuCard(undefined);
      }}>
        <ContextMenuTrigger asChild>
          <BoardLanes ref={boardRef} onKeyDown={onKeyDown}
            onContextMenuCapture={(e) => {
              // On a card, or (Shift+F10 / the menu key on a column) the cursor's card; elsewhere no menu.
              const el = (e.target as Element).closest('[data-card]');
              const fromKeys = (e.target as Element).getAttribute('role') === 'listbox' ? model.cursor.activeId : undefined;
              const id = el ? Number(el.getAttribute('data-card')) : fromKeys;
              if (id === undefined) {
                // The browser's own menu stays in text fields and on selected text.
                const t = e.target as HTMLElement;
                if (!t.closest('input,textarea,[contenteditable="true"]') && !document.getSelection()?.toString()) e.preventDefault();
                return;
              }
              setMenuCard(id);
              model.cursor.setActive(id);
            }}>
            {columns.map((c, i) => (
              <Column key={c.id} model={model} column={c} index={i} count={columns.length} dragging={dragging} handlers={cardHandlers} register={register} editable={editable}
                onDialog={(kind) => {
                  setColumnDialog({kind, columnId: c.id});
                }}/>
            ))}
            {columns.length === 0 && <EmptyState icon={Columns3} title="No columns yet" description="Add a column to start the board."/>}
            {editable && <AddColumn projectId={projectId} editing={adding} setEditing={setAdding}/>}
          </BoardLanes>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {menuCard !== undefined && <CardMenu model={model} issueId={menuCard} open={open} editable={editable}/>}
        </ContextMenuContent>
      </ContextMenu>
      <DropIndicator ref={indicatorRef}/>
      {columnDialog && <ColumnDialog model={model} state={columnDialog} onClose={(deleted) => {
        setColumnDialog(undefined);
        focusColumn(deleted ? undefined : columnDialog.columnId);
      }}/>}
    </>
  );
});

/** While older closed issues load (their cards count in positions), and when some stay out (the page cap). */
const ClosedTierBadge = observer(function ClosedTierBadge({repoId}: {repoId: number}) {
  const {data} = useSession();
  if (!repoId) return null;
  const pager = closedPager(data, `repo:${String(repoId)}`);
  if (pager.done) return null;
  if (pager.pages < CLOSED_PAGES) return pager.loading ? <Badge>Loading older closed cards…</Badge> : null;
  return <Badge tone="warning">Older closed cards may be missing</Badge>;
});

function boardRepo(s: ReturnType<typeof useSession>, repoId: number) {
  return repoId ? s.data.pool.model('Repository').get(repoId)?.data : undefined;
}

/** A card's menu: the issue's actions (as in lists and the palette) and moves to other columns (touch included). */
function CardMenu({model, issueId, open, editable}: {model: BoardModel; issueId: number; open: (id: number, newTab?: boolean) => void; editable: boolean}) {
  const app = useApp();
  const layout = untracked(() => model.layout.get());
  const at = findCard(layout, issueId);
  const issue = untracked(() => app.session?.data.pool.model('Issue').get(issueId));
  const ci = layout.columns.findIndex((c) => c.id === at?.column);
  const actions = issue ? issueActions(app, [issue]).filter((a) => a.id !== 'open') : [];
  const path = issue && issuePath(app, issue);
  // One rule for every move to another column, by key or by menu: the card keeps its rank among the column's cards.
  const moveTo = (columnId: number) => {
    model.move(issueId, columnId, model.rankIn(issueId, columnId));
  };
  const moveBy = (d: number) => {
    const col = layout.columns[ci + d];
    if (col) moveTo(col.id);
  };
  return (
    <>
      <ContextMenuItem icon={ExternalLink} shortcut={formatKeys('enter')} onSelect={() => {
        open(issueId);
      }}>Open</ContextMenuItem>
      {editable && <>
      <ContextMenuSeparator/>
      <ContextMenuItem icon={ArrowLeft} shortcut={shortcutHint('board.moveLeft')} disabled={ci <= 0} onSelect={() => {
        moveBy(-1);
      }}>Move to the previous column</ContextMenuItem>
      <ContextMenuItem icon={ArrowRight} shortcut={shortcutHint('board.moveRight')} disabled={ci < 0 || ci >= layout.columns.length - 1} onSelect={() => {
        moveBy(1);
      }}>Move to the next column</ContextMenuItem>
      <ContextMenuSub label="Move to" icon={Columns3}>
        {layout.columns.map((c) => (
          <ContextMenuItem key={c.id} disabled={c.id === at?.column} onSelect={() => {
            moveTo(c.id);
          }}>{c.title}</ContextMenuItem>
        ))}
      </ContextMenuSub>
      </>}
      {actions.length > 0 && <ContextMenuSeparator/>}
      {actions.map((a) => (
        <ContextMenuItem key={a.id} icon={a.icon} shortcut={a.shortcut && activeHint(a.shortcut)} onSelect={() => {
          a.run();
        }}>{a.label}</ContextMenuItem>
      ))}
      {path && editable && (
        <>
          <ContextMenuSeparator/>
          {/* No API removes a card (B9): the issue's classic page sets its projects. */}
          <ContextMenuItem icon={SquareMinus} href={classicHref(app, path)} classic>Remove from the board…</ContextMenuItem>
        </>
      )}
    </>
  );
}

interface CardHandlers {
  click(id: number, e: MouseEvent<HTMLElement>): void;
  down(id: number, e: PointerEvent): void;
}

const cardDomId = (id: number) => `card-${String(id)}`;

const Column = observer(function Column({model, column, index, count, dragging, handlers, register, editable, onDialog}: {
  model: BoardModel; column: ProjectColumn; index: number; count: number; dragging: KeyedFlags; handlers: CardHandlers;
  register: (id: number, h: ColumnHandle | undefined) => void; editable: boolean; onDialog: (kind: ColumnDialogState['kind']) => void;
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
  // The listbox names the cursor's card when it is in this column.
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
      leading={column.color ? <LabelDot color={column.color}/> : null}
      // The default column (where new cards and the cards of a deleted column go) says so.
      badge={column.default ? <Badge>Default</Badge> : undefined}
      actions={editable ? <ColumnMenu model={model} column={column} index={index} count={count} onDialog={onDialog}/> : undefined}>
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
  const app = useApp();
  const pool = usePool();
  const issue = pool.model('Issue').get(issueId);
  const path = issue && issuePath(app, issue);
  // On a board of several repositories (an organization's or a user's), each card says whose it is.
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

/** Renaming or deleting a column (from its menu or the palette); `onClose` puts the focus back on the board. */
function ColumnDialog({model, state, onClose}: {model: BoardModel; state: ColumnDialogState; onClose: (deleted: boolean) => void}) {
  const app = useApp();
  const projectId = model.projectId;
  const column = untracked(() => model.columns.find((c) => c.id === state.columnId));
  if (!column) return null;
  if (state.kind === 'rename') {
    return (
      <PromptDialog title="Rename the column" label="Column name" initial={column.title} onClose={() => {
        onClose(false);
      }} onSave={(title) => {
        void editColumn(app, projectId, column.id, {title});
      }}/>
    );
  }
  return (
    <Dialog open title={`Delete “${column.title}”?`} description="Its cards move to the default column." onOpenChange={(o) => {
      if (!o) onClose(false);
    }} footer={<>
      <Button variant="ghost" onClick={() => {
        onClose(false);
      }}>Cancel</Button>
      <Button variant="danger" onClick={() => {
        onClose(true);
        void deleteColumn(app, projectId, column.id);
      }}>Delete</Button>
    </>}/>
  );
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
      <Menu>
        <MenuTrigger asChild><IconButton size="sm" icon={MoreHorizontal} label={`Column “${column.title}”`}/></MenuTrigger>
        <MenuContent align="end">
          {offline && <MenuItem disabled>{onlineOnly('Changing columns')}</MenuItem>}
          <MenuItem icon={Pencil} disabled={offline} onSelect={() => {
            onDialog('rename');
          }}>Rename…</MenuItem>
          <MenuItem icon={Star} disabled={offline || column.default} onSelect={() => {
            const before = untracked(() => model.columns.find((c) => c.default));
            void editColumn(app, projectId, column.id, {default: true}).then((ok) => {
              if (!ok) return;
              // Said, with Undo: the default decides where new cards go.
              notify(app, {tone: 'neutral', title: `“${column.title}” is the default column`, description: 'New cards go there.',
                ...(before ? {action: {label: 'Undo', run: () => {
                  void editColumn(app, projectId, before.id, {default: true});
                }}} : {})});
            });
          }}>{column.default ? 'The default column' : 'Make it the default'}</MenuItem>
          <MenuItem icon={ArrowLeft} disabled={offline || index === 0} onSelect={() => {
            reorder(-1);
          }}>Move left</MenuItem>
          <MenuItem icon={ArrowRight} disabled={offline || index === count - 1} onSelect={() => {
            reorder(1);
          }}>Move right</MenuItem>
          <MenuSeparator/>
          <MenuItem icon={SquarePen} onSelect={() => {
            newIssueIn(app, model.projectId, column.id);
          }}>New issue in this column…</MenuItem>
          <MenuSeparator/>
          <MenuItem icon={Trash2} danger disabled={offline || column.default} onSelect={() => {
            onDialog('delete');
          }}>Delete…</MenuItem>
        </MenuContent>
      </Menu>
    </>
  );
});

/**
 * A new issue that goes on this board, in this column (the create dialog). Its repository: the board's; on an
 * organization's or a user's board, the one most of its cards come from (not the first by name).
 */
function newIssueIn(app: ReturnType<typeof useApp>, projectId: number, columnId: number): void {
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
  openCreate(app, repoId, {projectId, columnId});
}

/** The lane after the last column: "Add column", then the new column's lane with its name field (online only). */
const AddColumn = observer(function AddColumn({projectId, editing, setEditing}: {projectId: number; editing: boolean; setEditing: (on: boolean) => void}) {
  const app = useApp();
  const [title, setTitle] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // Added or canceled from the keyboard: the focus back on "Add column" (another one is one Enter away), not <body>.
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
  // The field takes the focus without the board jumping: it scrolls only as far as needed to show the lane.
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
        <Input ref={field} aria-label="New column name" placeholder="Column name" value={title} className="w-full" maxLength={100}
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
              close();
            }
          }}/>
        <p className="px-1 text-sm text-fg-subtle">Enter adds it, Esc cancels.</p>
      </BoardColumnDraft>
    );
  }
  return (
    <div className="flex w-column shrink-0 flex-col">
      <Button ref={button} variant="ghost" icon={Plus} tooltip={tip} disabled={offline} onClick={() => {
        setEditing(true);
      }}>Add column</Button>
    </div>
  );
});
