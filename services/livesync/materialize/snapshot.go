// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	activities_model "forgejo.org/models/activities"
	"forgejo.org/models/db"
	issues_model "forgejo.org/models/issues"
	livesync_model "forgejo.org/models/livesync"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/git"
	"forgejo.org/modules/log"
	"forgejo.org/modules/structs"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/services/livesync/protocol"

	"xorm.io/builder"
)

// Snapshots (B6, PLAN §4.7): the current state of one sync group, read from
// the upstream tables through the same specs (loaders, placement, DTOs) as
// the materializer, so that a bootstrap carries exactly what the log would
// carry for every entity of the group.
//
// Consistency with the log. The caller reads the log head (the watermark W)
// before calling Snapshot; the client then applies the deltas after W. Each
// chunk of rows is loaded, then the entity index is read for the entities
// found in the group, and an entity without an index row is left out:
//
//   - An entity with an index row was emitted (or backfilled) and is
//     routed: whatever happens to it later (a change, a move, its delete)
//     is materialized after the chunk was read, i.e. after W was read, and
//     gets a sync id above W (a writer transaction that commits after W was
//     read assigns ids above it: the log head row stays locked until its
//     commit). The client gets it.
//   - An entity without an index row has not been materialized (its insert
//     is still in the outbox, or it entered a group by a change still
//     there), or its last materialization placed it nowhere / failed. In
//     the first cases the pending change is materialized after the chunk was
//     read, so the entity reaches the client as a delta above W — or, if it
//     was deleted meanwhile and the materializer coalesced the insert and
//     the delete, not at all, which is right (B3's "inserted and deleted
//     around the snapshot" case: no delete is ever emitted for it, so it
//     must not be in a bootstrap). In the last cases the log never carries
//     it, and a later bootstrap leaves it out as well.
//
// This needs every row that existed before livesync was installed to be
// indexed: callers must check BackfillPending for SnapshotTables first (the
// B3 bootstrap gate). Snapshots never wait for the materializer.
//
// Snapshot chunks are read in short read transactions on the master (a
// replica may lag behind W), and payloads go to the caller between chunks,
// so memory is bounded by a chunk and no transaction stays open while the
// client reads.

// SnapshotEntity is one entity of a snapshot.
type SnapshotEntity struct {
	Group   string
	Model   protocol.Model
	ID      int64
	Payload string
	// UserRefs are the users and organizations whose profile (User entity)
	// the entity refers to (posters, assignees, owners, …).
	UserRefs []int64
}

// ClosedCursor is where a page of the closed tier starts: closed issues
// updated before Updated, or at Updated with an id below ID.
type ClosedCursor struct {
	Updated int64
	ID      int64
}

// String is the cursor as clients send it (closedBefore): "<updated>" or
// "<updated>.<id>".
func (c ClosedCursor) String() string {
	if c.ID == 0 {
		return strconv.FormatInt(c.Updated, 10)
	}
	return strconv.FormatInt(c.Updated, 10) + "." + strconv.FormatInt(c.ID, 10)
}

// ParseClosedCursor parses a closedBefore value (ClosedCursor.String).
func ParseClosedCursor(s string) (ClosedCursor, error) {
	updated, id, hasID := strings.Cut(s, ".")
	var c ClosedCursor
	var err error
	if c.Updated, err = strconv.ParseInt(updated, 10, 64); err != nil || c.Updated <= 0 {
		return c, fmt.Errorf("invalid closedBefore %q", s)
	}
	if hasID {
		if c.ID, err = strconv.ParseInt(id, 10, 64); err != nil || c.ID <= 0 {
			return c, fmt.Errorf("invalid closedBefore %q", s)
		}
	}
	return c, nil
}

// SnapshotRequest describes a snapshot of one group.
type SnapshotRequest struct {
	Group string
	// Tier is protocol.TierSummary or protocol.TierClosed for a repo:{id}
	// group, protocol.TierFull for the others.
	Tier string
	// Recent is the recency cutoff: the summary tier's (open or updated
	// since) and, in user:{id} groups, the read notifications kept. The
	// zero time means no cutoff.
	Recent time.Time
	// ClosedBefore and Limit select the closed tier's page.
	ClosedBefore ClosedCursor
	Limit        int
	// Models, if not empty, restricts the snapshot to these models.
	Models []protocol.Model
	// Allows says whether the viewer may read an entity with the given unit
	// (the viewer's units in the group).
	Allows func(protocol.Unit) bool
}

