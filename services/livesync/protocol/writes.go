// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package protocol

// Writes (PLAN §4.8). Clients write through the unchanged REST API v1 with
// their bearer token (OAuth2 or personal access token in
// "Authorization: Bearer"/"token"). A POST, PUT, PATCH or DELETE below
// /api/v1/ that carries HeaderIdempotencyKey is handled by livesync:
//
//   - The key (1–255 printable ASCII characters, e.g. a UUID) is scoped to
//     the authenticated user and kept for [livesync] IDEMPOTENCY_TTL (7
//     days). The first request with it runs; a retry with the same key and
//     the same request (method, path, query, Content-Type, body) gets the
//     stored response again — same status, headers and body — with
//     HeaderIdempotentReplay: true. Responses with status 500 or above are
//     not stored: the next retry runs again (after the crash-window check
//     below).
//   - 409 {message} with Retry-After while another request with the key is
//     running; 422 {message} when the key was used for a different request;
//     400 for a malformed or repeated key or for credentials that are not a
//     token (e.g. HTTP signatures); 401 without a valid token (also for
//     basic auth with a password, which API v1 would accept: the layer
//     cannot honour the key then, so it does not run the request); 413 for
//     a request body over 16 MiB;
//     503 while livesync is not running. Requests without the header are
//     passed to API v1 untouched.
//   - Crash window: a retry whose earlier attempt was interrupted (the
//     server died while it ran) or failed with a server error first looks
//     for the issue, comment or review that attempt may have created (same
//     user, target and content, created since the first attempt) and answers
//     with it (201/201/200, the representation API v1's GET returns) instead
//     of creating it again. Other writes run again.
//
// HeaderSyncID: once the write's changes are in the sync log, the response
// carries the log position that covers them: every sync log entry produced
// from what the request committed before it answered has a sync id ("v") at
// or below it, in whatever group the entry lies. A client holds the write's
// effect in a group once the group's position (B5's positions contract:
// the highest "v" received, raised by delta "to", caught_up, pong,
// barrier_ok) is at or above it; it may drop the optimistic overlay of that
// write then. Not covered: writes API v1 makes asynchronously after it
// answered (e.g. notifications for other users), and a hot-table row
// (notification, commit_status, action_run_job) changed again by someone
// else before the materializer's coalescing delay (HOT_COALESCE) expired.
// The header is absent when the changes did not reach the log within
// [livesync] IDEMPOTENCY_SYNC_WAIT (default 2 s; the materializer is behind
// or not running): the client then keeps its overlay until a delta for the
// entity arrives. A replay carries the value of the original response (or,
// if that had none, the position computed at the replay).
const (
	// HeaderIdempotencyKey is the request header that makes an API v1
	// write idempotent (the contract: services/livesync/protocol/writes.go).
	HeaderIdempotencyKey = "Idempotency-Key"
	// HeaderSyncID is the response header with the sync log position that
	// covers the write (decimal): every entry produced from what the write
	// committed has v at or below it, so a group whose position is at or
	// above it holds the write's effect. Absent when the changes did not
	// reach the log within IDEMPOTENCY_SYNC_WAIT.
	HeaderSyncID = "X-Livesync-Sync-Id"
	// HeaderIdempotentReplay ("true") marks a stored response replayed for
	// a retry.
	HeaderIdempotentReplay = "X-Livesync-Idempotent-Replay"
	// HeaderBodyOmitted ("true") marks a replayed response whose body was
	// too large to store (over 16 MiB): status and headers only.
	HeaderBodyOmitted = "X-Livesync-Body-Omitted"
)
