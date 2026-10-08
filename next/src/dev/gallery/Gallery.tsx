// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Dev-only gallery of the shared primitives (/-/next/gallery under `npm run dev`).
// Switch the theme at the top to check both token sets.

import './gallery.css';
import {
  Archive, ArrowUpRight, CircleDashed, CircleDot, Copy, SignalHigh, Flag, Inbox, Moon, MoreHorizontal, Pencil, Plus, Search, Sun, SunMoon, Tag,
  Trash2,
} from 'lucide-react';
import {useState, type ReactNode} from 'react';
import {getThemePreference, setThemePreference} from '../../app/theme.ts';
import type {ThemePreference} from '../../app/splash.ts';
import {
  Avatar, AvatarGroup, Badge, Button, Callout, Entry, EntryList, Hint, LabelDot, LabelIcon, ListGroupHeader, Notice, Property, PropertyButton, PropertyEmpty, PropertyList,
  PropertyValue, ContextMenu, ContextMenuCheckboxItem, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuTrigger, Dialog, DialogClose, DialogTrigger, EmptyState, Icon, IconButton, Input, LabelChip, ListRow, Menu,
  MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub, MenuTrigger,
  AnsiText, BlameCell, CodeFileHeader, CodeLine, CodeTokens, DiffStat, LineNo, TabCount, TabLink, TabNav,
  NavGroup, NavHeading, NavItem, Popover, PopoverContent, PopoverTrigger, ProseSource, ResizeHandle, SectionHeading, Shortcut, Skeleton, Status, TextArea, TooltipProvider,
} from '../../ui/index.ts';

const swatches = [
  ['canvas', 'bg-canvas'], ['surface', 'bg-surface'], ['raised', 'bg-raised'], ['hover', 'bg-hover'],
  ['selected', 'bg-selected'], ['border', 'bg-border'], ['fg', 'bg-fg'], ['fg-muted', 'bg-fg-muted'],
  ['fg-subtle', 'bg-fg-subtle'], ['accent', 'bg-accent'], ['success', 'bg-success'], ['warning', 'bg-warning'],
  ['danger', 'bg-danger'], ['danger-solid', 'bg-danger-solid'], ['done', 'bg-done'], ['accent-subtle', 'bg-accent-subtle'],
] as const;

