// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Package bootstrap serves livesync's bootstraps and partial loads (PLAN
// §4.7, B6): the NDJSON snapshot of one sync group at a watermark
// (protocol.BootstrapHeader, the entities as protocol.Change lines,
// protocol.BootstrapEnd), and the workspace listing. The snapshot itself
// (which rows, placement, payloads, consistency with the sync log) is
// materialize.Snapshot; this package adds the watermark, the viewer's
// units, the profiles the entities refer to, and the line format.
// routers/livesync does the HTTP part (authentication, permission check,
// parameters, compression).
package bootstrap

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"maps"
	"slices"
	"strconv"
	"time"

	"forgejo.org/modules/json"
	"forgejo.org/services/livesync/materialize"
	"forgejo.org/services/livesync/perm"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/services/livesync/synclog"
)

// Request is a bootstrap or load request whose group the viewer may read
// (the caller checked it: Units are the viewer's units in the group).
type Request struct {
	Group    string
	ViewerID int64
	Units    perm.UnitSet
	// Tier is protocol.TierSummary or protocol.TierClosed for repo:{id}
	// groups, protocol.TierFull for the others.
	Tier string
	// Recent is the recency cutoff of the summary tier ([livesync]
	// SUMMARY_RECENCY ago), also applied to read notifications.
	Recent time.Time
	// ClosedBefore and Limit select a closed tier page.
	ClosedBefore materialize.ClosedCursor
	Limit        int
	// Models, if not empty, restricts the response to these models.
	Models []protocol.Model
}

func (r *Request) snapshot() materialize.SnapshotRequest {
	return materialize.SnapshotRequest{
		Group: r.Group, Tier: r.Tier, Recent: r.Recent, ClosedBefore: r.ClosedBefore, Limit: r.Limit,
		Models: r.Models, Allows: r.Units.Allows,
	}
}

// Prepared is a request whose watermark was read and whose tables are all
// indexed: ready to Stream.
type Prepared struct {
	req       Request
	watermark int64
	logID     string
}

// betweenReads, when set (tests only), runs in Prepare between the
// watermark read and the gate read.
var betweenReads func(ctx context.Context)

// Prepare reads the watermark (the sync log head) and then checks B3's
// bootstrap gate: it returns the tables the request reads whose entity
// index backfill is not done, and no Prepared, when the bootstrap must not
// be served yet (the client retries later).
//
// The order matters: a re-bootstrap marker and the restart of its table's
// index walk ("repair:0") are written in one transaction, so either the
// marker is above the watermark (the client gets bootstrap_required after
// this bootstrap and loads again) or the gate, read after the watermark,
// sees the walk and refuses.
func Prepare(ctx context.Context, req Request) (*Prepared, []string, error) {
	watermark, err := synclog.Head(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("livesync: bootstrap: read the sync log head: %w", err)
	}
	logID, err := synclog.LogID(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("livesync: bootstrap: read the sync log id: %w", err)
	}
	if betweenReads != nil {
		betweenReads(ctx)
	}
	tables, err := materialize.SnapshotTables(req.snapshot())
	if err != nil {
		return nil, nil, err
	}
	pending, err := materialize.BackfillPending(ctx, tables)
	if err != nil || len(pending) > 0 {
		return nil, pending, err
	}
	return &Prepared{req: req, watermark: watermark, logID: logID}, nil, nil
}

// Stream writes the response to w: the header line, the group's entities,
// the profiles they refer to that live in per-user groups, and the end
// line. flush is called after the header and after every chunk, so the
// client receives the response while it is produced. An error after the
// header leaves the response without its end line (the client discards
// it). perms decides which referenced profiles the viewer may read.
func (p *Prepared) Stream(ctx context.Context, w io.Writer, flush func() error, perms *perm.Cache) error {
	// The watermark was read before the snapshot (PLAN §4.7).
	req, watermark := p.req, p.watermark
	snap := req.snapshot()
	models, err := materialize.SnapshotModels(snap)
	if err != nil {
		return err
	}
	all := materialize.Schemas()
	header := protocol.BootstrapHeader{
		Type: "header", Group: req.Group, Watermark: watermark, LogID: p.logID, Units: req.Units.Units(), Tier: req.Tier,
		Schemas: make(map[protocol.Model]int, len(models)), Models: req.Models,
	}
	for _, m := range models {
		header.Schemas[m] = all[m]
	}
	// The profiles the entities refer to may follow them.
	header.Schemas[protocol.ModelUser] = all[protocol.ModelUser]
	// The tiers' cutoffs (protocol.BootstrapHeader: what the replacement
	// leaves alone).
	switch prefix, _, _ := protocol.ParseGroup(req.Group); {
	case req.Tier == protocol.TierClosed:
		header.Before = req.ClosedBefore.String()
	case req.Tier == protocol.TierSummary, prefix == protocol.GroupPrefixUser:
		if !req.Recent.IsZero() {
			header.ClosedBefore = new(req.Recent.Unix())
		}
	}

	bw := bufio.NewWriterSize(w, 32<<10)
	flushAll := func() error {
		if err := bw.Flush(); err != nil {
			return err
		}
		return flush()
	}
	if err := writeJSONLine(bw, header); err != nil {
		return err
	}
	if err := flushAll(); err != nil {
		return err
	}

	refs := map[int64]struct{}{}
	var line []byte
	writeEntities := func(batch []materialize.SnapshotEntity) error {
		for i := range batch {
			e := &batch[i]
			line = appendChange(line[:0], watermark, e)
			if _, err := bw.Write(line); err != nil {
				return err
			}
			for _, id := range e.UserRefs {
				refs[id] = struct{}{}
			}
		}
		return flushAll()
	}
	res, err := materialize.Snapshot(ctx, snap, writeEntities)
	if err != nil {
		return err
	}
	if prefix, id, _ := protocol.ParseGroup(req.Group); prefix == protocol.GroupPrefixIssue {
		extras, err := conditionals(ctx, perms, req, id)
		if err != nil {
			return err
		}
		res.Count += len(extras)
		if err := writeEntities(extras); err != nil {
			return err
		}
	}

	end := protocol.BootstrapEnd{Type: "end", Count: res.Count, Refs: []string{}}
	if res.Next != nil {
		end.Next = res.Next.String()
	}
	owners, err := ownerRefs(ctx, req)
	if err != nil {
		return err
	}
	groups, embed, err := profileRefs(ctx, perms, req, slices.Sorted(maps.Keys(refs)), owners)
	if err != nil {
		return err
	}
	end.Refs = groups
	if len(embed) > 0 {
		profiles, err := materialize.Profiles(ctx, embed)
		if err != nil {
			return err
		}
		if err := writeEntities(profiles); err != nil {
			return err
		}
	}
	if err := writeJSONLine(bw, end); err != nil {
		return err
	}
	return flushAll()
}

