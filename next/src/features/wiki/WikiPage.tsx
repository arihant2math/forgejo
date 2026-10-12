// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {createLink, useNavigate, useParams, useSearch} from '@tanstack/react-router';
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
import type {Loaded} from '../code/hooks.ts';
import {Unloaded} from '../code/states.tsx';
import {RowList} from '../code/RowList.tsx';
import {MarkdownField} from '../editor/Composer.tsx';
import {Markdown} from '../issue/Markdown.tsx';
import {usePool} from '../issues/cells.tsx';
import {TimeAgo} from '../../components/TimeAgo.tsx';
import {RepoHeader, Unavailable, useRepoPage} from '../repo/repoPage.tsx';
import {type Slot, type WikiList, type WikiPageMeta, type WikiPageRecord, type WikiSource, wikiSource} from './data.ts';
import {classicWikiPath, FOOTER, HOME, listOrder, pageTitle, revisionsPath, SIDEBAR, type WikiView, wikiPageOfPath, wikiPath} from './paths.ts';
import {BrowserIcon, BookIcon, FileAddedIcon, FileIcon, GlobeIcon, HistoryIcon, PencilIcon, GearIcon, SearchIcon, TrashIcon, KebabHorizontalIcon} from '@primer/octicons-react';
import {Banner, Heading, CounterLabel, NavList, Tooltip, Button, LinkButton, ActionMenu, ActionList, ConfirmationDialog, FormControl, Link as PrimerLink, TextInput} from '@primer/react';
import {RouterLinkButton, RouterLink} from '../../app/routerLinks.tsx';
import {SkeletonBox, SkeletonText, Blankslate} from '@primer/react/experimental';

const WikiNavItem = createLink(NavList.Item);

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

function useWritable(repoId: number): boolean {
  const s = useSession();
  const archived = usePool().model('Repository').get(repoId)?.get('archived') === true;
  return canWrite(s, repoId) && !archived;
}

function useList(src: WikiSource, {owner, repo, repoId}: WikiProps): Slot<WikiList> {
  const back = connectivity.online;
  useEffect(() => {
    void src.loadList(repoId, owner, repo);
  }, [src, repoId, owner, repo, back]);
  return src.list(repoId);
}

function WikiFrame({owner, repo, repoId, title, docTitle, controls, children}: {
  owner: string; repo: string; repoId: number | undefined; title: string; docTitle?: string; controls?: ReactNode; children: ReactNode;
}) {
  return (
    <>
      <RepoHeader owner={owner} repo={repo} repoId={repoId} icon={BookIcon} title={title} docTitle={docTitle ?? `${title} · Wiki`}>{controls}</RepoHeader>
      {children}
    </>
  );
}

function WithRepo({title, children}: {title: string; children: (p: WikiProps) => ReactNode}) {
  const {owner, repo, repoId} = useRepoPage();
  if (repoId === undefined) {
    return <WikiFrame owner={owner} repo={repo} repoId={undefined} title={title}><PageBody><Unavailable owner={owner} repo={repo}/></PageBody></WikiFrame>;
  }
  return <>{children({owner, repo, repoId})}</>;
}


export function WikiHome() {
  return <WithRepo title="Wiki">{(p) => <PageView key={`${String(p.repoId)}:${HOME}`} {...p} page={HOME}/>}</WithRepo>;
}

export function WikiPageView() {
  const {page = HOME} = useParams({strict: false});
  return <WithRepo title={pageTitle(page)}>{(p) => <PageView key={`${String(p.repoId)}:${page}`} {...p} page={page}/>}</WithRepo>;
}

export function WikiPages() {
  return <WithRepo title="Pages">{(p) => <PagesView key={p.repoId} {...p}/>}</WithRepo>;
}

export function WikiNew() {
  const title = useSearch({strict: false, select: (s: {title?: string}) => s.title}) ?? '';
  return <WithRepo title="New page">{(p) => <Editor key={`${String(p.repoId)}:new`} {...p} page={undefined} initialTitle={title}/>}</WithRepo>;
}

