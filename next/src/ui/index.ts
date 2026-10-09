// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The shared primitives. Features compose these; they never restyle a button,
// menu, input or row locally (IMPLEMENTATION.md §2.4; tokens/no-restyle).

export {Avatar, AvatarGroup} from './Avatar.tsx';
export {Badge, ChipButton, LabelChip, LabelDot, LabelIcon, type BadgeTone} from './Badge.tsx';
export {Button, IconButton, type ButtonVariant} from './Button.tsx';
export {Callout, type CalloutTone} from './Callout.tsx';
export {Card, Panel} from './Card.tsx';
export {SegmentedControl, type Segment} from './SegmentedControl.tsx';
export {AnsiText, BlameCell, CodeFileHeader, CodeLine, CodeTokens, DiffStat, LineAction, LineNo, paintTokens, StepHeader, TabLink, TabNav, type LineTone, type TokenSpans} from './Code.tsx';
export {CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandPopover, CommandRoot, matchOptions, type PickOption} from './Command.tsx';
export {cx} from './cx.ts';
export {Dialog, DialogClose, DialogTrigger} from './Dialog.tsx';
export {EmptyState} from './EmptyState.tsx';
export {Entry, EntryList} from './Entry.tsx';
export {Hint, Icon, type LucideIcon} from './Icon.tsx';
export {Checkbox, EditableHeading, EditorFrame, Input, TextArea, TitleInput} from './Input.tsx';
export {Kbd, Shortcut} from './Kbd.tsx';
export {ListGroupHeader, ListRow} from './ListRow.tsx';
export {NavGroup, NavHeading, NavItem} from './NavItem.tsx';
export {
  ContextMenu, ContextMenuCheckboxItem, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuRadioGroup,
  ContextMenuRadioItem, ContextMenuSeparator, ContextMenuSub, ContextMenuTrigger,
  Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub,
  MenuTrigger, MoreMenu,
} from './Menu.tsx';
export {Notice, type NoticeTone} from './Notice.tsx';
export {PendingBadge, PendingIcon} from './Pending.tsx';
export {NoticeViewport} from './NoticeViewport.tsx';
export {Popover, PopoverClose, PopoverContent, PopoverTrigger} from './Popover.tsx';
export {Property, PropertyButton, PropertyEmpty, PropertyList, PropertyValue} from './Property.tsx';
export {Prose, ProseSource} from './Prose.tsx';
export {ResizeHandle} from './ResizeHandle.tsx';
export {Skeleton, SkeletonText} from './Skeleton.tsx';
export {SectionHeading} from './SectionHeading.tsx';
export {Status, StatusDot, type StatusTone} from './StatusDot.tsx';
export {Code, TextLink} from './Text.tsx';
export {Tooltip, TooltipProvider} from './Tooltip.tsx';
export {BoardCard, BoardColumn, BoardColumnDraft, BoardLanes, DropIndicator} from './Board.tsx';
export {PromptDialog} from './PromptDialog.tsx';
