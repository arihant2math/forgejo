// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package protocol

// APIDiscovery is GET /-/sync/api/discovery's response. This authenticated,
// read-only search uses Explore's repository and profile visibility rules.
// Query: type=repositories|users|organizations, q, page (1-based, 50 rows),
// sort=updated|created|alpha|stars (stars only for repositories). Repository
// filters: archived=true|false and language (the primary language's name).
// Disabled Explore categories answer 404; invalid page/sort/filter answers 400.
// Total counts all matching visible results, not just the current page.
type APIDiscovery struct {
	Rows  []APIDiscoveryRow `json:"rows"`
	Total int64             `json:"total"`
}

// APIDiscoveryRow links to a repository or profile. Path excludes AppSubURL.
type APIDiscoveryRow struct {
	ID     int64  `json:"id"`
	Title  string `json:"title"`
	Detail string `json:"detail"`
	Path   string `json:"path"`
}
