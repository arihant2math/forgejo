// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A repository's wiki (its own chunk): a page (Home at /wiki) rendered as
// Forgejo renders it, with the wiki's pages, its _Sidebar and its _Footer
// around it, who changed it last and a link to its revisions (classic); the
// page list; a page's editor and a new page (the markdown editor; online
// only, API v1); deleting a page (confirmed). Pages come from the wiki
// source (data.ts): from memory or the device first, then from Forgejo, so
// a page seen before paints at once and offline. Links to other pages fetch
// them on hover. Writers only see the writing controls; the server decides.

import {Link, useNavigate, useParams, useSearch} from '@tanstack/react-router';
import {AppWindow, BookOpen, FilePlus2, FileText, Globe, History, List, Pencil, Settings, Trash2} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {type PointerEvent, type ReactNode, useEffect, useState} from 'react';
import {canWrite, repoAccess} from '../../app/access.ts';
import {CLASSIC_HINT, classicHref} from '../../app/classic.ts';
import {ClassicLink} from '../../app/ClassicLink.tsx';
import {ClassicMenuItem} from '../../app/ClassicMenuItem.tsx';
import {hrefOf} from '../../app/links.ts';
import {notify} from '../../app/notices.ts';
import {connectivity, onlineOnly} from '../../app/online.ts';
import {PageBody, PageColumn} from '../../app/shell/Frame.tsx';
import {useNotFound} from '../../app/shell/PageHeader.tsx';
import {useApp, useSession} from '../../app/store.ts';
import {
  Button, Callout, Dialog, EmptyState, Icon, Input, MenuItem, MenuSeparator, MoreMenu, NavItem, Skeleton, SkeletonText, TextLink,
} from '../../ui/index.ts';
import type {Loaded} from '../code/hooks.ts';
import {Unloaded} from '../code/states.tsx';
import {RowList} from '../code/RowList.tsx';
import {MarkdownField} from '../editor/Composer.tsx';
import {Markdown} from '../issue/Markdown.tsx';
import {usePool} from '../issues/cells.tsx';
import {ago, agoWords, fullDate} from '../issues/format.ts';
import {RepoHeader, Unavailable, useRepoPage} from '../repo/repoPage.tsx';
import {type Slot, type WikiList, type WikiPageMeta, type WikiPageRecord, type WikiSource, wikiSource} from './data.ts';
import {classicWikiPath, FOOTER, HOME, listOrder, pageTitle, revisionsPath, SIDEBAR, type WikiView, wikiPageOfPath, wikiPath} from './paths.ts';

/** Pages listed in the side pane at most (the page list has them all). */
const SIDE_PAGES = 40;

function useWiki(): WikiSource {
  const src = wikiSource(useApp());
  if (!src) throw new Error('the wiki needs a session');
  return src;
}

interface WikiProps {
  owner: string;
  repo: string;
  repoId: number;
}

/** Whether the viewer may write the wiki (write access, not archived: observes the pool). */
function useWritable(repoId: number): boolean {
  const s = useSession();
  const archived = usePool().model('Repository').get(repoId)?.get('archived') === true;
  return canWrite(s, repoId) && !archived;
}

/** Loads the page list while a wiki page is open (again when the connection comes back). */
function useList(src: WikiSource, {owner, repo, repoId}: WikiProps): Slot<WikiList> {
  const back = connectivity.online;
  useEffect(() => {
    void src.loadList(repoId, owner, repo);
  }, [src, repoId, owner, repo, back]);
  return src.list(repoId);
}

/** Every wiki view's frame: the repository header (the page's title and controls), the body. */
function WikiFrame({owner, repo, repoId, title, docTitle, controls, children}: {
  owner: string; repo: string; repoId: number | undefined; title: string; docTitle?: string; controls?: ReactNode; children: ReactNode;
}) {
  return (
    <>
      <RepoHeader owner={owner} repo={repo} repoId={repoId} icon={BookOpen} title={title} docTitle={docTitle ?? `${title} · Wiki`}>{controls}</RepoHeader>
      {children}
    </>
  );
}

/** A wiki route's repository, or its "not available" page. */
function WithRepo({title, children}: {title: string; children: (p: WikiProps) => ReactNode}) {
  const {owner, repo, repoId} = useRepoPage();
  if (repoId === undefined) {
    return <WikiFrame owner={owner} repo={repo} repoId={undefined} title={title}><PageBody><Unavailable owner={owner} repo={repo}/></PageBody></WikiFrame>;
  }
  return <>{children({owner, repo, repoId})}</>;
}

