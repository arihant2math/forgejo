// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"context"
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

// source is a table read by a snapshot and the condition selecting the
// candidate rows. Candidates may be a superset: only the entities the specs
// place in the requested group are kept. children are tables whose rows
// hang off the source's rows: they are read per chunk of the source's rows
// through an index of their parent column (an issue's labels, assignees,
// project cards and pull request), instead of walking the whole child table
// filtered by a subquery.
type source struct {
	table    string
	cond     builder.Cond
	children []child
}

// child is a table read for each chunk of a source's rows; cond selects the
// child rows of the chunk's ids.
type child struct {
	table string
	cond  func(ids []int64) builder.Cond
}

// issueChildren are the summary-tier rows that hang off an issue.
var issueChildren = []child{
	{"issue_label", func(ids []int64) builder.Cond { return builder.In("issue_id", ids) }},
	{"issue_assignees", func(ids []int64) builder.Cond { return builder.In("issue_id", ids) }},
	{"project_issue", func(ids []int64) builder.Cond { return builder.In("issue_id", ids) }},
	{"pull_request", func(ids []int64) builder.Cond { return builder.In("issue_id", ids) }},
	{"pull_auto_merge", func(ids []int64) builder.Cond {
		return builder.In("pull_id", sel("pull_request", builder.In("issue_id", ids)))
	}},
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
			return []source{{table: "issue", cond: builder.In("id", page), children: issueChildren}}, nil
		}
		repo := builder.Eq{"repo_id": id}
		issues := builder.Eq{"repo_id": id}.And(builder.Or(builder.Eq{"is_closed": false}, recently("updated_unix")))
		return []source{
			{table: "repository", cond: builder.Eq{"id": id}},
			{table: "repo_unit", cond: repo},
			{table: "collaboration", cond: repo},
			{table: "label", cond: repo},
			{table: "milestone", cond: repo},
			{table: "project", cond: repo},
			{table: "project_board", cond: builder.In("project_id", sel("project", repo))},
			{table: "branch", cond: repo},
			{table: "release", cond: builder.Eq{"repo_id": id, "is_draft": false}},
			{table: "attachment", cond: builder.In("release_id", sel("release", repo))},
			{table: "issue", cond: issues, children: issueChildren},
			{table: "commit_status", cond: repo.And(recently("updated_unix"))},
			{table: "action_run", cond: repo.And(recently("updated"))},
			{table: "action_run_job", cond: repo.And(recently("updated"))},
		}, nil
	case protocol.GroupPrefixIssue:
		issue := builder.Eq{"issue_id": id}
		// Rows that hang off a comment are placed by the comment, whatever
		// their own issue_id says.
		issueOrComment := builder.Or(issue, builder.In("comment_id", sel("comment", issue)))
		return []source{
			{table: "issue", cond: builder.Eq{"id": id}},
			{table: "comment", cond: issue},
			{table: "review", cond: issue},
			{table: "reaction", cond: issueOrComment},
			{table: "attachment", cond: issueOrComment},
			{table: "issue_dependency", cond: issue},
			{table: "tracked_time", cond: issue},
			{table: "issue_content_history", cond: issueOrComment},
		}, nil
	case protocol.GroupPrefixUser:
		user := builder.Eq{"user_id": id}
		pending := builder.Eq{"reviewer_id": id, "`type`": issues_model.ReviewTypePending}
		pendingComments := builder.In("review_id", sel("review", pending))
		onPendingComments := builder.In("comment_id", sel("comment", pendingComments))
		return []source{
			{table: "access", cond: user},
			{table: "notification", cond: user.And(builder.Or(builder.Neq{"status": activities_model.NotificationStatusRead}, recently("updated_unix")))},
			{table: "stopwatch", cond: user},
			{table: "issue_watch", cond: user},
			{table: "watch", cond: user},
			{table: "star", cond: builder.Eq{"uid": id}},
			{table: "forgejo_blocked_user", cond: user},
			{table: "review_state", cond: user},
			{table: "review", cond: pending},
			{table: "comment", cond: pendingComments},
			{table: "reaction", cond: onPendingComments},
			{table: "attachment", cond: onPendingComments},
			{table: "issue_content_history", cond: onPendingComments},
		}, nil
	case protocol.GroupPrefixProfile:
		projects := builder.Eq{"owner_id": id, "repo_id": 0}
		return []source{
			{table: "user", cond: builder.Eq{"id": id}},
			{table: "project", cond: projects},
			{table: "project_board", cond: builder.In("project_id", sel("project", projects))},
		}, nil
	case protocol.GroupPrefixProfiles:
		vis := structs.VisibleTypePublic
		if req.Group == protocol.GroupProfilesLimited {
			vis = structs.VisibleTypeLimited
		}
		return []source{
			{table: "user", cond: builder.Neq{"`type`": user_model.UserTypeOrganization}.And(builder.Eq{"visibility": vis})},
		}, nil
	case protocol.GroupPrefixOrg:
		org := builder.Eq{"org_id": id}
		projects := builder.Eq{"owner_id": id, "repo_id": 0}
		return []source{
			{table: "user", cond: builder.Eq{"id": id}},
			{table: "org_user", cond: org},
			{table: "team", cond: org},
			{table: "team_user", cond: org},
			{table: "team_repo", cond: org},
			{table: "team_unit", cond: org},
			{table: "label", cond: org},
			{table: "project", cond: projects},
			{table: "project_board", cond: builder.In("project_id", sel("project", projects))},
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
	for _, s := range sources {
		for _, table := range s.tables() {
			for _, m := range specs[table].models {
				if (len(req.Models) == 0 || slices.Contains(req.Models, m)) && !slices.Contains(res, m) {
					res = append(res, m)
				}
			}
		}
	}
	return res, nil
}