// conditionals returns the conditional entities of the issue (its
// cross-references from other repositories and its dependencies,
// materialize.Conditionals) that the viewer may see: those whose second
// repository the viewer may read with the needed unit, as upstream decides
// (filterXRefComments, API v1's issue dependencies). They are not in the
// sync log, so the load is their only source.
func conditionals(ctx context.Context, perms *perm.Cache, req Request, issueID int64) ([]materialize.SnapshotEntity, error) {
	extras, err := materialize.Conditionals(ctx, issueID, req.Models)
	if err != nil || len(extras) == 0 {
		return nil, err
	}
	var groups []string
	for _, x := range extras {
		groups = append(groups, protocol.RepoGroup(x.RepoID))
	}
	readable, err := perms.CheckGroups(ctx, req.ViewerID, groups)
	if err != nil {
		return nil, err
	}
	var res []materialize.SnapshotEntity
	for _, x := range extras {
		if d, ok := readable[protocol.RepoGroup(x.RepoID)]; ok && d.Units.Allows(x.RepoUnit) && req.Units.Allows(x.Unit) {
			res = append(res, x.SnapshotEntity)
		}
	}
	return res, nil
}

// ownerRefs returns the owner:{id} group a repo:{id} response refers to:
// its issues' labels and project cards may name the owner's labels and
// projects (IssueLabel.label_id, ProjectIssue.project_id).
func ownerRefs(ctx context.Context, req Request) ([]string, error) {
	prefix, id, _ := protocol.ParseGroup(req.Group)
	if prefix != protocol.GroupPrefixRepo {
		return nil, nil
	}
	owner, err := materialize.RepositoryOwner(ctx, id)
	if err != nil || owner <= 0 {
		return nil, err
	}
	return []string{protocol.OwnerGroup(owner)}, nil
}

// profileRefs returns the groups the response refers to that the viewer
// may read (sorted, without the requested group itself): those holding the
// profiles of users, and the groups of extra. It also returns the users
// whose profiles are in per-user groups (profile:{id}, org:{id}), which the
// response embeds. The groups are decided in one batch
// (perm.Cache.CheckGroups), however many the response refers to.
func profileRefs(ctx context.Context, perms *perm.Cache, req Request, users []int64, extra []string) ([]string, []int64, error) {
	refs := []string{}
	if len(users) == 0 && len(extra) == 0 {
		return refs, nil, nil
	}
	places, err := materialize.ProfileGroups(ctx, users)
	if err != nil {
		return nil, nil, err
	}
	var groups []string
	for _, group := range places {
		if group != req.Group {
			groups = append(groups, group)
		}
	}
	for _, group := range extra {
		if group != req.Group {
			groups = append(groups, group)
		}
	}
	readable, err := perms.CheckGroups(ctx, req.ViewerID, groups)
	if err != nil {
		return nil, nil, err
	}
	var embed []int64
	for _, id := range users {
		group, ok := places[id]
		if _, r := readable[group]; !ok || !r || group == req.Group {
			continue
		}
		if group != protocol.GroupProfilesPublic && group != protocol.GroupProfilesLimited {
			embed = append(embed, id)
		}
	}
	for group := range readable {
		refs = append(refs, group)
	}
	slices.Sort(refs)
	return refs, embed, nil
}

// writeJSONLine writes v as one JSON line.
func writeJSONLine(w io.Writer, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	_, err = w.Write(b)
	return err
}

// appendChange appends e as a protocol.Change line (op U, version v) with
// its payload embedded verbatim (it is the DTO's JSON, as in the log).
func appendChange(b []byte, v int64, e *materialize.SnapshotEntity) []byte {
	b = append(b, `{"v":`...)
	b = strconv.AppendInt(b, v, 10)
	b = append(b, `,"g":`...)
	b = appendJSONString(b, e.Group)
	b = append(b, `,"m":`...)
	b = appendJSONString(b, string(e.Model))
	b = append(b, `,"id":`...)
	b = strconv.AppendInt(b, e.ID, 10)
	b = append(b, `,"op":"U","d":`...)
	b = append(b, e.Payload...)
	return append(b, "}\n"...)
}

// appendJSONString appends s as a JSON string. Group and model names are
// plain ASCII; anything else is escaped by the JSON encoder.
func appendJSONString(b []byte, s string) []byte {
	for i := 0; i < len(s); i++ {
		if c := s[i]; c < 0x20 || c >= 0x7f || c == '"' || c == '\\' || c == '<' || c == '>' || c == '&' {
			q, _ := json.Marshal(s)
			return append(b, q...)
		}
	}
	b = append(b, '"')
	b = append(b, s...)
	return append(b, '"')
}