// ---- Routes ----

/** /{owner}/{repo}/wiki: its Home. */
export function WikiHome() {
  return <WithRepo title="Wiki">{(p) => <PageView key={`${String(p.repoId)}:${HOME}`} {...p} page={HOME}/>}</WithRepo>;
}

/** /{owner}/{repo}/wiki/{page}. */
export function WikiPageView() {
  const {page = HOME} = useParams({strict: false});
  return <WithRepo title={pageTitle(page)}>{(p) => <PageView key={`${String(p.repoId)}:${page}`} {...p} page={page}/>}</WithRepo>;
}

/** /{owner}/{repo}/wiki/-/pages. */
export function WikiPages() {
  return <WithRepo title="Pages">{(p) => <PagesView key={p.repoId} {...p}/>}</WithRepo>;
}

/** /{owner}/{repo}/wiki/-/new[?title=…]. */
export function WikiNew() {
  const title = useSearch({strict: false, select: (s: {title?: string}) => s.title}) ?? '';
  return <WithRepo title="New page">{(p) => <Editor key={`${String(p.repoId)}:new`} {...p} page={undefined} initialTitle={title}/>}</WithRepo>;
}

/** /{owner}/{repo}/wiki/{page}/-/edit. */
export function WikiEdit() {
  const {page = HOME} = useParams({strict: false});
  return <WithRepo title={`Edit ${pageTitle(page)}`}>{(p) => <EditView key={`${String(p.repoId)}:${page}`} {...p} page={page}/>}</WithRepo>;
}

// ---- A page ----

const PageView = observer(function PageView({owner, repo, repoId, page}: WikiProps & {page: string}) {
  const src = useWiki();
  const back = connectivity.online;
  useEffect(() => {
    void src.loadPage(repoId, owner, repo, page);
  }, [src, repoId, owner, repo, page, back]);
  const slot = src.page(repoId, page);
  const list = useList(src, {owner, repo, repoId});
  const writable = useWritable(repoId);
  const rec = slot.state === 'ready' ? slot.value : undefined;
  const title = rec?.title ?? pageTitle(page);
  const view: WikiView = {view: 'page', page};
  return (
    <WikiFrame owner={owner} repo={repo} repoId={repoId} title={title} controls={<PageControls owner={owner} repo={repo} repoId={repoId} page={page} title={title} exists={rec !== undefined} writable={writable} view={view}/>}>
      <PageBody>
        <div className="flex flex-col @xl:min-h-full @xl:flex-row">
          <PageColumn wide>
            <PageContent owner={owner} repo={repo} repoId={repoId} page={page} slot={slot} list={list} writable={writable}/>
          </PageColumn>
          <WikiAside owner={owner} repo={repo} repoId={repoId} current={page} list={list} sidebar={rec?.sidebar?.html} writable={writable}/>
        </div>
      </PageBody>
    </WikiFrame>
  );
});

/** The header's controls: Pages, Edit, New page, and More (delete, revisions, the classic page). */
function PageControls({owner, repo, repoId, page, title, exists, writable, view}: WikiProps & {page: string; title: string; exists: boolean; writable: boolean; view: WikiView}) {
  const app = useApp();
  const src = useWiki();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const offline = !connectivity.online;
  const remove = () => {
    setConfirming(false);
    src.remove(repoId, owner, repo, page).then(() => {
      notify(app, {tone: 'success', title: `Deleted “${title}”`});
      void navigate({to: '/$owner/$repo/wiki', params: {owner, repo}});
    }, (err: unknown) => {
      notify(app, {tone: 'danger', title: 'The page was not deleted', description: err instanceof Error ? err.message : String(err)});
    });
  };
  return (
    <>
      <Button size="sm" variant="ghost" asChild>
        <Link to="/$owner/$repo/wiki/-/pages" params={{owner, repo}}><Icon icon={List} size="sm"/>Pages</Link>
      </Button>
      {writable && exists && (
        <Button size="sm" variant="ghost" asChild tooltip={offline ? onlineOnly('Editing a wiki page') : undefined}>
          <Link to="/$owner/$repo/wiki/$page/-/edit" params={{owner, repo, page}}><Icon icon={Pencil} size="sm"/>Edit</Link>
        </Button>
      )}
      {writable && (
        <Button size="sm" variant="ghost" asChild>
          <Link to="/$owner/$repo/wiki/-/new" params={{owner, repo}}><Icon icon={FilePlus2} size="sm"/>New page</Link>
        </Button>
      )}
      <MoreMenu label="More of this page">
        {writable && exists && (
          <MenuItem icon={Trash2} danger disabled={offline} hint={offline ? 'offline' : undefined} onSelect={() => {
            setConfirming(true);
          }}>Delete page</MenuItem>
        )}
        {exists && <ClassicMenuItem to={revisionsPath(owner, repo, page)} icon={History}>Revisions</ClassicMenuItem>}
        {writable && exists && <MenuSeparator/>}
        <ClassicMenuItem to={classicWikiPath(owner, repo, view)} icon={AppWindow}>This page</ClassicMenuItem>
      </MoreMenu>
      {confirming && (
        <Dialog open size="sm" title={`Delete “${title}”?`} description="The page is removed from the wiki for everyone. Its revisions stay in the wiki's history." onOpenChange={(o) => {
          if (!o) setConfirming(false);
        }} footer={<>
          <Button variant="ghost" onClick={() => {
            setConfirming(false);
          }}>Cancel</Button>
          <Button variant="danger" autoFocus onClick={remove}>Delete</Button>
        </>}/>
      )}
    </>
  );
}