// BackfillPending returns the tables among tables whose entity index
// backfill (or repair / permission walk) is not done: a snapshot reading
// them must wait (see the entity index backfill in backfill.go).
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
		done[m.Name[len(MetaBackfillPrefix):]] = m.Value == backfillDoneValue
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

// maxClosedPage bounds the closed tier's page size.
const maxClosedPage = 2000

// Snapshot reads the group's current entities that req.Allows and passes
// them to emit, chunk by chunk (emit is called outside any transaction). See
// the consistency notes above; the caller reads the watermark first and
// checks the backfill gate.
func Snapshot(ctx context.Context, req SnapshotRequest, emit func([]SnapshotEntity) error) (SnapshotResult, error) {
	var res SnapshotResult
	var page []int64
	if req.Tier == protocol.TierClosed {
		var err error
		if page, res.Next, err = closedPage(ctx, req); err != nil {
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
	for _, src := range sources {
		if !slices.ContainsFunc(src.tables(), func(t string) bool { return wantedTable(t, req.Models) }) {
			continue
		}
		n := snapshotChunk(src.table)
		var last int64
		for {
			if err := ctx.Err(); err != nil {
				return res, err
			}
			var ids []int64
			var batch []SnapshotEntity
			err := capture.WithQuietTx(ctx, func(ctx context.Context) error {
				if err := db.GetEngine(ctx).Table(src.table).Cols("id").Where(src.cond.And(builder.Gt{"id": last})).
					OrderBy("id").Limit(n).Find(&ids); err != nil {
					return fmt.Errorf("livesync: snapshot of %s: %s rows: %w", req.Group, src.table, err)
				}
				if len(ids) == 0 {
					return nil
				}
				var err error
				if wantedTable(src.table, req.Models) {
					if batch, err = snapshotRows(ctx, src.table, ids, keep); err != nil {
						return err
					}
				}
				for _, c := range src.children {
					if !wantedTable(c.table, req.Models) {
						continue
					}
					var childIDs []int64
					if err := db.GetEngine(ctx).Table(c.table).Cols("id").Where(c.cond(ids)).OrderBy("id").Find(&childIDs); err != nil {
						return fmt.Errorf("livesync: snapshot of %s: %s rows: %w", req.Group, c.table, err)
					}
					if len(childIDs) == 0 {
						continue
					}
					more, err := snapshotRows(ctx, c.table, childIDs, keep)
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
			if len(ids) < n {
				break
			}
			last = ids[len(ids)-1]
		}
	}
	return res, nil
}

// closedPage returns the ids of the closed tier's page (newest first) and
// the cursor of the next page.
func closedPage(ctx context.Context, req SnapshotRequest) ([]int64, *ClosedCursor, error) {
	prefix, repoID, ok := protocol.ParseGroup(req.Group)
	if !ok || prefix != protocol.GroupPrefixRepo {
		return nil, nil, fmt.Errorf("livesync: the closed tier needs a repo group, not %q", req.Group)
	}
	limit := min(max(req.Limit, 1), maxClosedPage)
	c := req.ClosedBefore
	cond := builder.Eq{"repo_id": repoID, "is_closed": true}.And(builder.Or(
		builder.Lt{"updated_unix": c.Updated},
		builder.Eq{"updated_unix": c.Updated}.And(builder.Lt{"id": c.ID}),
	))
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

// snapshotRows loads the rows ids of table and returns the entities keep
// accepts that the entity index knows, with their payloads. It runs in a
// read transaction on the master.
func snapshotRows(ctx context.Context, table string, ids []int64, keep func(*entity) bool) ([]SnapshotEntity, error) {
	l := newLoader()
	defer l.close()
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
			batch, err := snapshotRows(ctx, "user", chunk, func(*entity) bool { return true })
			res = append(res, batch...)
			return err
		})
		if err != nil {
			return nil, err
		}
	}
	return res, nil
}

// CrossReference is a comment of an issue that refers to it from another
// repository (an issue, pull request or comment of repository RefRepoID
// mentioned the issue).
type CrossReference struct {
	SnapshotEntity
	RefRepoID int64
	RefIsPull bool
}

// maxCrossReferences bounds the cross-references of one issue a load
// sends.
const maxCrossReferences = 1000

// CrossReferences returns the comments of issue that refer to it from
// other repositories, in the issue's group, as the materializer would
// build them. They are in no group (commentPlace: upstream shows such a
// comment only to viewers who can read the issues or pulls of the
// referencing repository too, which one group and unit cannot express), so
// they are not in the sync log: an issue's load adds the ones its viewer
// may see (bootstrap.Stream). Their attachments and reactions, if any, are
// not included.
func CrossReferences(ctx context.Context, issueID int64) ([]CrossReference, error) {
	var res []CrossReference
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
		var comments []*issues_model.Comment
		cond := builder.Eq{"issue_id": issueID}.
			And(builder.In("`type`", issues_model.CommentTypeIssueRef, issues_model.CommentTypeCommentRef, issues_model.CommentTypePullRef)).
			And(builder.Neq{"ref_repo_id": 0}).And(builder.Neq{"ref_repo_id": issue.RepoID})
		if err := db.GetEngine(ctx).Where(cond).OrderBy("id").Limit(maxCrossReferences).Find(&comments); err != nil {
			return err
		}
		group, unit := l.issuePlace(issueID)
		for _, c := range comments {
			if !issues_model.CommentTypeIsRef(c.Type) {
				continue
			}
			e := entity{key: "comment", model: protocol.ModelComment, schema: protocol.SchemaComment, group: group, unit: unit, dto: commentDTO(l, c)}
			e.renders = l.takeRenders()
			if _, err := e.changeHash(ctx, l); err != nil {
				return err
			}
			payload, err := e.payload(ctx, l)
			if err != nil {
				return err
			}
			res = append(res, CrossReference{
				SnapshotEntity: SnapshotEntity{Group: group, Model: protocol.ModelComment, ID: c.ID, Payload: payload, UserRefs: userRefs(e.dto)},
				RefRepoID:      c.RefRepoID, RefIsPull: c.RefIsPull,
			})
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("livesync: cross-references of issue %d: %w", issueID, err)
	}
	return res, nil
}