export function WikiEdit() {
  const {page = HOME} = useParams({strict: false});
  return <WithRepo title={`Edit ${pageTitle(page)}`}>{(p) => <EditView key={`${String(p.repoId)}:${page}`} {...p} page={page}/>}</WithRepo>;
}


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
      {writable && exists && (
        <Tooltip text={offline ? onlineOnly('Editing a wiki page') : 'Edit this page'}><RouterLinkButton size="small" to="/$owner/$repo/wiki/$page/-/edit" params={{owner, repo, page}}>Edit</RouterLinkButton></Tooltip>
      )}
      {writable && (
        <RouterLinkButton variant="primary" size="small" to="/$owner/$repo/wiki/-/new" params={{owner, repo}}>New page</RouterLinkButton>
      )}
      <ActionMenu><ActionMenu.Button variant="invisible" size="small" leadingVisual={KebabHorizontalIcon} aria-label="More of this page">More</ActionMenu.Button><ActionMenu.Overlay><ActionList>
        {writable && exists && (
          <ActionList.Item variant="danger" disabled={offline} onSelect={() => {
            setConfirming(true);
          }}><ActionList.LeadingVisual><TrashIcon/></ActionList.LeadingVisual>Delete page<ActionList.TrailingVisual>{offline ? 'offline' : undefined}</ActionList.TrailingVisual></ActionList.Item>
        )}
        {exists && <ClassicMenuItem to={revisionsPath(owner, repo, page)} icon={HistoryIcon}>Revisions</ClassicMenuItem>}
        {writable && exists && <ActionList.Divider/>}
        <ClassicMenuItem to={classicWikiPath(owner, repo, view)} icon={BrowserIcon}>This page</ClassicMenuItem>
      </ActionList></ActionMenu.Overlay></ActionMenu>
      {confirming && (
        <ConfirmationDialog title={`Delete “${title}”?`} confirmButtonContent="Delete" confirmButtonType="danger" onClose={(gesture) => {
          if (gesture === 'confirm') remove();
          else setConfirming(false);
        }}>The page is removed from the wiki for everyone. Its revisions stay in the wiki's history.</ConfirmationDialog>
      )}
    </>
  );
}

const PageContent = observer(function PageContent({owner, repo, repoId, page, slot, list, writable}: WikiProps & {
  page: string; slot: Slot<WikiPageRecord>; list: Slot<WikiList>; writable: boolean;
}) {
  if (slot.state === 'ready') return <Article owner={owner} repo={repo} repoId={repoId} rec={slot.value}/>;
  if (slot.state === 'missing') return <NoPage owner={owner} repo={repo} repoId={repoId} page={page} list={list} writable={writable}/>;
  if (slot.state === 'loading') return <ArticleSkeleton/>;
  return <Unloaded loaded={unloadedOf(slot)} what="This page"/>;
});

/** A missing page maps to Not found, not an unloaded placeholder. */
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
    <div className="flex flex-col gap-4" aria-busy>
      <SkeletonBox className="h-3 w-48"/>
      <SkeletonBox className="h-5 w-64"/>
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
        <p className="text-sm text-muted">
          {rec.author || 'Someone'} edited this page <TimeAgo at={rec.date} variant="words"/>
          {rec.commitCount > 0 && <> · <PrimerLink href={revisions} data-classic="" title={CLASSIC_HINT} muted>{rec.commitCount === 1 ? '1 revision' : `${String(rec.commitCount)} revisions`}</PrimerLink></>}
        </p>
      )}
      <WikiMarkdown owner={owner} repo={repo} repoId={repoId} html={rec.html} empty="This page is empty."/>
      {rec.footer && (
        <footer aria-label="Wiki footer" className="border-t border-muted pt-4">
          <WikiMarkdown owner={owner} repo={repo} repoId={repoId} html={rec.footer.html}/>
        </footer>
      )}
    </article>
  );
}