// SnapshotResult says what Snapshot sent.
type SnapshotResult struct {
	// Count is the number of entities sent.
	Count int
	// Next is the closed tier's next page, nil on the last page.
	Next *ClosedCursor
}

// source is a table read by a snapshot and the conditions selecting the
// candidate rows. Candidates may be a superset: only the entities the specs
// place in the requested group are kept. Each condition is read on its own,
// so that it can use an index of its columns (an OR of conditions on
// different columns cannot: "issue_id = N OR comment_id IN (…)" was planned
// as a walk of the whole table), and the candidates are their union.
// children are tables whose rows hang off the source's rows: they are read
// per chunk of the source's rows through an index of their parent column
// (an issue's labels, assignees, project cards and pull request), instead of
// walking the whole child table filtered by a subquery.
type source struct {
	table    string
	conds    []builder.Cond
	children []child
	// models are the models of the table's entities that the group can
	// hold, when that is not all of them (SnapshotModels).
	models []protocol.Model
}

// from is the source of table's rows matching any of conds.
func from(table string, conds ...builder.Cond) source {
	return source{table: table, conds: conds}
}

// holding restricts the models the source's own table contributes to the
// group to models.
func (s source) holding(models ...protocol.Model) source {
	s.models = models
	return s
}

// child is a table read for each chunk of a source's rows; cond selects the
// child rows of the chunk's ids; models, if set, are the only models the
// child's table contributes (see source.holding).
type child struct {
	table  string
	cond   func(ids []int64) builder.Cond
	models []protocol.Model
}

// issueChildren are the summary-tier rows that hang off an issue.
var issueChildren = []child{
	{"issue_label", func(ids []int64) builder.Cond { return builder.In("issue_id", ids) }, nil},
	{"issue_assignees", func(ids []int64) builder.Cond { return builder.In("issue_id", ids) }, nil},
	{"project_issue", func(ids []int64) builder.Cond { return builder.In("issue_id", ids) }, nil},
	{"pull_request", func(ids []int64) builder.Cond { return builder.In("issue_id", ids) }, nil},
	{"pull_auto_merge", func(ids []int64) builder.Cond {
		return builder.In("pull_id", sel("pull_request", builder.In("issue_id", ids)))
	}, nil},
	// The verdicts of the pull requests (their Reviews are in the issues' groups).
	{"review", func(ids []int64) builder.Cond {
		return builder.In("issue_id", ids).And(builder.In("`type`", issues_model.ReviewTypeApprove, issues_model.ReviewTypeReject))
	}, []protocol.Model{protocol.ModelReviewVerdict}},
}

// issues is the source of the issues matching cond, with their children.
func issues(cond builder.Cond) source {
	return source{table: "issue", conds: []builder.Cond{cond}, children: issueChildren}
}

// tables returns the source's table and its children's.
func (s *source) tables() []string {
	res := []string{s.table}
	for _, c := range s.children {
		res = append(res, c.table)
	}
	return res
}

// sel is the subquery selecting the ids of table's rows matching cond.
func sel(table string, cond builder.Cond) *builder.Builder {
	return builder.Select("id").From("`" + table + "`").Where(cond)
}

