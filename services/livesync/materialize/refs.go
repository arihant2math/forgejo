// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"reflect"
	"strings"
	"sync"
)

// userRefFields are the DTO fields (JSON names) that hold the id of a user
// or organization whose User entity (profile) a client needs to show the
// entity: posters, assignees, owners, … A bootstrap collects them so that
// the client can reach those profiles (B6: BootstrapEnd.Refs).
var userRefFields = map[string]bool{
	"actor_id":        true,
	"approved_by":     true,
	"assignee_id":     true,
	"block_id":        true,
	"creator_id":      true,
	"deleted_by_id":   true,
	"doer_id":         true,
	"merger_id":       true,
	"owner_id":        true,
	"poster_id":       true,
	"publisher_id":    true,
	"pusher_id":       true,
	"resolve_doer_id": true,
	"reviewer_id":     true,
	"trigger_user_id": true,
	"uploader_id":     true,
	"user_id":         true,
}

// refFieldIndexes caches, per DTO struct type, the indexes of its user
// reference fields.
var refFieldIndexes sync.Map // reflect.Type → []int

func refIndexes(t reflect.Type) []int {
	if v, ok := refFieldIndexes.Load(t); ok {
		return v.([]int)
	}
	var res []int
	for i := range t.NumField() {
		f := t.Field(i)
		name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
		if userRefFields[name] && f.Type.Kind() == reflect.Int64 {
			res = append(res, i)
		}
	}
	refFieldIndexes.Store(t, res)
	return res
}

// userRefs returns the ids of the users a DTO refers to (non-zero, positive:
// the ghost user -1 and unknown 0 are no profiles).
func userRefs(dto any) []int64 {
	v := reflect.ValueOf(dto)
	if v.Kind() == reflect.Pointer {
		if v.IsNil() {
			return nil
		}
		v = v.Elem()
	}
	if v.Kind() != reflect.Struct {
		return nil
	}
	var res []int64
	for _, i := range refIndexes(v.Type()) {
		if id := v.Field(i).Int(); id > 0 {
			res = append(res, id)
		}
	}
	return res
}
