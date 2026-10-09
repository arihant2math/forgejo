// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
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
// updated_unix, a counter, a name) name no subjects. A change undone before
// the materializer reads the row is not lost, although the capture
// triggers reference only id and so cannot say which columns an update
// changed (PLAN §4.3): any update of a row of the rarely updated
// permission tables names its subjects, an update of a repository or user
// row that leaves its state as stored is a touch (perm.Basis), and inserted
// rows that are gone again are unknown states (see
// permSubjects.transition).
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

// permUnverified prefixes a permission state that an index walk recorded
// for a row with changes still in the outbox: the walk read the row's
// current state, which may already include those changes, so it is not
// known to be the state before them. The next change of the row is an
// epoch for the subjects of the recorded and of the current state, whatever
// they are (see permSubjects.transition).
const permUnverified = "?"

// permKey identifies a permission state of a table, for netting.
type permKey struct {
	table, state string
}

// permSubjects collects the subjects of the permission states that changed
// in a transaction.
type permSubjects struct {
	// ids are the subjects collected directly, by kind.
	ids map[byte]map[int64]bool
	// removed and added count the known states that went and appeared
	// (rows deleted / inserted or changed). A state that went and appeared
	// again in the same transaction (Forgejo deletes and re-inserts the
	// access rows of a repository with new ids on every recalculation,
	// team and repository units on every update) changed nobody's access,
	// so change nets them out before collecting their subjects.
	removed, added map[permKey]int
	// all: a permission row changed whose state is unknown (gone before
	// the materializer or an index walk recorded it), so its subjects are
	// too.
	all bool
	// touched are the touches (protocol.PermissionChange.Touched) by kind
	// and row id: their current state's fingerprint.
	touched map[rowKey]string
}

// permFlags describes what the changes of a batch say about a row of a
// permission table (see permSubjects.transition).
type permFlags struct {
	// inserted: the row was inserted in this batch.
	inserted bool
	// updated: the row was updated in this batch (which columns changed
	// is not known).
	updated bool
	// touch: the protocol.PermissionTouch kind of a busy table (spec
	// permTouch), "" for the others.
	touch string
	// derived: the table's rows are derived from other permission rows in
	// the same transaction (spec.permDerived: access).
	derived bool
	// backfilled: the table's index backfill is complete.
	backfilled bool
}

// transition records the change of the permission state of a row of table
// (main entity of a spec with perm) from the state stored in its index row
// o (nil: not indexed) to its current state cur ("" when the row is gone or
// in no group), and reports whether the stored state must be updated.
//
//   - Not indexed and gone: the row existed between two materializations
//     only if it was inserted in this batch (inserted) — or before the
//     table's index backfill recorded it (!backfilled): its state is unknown,
//     so the epoch names everyone (PermissionChange.All). Tables whose rows
//     are derived from other permission rows in the same transaction
//     (derived: access) are exempt for inserted rows, see there.
//   - Not indexed and present: a new row (inserted: its state counts as
//     appeared) or one the backfill has not recorded yet (its earlier state
//     is unknown: the subjects of the current one are named directly — a
//     state's subjects are fixed columns of the row (ids), except a
//     repository's owner, whose old readers are also the repository's
//     readers, r<id>).
//   - Indexed with an empty state (written before permission states
//     existed, until the permission walk recorded it) or an unverified one
//     (permUnverified): gone ⇒ everyone (empty) or the recorded subjects
//     (unverified); present ⇒ the recorded and the current subjects.
//   - Otherwise a known state: removed and/or added when it differs.
//
// The materializer sees only the stored and the current state: a row whose
// permission columns changed and changed back before it was materialized
// (a repository made public and private again; the changes may even be
// split across batches, the first batch already reading the restored row)
// looks unchanged, and the capture triggers reference only id, so an
// update does not say which columns it changed (PLAN §4.3: an upstream
// migration must never be able to break a trigger). So an updated row
// (updated) whose state may have been different in between is handled
// conservatively:
//
//   - Rows of the busy tables (touch: repository, user — counters,
//     sign-ins) whose state is as stored become a touch carrying the
//     state's fingerprint: grant caches and the hub drop or re-check only
//     the grants and decisions that recorded another state of the row
//     (perm.Basis), i.e. those computed while it was different. An update
//     that changed nothing permission-relevant costs one comparison per
//     cached grant that read the row.
//   - Rows of the other permission tables (updated only when a permission
//     really changes, or rarely) name the stored and the current subjects
//     directly, outside netting, whatever the states are.
//
// Either way the intermediate state had the same subjects (the id columns
// Forgejo never updates, except a repository's owner, whose intermediate
// owner's access is the repository's, r<id>).
func (p *permSubjects) transition(r rowKey, o *livesync_model.Entity, cur string, f permFlags) bool {
	table := r.tbl
	if f.updated {
		switch {
		case f.touch == "":
			if o != nil {
				p.add(o.Perm)
			}
			p.add(cur)
		case o != nil && cur != "" && o.Perm == cur:
			p.touch(f.touch, r.id, cur)
			return false
		}
	}
	switch {
	case o == nil && cur == "":
		if !f.backfilled || (f.inserted && !f.derived) {
			p.all = true
		}
		return false
	case o == nil && f.inserted:
		p.count(&p.added, table, cur)
		return true
	case o == nil:
		p.add(cur)
		return true
	case o.Perm == "":
		if cur == "" {
			p.all = true
		}
		p.add(cur)
		return true
	case strings.HasPrefix(o.Perm, permUnverified):
		p.add(o.Perm)
		p.add(cur)
		return true
	case o.Perm == cur:
		return false
	}
	p.count(&p.removed, table, o.Perm)
	if cur != "" {
		p.count(&p.added, table, cur)
	}
	return true
}

// touch records a touch of row id of kind in state.
func (p *permSubjects) touch(kind string, id int64, state string) {
	if p.touched == nil {
		p.touched = map[rowKey]string{}
	}
	_, fp, _ := strings.Cut(state, "#")
	p.touched[rowKey{kind, id}] = fp
}

func (p *permSubjects) count(m *map[permKey]int, table, state string) {
	if *m == nil {
		*m = map[permKey]int{}
	}
	(*m)[permKey{table, state}]++
}

// add records the subjects of a state ("" adds nothing; an unverified
// state's subjects count).
func (p *permSubjects) add(state string) {
	state = strings.TrimPrefix(state, permUnverified)
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

// net adds the subjects of the states that went or appeared more often
// than the other way round.
func (p *permSubjects) net() {
	for k, n := range p.removed {
		if n > p.added[k] {
			p.add(k.state)
		}
	}
	for k, n := range p.added {
		if n > p.removed[k] {
			p.add(k.state)
		}
	}
	p.removed, p.added = nil, nil
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
	p.net()
	if len(p.ids) == 0 && len(p.touched) == 0 {
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
	touched := make([]protocol.PermissionTouch, 0, len(p.touched))
	for k, state := range p.touched {
		touched = append(touched, protocol.PermissionTouch{Kind: k.tbl, ID: k.id, State: state})
	}
	slices.SortFunc(touched, func(a, b protocol.PermissionTouch) int {
		return cmp.Or(strings.Compare(a.Kind, b.Kind), cmp.Compare(a.ID, b.ID))
	})
	if len(touched) == 0 {
		touched = nil
	}
	return protocol.PermissionChange{
		Users: sortedUnique(users), Repos: sortedUnique(repos), Owners: sortedUnique(owners), Touched: touched,
	}, true, nil
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
