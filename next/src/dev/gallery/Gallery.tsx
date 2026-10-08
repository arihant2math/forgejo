// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Dev-only gallery of the shared primitives (/-/next/gallery under `npm run dev`).
// Switch the theme at the top to check both token sets.

import './gallery.css';
import {
  Archive, ArrowUpRight, CircleDot, Copy, Flag, Inbox, Moon, MoreHorizontal, Pencil, Plus, Search, Sun, SunMoon, Tag,
  Trash2,
} from 'lucide-react';
import {useState, type ReactNode} from 'react';
import {getThemePreference, setThemePreference} from '../../app/theme.ts';
import type {ThemePreference} from '../../app/splash.ts';
import {
  Avatar, Badge, Button, ContextMenu, ContextMenuCheckboxItem, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuTrigger, Dialog, DialogClose, DialogTrigger, EmptyState, Icon, IconButton, Input, LabelChip, ListRow, Menu,
  MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub, MenuTrigger,
  NavGroup, NavHeading, NavItem, Popover, PopoverContent, PopoverTrigger, ResizeHandle, SectionHeading, Shortcut, Skeleton, Status, TooltipProvider,
} from '../../ui/index.ts';

const swatches = [
  ['canvas', 'bg-canvas'], ['surface', 'bg-surface'], ['raised', 'bg-raised'], ['hover', 'bg-hover'],
  ['selected', 'bg-selected'], ['border', 'bg-border'], ['fg', 'bg-fg'], ['fg-muted', 'bg-fg-muted'],
  ['fg-subtle', 'bg-fg-subtle'], ['accent', 'bg-accent'], ['success', 'bg-success'], ['warning', 'bg-warning'],
  ['danger', 'bg-danger'], ['danger-solid', 'bg-danger-solid'], ['done', 'bg-done'], ['accent-subtle', 'bg-accent-subtle'],
] as const;

const themes = [['light', Sun], ['dark', Moon], ['system', SunMoon]] as const;

const rows = [
  {id: 'FJ-128', title: 'Sync log trims too early on MySQL with binlog off', labels: [['bug', 'var(--color-danger)']]},
  {id: 'FJ-131', title: 'Keyboard shortcut hints in menus', labels: [['ui', 'var(--color-accent)'], ['good first issue', 'var(--color-success)']]},
  {id: 'FJ-140', title: 'Offline queue: show pending badge on rows', labels: []},
] as const;

function Section({id, title, children}: {id?: string; title: string; children: ReactNode}) {
  return (
    <section id={id} className="flex flex-col gap-3 border-b border-border px-6 py-5">
      <h2 className="text-sm font-medium text-fg-subtle">{title}</h2>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </section>
  );
}

