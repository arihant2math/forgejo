// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"fmt"
	"slices"
	"strings"

	"forgejo.org/models/db"
	"forgejo.org/modules/log"
	"forgejo.org/services/livesync/catalog"
)

// CheckCatalog compares the livesync catalog with the tables Forgejo
// registers (db.RegisterModel). It fails when a tracked table is no longer
// registered or has no auto-increment primary key named id (the capture
// triggers reference only that column). It returns the registered tables
// that are neither tracked nor ignored, and logs them along with catalogued
// ignored tables that vanished: both mean the catalog needs a decision, which
// the TestLivesyncCatalogContract integration test enforces in CI.
func CheckCatalog() (unclassified []string, err error) {
	beans, err := db.NamesToBean()
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(beans))
	primaryKey := make(map[string]string, len(beans))
	for _, bean := range beans {
		info, err := db.TableInfo(bean)
		if err != nil {
			return nil, fmt.Errorf("livesync: table info for %T: %w", bean, err)
		}
		names = append(names, info.Name)
		if slices.Equal(info.PrimaryKeys, []string{"id"}) && info.AutoIncrement == "id" {
			primaryKey[info.Name] = "id"
		} else {
			primaryKey[info.Name] = fmt.Sprintf("primary key %v, auto-increment %q", info.PrimaryKeys, info.AutoIncrement)
		}
	}

	unclassified, vanished := catalog.Classify(names)
	var problems []string
	trackedSet := map[string]bool{}
	for _, t := range catalog.Tracked() {
		trackedSet[t.Name] = true
		if pk, ok := primaryKey[t.Name]; ok && pk != "id" {
			problems = append(problems, fmt.Sprintf("tracked table %s has %s, want an auto-increment id", t.Name, pk))
		}
	}
	var vanishedIgnored []string
	for _, name := range vanished {
		if trackedSet[name] {
			problems = append(problems, fmt.Sprintf("tracked table %s is not registered any more", name))
		} else {
			vanishedIgnored = append(vanishedIgnored, name)
		}
	}
	if len(problems) > 0 {
		return unclassified, fmt.Errorf("livesync: the table catalog does not match this Forgejo: %s", strings.Join(problems, "; "))
	}
	if len(unclassified) > 0 {
		log.Warn("livesync: tables neither tracked nor ignored by the livesync catalog (their changes are not synced): %s", strings.Join(unclassified, ", "))
	}
	if len(vanishedIgnored) > 0 {
		log.Warn("livesync: tables in the livesync ignore list that Forgejo no longer registers: %s", strings.Join(vanishedIgnored, ", "))
	}
	return unclassified, nil
}
