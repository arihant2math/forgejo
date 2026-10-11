// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Dev-only gallery of the shared primitives (/-/next/gallery under `npm run dev`).
// Switch the theme at the top to check both token sets.

import './gallery.css';
import {useState, type ReactNode} from 'react';
import {getThemePreference, setThemePreference} from '../../app/theme.ts';
import type {ThemePreference} from '../../app/splash.ts';
import {CodeMenuPanel} from '../../features/repo/CodeMenu.tsx';
import {
  AsideLink, AsideLinks, AsideSection, ShareBar, Avatar, AvatarGroup, Callout, Entry, EntryList, Hint, LabelDot, LabelIcon, ListGroupHeader, Notice, Property, PropertyButton, PropertyEmpty, PropertyList,
  PropertyValue, ContextMenu, ContextMenuCheckboxItem, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuTrigger, CopyField, Dialog, DialogClose, DialogTrigger, LabelChip, ListRow, Menu,
  MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub, MenuTrigger,
  AnsiText, BlameCell, CodeFileHeader, CodeLine, CodeTokens, DiffStat, LineNo, StepHeader, StatusDot, TabLink, TabNav,
  ConfirmDialog, FormSection, SectionNav, SectionNavHeading, SectionNavLink, Select, SettingRow, Switch,
  NavGroup, NavHeading, NavItem, Popover, PopoverContent, PopoverTrigger, ProseSource, ResizeHandle, SectionHeading, Shortcut, Status, TooltipProvider,
  ColorPicker, LabelPill
} from '../../ui/index.ts';
import {LABEL_PRESETS} from '../../features/meta/labels.ts';
import {ArchiveIcon, ArrowUpRightIcon, ChevronDownIcon, IssueDraftIcon, CodeIcon, IssueOpenedIcon, CopyIcon, StarIcon, GraphBarVerticalIcon, FlagIcon, InboxIcon, MoonIcon, KebabHorizontalIcon, PencilIcon, PlusIcon, SearchIcon, SunIcon, DeviceDesktopIcon, TagIcon, TrashIcon} from '@primer/octicons-react';
import {Button, IconButton, LinkButton, ActionMenu, ActionList, Label, ProgressBar, FormControl, TextInput, Textarea} from '@primer/react';
import {OptionalTooltip} from '../../app/OptionalTooltip.tsx';
import {SkeletonBox, Blankslate} from '@primer/react/experimental';