// snapshotSources returns the tables a snapshot of the group reads, in the
// order they are sent (structure first), with their candidate conditions.
// page is the closed tier's page of issue ids.
func snapshotSources(req *SnapshotRequest, page []int64) ([]source, error) {
	prefix, id, ok := protocol.ParseGroup(req.Group)
	if !ok {
		return nil, fmt.Errorf("livesync: not a client group: %q", req.Group)
	}
	// recently bounds the rows updated since the recency cutoff (no bound
	// without one).
	recently := func(col string) builder.Cond {
		if req.Recent.IsZero() {
			return builder.Expr("1=1")
		}
		return builder.Gte{col: req.Recent.Unix()}
	}
	switch prefix {
	case protocol.GroupPrefixRepo:
		if req.Tier == protocol.TierClosed {
			return []source{issues(builder.In("id", page))}, nil
		}
		repo := builder.Eq{"repo_id": id}
		return []source{
			from("repository", builder.Eq{"id": id}),
			from("repo_unit", repo),
			from("collaboration", repo),
			from("label", repo),
			from("milestone", repo),
			from("project", repo).holding(protocol.ModelProject),
			from("project_board", builder.In("project_id", sel("project", repo))),
			from("branch", repo),
			from("release", builder.Eq{"repo_id": id, "is_draft": false}),
			from("attachment", builder.In("release_id", sel("release", repo))),
			issues(repo.And(builder.Or(builder.Eq{"is_closed": false}, recently("updated_unix")))),
			from("commit_status", repo.And(recently("updated_unix"))),
			from("action_run", repo.And(recently("updated"))),
			from("action_run_job", repo.And(recently("updated"))),
		}, nil
	case protocol.GroupPrefixIssue:
		issue := builder.Eq{"issue_id": id}
		// Rows that hang off a comment are placed by the comment, whatever
		// their own issue_id says.
		onComments := builder.In("comment_id", sel("comment", issue))
		return []source{
			from("issue", builder.Eq{"id": id}),
			from("comment", issue),
			from("review", issue).holding(protocol.ModelReview),
			from("reaction", issue, onComments),
			from("attachment", issue, onComments),
			from("issue_content_history", issue, onComments),
		}, nil
	case protocol.GroupPrefixUser:
		user := builder.Eq{"user_id": id}
		pending := builder.Eq{"reviewer_id": id, "`type`": issues_model.ReviewTypePending}
		pendingComments := builder.In("review_id", sel("review", pending))
		onPendingComments := builder.In("comment_id", sel("comment", pendingComments))
		return []source{
			from("access", user),
			from("notification", user.And(builder.Neq{"status": activities_model.NotificationStatusRead}), user.And(recently("updated_unix"))),
			from("stopwatch", user),
			from("issue_watch", user),
			from("watch", user),
			from("star", builder.Eq{"uid": id}),
			from("forgejo_blocked_user", user),
			from("review_state", user),
			from("tracked_time", user.And(builder.Eq{"deleted": false})),
			from("review", pending).holding(protocol.ModelReview),
			from("comment", pendingComments),
			from("reaction", onPendingComments),
			from("attachment", onPendingComments),
			from("issue_content_history", onPendingComments),
		}, nil
	case protocol.GroupPrefixProfile:
		projects := builder.Eq{"owner_id": id, "repo_id": 0}
		return []source{
			from("user", builder.Eq{"id": id}),
			from("project", projects).holding(protocol.ModelProject),
			from("project_board", builder.In("project_id", sel("project", projects))),
		}, nil
	case protocol.GroupPrefixOwner:
		// The ProjectRefs of the owner's projects (their Projects are in
		// org:{id} / profile:{id}).
		return []source{
			from("label", builder.Eq{"org_id": id}),
			from("project", builder.Eq{"owner_id": id, "repo_id": 0}).holding(protocol.ModelProjectRef),
		}, nil
	case protocol.GroupPrefixProfiles:
		vis := structs.VisibleTypePublic
		if req.Group == protocol.GroupProfilesLimited {
			vis = structs.VisibleTypeLimited
		}
		return []source{
			from("user", builder.Neq{"`type`": user_model.UserTypeOrganization}.And(builder.Eq{"visibility": vis})),
		}, nil
	case protocol.GroupPrefixOrg:
		org := builder.Eq{"org_id": id}
		projects := builder.Eq{"owner_id": id, "repo_id": 0}
		return []source{
			from("user", builder.Eq{"id": id}),
			from("org_user", org),
			from("team", org),
			from("team_unit", org),
			from("project", projects).holding(protocol.ModelProject),
			from("project_board", builder.In("project_id", sel("project", projects))),
		}, nil
	case protocol.GroupPrefixTeam:
		team := builder.Eq{"team_id": id}
		return []source{
			from("team_user", team),
			from("team_repo", team),
		}, nil
	}
	return nil, fmt.Errorf("livesync: not a client group: %q", req.Group)
}

