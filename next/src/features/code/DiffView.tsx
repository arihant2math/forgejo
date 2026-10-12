// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {observer} from 'mobx-react-lite';
import {lazy, type ReactNode, type Ref, Suspense, useState} from 'react';
import {type DiffFile, filePath} from '../../code/diff.ts';
import {DiffStat} from '../../code/parts.tsx';
import {useDiffSettings} from './DiffSettings.tsx';
import {CodeSkeleton} from './Src.tsx';
import {ChevronDownIcon, ChevronRightIcon, FileDiffIcon} from '@primer/octicons-react';
import {IconButton} from '@primer/react';
import {Blankslate} from '@primer/react/experimental';

export interface DiffExtras {
  threads: ReadonlySet<string>;
  notes: ReadonlySet<number>;
  collapsed: ReadonlySet<number>;
  thread: (f: number, l: number) => ReactNode;
  notesOf: (f: number) => ReactNode;
  /** Starts a comment on line l of file f (undefined: no comments here, e.g. offline without the head). */
  onComment?: ((f: number, l: number, range?: boolean) => void) | undefined;
  /** Whether line l of file f takes a comment (default: every line, when onComment is set). */
  commentable?: ((f: number, l: number) => boolean) | undefined;
  fileActions: (f: number) => ReactNode;
  onToggle: (f: number) => void;
}

export interface DiffHandle {
  toFile(f: number): void;
  toLine(f: number, l: number): void;
  /** The file of the keyboard cursor, else the one in view. */
  current(): number;
  focus(): void;
}

export interface DiffViewProps {
  repoId: number;
  base: string;
  head: string;
  files: readonly DiffFile[];
  scroller: HTMLDivElement | null;
  extras?: DiffExtras | undefined;
  onFile?: ((f: number) => void) | undefined;
  /** Keep file jumps and the floating header below the measured data-sticky-bar. */
  underBar?: boolean | undefined;
  ref?: Ref<DiffHandle>;
}

const ReviewSurface = lazy(async () => ({default: (await import('../../code/ReviewSurface.tsx')).ReviewSurface}));

export const DiffView = observer(function DiffView(props: DiffViewProps) {
  const {whitespace} = useDiffSettings();
  if (!props.files.length) return <Blankslate><Blankslate.Visual><FileDiffIcon size={24}/></Blankslate.Visual><Blankslate.Heading>No changes</Blankslate.Heading><Blankslate.Description>{whitespace ? 'No changes remain with whitespace hidden.' : 'These two commits have the same content.'}</Blankslate.Description></Blankslate>;
  return <Suspense fallback={<CodeSkeleton/>}><ReviewSurface key={`${props.base}:${props.head}:${whitespace}`} {...props}/></Suspense>;
});

const OPEN_FILES = 12;

/** Keep the file list pinned while wide diff lines scroll sideways. */
export function ChangedFiles({files, diff}: {files: readonly DiffFile[]; diff: {current: DiffHandle | null}}) {
  const [open, setOpen] = useState(files.length <= OPEN_FILES);
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <section aria-label="Changed files" className="sticky left-0 w-view border-b border-muted py-1">
      <div className="flex h-control items-center gap-2 px-4 text-base text-default">
        <IconButton icon={open ? ChevronDownIcon : ChevronRightIcon} variant="invisible" size="small" aria-label={open ? 'Hide the files' : 'Show the files'} type="button" aria-expanded={open} onClick={() => {
          setOpen((o) => !o);
        }}/>
        <span className="text-default">{files.length} {files.length === 1 ? 'file' : 'files'} changed</span>
        <DiffStat additions={additions} deletions={deletions}/>
      </div>
      {open && files.map((f, i) => (
        <a className="flex items-center gap-2 px-4 py-2 text-base text-default hover:bg-control-transparent-hover hover:text-accent hover:underline" key={`${filePath(f)}:${String(i)}`} href={`#${encodeURIComponent(filePath(f))}`}
          onClick={(e) => {
            e.preventDefault();
            diff.current?.toFile(i);
          }}>
          <FileDiffIcon size={16}/><span className="min-w-0 flex-1 truncate" title={filePath(f)}>{filePath(f)}</span><DiffStat additions={f.additions} deletions={f.deletions}/>
        </a>
      ))}
    </section>
  );
}