/** The page's body: its rendering, who changed it last, its footer; or why there is none. */
const PageContent = observer(function PageContent({owner, repo, repoId, page, slot, list, writable}: WikiProps & {
  page: string; slot: Slot<WikiPageRecord>; list: Slot<WikiList>; writable: boolean;
}) {
  if (slot.state === 'ready') return <Article owner={owner} repo={repo} repoId={repoId} rec={slot.value}/>;
  if (slot.state === 'missing') return <NoPage owner={owner} repo={repo} repoId={repoId} page={page} list={list} writable={writable}/>;
  if (slot.state === 'loading') return <ArticleSkeleton/>;
  return <Unloaded loaded={unloadedOf(slot)} what="This page"/>;
});

/** A slot's state for the code views' placeholders (Unloaded): no page is "Not found". */
function unloadedOf(s: Slot<unknown>): Exclude<Loaded<unknown>, {state: 'ready'}> {
  switch (s.state) {
    case 'missing':
      return {state: 'error', message: 'Not found', status: 404};
    case 'ready':
      return {state: 'loading'};
    default:
      return s;
  }
}

function ArticleSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy>
      <Skeleton className="h-3 w-48"/>
      <Skeleton className="h-5 w-64"/>
      <SkeletonText lines={6}/>
    </div>
  );
}

function Article({owner, repo, repoId, rec}: WikiProps & {rec: WikiPageRecord}) {
  const app = useApp();
  const revisions = classicHref(app, revisionsPath(owner, repo, rec.name));
  return (
    <article aria-label={rec.title} className="flex min-w-0 flex-col gap-4">
      {rec.date && (
        <p className="text-sm text-fg-muted">
          {rec.author || 'Someone'} edited this page <time dateTime={rec.date} title={fullDate(rec.date)}>{agoWords(rec.date)}</time>
          {rec.commitCount > 0 && <> · <TextLink wrap><a href={revisions} data-classic="" title={CLASSIC_HINT}>{rec.commitCount === 1 ? '1 revision' : `${String(rec.commitCount)} revisions`}</a></TextLink></>}
        </p>
      )}
      <WikiMarkdown owner={owner} repo={repo} repoId={repoId} html={rec.html} empty="This page is empty."/>
      {rec.footer && (
        <footer aria-label="Wiki footer" className="border-t border-border-subtle pt-4">
          <WikiMarkdown owner={owner} repo={repo} repoId={repoId} html={rec.footer.html}/>
        </footer>
      )}
    </article>
  );
}

/** A wiki's rendered markdown: its links to other pages of the wiki fetch them on hover. */
function WikiMarkdown({owner, repo, repoId, html, empty}: WikiProps & {html: string; empty?: string}) {
  const src = useWiki();
  const app = useApp();
  if (!html.trim()) return empty ? <p className="text-base text-fg-subtle">{empty}</p> : null;
  const onPointerOver = (e: PointerEvent<HTMLDivElement>) => {
    const a = (e.target as Element).closest('a');
    if (!a?.href) return;
    const url = new URL(a.href);
    const sub = app.config.app_sub_url;
    if (url.origin !== location.origin || !url.pathname.startsWith(`${sub}/`)) return;
    const page = wikiPageOfPath(url.pathname.slice(sub.length), owner, repo);
    if (page !== undefined) src.prefetchPage(repoId, owner, repo, page);
  };
  return <div onPointerOver={onPointerOver}><Markdown html={html}/></div>;
}