// wantedTable reports whether table produces any of models (all when
// models is empty).
func wantedTable(table string, models []protocol.Model) bool {
	if len(models) == 0 {
		return true
	}
	for _, m := range specs[table].models {
		if slices.Contains(models, m) {
			return true
		}
	}
	return false
}

// SnapshotTables returns the tables a snapshot reads (its sources, and the
// user table for the profiles it refers to): their entity index backfill
// must be done before it is taken (BackfillPending).
func SnapshotTables(req SnapshotRequest) ([]string, error) {
	sources, err := snapshotSources(&req, nil)
	if err != nil {
		return nil, err
	}
	res := []string{"user"}
	for _, s := range sources {
		for _, table := range s.tables() {
			if wantedTable(table, req.Models) && !slices.Contains(res, table) {
				res = append(res, table)
			}
		}
	}
	return res, nil
}

// SnapshotModels returns the models a snapshot may contain.
func SnapshotModels(req SnapshotRequest) ([]protocol.Model, error) {
	sources, err := snapshotSources(&req, nil)
	if err != nil {
		return nil, err
	}
	var res []protocol.Model
	add := func(m protocol.Model) {
		if (len(req.Models) == 0 || slices.Contains(req.Models, m)) && !slices.Contains(res, m) {
			res = append(res, m)
		}
	}
	for _, s := range sources {
		for i, table := range s.tables() {
			models := specs[table].models
			if i == 0 && s.models != nil {
				models = s.models
			} else if i > 0 && s.children[i-1].models != nil {
				models = s.children[i-1].models
			}
			for _, m := range models {
				add(m)
			}
		}
	}
	if prefix, _, _ := protocol.ParseGroup(req.Group); prefix == protocol.GroupPrefixIssue {
		for _, m := range conditionalModels {
			add(m)
		}
	}
	return res, nil
}

// BackfillPending returns the tables among tables whose entity index
// backfill or repair walk is not done: a snapshot reading them must wait
// (see the entity index backfill in backfill.go). A permission walk
// ("perm:<id>") does not make them wait: it runs only on a table whose
// index was complete (HandleEpochs) and writes nothing but the index rows'
// permission states, which snapshots do not read (their presence, group,
// unit and hash stay).
func BackfillPending(ctx context.Context, tables []string) ([]string, error) {
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return nil, err
	}
	var metas []livesync_model.Meta
	if err := e.Where("name LIKE ?", MetaBackfillPrefix+"%").Find(&metas); err != nil {
		return nil, fmt.Errorf("livesync: read the backfill progress: %w", err)
	}
	done := map[string]bool{}
	for _, m := range metas {
		done[m.Name[len(MetaBackfillPrefix):]] = m.Value == backfillDoneValue || strings.HasPrefix(m.Value, backfillPermPrefix)
	}
	var res []string
	for _, t := range tables {
		if !done[t] {
			res = append(res, t)
		}
	}
	return res, nil
}

// snapshotChunk is the number of rows read per snapshot transaction; tables
// with markdown bodies use smaller chunks to bound memory.
func snapshotChunk(table string) int {
	switch table {
	case "comment", "review", "release":
		return 100
	}
	return inChunk
}

// MaxClosedPage bounds the closed tier's page size (SnapshotRequest.Limit).
const MaxClosedPage = 2000

