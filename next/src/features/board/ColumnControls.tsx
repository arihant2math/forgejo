// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {ArrowLeftIcon, ArrowRightIcon, KebabHorizontalIcon, PencilIcon, PlusIcon, StarIcon, TrashIcon} from '@primer/octicons-react';
import {ActionList, ActionMenu, Button, ConfirmationDialog, Dialog, FormControl, IconButton, TextInput, Tooltip} from '@primer/react';
import {untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {useEffect, useMemo, useRef, useState} from 'react';
import {notify} from '../../app/notices.ts';
import {connectivity, onlineOnly} from '../../app/online.ts';
import {useApp} from '../../app/store.ts';
import type {ProjectColumn} from '../../protocol/types.gen.ts';
import {BoardColumnDraft} from './BoardParts.tsx';
import {createColumn, deleteColumn, editColumn, orderColumns} from './columns.ts';
import {newIssueIn} from './create.ts';
import type {BoardModel} from './model.ts';

export interface ColumnDialogState {
  kind: 'rename' | 'delete';
  columnId: number;
}

export function ColumnDialog({model, state, onClose}: {model: BoardModel; state: ColumnDialogState; onClose: (deleted: boolean) => void}) {
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

export const ColumnMenu = observer(function ColumnMenu({model, column, index, count, onDialog}: {
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

export const AddColumn = observer(function AddColumn({projectId, editing, setEditing}: {projectId: number; editing: boolean; setEditing: (on: boolean) => void}) {
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
      <Tooltip text={tip}><Button size="small" variant="invisible" leadingVisual={PlusIcon} type="button" ref={button} inactive={offline} onClick={() => {
        setEditing(true);
      }}>Add column</Button></Tooltip>
    </div>
  );
});