function WikiMarkdown({owner, repo, repoId, html, empty}: WikiProps & {html: string; empty?: string}) {
  const src = useWiki();
  const app = useApp();
  if (!html.trim()) return empty ? <p className="text-base text-muted">{empty}</p> : null;
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

const NoPage = observer(function NoPage({owner, repo, repoId, page, list, writable}: WikiProps & {page: string; list: Slot<WikiList>; writable: boolean}) {
  const none = list.state === 'ready' && list.value.kind !== 'pages';
  useNotFound(!none && list.state !== 'loading');
  if (list.state === 'loading') return <ArticleSkeleton/>;
  if (list.state === 'ready' && list.value.kind !== 'pages') return <NoWiki owner={owner} repo={repo} repoId={repoId} list={list.value} writable={writable}/>;
  const create = writable && page !== SIDEBAR && page !== FOOTER ? (
    <RouterLinkButton variant="primary" leadingVisual={FileAddedIcon} to="/$owner/$repo/wiki/-/new" params={{owner, repo}} search={{title: pageTitle(page)}}>Create “{pageTitle(page)}”</RouterLinkButton>
  ) : undefined;
  return (
    <Blankslate><Blankslate.Visual><FileIcon size={24}/></Blankslate.Visual><Blankslate.Heading>{page === HOME ? 'This wiki has no Home page' : 'No such page'}</Blankslate.Heading><Blankslate.Description>{page === HOME ? 'Its pages are listed on the side.' : `The wiki has no page “${pageTitle(page)}”, or you cannot see it.`}</Blankslate.Description>{create}</Blankslate>
  );
});

function NoWiki({owner, repo, repoId, list, writable}: WikiProps & {list: Exclude<WikiList, {kind: 'pages'}>; writable: boolean}) {
  const admin = repoAccess(useSession(), repoId) === 'admin';
  switch (list.kind) {
    case 'disabled':
      return (
        <Blankslate><Blankslate.Visual><BookIcon size={24}/></Blankslate.Visual><Blankslate.Heading>This repository has no wiki</Blankslate.Heading><Blankslate.Description>Its wiki is turned off.</Blankslate.Description>{admin ? <ClassicLink to={`/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/settings`}><GearIcon size={16} className="shrink-0"/>Turn it on in the settings</ClassicLink> : undefined}</Blankslate>
      );
    case 'external':
      return (
        <Blankslate><Blankslate.Visual><GlobeIcon size={24}/></Blankslate.Visual><Blankslate.Heading>This wiki is elsewhere</Blankslate.Heading><Blankslate.Description>{list.url}</Blankslate.Description>{<LinkButton leadingVisual={GlobeIcon} href={list.url} rel="noopener noreferrer">Open the wiki</LinkButton>}</Blankslate>
      );
    case 'empty':
      return (
        <Blankslate><Blankslate.Visual><BookIcon size={24}/></Blankslate.Visual><Blankslate.Heading>This wiki has no pages yet</Blankslate.Heading><Blankslate.Description>{writable ? 'Start it with its Home page: the page the wiki opens on.' : 'Nobody has written a page yet.'}</Blankslate.Description>{writable ? (
            <RouterLinkButton variant="primary" leadingVisual={FileAddedIcon} to="/$owner/$repo/wiki/-/new" params={{owner, repo}} search={{title: HOME}}>Create the first page</RouterLinkButton>
          ) : undefined}</Blankslate>
      );
  }
}

const WikiAside = observer(function WikiAside({owner, repo, repoId, current, list, sidebar, writable}: WikiProps & {
  current: string | undefined; list: Slot<WikiList>; sidebar: string | undefined; writable: boolean;
}) {
  if (list.state === 'ready' && list.value.kind !== 'pages' && !sidebar) return null;
  const pages = list.state === 'ready' && list.value.kind === 'pages' ? listOrder(list.value.pages) : [];
  return (
    <aside aria-label="Wiki" className="flex shrink-0 flex-col gap-4 border-t border-default p-4 @xl:w-pane @xl:border-t-0 @xl:border-l">
      <PageNav owner={owner} repo={repo} current={current} pages={pages} loading={list.state === 'loading'}/>
      {sidebar ? (
        <section aria-label="Wiki sidebar" className="flex flex-col gap-2 border-t border-default pt-4">
          {writable && (
            <div className="flex justify-end">
              <RouterLinkButton variant="invisible" size="small" leadingVisual={PencilIcon} to="/$owner/$repo/wiki/$page/-/edit" params={{owner, repo, page: SIDEBAR}} aria-label="Edit the sidebar">Edit</RouterLinkButton>
            </div>
          )}
          <div className="markdown-nav"><WikiMarkdown owner={owner} repo={repo} repoId={repoId} html={sidebar}/></div>
        </section>
      ) : list.state === 'ready' && list.value.kind === 'pages' && writable && (
        <RouterLink to="/$owner/$repo/wiki/-/new" params={{owner, repo}} search={{title: SIDEBAR}} className="px-2">Add a custom sidebar</RouterLink>
      )}
    </aside>
  );
});

/** GitHub's Pages box: a filter over the page titles and the first SIDE_PAGES, the rest behind Show more. */
function PageNav({owner, repo, current, pages, loading}: {owner: string; repo: string; current: string | undefined; pages: readonly WikiPageMeta[]; loading: boolean}) {
  const app = useApp();
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const shown = q ? pages.filter((p) => p.title.toLowerCase().includes(q)) : pages;
  const head = q ? shown : shown.slice(0, SIDE_PAGES);
  const rest = q ? [] : shown.slice(SIDE_PAGES);
  const item = (p: WikiPageMeta, focus?: string) => (
    <WikiNavItem key={p.name} to="/$owner/$repo/wiki/$page" params={{owner, repo, page: p.name}} aria-current={p.name === current ? 'page' : false} activeProps={{}} data-expand-focus-target={focus}>{p.title}</WikiNavItem>
  );
  const byHref = new Map(rest.map((p) => [hrefOf(app, wikiPath(owner, repo, {view: 'page', page: p.name})), p]));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-2"><Heading as="h2" variant="small">Pages</Heading>{pages.length > 0 && <CounterLabel>{pages.length}</CounterLabel>}</div>
      {pages.length > 0 && <TextInput size="small" block leadingVisual={SearchIcon} aria-label="Find a page" placeholder="Find a page…" value={filter} onChange={(e) => { setFilter(e.target.value); }}/>}
      <NavList aria-label="Pages">
        <NavList.Group>
          {loading && Array.from({length: 5}, (_, i) => <div key={i} className="flex h-control items-center px-2"><SkeletonBox className="h-3 w-28"/></div>)}
          {head.map((p) => item(p))}
          {rest.length > 0 && (
            <NavList.GroupExpand label={`Show ${String(rest.length)} more ${rest.length === 1 ? 'page' : 'pages'}…`} items={[...byHref.keys()].map((href) => ({text: '', href}))}
              renderItem={(it) => {
                const p = byHref.get(it.href ?? '');
                return p ? item(p, it['data-expand-focus-target']) : null;
              }}/>
          )}
        </NavList.Group>
      </NavList>
      {q && !shown.length && <p className="px-2 text-sm text-muted">No page matches.</p>}
    </div>
  );
}

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
        <RouterLinkButton variant="primary" size="small" to="/$owner/$repo/wiki/-/new" params={{owner, repo}}>New page</RouterLinkButton>
      )}
      <ActionMenu><ActionMenu.Button variant="invisible" size="small" leadingVisual={KebabHorizontalIcon} aria-label="More of the wiki">More</ActionMenu.Button><ActionMenu.Overlay><ActionList>
        <ClassicMenuItem to={classicWikiPath(owner, repo, {view: 'pages'})} icon={BrowserIcon}>This page</ClassicMenuItem>
      </ActionList></ActionMenu.Overlay></ActionMenu>
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
          leading: <FileIcon size={16} className="shrink-0"/>,
          main: p.title,
          trailing: p.date ? <>{p.author && <span>{p.author}</span>}<TimeAgo at={p.date}/></> : undefined,
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
    body = <div className="flex flex-col gap-4 px-4 py-4" aria-busy><SkeletonText lines={8}/></div>;
  } else {
    body = <Unloaded loaded={unloadedOf(list)} what="This wiki's pages"/>;
  }
  return (
    <WikiFrame owner={owner} repo={repo} repoId={repoId} title="Pages" docTitle="Pages · Wiki" controls={controls}>
      <PageBody ref={setScroller}>{body}</PageBody>
    </WikiFrame>
  );
});