// Snapshot reads the group's current entities that req.Allows and passes
// them to emit, chunk by chunk (emit is called outside any transaction). See
// the consistency notes above; the caller reads the watermark first and
// checks the backfill gate.
//
// The candidate rows of each source are read first, through the indexes of
// their conditions and without ORDER BY id … LIMIT: keyset paging ("cond AND
// id > last ORDER BY id LIMIT n") makes PostgreSQL walk the primary key and
// filter every row of the table whenever the matches are not dense in id
// order (B6 review: 0.5 s per chunk of a repository's summary in a table of
// 3M issues). The ids (8 bytes each) are then chunked in Go. Reading them
// before the chunks is as consistent as reading them per chunk: a row that
// enters the candidates later changed after the watermark was read, so it
// reaches the client as a delta.
func Snapshot(ctx context.Context, req SnapshotRequest, emit func([]SnapshotEntity) error) (SnapshotResult, error) {
	var res SnapshotResult
	var page []int64
	if req.Tier == protocol.TierClosed {
		var err error
		if page, res.Next, err = closedPage(ctx, req); errors.Is(err, errNoClosedTier) {
			return res, nil
		} else if err != nil {
			return res, err
		}
		if len(page) == 0 {
			return res, nil
		}
	}
	sources, err := snapshotSources(&req, page)
	if err != nil {
		return res, err
	}
	keep := func(e *entity) bool {
		return e.group == req.Group && (len(req.Models) == 0 || slices.Contains(req.Models, e.model)) && req.Allows(e.unit)
	}
	// The git repositories opened for rendering markdown are kept for the
	// whole snapshot (an issue with 1000 comments is 10 chunks); the parent
	// rows are cached per chunk, since each chunk is its own transaction.
	gitRepos := map[int64]*git.Repository{}
	defer closeGitRepos(gitRepos)
	for _, src := range sources {
		if !slices.ContainsFunc(src.tables(), func(t string) bool { return wantedTable(t, req.Models) }) {
			continue
		}
		ids, err := candidates(ctx, &src)
		if err != nil {
			return res, fmt.Errorf("livesync: snapshot of %s: %s rows: %w", req.Group, src.table, err)
		}
		n := snapshotChunk(src.table)
		for start := 0; start < len(ids); start += n {
			if err := ctx.Err(); err != nil {
				return res, err
			}
			chunk := ids[start:min(start+n, len(ids))]
			var batch []SnapshotEntity
			err := capture.WithQuietTx(ctx, func(ctx context.Context) error {
				// One loader for the chunk and its children: the issues an
				// issue's labels, assignees and project cards are placed by
				// are the chunk's, read once.
				l := newLoader()
				l.gitRepos = gitRepos
				var err error
				if wantedTable(src.table, req.Models) {
					if batch, err = snapshotRows(ctx, l, src.table, chunk, keep); err != nil {
						return err
					}
				}
				for _, c := range src.children {
					if !wantedTable(c.table, req.Models) {
						continue
					}
					var childIDs []int64
					if err := db.GetEngine(ctx).Table(c.table).Cols("id").Where(c.cond(chunk)).Find(&childIDs); err != nil {
						return fmt.Errorf("livesync: snapshot of %s: %s rows: %w", req.Group, c.table, err)
					}
					if len(childIDs) == 0 {
						continue
					}
					slices.Sort(childIDs)
					more, err := snapshotRows(ctx, l, c.table, childIDs, keep)
					if err != nil {
						return err
					}
					batch = append(batch, more...)
				}
				return nil
			})
			if err != nil {
				return res, err
			}
			if len(batch) > 0 {
				res.Count += len(batch)
				if err := emit(batch); err != nil {
					return res, err
				}
			}
		}
	}
	return res, nil
}