/** No such page: the wiki has none at all (or no wiki), or not this one. */
const NoPage = observer(function NoPage({owner, repo, repoId, page, list, writable}: WikiProps & {page: string; list: Slot<WikiList>; writable: boolean}) {
  const none = list.state === 'ready' && list.value.kind !== 'pages';
  useNotFound(!none && list.state !== 'loading');
  if (list.state === 'loading') return <ArticleSkeleton/>;
  if (list.state === 'ready' && list.value.kind !== 'pages') return <NoWiki owner={owner} repo={repo} repoId={repoId} list={list.value} writable={writable}/>;
  const create = writable && page !== SIDEBAR && page !== FOOTER ? (
    <Button variant="primary" asChild>
      <Link to="/$owner/$repo/wiki/-/new" params={{owner, repo}} search={{title: pageTitle(page)}}><Icon icon={FilePlus2}/>Create “{pageTitle(page)}”</Link>
    </Button>
  ) : undefined;
  return (
    <EmptyState icon={FileText} title={page === HOME ? 'This wiki has no Home page' : 'No such page'}
      description={page === HOME ? 'Its pages are listed on the side.' : `The wiki has no page “${pageTitle(page)}”, or you cannot see it.`}
      action={create}/>
  );
});

/** A repository without wiki pages: no wiki, a wiki elsewhere, or no page yet ("Create the first page"). */
function NoWiki({owner, repo, repoId, list, writable}: WikiProps & {list: Exclude<WikiList, {kind: 'pages'}>; writable: boolean}) {
  const admin = repoAccess(useSession(), repoId) === 'admin';
  switch (list.kind) {
    case 'disabled':
      return (
        <EmptyState icon={BookOpen} title="This repository has no wiki" description="Its wiki is turned off."
          action={admin ? <ClassicLink to={`/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/settings`}><Icon icon={Settings} size="md"/>Turn it on in the settings</ClassicLink> : undefined}/>
      );
    case 'external':
      return (
        <EmptyState icon={Globe} title="This wiki is elsewhere" description={list.url}
          action={<Button asChild><a href={list.url} rel="noopener noreferrer"><Icon icon={Globe}/>Open the wiki</a></Button>}/>
      );
    case 'empty':
      return (
        <EmptyState icon={BookOpen} title="This wiki has no pages yet"
          description={writable ? 'Start it with its Home page: the page the wiki opens on.' : 'Nobody has written a page yet.'}
          action={writable ? (
            <Button variant="primary" asChild>
              <Link to="/$owner/$repo/wiki/-/new" params={{owner, repo}} search={{title: HOME}}><Icon icon={FilePlus2}/>Create the first page</Link>
            </Button>
          ) : undefined}/>
      );
  }
}

/** The side pane: the wiki's own sidebar (_Sidebar), its pages. */
const WikiAside = observer(function WikiAside({owner, repo, repoId, current, list, sidebar, writable}: WikiProps & {
  current: string | undefined; list: Slot<WikiList>; sidebar: string | undefined; writable: boolean;
}) {
  if (list.state === 'ready' && list.value.kind !== 'pages' && !sidebar) return null;
  const pages = list.state === 'ready' && list.value.kind === 'pages' ? listOrder(list.value.pages) : [];
  return (
    <aside aria-label="Wiki" className="flex shrink-0 flex-col gap-4 border-t border-border p-4 @xl:w-pane @xl:border-t-0 @xl:border-l">
      {sidebar && (
        <section aria-label="Wiki sidebar" className="flex flex-col gap-2">
          <WikiMarkdown owner={owner} repo={repo} repoId={repoId} html={sidebar}/>
          {writable && (
            <TextLink><Link to="/$owner/$repo/wiki/$page/-/edit" params={{owner, repo, page: SIDEBAR}} className="text-sm">Edit the sidebar</Link></TextLink>
          )}
        </section>
      )}
      <nav aria-label="Pages" className="flex flex-col">
        <h2 className="flex h-control items-center justify-between px-2 text-sm font-medium text-fg-muted">
          <span>Pages</span>
          {pages.length > 0 && <span className="tabular-nums text-fg-subtle">{pages.length}</span>}
        </h2>
        {list.state === 'loading' && Array.from({length: 5}, (_, i) => <div key={i} className="flex h-control items-center px-2"><Skeleton className="h-3 w-28"/></div>)}
        {pages.slice(0, SIDE_PAGES).map((p) => (
          <NavItem key={p.name} label={p.title} asChild>
            <Link to="/$owner/$repo/wiki/$page" params={{owner, repo, page: p.name}} aria-current={p.name === current ? 'page' : undefined} activeProps={{}}/>
          </NavItem>
        ))}
        {pages.length > SIDE_PAGES && (
          <NavItem label={`All ${String(pages.length)} pages`} asChild>
            <Link to="/$owner/$repo/wiki/-/pages" params={{owner, repo}}/>
          </NavItem>
        )}
      </nav>
      {list.state === 'ready' && list.value.kind === 'pages' && writable && !sidebar && (
        <TextLink><Link to="/$owner/$repo/wiki/-/new" params={{owner, repo}} search={{title: SIDEBAR}} className="px-2 text-sm">Add a custom sidebar</Link></TextLink>
      )}
    </aside>
  );
});

