import {observer} from 'mobx-react-lite';
import {runInAction} from 'mobx';
import {canWrite} from '../../app/access.ts';
import {useApp, useSession} from '../../app/store.ts';
import {useShortcut} from '../../app/shortcuts/index.ts';
import type {Entity} from '../../data/entity.ts';
import {editing} from '../../intents/session.ts';
import {issueTitle} from '../../intents/view.ts';
import {Button, Menu, MenuContent, MenuItem, MenuTrigger} from '../../ui/index.ts';
import {draftPrefix, draftTitle, wipPrefixes} from './draft.ts';

export const DraftControl = observer(function DraftControl({issue}: {issue: Entity<'Issue'>}) {
  const app = useApp();
  const session = useSession();
  const {overlay, intents} = editing(app);
  const title = issueTitle(overlay, issue);
  const prefixes = wipPrefixes(app.config);
  const draft = draftPrefix(title, prefixes) !== undefined;
  const allowed = issue.get('state') === 'open' && (issue.get('poster_id') === session.userId || canWrite(session, issue.get('repo_id')));
  const toggle = () => {
    runInAction(() => {
      const next = draftTitle(title, !draft, prefixes);
      if (next.trim() && next.length <= 255 && next !== title) intents.submit({kind: 'issue.title', issueId: issue.id, repoId: issue.get('repo_id'), title: next, base: title});
    });
  };
  useShortcut('pull.ready', toggle, allowed && draft);
  useShortcut('pull.draft', toggle, allowed && !draft && !!prefixes[0]);
  if (!allowed) return null;
  if (draft) return <Button variant="primary" onClick={toggle}>Ready for review</Button>;
  if (!prefixes[0]) return null;
  return <Menu><MenuTrigger asChild><Button>Pull request actions</Button></MenuTrigger><MenuContent><MenuItem onSelect={toggle}>Convert to draft</MenuItem></MenuContent></Menu>;
});