// candidates returns the ids of the rows matching any of the source's
// conditions, sorted and without duplicates, read in one transaction.
func candidates(ctx context.Context, src *source) ([]int64, error) {
	var res []int64
	err := capture.WithQuietTx(ctx, func(ctx context.Context) error {
		for _, cond := range src.conds {
			var ids []int64
			if err := db.GetEngine(ctx).Table(src.table).Cols("id").Where(cond).Find(&ids); err != nil {
				return err
			}
			res = append(res, ids...)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	slices.Sort(res)
	return slices.Compact(res), nil
}

// errNoClosedTier: the viewer may read neither issues nor pull requests.
var errNoClosedTier = errors.New("no closed tier")

// closedPage returns the ids of the closed tier's page (newest first) and
// the cursor of the next page. Only the issues, or only the pull requests,
// when the viewer may read only those: the page and its cursor are built
// from rows the viewer may read (a cursor taken from a pull request would
// tell an issues-only reader that it exists and when it was updated).
func closedPage(ctx context.Context, req SnapshotRequest) ([]int64, *ClosedCursor, error) {
	prefix, repoID, ok := protocol.ParseGroup(req.Group)
	if !ok || prefix != protocol.GroupPrefixRepo {
		return nil, nil, fmt.Errorf("livesync: the closed tier needs a repo group, not %q", req.Group)
	}
	limit := min(max(req.Limit, 1), MaxClosedPage)
	c := req.ClosedBefore
	cond := builder.Eq{"repo_id": repoID, "is_closed": true}.And(builder.Or(
		builder.Lt{"updated_unix": c.Updated},
		builder.Eq{"updated_unix": c.Updated}.And(builder.Lt{"id": c.ID}),
	))
	switch issues, pulls := req.Allows(protocol.UnitIssues), req.Allows(protocol.UnitPulls); {
	case !issues && !pulls:
		return nil, nil, errNoClosedTier
	case !pulls:
		cond = cond.And(builder.Eq{"is_pull": false})
	case !issues:
		cond = cond.And(builder.Eq{"is_pull": true})
	}
	var rows []struct {
		ID          int64 `xorm:"id"`
		UpdatedUnix int64 `xorm:"updated_unix"`
	}
	err := capture.WithQuietTx(ctx, func(ctx context.Context) error {
		return db.GetEngine(ctx).Table("issue").Cols("id", "updated_unix").Where(cond).
			OrderBy("updated_unix DESC, id DESC").Limit(limit + 1).Find(&rows)
	})
	if err != nil {
		return nil, nil, fmt.Errorf("livesync: closed issues of %s: %w", req.Group, err)
	}
	var next *ClosedCursor
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[limit-1]
		next = &ClosedCursor{Updated: last.UpdatedUnix, ID: last.ID}
	}
	ids := make([]int64, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.ID)
	}
	return ids, next, nil
}

// snapshotRows loads the rows ids of table with l and returns the entities
// keep accepts that the entity index knows, with their payloads. It runs in
// a read transaction on the master.
func snapshotRows(ctx context.Context, l *loader, table string, ids []int64, keep func(*entity) bool) ([]SnapshotEntity, error) {
	loaded, err := specs[table].load(ctx, l, ids, true)
	if err != nil {
		return nil, fmt.Errorf("livesync: snapshot: load %s rows: %w", table, err)
	}
	type candidate struct {
		id int64
		e  *entity
	}
	var cands []candidate
	byKey := map[string][]int64{}
	for _, id := range ids {
		ents := loaded[id]
		for i := range ents {
			if e := &ents[i]; e.group != "" && keep(e) {
				cands = append(cands, candidate{id, e})
				byKey[e.key] = append(byKey[e.key], id)
			}
		}
	}
	if len(cands) == 0 {
		return nil, nil
	}
	index := map[indexKey]*livesync_model.Entity{}
	for key, kids := range byKey {
		rows, err := loadIndex(ctx, key, kids)
		if err != nil {
			return nil, err
		}
		for id, r := range rows {
			index[indexKey{key, id}] = r
		}
	}

	// Markdown is not rendered again when the index says the entity is
	// unchanged since its last entry, which is still in the log: that
	// entry's payload is exactly what rendering would produce.
	kept := cands[:0]
	reuse := map[int64]int{} // sync id of the last entry → position in kept
	for _, c := range cands {
		r := index[indexKey{c.e.key, c.id}]
		if r == nil {
			continue // not materialized (yet): see the consistency notes
		}
		hash, err := "", c.e.err
		if err == nil {
			hash, err = c.e.changeHash(ctx, l)
		}
		if err != nil {
			log.Warn("livesync: snapshot: skipping %s %d: %v", c.e.model, c.id, err)
			continue
		}
		if len(c.e.renders) > 0 && r.Hash == hash && r.LastSyncID > 0 {
			reuse[r.LastSyncID] = len(kept)
		}
		kept = append(kept, c)
	}
	payloads := make([]string, len(kept))
	if len(reuse) > 0 {
		e, err := livesync_model.MasterEngine(ctx)
		if err != nil {
			return nil, err
		}
		syncIDs := make([]int64, 0, len(reuse))
		for id := range reuse {
			syncIDs = append(syncIDs, id)
		}
		var entries []livesync_model.LogEntry
		if err := e.In("sync_id", syncIDs).Cols("sync_id", "model", "entity_id", "op", "payload").Find(&entries); err != nil {
			return nil, fmt.Errorf("livesync: snapshot: read the sync log: %w", err)
		}
		for _, entry := range entries {
			i := reuse[entry.SyncID]
			if c := kept[i]; entry.Model == string(c.e.model) && entry.EntityID == c.id && entry.Op == string(protocol.OpUpsert) {
				payloads[i] = entry.Payload
			}
		}
	}
	res := make([]SnapshotEntity, 0, len(kept))
	for i, c := range kept {
		payload := payloads[i]
		if payload == "" {
			if payload, err = c.e.payload(ctx, l); err != nil {
				log.Warn("livesync: snapshot: skipping %s %d: %v", c.e.model, c.id, err)
				continue
			}
		}
		res = append(res, SnapshotEntity{Group: c.e.group, Model: c.e.model, ID: c.id, Payload: payload, UserRefs: userRefs(c.e.dto)})
	}
	return res, nil
}

// RepositoryOwner returns the owner id of repository id (0 when it does not
// exist).
func RepositoryOwner(ctx context.Context, id int64) (int64, error) {
	var owner int64
	err := capture.WithQuietTx(ctx, func(ctx context.Context) error {
		_, err := db.GetEngine(ctx).Table("repository").Cols("owner_id").Where(builder.Eq{"id": id}).Get(&owner)
		return err
	})
	if err != nil {
		return 0, fmt.Errorf("livesync: owner of repository %d: %w", id, err)
	}
	return owner, nil
}

// ProfileGroups returns the group of the User entity (profile) of each of
// the users that exist.
func ProfileGroups(ctx context.Context, ids []int64) (map[int64]string, error) {
	res := make(map[int64]string, len(ids))
	for start := 0; start < len(ids); start += inChunk {
		chunk := ids[start:min(start+inChunk, len(ids))]
		err := capture.WithQuietTx(ctx, func(ctx context.Context) error {
			users, err := findByIDs(ctx, chunk, func(u *user_model.User) int64 { return u.ID })
			if err != nil {
				return err
			}
			for id, u := range users {
				res[id], _ = userPlace(u)
			}
			return nil
		})
		if err != nil {
			return nil, fmt.Errorf("livesync: profile groups: %w", err)
		}
	}
	return res, nil
}

// Profiles returns the User entities of users as a snapshot of their groups
// would send them (only those the entity index knows).
func Profiles(ctx context.Context, ids []int64) ([]SnapshotEntity, error) {
	var res []SnapshotEntity
	for start := 0; start < len(ids); start += inChunk {
		chunk := ids[start:min(start+inChunk, len(ids))]
		err := capture.WithQuietTx(ctx, func(ctx context.Context) error {
			l := newLoader()
			defer l.close()
			batch, err := snapshotRows(ctx, l, "user", chunk, func(*entity) bool { return true })
			res = append(res, batch...)
			return err
		})
		if err != nil {
			return nil, err
		}
	}
	return res, nil
}

// Conditional is an entity of an issue's load that is in no group,
// because who may read it depends on a second repository: a load sends it
// to the viewers who may read the issue's Unit (as for the issue's other
// entities) and RepoID's RepoUnit (bootstrap.Stream). Its group is the
// issue's. It is not in the sync log: no delta changes it, the next load of
// the issue refreshes it.
type Conditional struct {
	SnapshotEntity
	Unit     protocol.Unit
	RepoID   int64
	RepoUnit protocol.Unit
}

// maxConditionals bounds the cross-references and the dependencies of one
// issue a load sends.
const maxConditionals = 1000

// Conditionals returns the issue's conditional entities among models (all
// when models is empty), as the materializer would build them:
//
//   - the comments that refer to the issue from other repositories
//     (Comment). They are in no group (commentPlace): upstream shows such a
//     comment only to viewers who can read the issues or pulls of the
//     referencing repository too (filterXRefComments), which one group and
//     unit cannot express. Their attachments and reactions, if any, are not
//     included.
//   - the issue's dependencies (IssueDependency: the issues blocking it),
//     when the issue's repository has dependencies enabled. API v1 (GET
//     …/issues/{n}/dependencies) lists a dependency only to viewers who can
//     read the dependency's issues or pulls, and nothing when dependencies
//     are disabled (B6 review): no group either (issueDependencySpec).
func Conditionals(ctx context.Context, issueID int64, models []protocol.Model) ([]Conditional, error) {
	want := func(m protocol.Model) bool { return len(models) == 0 || slices.Contains(models, m) }
	var res []Conditional
	err := capture.WithQuietTx(ctx, func(ctx context.Context) error {
		l := newLoader()
		defer l.close()
		if err := issueRepos(ctx, l, []int64{issueID}); err != nil {
			return err
		}
		issue := l.issues[issueID]
		if issue == nil {
			return nil
		}
		group, unit := l.issuePlace(issueID)
		add := func(e *entity, id, repoID int64, need protocol.Unit) error {
			if _, err := e.changeHash(ctx, l); err != nil {
				return err
			}
			payload, err := e.payload(ctx, l)
			if err != nil {
				return err
			}
			res = append(res, Conditional{
				SnapshotEntity: SnapshotEntity{Group: e.group, Model: e.model, ID: id, Payload: payload, UserRefs: userRefs(e.dto)},
				Unit:           e.unit, RepoID: repoID, RepoUnit: need,
			})
			return nil
		}

		if want(protocol.ModelComment) {
			// Read through the issue_id index, not paged by id (see
			// Snapshot), then bounded.
			var comments []*issues_model.Comment
			cond := builder.Eq{"issue_id": issueID}.
				And(builder.In("`type`", issues_model.CommentTypeIssueRef, issues_model.CommentTypeCommentRef, issues_model.CommentTypePullRef)).
				And(builder.Neq{"ref_repo_id": 0}).And(builder.Neq{"ref_repo_id": issue.RepoID})
			if err := db.GetEngine(ctx).Where(cond).Find(&comments); err != nil {
				return err
			}
			slices.SortFunc(comments, func(a, b *issues_model.Comment) int { return cmp.Compare(a.ID, b.ID) })
			for _, c := range comments[:min(len(comments), maxConditionals)] {
				if !issues_model.CommentTypeIsRef(c.Type) {
					continue
				}
				e := entity{key: "comment", model: protocol.ModelComment, schema: protocol.SchemaComment, group: group, unit: unit, dto: commentDTO(l, c)}
				e.renders = l.takeRenders()
				need := protocol.UnitIssues
				if c.RefIsPull {
					need = protocol.UnitPulls
				}
				if err := add(&e, c.ID, c.RefRepoID, need); err != nil {
					return err
				}
			}
		}

		if want(protocol.ModelIssueDependency) && l.repos[issue.RepoID] != nil && l.repos[issue.RepoID].IsDependenciesEnabled(ctx) {
			var deps []*issues_model.IssueDependency
			if err := db.GetEngine(ctx).Where(builder.Eq{"issue_id": issueID}).Find(&deps); err != nil {
				return err
			}
			slices.SortFunc(deps, func(a, b *issues_model.IssueDependency) int { return cmp.Compare(a.ID, b.ID) })
			deps = deps[:min(len(deps), maxConditionals)]
			if err := l.loadIssues(ctx, ids(deps, func(d *issues_model.IssueDependency) int64 { return d.DependencyID })); err != nil {
				return err
			}
			for _, d := range deps {
				dep := l.issues[d.DependencyID]
				if dep == nil {
					continue // upstream skips a dependency on a missing issue
				}
				e := entity{key: "issue_dependency", model: protocol.ModelIssueDependency, schema: protocol.SchemaIssueDependency, group: group, unit: unit, dto: issueDependencyDTO(d)}
				if err := add(&e, d.ID, dep.RepoID, issueUnit(dep)); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("livesync: conditional entities of issue %d: %w", issueID, err)
	}
	return res, nil
}

// conditionalModels are the models of Conditionals.
var conditionalModels = []protocol.Model{protocol.ModelComment, protocol.ModelIssueDependency}