// ---- The page list ----

const PagesView = observer(function PagesView({owner, repo, repoId}: WikiProps) {
  const app = useApp();
  const src = useWiki();
  const navigate = useNavigate();
  const list = useList(src, {owner, repo, repoId});
  const writable = useWritable(repoId);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const controls = (
    <>
      {writable && (
        <Button size="sm" variant="ghost" asChild>
          <Link to="/$owner/$repo/wiki/-/new" params={{owner, repo}}><Icon icon={FilePlus2} size="sm"/>New page</Link>
        </Button>
      )}
      <MoreMenu label="More of the wiki">
        <ClassicMenuItem to={classicWikiPath(owner, repo, {view: 'pages'})} icon={AppWindow}>This page</ClassicMenuItem>
      </MoreMenu>
    </>
  );
  let body: ReactNode;
  const value = list.state === 'ready' ? list.value : undefined;
  if (value?.kind === 'pages') {
    const pages = listOrder(value.pages);
    const linkOf = (p: WikiPageMeta) => hrefOf(app, wikiPath(owner, repo, {view: 'page', page: p.name}));
    body = (
      <RowList items={pages} scroller={scroller} label="Pages" keyOf={(p) => p.name}
        row={(p) => ({
          leading: <Icon icon={FileText} size="sm"/>,
          main: p.title,
          trailing: p.date ? <>{p.author && <span>{p.author}</span>}<time dateTime={p.date} title={fullDate(p.date)}>{ago(p.date)}</time></> : undefined,
        })}
        onOpen={(p) => void navigate({to: '/$owner/$repo/wiki/$page', params: {owner, repo, page: p.name}})}
        onIntent={(p) => {
          src.prefetchPage(repoId, owner, repo, p.name);
        }}
        linkOf={linkOf}/>
    );
  } else if (value) {
    body = <PageColumn><NoWiki owner={owner} repo={repo} repoId={repoId} list={value} writable={writable}/></PageColumn>;
  } else if (list.state === 'loading') {
    body = <div className="flex flex-col gap-3 px-4 py-4" aria-busy><SkeletonText lines={8}/></div>;
  } else {
    body = <Unloaded loaded={unloadedOf(list)} what="This wiki's pages"/>;
  }
  return (
    <WikiFrame owner={owner} repo={repo} repoId={repoId} title="Pages" docTitle="Pages · Wiki" controls={controls}>
      <PageBody ref={setScroller}>{body}</PageBody>
    </WikiFrame>
  );
});

// ---- Writing ----

/** A page's editor once its text is here. */
const EditView = observer(function EditView({owner, repo, repoId, page}: WikiProps & {page: string}) {
  const src = useWiki();
  const back = connectivity.online;
  // The text Forgejo has now, not the device's copy of it (saving an older text would undo a newer change): asked
  // for again; offline (or Forgejo not answering) the copy is all there is, and saving waits for a connection.
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    let live = true;
    void src.loadPage(repoId, owner, repo, page, true).finally(() => {
      if (live) setAsked(true);
    });
    return () => {
      live = false;
    };
  }, [src, repoId, owner, repo, page, back]);
  const slot = src.page(repoId, page);
  // Once the editor is open it keeps its text: the page asked for again (back online) never replaces what is typed.
  const [opened, setOpened] = useState<WikiPageRecord | undefined>(undefined);
  const now = asked && slot.state === 'ready' ? slot.value : undefined;
  if (now && !opened) setOpened(now);
  const rec = opened ?? now;
  if (rec) return <Editor owner={owner} repo={repo} repoId={repoId} page={rec} initialTitle={rec.title}/>;
  return (
    <WikiFrame owner={owner} repo={repo} repoId={repoId} title={`Edit ${pageTitle(page)}`}>
      <PageBody>
        <PageColumn wide>
          {slot.state === 'loading' || slot.state === 'ready' ? <ArticleSkeleton/> : <Unloaded loaded={unloadedOf(slot)} what="This page"/>}
        </PageColumn>
      </PageBody>
    </WikiFrame>
  );
});

