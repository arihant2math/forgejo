// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"forgejo.org/models/db"
	"forgejo.org/modules/json"
	"forgejo.org/modules/log"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/services/livesync/synclog"
)

// Permission epochs (PLAN §4.5, B4). The rows of the tables that decide who
// may read what (access, collaboration, team*, org_user, repository,
// repo_unit, user, forgejo_blocked_user) have a permission state:
// the subjects whose access the row affects plus a fingerprint of its
// permission-relevant columns (spec.perm). The state of the last
// materialized version is kept in the entity index (livesync_entity.perm),
// so that deletes have it too. When a row's state changes — it appears,
// goes, or a relevant column changes — the subjects of the old and the new
// state are collected; at the end of the transaction they are expanded and
// written as one protocol.OpPermission entry to protocol.GroupPermission,
// *before* the transaction's other entries, so a hub that applies the log in
// order revokes access before delivering anything written after the
// change in the same batch. Changes that leave the state alone (an
// updated_unix, a counter, a name) produce no epoch.
//
// Subjects, as tokens of the state:
//
//	u<id>  the user's own grants (protocol.PermissionChange.Users)
//	r<id>  the readers of repository <id> (Repos)
//	o<id>  the readers of user/organization <id>'s org:/profile: group (Owners)
//	O<id>  o<id> plus every repository the user/organization owns
//	t<id>  the members of team <id> (expanded to their users)
//
// followed by "#" and the fingerprint (no spaces).

// permState encodes a permission state.
func permState(fingerprint string, subjects ...string) string {
	return strings.Join(subjects, " ") + " #" + fingerprint
}

func subject(kind byte, id int64) string { return string(kind) + strconv.FormatInt(id, 10) }

// fingerprint joins permission-relevant column values.
func fingerprint(values ...any) string {
	parts := make([]string, len(values))
	for i, v := range values {
		parts[i] = fmt.Sprint(v)
	}
	return strings.Join(parts, ",")
}

// permSubjects collects the subjects of changed permission states.
type permSubjects struct {
	ids map[byte]map[int64]bool
	// all: a permission row went whose state is unknown (deleted before
	// the entity index backfill reached it), so its subjects are too.
	all bool
}

// add records the subjects of a state ("" adds nothing).
func (p *permSubjects) add(state string) {
	for tok := range strings.FieldsSeq(state) {
		if tok[0] == '#' {
			break
		}
		id, err := strconv.ParseInt(tok[1:], 10, 64)
		if err != nil || id <= 0 {
			continue
		}
		if p.ids == nil {
			p.ids = map[byte]map[int64]bool{}
		}
		if p.ids[tok[0]] == nil {
			p.ids[tok[0]] = map[int64]bool{}
		}
		p.ids[tok[0]][id] = true
	}
}

func (p *permSubjects) list(kind byte) []int64 {
	res := make([]int64, 0, len(p.ids[kind]))
	for id := range p.ids[kind] {
		res = append(res, id)
	}
	slices.Sort(res)
	return res
}

// change expands the collected subjects (team members, owners'
// repositories, read in the caller's transaction) into a
// PermissionChange; ok is false when nothing was collected.
func (p *permSubjects) change(ctx context.Context) (ch protocol.PermissionChange, ok bool, err error) {
	if p.all {
		return protocol.PermissionChange{All: true}, true, nil
	}
	if len(p.ids) == 0 {
		return ch, false, nil
	}
	users := p.list('u')
	repos := p.list('r')
	owners := append(p.list('o'), p.list('O')...)
	e := db.GetEngine(ctx)
	if teams := p.list('t'); len(teams) > 0 {
		for start := 0; start < len(teams); start += inChunk {
			var members []int64
			if err := e.Table("team_user").Cols("uid").In("team_id", teams[start:min(start+inChunk, len(teams))]).Find(&members); err != nil {
				return ch, false, fmt.Errorf("livesync: permission epoch: team members: %w", err)
			}
			users = append(users, members...)
		}
	}
	if full := p.list('O'); len(full) > 0 {
		for start := 0; start < len(full); start += inChunk {
			var owned []int64
			if err := e.Table("repository").Cols("id").In("owner_id", full[start:min(start+inChunk, len(full))]).Find(&owned); err != nil {
				return ch, false, fmt.Errorf("livesync: permission epoch: owned repositories: %w", err)
			}
			repos = append(repos, owned...)
		}
	}
	return protocol.PermissionChange{Users: sortedUnique(users), Repos: sortedUnique(repos), Owners: sortedUnique(owners)}, true, nil
}

func sortedUnique(ids []int64) []int64 {
	if len(ids) == 0 {
		return nil
	}
	slices.Sort(ids)
	return slices.Compact(ids)
}

// permEntry is the sync log entry of a permission epoch.
func permEntry(ch protocol.PermissionChange) (synclog.Entry, error) {
	payload, err := json.Marshal(ch)
	if err != nil {
		return synclog.Entry{}, err
	}
	log.Trace("livesync: permission epoch: %s", payload)
	return synclog.Entry{Group: protocol.GroupPermission, Op: protocol.OpPermission, Payload: string(payload)}, nil
}
