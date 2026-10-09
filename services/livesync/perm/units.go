// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package perm

import (
	"fmt"
	"strings"

	access_model "forgejo.org/models/perm/access"
	unit_model "forgejo.org/models/unit"
	"forgejo.org/services/livesync/protocol"
)

// UnitSet is the set of units a viewer may read in a granted group, as a
// bit mask (cheap to test per delivered entry). Every granted group has the
// base bit: entries with protocol.UnitNone are readable whenever the group
// is granted at all.
type UnitSet uint32

const (
	unitBase UnitSet = 1 << iota
	unitCode
	unitIssues
	unitPulls
	unitReleases
	unitWiki
	unitExternalWiki
	unitExternalTracker
	unitProjects
	unitPackages
	unitActions
	unitSelf
	unitMembers
	// unitUnknown stands for a unit name this binary does not know: never
	// granted, so such an entry is delivered to nobody.
	unitUnknown UnitSet = 1 << 31
)

// unitOrder lists the named units in their canonical (wire) order.
var unitOrder = []struct {
	unit protocol.Unit
	bit  UnitSet
}{
	{protocol.UnitCode, unitCode},
	{protocol.UnitIssues, unitIssues},
	{protocol.UnitPulls, unitPulls},
	{protocol.UnitReleases, unitReleases},
	{protocol.UnitWiki, unitWiki},
	{protocol.UnitExternalWiki, unitExternalWiki},
	{protocol.UnitExternalTracker, unitExternalTracker},
	{protocol.UnitProjects, unitProjects},
	{protocol.UnitPackages, unitPackages},
	{protocol.UnitActions, unitActions},
	{protocol.UnitSelf, unitSelf},
	{protocol.UnitMembers, unitMembers},
}

// unitMasks maps the unit names (and the common alternatives) to their
// masks.
var unitMasks = func() map[protocol.Unit]UnitSet {
	m := map[protocol.Unit]UnitSet{protocol.UnitIssuesOrPulls: unitIssues | unitPulls}
	for _, u := range unitOrder {
		m[u.unit] = u.bit
	}
	return m
}()

// Mask returns the units an entry with unit u needs (any one of them): 0
// for protocol.UnitNone, several bits for alternatives ("issues|pulls").
func Mask(u protocol.Unit) UnitSet {
	if u == protocol.UnitNone {
		return 0
	}
	if m, ok := unitMasks[u]; ok {
		return m
	}
	var m UnitSet
	for part := range strings.SplitSeq(string(u), "|") {
		b, ok := unitMasks[protocol.Unit(part)]
		if !ok {
			b = unitUnknown
		}
		m |= b
	}
	return m
}

// Allows reports whether a viewer with these units in a group may read an
// entry of the group with unit u. The zero UnitSet (group not granted)
// allows nothing.
func (s UnitSet) Allows(u protocol.Unit) bool {
	if s&unitBase == 0 {
		return false
	}
	m := Mask(u)
	return m == 0 || s&m != 0
}

// Units returns the named units of the set in canonical order (never nil).
func (s UnitSet) Units() []protocol.Unit {
	res := []protocol.Unit{}
	for _, u := range unitOrder {
		if s&u.bit != 0 {
			res = append(res, u.unit)
		}
	}
	return res
}

// UnitOf maps a Forgejo repository unit type to its protocol unit name (the
// names of RepoUnit.type / TeamUnit.type and of entry units).
func UnitOf(t unit_model.Type) protocol.Unit {
	switch t {
	case unit_model.TypeCode:
		return protocol.UnitCode
	case unit_model.TypeIssues:
		return protocol.UnitIssues
	case unit_model.TypePullRequests:
		return protocol.UnitPulls
	case unit_model.TypeReleases:
		return protocol.UnitReleases
	case unit_model.TypeWiki:
		return protocol.UnitWiki
	case unit_model.TypeExternalWiki:
		return protocol.UnitExternalWiki
	case unit_model.TypeExternalTracker:
		return protocol.UnitExternalTracker
	case unit_model.TypeProjects:
		return protocol.UnitProjects
	case unit_model.TypePackages:
		return protocol.UnitPackages
	case unit_model.TypeActions:
		return protocol.UnitActions
	}
	return protocol.Unit(fmt.Sprintf("unknown_%d", int(t)))
}

// repoUnits is the UnitSet of a repository permission: the base bit plus
// every unit the viewer can read (Permission.CanRead, as API v1's
// reqRepoReader checks it).
func repoUnits(p *access_model.Permission) UnitSet {
	s := unitBase
	for _, t := range unit_model.AllRepoUnitTypes {
		if p.CanRead(t) {
			s |= Mask(UnitOf(t))
		}
	}
	return s
}