export default function Gallery() {
  const [theme, setTheme] = useState<ThemePreference>(getThemePreference);
  const [selected, setSelected] = useState(0);
  const [showClosed, setShowClosed] = useState(true);
  const [priority, setPriority] = useState('high');
  const [navOpen, setNavOpen] = useState(true);
  const pick = (t: ThemePreference) => {
    setThemePreference(t);
    setTheme(t);
  };

  return (
    <TooltipProvider>
      <div className="h-full overflow-y-auto bg-surface">
        <header className="sticky top-0 z-sticky flex h-header items-center gap-2 border-b border-border bg-surface px-6">
          <h1 className="flex-1 text-md font-semibold">Primitives</h1>
          {themes.map(([t, icon]) => (
            <Button key={t} size="sm" icon={icon} variant={theme === t ? 'secondary' : 'ghost'} aria-pressed={theme === t} onClick={() => {
              pick(t);
            }}
            >
              {t}
            </Button>
          ))}
        </header>

        <Section id="tokens" title="Tokens">
          {swatches.map(([name, cls]) => (
            <div key={name} className="flex w-20 flex-col gap-1">
              <span className={`h-8 rounded-md border border-border ${cls}`}/>
              <span className="text-xs text-fg-muted">{name}</span>
            </div>
          ))}
        </Section>

        <Section title="Buttons">
          <Button variant="primary" icon={Plus} tooltip="Create issue" shortcut="C">New issue</Button>
          <Button>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger" icon={Trash2}>Delete</Button>
          <Button disabled>Disabled</Button>
          <Button size="sm" variant="primary">Small</Button>
          <Button size="sm">Small</Button>
          <Button asChild variant="ghost"><a href="#tokens">Link <Icon icon={ArrowUpRight} size="sm"/></a></Button>
          <IconButton icon={Search} label="Search" shortcut="/"/>
          <IconButton icon={Plus} label="Create issue" shortcut="C" variant="secondary"/>
          <IconButton icon={Pencil} label="Edit" shortcut="E" size="sm"/>
        </Section>

        <Section title="Inputs">
          <div className="w-64"><Input placeholder="Filter issues…"/></div>
          <div className="w-64"><Input placeholder="Invalid" invalid defaultValue="not-a-number"/></div>
          <div className="w-48"><Input size="sm" placeholder="Small"/></div>
        </Section>

        <Section title="Keys, badges, labels, avatars">
          <Shortcut keys="⌘K"/>
          <Shortcut keys="G I"/>
          <Badge>12</Badge>
          <Badge tone="accent">Review</Badge>
          <Badge tone="danger">Conflict</Badge>
          <Badge tone="success">Open</Badge>
          <Badge tone="warning">Draft</Badge>
          <Badge tone="done">Merged</Badge>
          <LabelChip name="bug" color="var(--color-danger)"/>
          <LabelChip name="enhancement" color="var(--color-accent)"/>
          <Avatar name="alice" size="sm"/>
          <Avatar name="Bob"/>
          <Avatar name="Ünal" size="lg"/>
        </Section>

        <Section title="Menus, popover, dialog">
          <Menu>
            <MenuTrigger asChild><Button icon={MoreHorizontal}>Menu</Button></MenuTrigger>
            <MenuContent>
              <MenuLabel>Issue</MenuLabel>
              <MenuItem icon={CircleDot} shortcut="S">Change status</MenuItem>
              <MenuItem icon={Tag} shortcut="L">Labels</MenuItem>
              <MenuItem icon={Copy} shortcut="⌘ ." disabled>Copy link</MenuItem>
              <MenuCheckboxItem checked={showClosed} onCheckedChange={(v) => {
                setShowClosed(v);
              }}
              >
                Show closed
              </MenuCheckboxItem>
              <MenuSub label="Priority" icon={Flag}>
                <MenuRadioGroup value={priority} onValueChange={setPriority}>
                  <MenuRadioItem value="high">High</MenuRadioItem>
                  <MenuRadioItem value="low">Low</MenuRadioItem>
                </MenuRadioGroup>
              </MenuSub>
              <MenuSeparator/>
              <MenuItem icon={Trash2} danger>Delete</MenuItem>
            </MenuContent>
          </Menu>
          <Menu>
            <MenuTrigger asChild><IconButton icon={MoreHorizontal} label="More actions"/></MenuTrigger>
            <MenuContent>
              <MenuItem icon={Copy}>Copy link</MenuItem>
            </MenuContent>
          </Menu>
          <Popover>
            <PopoverTrigger asChild><Button>Popover</Button></PopoverTrigger>
            <PopoverContent>
              <Input size="sm" placeholder="Set due date…" autoFocus/>
            </PopoverContent>
          </Popover>
          <Dialog
            title="Archive repository?"
            description="Archived repositories are read-only. You can unarchive it later."
            trigger={<DialogTrigger asChild><Button icon={Archive}>Dialog</Button></DialogTrigger>}
            footer={(
              <>
                <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
                <DialogClose asChild><Button variant="primary">Archive</Button></DialogClose>
              </>
            )}
          >
            <Menu>
              <MenuTrigger asChild><Button size="sm" icon={Tag}>Labels</Button></MenuTrigger>
              <MenuContent>
                <MenuItem>bug</MenuItem>
                <MenuItem>enhancement</MenuItem>
              </MenuContent>
            </Menu>
          </Dialog>
        </Section>

        <section className="border-b border-border">
          <h2 className="px-6 pt-5 pb-3 text-sm font-medium text-fg-subtle">List rows (right click for the context menu)</h2>
          <div role="listbox" aria-label="Issues">
            {rows.map((row, i) => (
              <ContextMenu key={row.id}>
                <ContextMenuTrigger asChild>
                  <ListRow
                    role="option"
                    selected={selected === i}
                    onClick={() => {
                      setSelected(i);
                    }}
                    leading={(
                      <>
                        <span className="w-12 text-sm tabular-nums">{row.id}</span>
                        <Icon icon={CircleDot} className="text-success"/>
                      </>
                    )}
                    trailing={(
                      <>
                        {row.labels.map(([name, color]) => <LabelChip key={name} name={name} color={color}/>)}
                        <Avatar name="alice" size="sm"/>
                      </>
                    )}
                  >
                    {row.title}
                  </ListRow>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem icon={CircleDot} shortcut="S">Change status</ContextMenuItem>
                  <ContextMenuItem icon={Tag} shortcut="L">Labels</ContextMenuItem>
                  <ContextMenuCheckboxItem checked={showClosed} onCheckedChange={setShowClosed}>Show closed</ContextMenuCheckboxItem>
                  <ContextMenuSeparator/>
                  <ContextMenuItem icon={Trash2} danger>Delete</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </div>
        </section>

        <Section title="Sidebar navigation, status">
          <div className="relative flex w-sidebar flex-col gap-px rounded-md border border-border bg-canvas p-2">
            <NavItem icon={Inbox} label="Inbox" count={3} shortcut="G N"/>
            <NavItem icon={CircleDot} label="My issues" aria-current="page"/>
            <NavHeading>Workspace</NavHeading>
            <NavGroup label="acme" leading={<Avatar size="sm" name="acme"/>} open={navOpen} onOpenChange={setNavOpen}>
              <NavItem inset label="website"/>
              <NavItem inset label="api"/>
            </NavGroup>
            <ResizeHandle label="Resize" value={232} min={180} max={480} onResize={() => undefined} onCommit={() => undefined}/>
          </div>
          <Status tone="success">Live</Status>
          <Status tone="muted">Catching up</Status>
          <Status tone="warning">Signed out</Status>
          <Status tone="danger">Error</Status>
          <SectionHeading>Section heading</SectionHeading>
        </Section>

        <Section title="Skeleton and empty state">
          <div className="flex w-64 flex-col gap-2">
            <Skeleton className="h-3 w-full"/>
            <Skeleton className="h-3 w-2/3"/>
          </div>
          <div className="flex-1">
            <EmptyState icon={Inbox} title="Inbox zero" description="Notifications you receive show up here." action={<Button size="sm">Refresh</Button>}/>
          </div>
        </Section>
      </div>
    </TooltipProvider>
  );
}