/** A colour field with its form field's frame (a label's colour). */
function GalleryColor() {
  const [color, setColor] = useState(LABEL_PRESETS[2] ?? '');
  return (
    <div className="w-80">
      <FormControl id="gallery-color"><FormControl.Label>Colour</FormControl.Label>
        <ColorPicker id="gallery-color" label="Colour" value={color} presets={LABEL_PRESETS} onChange={setColor}/>
      {(/^#[\da-f]{6}$/i.test(color) ? undefined : 'A colour as #rrggbb.') && <FormControl.Validation variant="error">{/^#[\da-f]{6}$/i.test(color) ? undefined : 'A colour as #rrggbb.'}</FormControl.Validation>}</FormControl>
    </div>
  );
}

const swatches = [
  ['canvas', 'bg-canvas'], ['surface', 'bg-surface'], ['raised', 'bg-raised'], ['hover', 'bg-hover'],
  ['selected', 'bg-selected'], ['border', 'bg-border'], ['fg', 'bg-fg'], ['fg-muted', 'bg-fg-muted'],
  ['fg-subtle', 'bg-fg-subtle'], ['accent', 'bg-accent'], ['success', 'bg-success'], ['warning', 'bg-warning'],
  ['danger', 'bg-danger'], ['danger-solid', 'bg-danger-solid'], ['done', 'bg-done'], ['accent-subtle', 'bg-accent-subtle'],
] as const;

// "const answer = 42; // ok": keyword, plain, constant, plain, comment (workers/highlight.ts SYN).
const sampleHl = {spans: Uint32Array.of(5, 1, 10, 0, 2, 5, 2, 0, 5, 3), starts: Uint32Array.of(0, 5)};

const themes = [['light', SunIcon], ['dark', MoonIcon], ['system', DeviceDesktopIcon]] as const;

const OVERFLOW_TABS = ['Code', 'Issues', 'Pull requests', 'Actions', 'Projects', 'Wiki', 'Activity', 'Settings'];

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
  const [feature, setFeature] = useState(true);
  const [role, setRole] = useState<'read' | 'write' | 'admin'>('write');
  const [confirm, setConfirm] = useState(false);
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
            <Button variant={theme === t ? 'default' : 'invisible'} size="small" leadingVisual={icon} type="button" key={t} aria-pressed={theme === t} onClick={() => {
              pick(t);
            }}>
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
          <OptionalTooltip text={'Create issue'} keybindingHint={'C'}><Button variant="primary" leadingVisual={PlusIcon} type="button">New issue</Button></OptionalTooltip>
          <Button type="button">Secondary</Button>
          <Button variant="invisible" type="button">Ghost</Button>
          <Button variant="primary" leadingVisual={CodeIcon} type="button">Code</Button>
          <Button variant="danger" leadingVisual={TrashIcon} type="button">Delete</Button>
          <Button type="button" disabled>Disabled</Button>
          <Button variant="primary" size="small" type="button">Small</Button>
          <Button size="small" type="button">Small</Button>
          <LinkButton variant="invisible" href="#tokens">Link <ArrowUpRightIcon size={12} className="shrink-0"/></LinkButton>
          <IconButton icon={SearchIcon} variant="invisible" aria-label="Search" keybindingHint={'/'} type="button"/>
          <IconButton icon={PlusIcon} aria-label="Create issue" keybindingHint={'C'} type="button"/>
          <IconButton icon={PencilIcon} variant="invisible" size="small" aria-label="Edit" keybindingHint={'E'} type="button"/>
        </Section>

        <Section title="Inputs">
          <div className="w-64"><TextInput placeholder="Filter issues…"/></div>
          <div className="w-64"><TextInput placeholder="Invalid" defaultValue="not-a-number" validationStatus="error"/></div>
          <div className="w-48"><TextInput placeholder="Small" size="small"/></div>
          <TextInput placeholder="Search…" className="w-48" size="small" leadingVisual={SearchIcon}/>
          <div className="w-96"><Textarea aria-label="Comment" placeholder="Leave a comment" rows={3} block/></div>
          <div className="w-96"><Textarea aria-label="Conflict" rows={3} defaultValue={'<<<<<<< yours\nmine\n=======\ntheirs\n>>>>>>> theirs'} block validationStatus="error"/></div>
        </Section>

        <Section title="Keys, badges, labels, avatars">
          <Shortcut keys="⌘K"/>
          <Shortcut keys="G I"/>
          <Label>12</Label>
          <Label variant="accent">Review</Label>
          <Label variant="danger">Conflict</Label>
          <Label variant="success">Open</Label>
          <Label variant="attention">Draft</Label>
          <Label variant="done">Merged</Label>
          <LabelChip name="bug" color="var(--color-danger)"/>
          <LabelChip name="enhancement" color="var(--color-accent)"/>
          <Avatar name="alice" size="sm"/>
          <Avatar name="Bob"/>
          <Avatar name="Ünal" size="lg"/>
          <AvatarGroup><Avatar name="alice" size="sm"/><Avatar name="Bob" size="sm"/></AvatarGroup>
          <LabelDot color="var(--color-done)"/>
          <LabelIcon icon={IssueDraftIcon} color="var(--color-warning)"/>
          <Hint label="Priority: High"><LabelIcon icon={GraphBarVerticalIcon} color="var(--color-danger)"/></Hint>
        </Section>

        <Section title="Label pills, progress, colour">
          {LABEL_PRESETS.map((c, i) => <LabelPill key={c} name={i % 3 === 0 ? `kind/label ${String(i)}` : `label ${String(i)}`} scope={i % 3 === 0 ? 'kind' : undefined} color={c}/>)}
          <LabelPill name="not a colour" color="var(--color-accent)"/>
          <div className="w-64"><ProgressBar barSize="small" progress={37.5} aria-label="3 of 8 closed"/></div>
          <div className="w-64"><ProgressBar barSize="small" progress={0} aria-label="Nothing yet"/></div>
          <GalleryColor/>
        </Section>

        <Section title="Issue list rows, properties, prose, notices">
          <div role="listbox" aria-label="Rows" className="w-full max-w-lg">
            <ListGroupHeader leading={<LabelIcon icon={IssueDraftIcon} color="var(--color-warning)"/>} label="Backlog" count={2}/>
            <ListRow role="option" active leading={<IssueOpenedIcon size={16} className="shrink-0"/>} trailing={<LabelChip name="bug" color="var(--color-danger)"/>}>Active row</ListRow>
            <ListRow role="option" selected leading={<IssueOpenedIcon size={16} className="shrink-0"/>}>Selected row</ListRow>
          </div>
          <div className="w-80">
            <PropertyList>
              <Property label="Status"><PropertyButton label="Change status" shortcut="S" onClick={() => undefined}><IssueOpenedIcon size={16} className="shrink-0"/>Open</PropertyButton></Property>
              <Property label="Priority"><PropertyButton label="Set priority" onClick={() => undefined}><PropertyEmpty>No priority</PropertyEmpty></PropertyButton></Property>
              <Property label="Due date"><PropertyValue tone="danger">Oct 3 · overdue</PropertyValue></Property>
            </PropertyList>
          </div>
          <div className="relative h-40 w-96">
            <Notice tone="danger" title="Adding the label “bug” failed" description="Forbidden. The change was undone." action={<Button size="small" type="button">Retry</Button>} onDismiss={() => undefined}/>
          </div>
          <Notice tone="success" title="Link copied" onDismiss={() => undefined}/>
          <Notice tone="warning" title="Your edit conflicts with a newer change" action={<Button size="small" type="button">Review</Button>} onDismiss={() => undefined}/>
          <div className="flex w-96 flex-col gap-2">
            <Callout tone="warning" title="Your edit conflicts with a newer change" actions={<><Button size="small" type="button">Keep mine</Button><Button size="small" type="button">Use theirs</Button></>}>Both changed the same lines.</Callout>
            <Callout title="You overrode @alice’s change to the status" actions={<Button size="small" type="button">Undo</Button>}>Your change was applied last.</Callout>
            <Callout tone="danger" title="Not sent">Forbidden.</Callout>
            <ProseSource text={'Typed **markdown**, not synced yet.\n\nSecond paragraph.'}/>
          </div>
          <div className="w-96">
            <EntryList>
              <Entry leading={<InboxIcon size={16} className="shrink-0"/>} title="Adding the label “bug”" meta="#12 · dev/big" description="Sent when you are back online." actions={<IconButton icon={SearchIcon} variant="invisible" size="small" aria-label="Discard" type="button"/>}/>
              <Entry title="Posting a comment" meta="#3 · dev/big" description="Forbidden."/>
            </EntryList>
          </div>
        </Section>

        <Section title="Side pane: sections, links with counts, share bar">
          <div className="flex w-pane flex-col">
            <AsideSection title="About">
              <AsideLinks label="Links">
                <AsideLink icon={StarIcon} count={12}><a href="#tokens">stars</a></AsideLink>
                <AsideLink icon={ArrowUpRightIcon} tone="accent"><a href="#tokens">example.com</a></AsideLink>
              </AsideLinks>
            </AsideSection>
            <AsideSection title="Releases" count={3}>
              <AsideLinks><AsideLink icon={TagIcon} count={4}><a href="#tokens">tags</a></AsideLink></AsideLinks>
            </AsideSection>
            <AsideSection title="Languages">
              <ShareBar label="Languages" shares={[
                {label: 'Go', value: 50, tone: 1}, {label: 'TypeScript', value: 25, tone: 2}, {label: 'CSS', value: 10, tone: 3},
                {label: 'Shell', value: 6, tone: 4}, {label: 'Makefile', value: 4, tone: 5}, {label: 'Other', value: 5, tone: 'other'},
              ]}/>
            </AsideSection>
          </div>
        </Section>

        <Section title="Menus, popover, dialog">
          <Menu>
            <MenuTrigger asChild><Button leadingVisual={KebabHorizontalIcon} type="button">Menu</Button></MenuTrigger>
            <MenuContent>
              <MenuLabel>Issue</MenuLabel>
              <MenuItem icon={IssueOpenedIcon} shortcut="S">Change status</MenuItem>
              <MenuItem icon={TagIcon} shortcut="L">Labels</MenuItem>
              <MenuItem icon={CopyIcon} shortcut="⌘ ." disabled>Copy link</MenuItem>
              <MenuCheckboxItem checked={showClosed} onCheckedChange={(v) => {
                setShowClosed(v);
              }}
              >
                Show closed
              </MenuCheckboxItem>
              <MenuSub label="Priority" icon={FlagIcon}>
                <MenuRadioGroup value={priority} onValueChange={setPriority}>
                  <MenuRadioItem value="high">High</MenuRadioItem>
                  <MenuRadioItem value="low">Low</MenuRadioItem>
                </MenuRadioGroup>
              </MenuSub>
              <MenuSeparator/>
              <MenuItem icon={TrashIcon} danger>Delete</MenuItem>
            </MenuContent>
          </Menu>
          <ActionMenu>
            <ActionMenu.Anchor><IconButton icon={KebabHorizontalIcon} variant="invisible" aria-label="More actions" type="button"/></ActionMenu.Anchor>
            <ActionMenu.Overlay><ActionList>
              <ActionList.Item><ActionList.LeadingVisual><CopyIcon/></ActionList.LeadingVisual>Copy link</ActionList.Item>
            </ActionList></ActionMenu.Overlay>
          </ActionMenu>
          <Popover>
            <PopoverTrigger asChild><Button type="button">Popover</Button></PopoverTrigger>
            <PopoverContent>
              <TextInput placeholder="Set due date…" autoFocus size="small"/>
            </PopoverContent>
          </Popover>
          <Dialog
            title="Archive repository?"
            description="Archived repositories are read-only. You can unarchive it later."
            trigger={<DialogTrigger asChild><Button leadingVisual={ArchiveIcon} type="button">Dialog</Button></DialogTrigger>}
            footer={(
              <>
                <DialogClose asChild><Button variant="invisible" type="button">Cancel</Button></DialogClose>
                <DialogClose asChild><Button variant="primary" type="button">Archive</Button></DialogClose>
              </>
            )}
          >
            <ActionMenu>
              <ActionMenu.Anchor><Button size="small" leadingVisual={TagIcon} type="button">Labels</Button></ActionMenu.Anchor>
              <ActionMenu.Overlay><ActionList>
                <ActionList.Item>bug</ActionList.Item>
                <ActionList.Item>enhancement</ActionList.Item>
              </ActionList></ActionMenu.Overlay>
            </ActionMenu>
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
                        <IssueOpenedIcon size={16} className="shrink-0 text-success"/>
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
                  <ContextMenuItem icon={IssueOpenedIcon} shortcut="S">Change status</ContextMenuItem>
                  <ContextMenuItem icon={TagIcon} shortcut="L">Labels</ContextMenuItem>
                  <ContextMenuCheckboxItem checked={showClosed} onCheckedChange={setShowClosed}>Show closed</ContextMenuCheckboxItem>
                  <ContextMenuSeparator/>
                  <ContextMenuItem icon={TrashIcon} danger>Delete</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </div>
        </section>

        <Section title="Sidebar navigation, status">
          <div className="relative flex w-sidebar flex-col gap-px rounded-md border border-border bg-canvas p-2">
            <NavItem icon={InboxIcon} label="Inbox" count={3} shortcut="G N"/>
            <NavItem icon={IssueOpenedIcon} label="My issues" aria-current="page"/>
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
              <TabLink><a href="#code" aria-current="page">Files</a></TabLink>
              <TabLink><a href="#code">Commits</a></TabLink>
            </TabNav>
            {/* A repository's tabs in a narrow bar: what does not fit is in More (TabNav's `more`); the current one (Wiki) stays. */}
            <div className="max-w-sm">
              <TabNav label="Example tabs that overflow" more={(hidden) => (
                <ActionMenu>
                  <ActionMenu.Anchor><Button variant="invisible" size="small" leadingVisual={KebabHorizontalIcon} type="button">More</Button></ActionMenu.Anchor>
                  <ActionMenu.Overlay><ActionList>
                    {OVERFLOW_TABS.filter((_, i) => hidden.includes(i)).map((t) => <ActionList.Item key={t}>{t}</ActionList.Item>)}
                    <ActionList.Item>This page in the classic UI</ActionList.Item>
                  </ActionList></ActionMenu.Overlay>
                </ActionMenu>
              )}>
                {OVERFLOW_TABS.map((t, i) => <TabLink key={t}><a href="#code" aria-current={i === 5 ? 'page' : undefined}>{t}</a></TabLink>)}
              </TabNav>
            </div>
            <CodeFileHeader path="src/app.ts" oldPath="src/old.ts" status="renamed" stat={<DiffStat additions={12} deletions={3}/>}>
              <Button aria-pressed={true} variant="default" size="small" type="button">Viewed</Button>
            </CodeFileHeader>
            <CodeLine tone="hunk" gutter={<><LineNo n={0}/><LineNo n={0}/></>}>@@ -1,3 +1,4 @@ function main()</CodeLine>
            <CodeLine gutter={<><LineNo n={1}/><LineNo n={1}/></>}><CodeTokens text="const answer = 42; // ok" hl={sampleHl} line={0}/></CodeLine>
            <CodeLine tone="del" gutter={<><LineNo n={2}/><LineNo n={0}/></>}>{'return "old";'}</CodeLine>
            <CodeLine tone="add" active gutter={<><LineNo n={0}/><LineNo n={2}/></>}>{'return "new";'}</CodeLine>
            <CodeLine gutter={<><BlameCell first summary="Fix the parser" meta="3 d"/><LineNo n={3}/></>}>blamed line</CodeLine>
            <StepHeader expanded onToggle={() => undefined} mark={<StatusDot tone="success"/>} meta="1 m 5 s">Run tests</StepHeader>
            <CodeLine gutter={<LineNo n={4}/>}><AnsiText spans={[{text: 'PASS ', color: 2, bold: true}, {text: 'error ', color: 1, bold: false}, {text: 'plain', color: 0, bold: false}]}/></CodeLine>
          </div>
        </Section>

        <Section title="Settings: sections, fields, switches, select, confirmation">
          <div className="flex w-full gap-6">
            <SectionNav label="Gallery settings">
              <SectionNavLink label="General" icon={PencilIcon}><a href="#settings" aria-current="page"/></SectionNavLink>
              <SectionNavLink label="Webhooks" icon={TagIcon}><a href="#settings"/></SectionNavLink>
              <SectionNavHeading>In the classic UI</SectionNavHeading>
              <SectionNavLink label="Units" icon={ArchiveIcon} hint="classic"><a href="#settings"/></SectionNavLink>
            </SectionNav>
            <div id="settings" className="flex max-w-lg min-w-0 flex-1 flex-col gap-6">
              <FormSection id="gallery-general" title="General" description="A titled part of a settings page.">
                <FormControl id="gallery-name"><FormControl.Label>Repository name</FormControl.Label>
                  <TextInput id="gallery-name" className="w-full" defaultValue="atlas"/>
                <FormControl.Caption>Letters, digits, “-”, “_” and “.”.</FormControl.Caption></FormControl>
                <FormControl id="gallery-site"><FormControl.Label>Website</FormControl.Label>
                  <TextInput id="gallery-site" className="w-full" defaultValue="atlas.example" validationStatus="error"/>
                <FormControl.Validation variant="error">An address starting with http:// or https://.</FormControl.Validation></FormControl>
                <FormControl id="gallery-filter"><FormControl.Label>Branch filter</FormControl.Label>
                  <TextInput id="gallery-filter" className="w-full" defaultValue="release/*" monospace/>
                </FormControl>
                <SettingRow id="gallery-wiki" title="Wiki" description="Pages of documentation next to the code." control={<Switch id="gallery-wiki" checked={feature} onCheckedChange={setFeature}/>}/>
                <SettingRow id="gallery-off" title="Packages" description="Disabled." control={<Switch id="gallery-off" checked={false} disabled onCheckedChange={() => undefined}/>}/>
                <SettingRow id="gallery-role" title="Role" control={
                  <Select id="gallery-role" size="sm" value={role} onValueChange={setRole} options={[{value: 'read', label: 'Read'}, {value: 'write', label: 'Write'}, {value: 'admin', label: 'Admin'}]}/>
                }/>
              </FormSection>
              <FormSection id="gallery-danger" title="Danger zone" tone="danger">
                <SettingRow id="gallery-delete" title="Delete this repository" description="This cannot be undone." control={<Button variant="danger" type="button" onClick={() => {
                  setConfirm(true);
                }}>Delete</Button>}/>
              </FormSection>
              <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Delete acme/atlas?" description="Its code, issues and pull requests are deleted for good."
                confirmLabel="Delete this repository" confirmText="acme/atlas" error="Forgejo could not be reached." onConfirm={() => {
                  setConfirm(false);
                }}/>
            </div>
          </div>
        </Section>

        <Section title="Code menu (the overview's file bar), copy field">
          <Popover>
            <PopoverTrigger asChild><Button variant="primary" size="small" leadingVisual={CodeIcon} type="button">Code<ChevronDownIcon size={12} className="shrink-0"/></Button></PopoverTrigger>
            <PopoverContent width="md" align="start">
              <CodeMenuPanel https="https://code.example/acme/website.git" ssh="git@code.example:acme/website.git" onCopy={() => undefined}
                archives={[{format: 'zip', href: '#code'}, {format: 'tar.gz', href: '#code'}]}/>
            </PopoverContent>
          </Popover>
          <div className="w-80 rounded-lg border border-border p-2">
            <CodeMenuPanel https="https://code.example/acme/website.git" onCopy={() => undefined} archives={[]}/>
          </div>
          <div className="w-64">
            <CopyField value="https://code.example/acme/a-rather-long-repository-name.git" label="Clone URL" copyLabel="Copy the clone URL" onCopy={() => undefined}/>
          </div>
        </Section>

        <Section title="Skeleton and empty state">
          <div className="flex w-64 flex-col gap-2">
            <SkeletonBox className="h-3 w-full"/>
            <SkeletonBox className="h-3 w-2/3"/>
          </div>
          <div className="flex-1">
            <Blankslate><Blankslate.Visual><InboxIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Inbox zero</Blankslate.Heading><Blankslate.Description>Notifications you receive show up here.</Blankslate.Description>{<Button size="small" type="button">Refresh</Button>}</Blankslate>
          </div>
        </Section>
      </div>
    </TooltipProvider>
  );
}