// "const answer = 42; // ok": keyword, plain, constant, plain, comment (workers/highlight.ts SYN).
const sampleHl = {spans: Uint32Array.of(5, 1, 10, 0, 2, 5, 2, 0, 5, 3), starts: Uint32Array.of(0, 5)};

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
          <Input size="sm" icon={Search} placeholder="Search…" className="w-48"/>
          <div className="w-96"><TextArea aria-label="Comment" placeholder="Leave a comment" rows={3}/></div>
          <div className="w-96"><TextArea aria-label="Conflict" invalid rows={3} defaultValue={'<<<<<<< yours\nmine\n=======\ntheirs\n>>>>>>> theirs'}/></div>
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
          <AvatarGroup><Avatar name="alice" size="sm"/><Avatar name="Bob" size="sm"/></AvatarGroup>
          <LabelDot color="var(--color-done)"/>
          <LabelIcon icon={CircleDashed} color="var(--color-warning)"/>
          <Hint label="Priority: High"><LabelIcon icon={SignalHigh} color="var(--color-danger)"/></Hint>
        </Section>

        <Section title="Issue list rows, properties, prose, notices">
          <div role="listbox" aria-label="Rows" className="w-full max-w-lg">
            <ListGroupHeader leading={<LabelIcon icon={CircleDashed} color="var(--color-warning)"/>} label="Backlog" count={2}/>
            <ListRow role="option" active leading={<Icon icon={CircleDot}/>} trailing={<LabelChip name="bug" color="var(--color-danger)"/>}>Active row</ListRow>
            <ListRow role="option" selected leading={<Icon icon={CircleDot}/>}>Selected row</ListRow>
          </div>
          <div className="w-80">
            <PropertyList>
              <Property label="Status"><PropertyButton label="Change status" shortcut="S" onClick={() => undefined}><Icon icon={CircleDot}/>Open</PropertyButton></Property>
              <Property label="Priority"><PropertyButton label="Set priority" onClick={() => undefined}><PropertyEmpty>No priority</PropertyEmpty></PropertyButton></Property>
              <Property label="Due date"><PropertyValue tone="danger">Oct 3 · overdue</PropertyValue></Property>
            </PropertyList>
          </div>
          <div className="relative h-40 w-96">
            <Notice tone="danger" title="Adding the label “bug” failed" description="Forbidden. The change was undone." action={<Button size="sm">Retry</Button>} onDismiss={() => undefined}/>
          </div>
          <Notice tone="success" title="Link copied" onDismiss={() => undefined}/>
          <Notice tone="warning" title="Your edit conflicts with a newer change" action={<Button size="sm">Review</Button>} onDismiss={() => undefined}/>
          <div className="flex w-96 flex-col gap-2">
            <Callout tone="warning" title="Your edit conflicts with a newer change" actions={<><Button size="sm">Keep mine</Button><Button size="sm">Use theirs</Button></>}>Both changed the same lines.</Callout>
            <Callout title="You overrode @alice’s change to the status" actions={<Button size="sm">Undo</Button>}>Your change was applied last.</Callout>
            <Callout tone="danger" title="Not sent">Forbidden.</Callout>
            <ProseSource text={'Typed **markdown**, not synced yet.\n\nSecond paragraph.'}/>
          </div>
          <div className="w-96">
            <EntryList>
              <Entry leading={<Icon icon={Inbox}/>} title="Adding the label “bug”" meta="#12 · dev/big" description="Sent when you are back online." actions={<IconButton size="sm" icon={Search} label="Discard"/>}/>
              <Entry title="Posting a comment" meta="#3 · dev/big" description="Forbidden."/>
            </EntryList>
          </div>
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
          <Status tone="muted" onClick={() => undefined} label="Offline, 3 pending">Offline <span className="tabular-nums">· 3 pending</span></Status>
          <SectionHeading>Section heading</SectionHeading>
        </Section>

        <Section id="code" title="Code: lines, diff, blame, logs, tabs">
          <div className="flex w-full flex-col overflow-x-auto rounded-md border border-border">
            <TabNav label="Example tabs">
              <TabLink><a href="#code" aria-current="page">Files <TabCount n={3}/></a></TabLink>
              <TabLink><a href="#code">Commits</a></TabLink>
            </TabNav>
            <CodeFileHeader path="src/app.ts" oldPath="src/old.ts" status="renamed" stat={<DiffStat additions={12} deletions={3}/>}>
              <Button size="sm" pressed>Viewed</Button>
            </CodeFileHeader>
            <CodeLine tone="hunk" gutter={<><LineNo n={0}/><LineNo n={0}/></>}>@@ -1,3 +1,4 @@ function main()</CodeLine>
            <CodeLine gutter={<><LineNo n={1}/><LineNo n={1}/></>}><CodeTokens text="const answer = 42; // ok" hl={sampleHl} line={0}/></CodeLine>
            <CodeLine tone="del" gutter={<><LineNo n={2}/><LineNo n={0}/></>}>{'return "old";'}</CodeLine>
            <CodeLine tone="add" active gutter={<><LineNo n={0}/><LineNo n={2}/></>}>{'return "new";'}</CodeLine>
            <CodeLine gutter={<><BlameCell first summary="Fix the parser" meta="3 d"/><LineNo n={3}/></>}>blamed line</CodeLine>
            <CodeLine gutter={<LineNo n={4}/>}><AnsiText spans={[{text: 'PASS ', color: 2, bold: true}, {text: 'error ', color: 1, bold: false}, {text: 'plain', color: 0, bold: false}]}/></CodeLine>
          </div>
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
