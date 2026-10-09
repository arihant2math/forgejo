// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package perm

import (
	"iter"
	"strconv"

	repo_model "forgejo.org/models/repo"
	user_model "forgejo.org/models/user"
	"forgejo.org/services/livesync/protocol"
)

// Undone permission changes (B4). The capture triggers reference only id
// (PLAN §4.3), so the materializer cannot tell an update of a counter from
// an update that changed a permission column and a later one that changed
// it back before the materializer read the row (a repository made public
// and private again, a user made admin and back): both leave the stored
// and the current permission state equal. For most permission tables any
// such update is an epoch for the row's subjects (they are rarely updated
// otherwise), but repository and user rows are updated all the time (issue
// counters, sign-ins), and naming their readers would recompute grants on
// every issue created. Their updates are "touches" instead
// (protocol.PermissionChange.Touched, carrying the row's state after the
// updates), and every grant and decision records the states of the
// repository and user rows it was computed from (Basis): only those that
// recorded another state than a touch's are dropped or re-checked. A grant
// computed while the row was in the intermediate state recorded that
// state, so it is dropped; the ones that saw the current state (all of
// them, for a counter update) are kept.

// RepositoryState is the fingerprint of a repository row's permission
// state: the columns of the row that decide who may read the repository
// (its visibility and owner). The materializer stores it as part of the
// row's state (materialize/perm.go) and sends it in touches.
func RepositoryState(r *repo_model.Repository) string {
	return strconv.FormatBool(r.IsPrivate) + "," + strconv.FormatInt(r.OwnerID, 10)
}

// UserState is the fingerprint of a user (or organization) row's
// permission state: the columns that decide the user's own grants and who
// may see the user's profile and repositories.
func UserState(u *user_model.User) string {
	return strconv.Itoa(int(u.Visibility)) + "," + strconv.FormatBool(u.IsActive) + "," +
		strconv.FormatBool(u.ProhibitLogin) + "," + strconv.FormatBool(u.IsAdmin) + "," +
		strconv.FormatBool(u.IsRestricted) + "," + strconv.Itoa(int(u.Type))
}

type basisKey struct {
	kind string // protocol.TouchRepository or protocol.TouchUser
	id   int64
}

// basisConflict is recorded for a row read in two different states by one
// computation (PostgreSQL's READ COMMITTED gives every statement its own
// snapshot): it equals no state, so any touch of the row makes the result
// stale.
const basisConflict = "\x00conflict"

// Basis records the permission states (RepositoryState, UserState) of the
// repository and user rows a grant or decision was computed from. It is
// read-only once the computation is done.
type Basis map[basisKey]string

func (b Basis) add(kind string, id int64, state string) {
	k := basisKey{kind, id}
	if old, ok := b[k]; ok && old != state {
		state = basisConflict
	}
	b[k] = state
}

func (b Basis) addRepo(r *repo_model.Repository) {
	b.add(protocol.TouchRepository, r.ID, RepositoryState(r))
}

func (b Basis) addUser(u *user_model.User) {
	if u != nil {
		b.add(protocol.TouchUser, u.ID, UserState(u))
	}
}

// Stale reports whether one of touched names a row that b recorded in
// another state: the result may have been computed from a state that was
// undone since, so it must be recomputed (the hub re-checks a subscription
// whose Decision.Basis is stale). Rows b did not read do not matter.
func (b Basis) Stale(touched []protocol.PermissionTouch) bool {
	for _, t := range touched {
		if s, ok := b[basisKey{t.Kind, t.ID}]; ok && s != t.State {
			return true
		}
	}
	return false
}

// Rows yields the kind (protocol.TouchRepository, protocol.TouchUser) and
// id of every row b recorded: the hub indexes subscriptions by them, so a
// touch finds the decisions to compare without scanning all of them.
func (b Basis) Rows() iter.Seq2[string, int64] {
	return func(yield func(string, int64) bool) {
		for k := range b {
			if !yield(k.kind, k.id) {
				return
			}
		}
	}
}