/** A new page (page undefined) or a page's editor: title, text (Write / Preview as the wiki renders it), commit message. */
const Editor = observer(function Editor({owner, repo, repoId, page, initialTitle}: WikiProps & {page: WikiPageRecord | undefined; initialTitle: string}) {
  const app = useApp();
  const src = useWiki();
  const navigate = useNavigate();
  const writable = useWritable(repoId);
  const [title, setTitle] = useState(initialTitle);
  const [text, setText] = useState(page?.text ?? '');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [missing, setMissing] = useState(false);
  const offline = !connectivity.online;
  const heading = page ? `Edit ${page.title}` : 'New page';
  const leave = () => {
    if (page) void navigate({to: '/$owner/$repo/wiki/$page', params: {owner, repo, page: page.name}});
    else void navigate({to: '/$owner/$repo/wiki', params: {owner, repo}});
  };
  const save = () => {
    if (saving || offline) return;
    const t = title.trim();
    if (!t) {
      setMissing(true);
      return;
    }
    setSaving(true);
    setError(undefined);
    // The title always (API v1 renames a page saved without one to "unnamed"): the same title keeps its name.
    const edit = {title: t, text, message: message.trim()};
    const done = page ? src.edit(repoId, owner, repo, page.name, edit) : src.create(repoId, owner, repo, edit);
    done.then((name) => {
      notify(app, {tone: 'success', title: page ? `Saved “${t}”` : `Created “${t}”`});
      void navigate({to: '/$owner/$repo/wiki/$page', params: {owner, repo, page: name}, replace: true});
    }, (err: unknown) => {
      setSaving(false);
      setError(err instanceof Error ? err.message : String(err));
    });
  };
  const view: WikiView = page ? {view: 'edit', page: page.name} : {view: 'new'};
  return (
    <WikiFrame owner={owner} repo={repo} repoId={repoId} title={heading}
      controls={<MoreMenu label="More of this page"><ClassicMenuItem to={classicWikiPath(owner, repo, view)} icon={AppWindow}>This page</ClassicMenuItem></MoreMenu>}>
      <PageBody>
        <PageColumn wide>
          {!writable && <Callout tone="warning" title="You cannot write this wiki">Forgejo will refuse the change.</Callout>}
          {error !== undefined && <Callout tone="danger" title="Not saved">{error}</Callout>}
          <div className="flex flex-col gap-1">
            <Input aria-label="Title" placeholder="Page title" value={title} autoFocus={!page} className="w-full" maxLength={255} invalid={missing && !title.trim()}
              aria-describedby={missing && !title.trim() ? 'wiki-title-missing' : undefined}
              onChange={(e) => {
                setTitle(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  save();
                }
              }}/>
            {missing && !title.trim() && <p id="wiki-title-missing" role="alert" className="text-sm text-danger">A page needs a title.</p>}
          </div>
          <MarkdownField repoId={repoId} label="Content" placeholder="Write the page in markdown…" value={text} rows={16} autoFocus={Boolean(page)}
            onChange={setText} onSubmit={save} onCancel={leave} render={(t) => src.render(repoId, t)}/>
          <Input aria-label="Commit message" placeholder={page ? `Update “${page.title}” (optional message)` : 'Add the page (optional message)'} value={message} className="w-full" maxLength={255}
            onChange={(e) => {
              setMessage(e.target.value);
            }}/>
          <div className="flex items-center justify-end gap-2">
            {offline && <span className="text-sm text-fg-subtle">{onlineOnly(page ? 'Saving a wiki page' : 'Creating a wiki page')}</span>}
            <Button variant="ghost" onClick={leave}>Cancel</Button>
            <Button variant="primary" disabled={saving || offline} onClick={save}>{saving ? 'Saving…' : page ? 'Save' : 'Create page'}</Button>
          </div>
        </PageColumn>
      </PageBody>
    </WikiFrame>
  );
});