const EditView = observer(function EditView({owner, repo, repoId, page}: WikiProps & {page: string}) {
  const src = useWiki();
  const back = connectivity.online;
  // Refresh before editing to avoid overwriting newer server text; offline saves wait for a connection.
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
  // Revalidation must not replace text once the editor is open.
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
    // Always send the title: API v1 otherwise renames the page to "unnamed".
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
      controls={<ActionMenu><ActionMenu.Button variant="invisible" size="small" leadingVisual={KebabHorizontalIcon} aria-label="More of this page">More</ActionMenu.Button><ActionMenu.Overlay><ActionList><ClassicMenuItem to={classicWikiPath(owner, repo, view)} icon={BrowserIcon}>This page</ClassicMenuItem></ActionList></ActionMenu.Overlay></ActionMenu>}>
      <PageBody>
        <PageColumn wide>
          {!writable && <Banner variant="warning" title="You cannot write this wiki" description="Forgejo will refuse the change."/>}
          {error !== undefined && <Banner variant="critical" title="Not saved" description={error}/>}
          <FormControl required>
            <FormControl.Label>Title</FormControl.Label>
            <TextInput placeholder="Page title" value={title} autoFocus={!page} className="w-full" maxLength={255} onChange={(e) => {
                setTitle(e.target.value);
              }} onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  save();
                }
              }}/>
            {missing && !title.trim() && <FormControl.Validation variant="error">A page needs a title.</FormControl.Validation>}
          </FormControl>
          <MarkdownField attachments={false} repoId={repoId} label="Content" placeholder="Write the page in markdown…" value={text} rows={16} autoFocus={Boolean(page)}
            onChange={setText} onSubmit={save} onCancel={leave} render={(t) => src.render(repoId, t)}/>
          <FormControl>
            <FormControl.Label>Commit message</FormControl.Label>
            <TextInput placeholder={page ? `Update “${page.title}” (optional message)` : 'Add the page (optional message)'} value={message} className="w-full" maxLength={255} onChange={(e) => {
              setMessage(e.target.value);
            }}/>
            <FormControl.Caption>Optional description of this change.</FormControl.Caption>
          </FormControl>
          <div className="flex items-center justify-end gap-2">
            {offline && <span className="text-sm text-muted">{onlineOnly(page ? 'Saving a wiki page' : 'Creating a wiki page')}</span>}
            <Button variant="invisible" type="button" onClick={leave}>Cancel</Button>
            <Button variant="primary" type="button" disabled={saving || offline} onClick={save}>{saving ? 'Saving…' : page ? 'Save' : 'Create page'}</Button>
          </div>
        </PageColumn>
      </PageBody>
    </WikiFrame>
  );
});

