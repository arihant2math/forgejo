// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package protocol

// The sync protocol (PLAN §4.6): JSON messages exchanged over the WebSocket
// at /-/sync/ws, one message per WebSocket text message, or over the
// fallback transport (server messages as Server-Sent Events from
// GET /-/sync/sse, client messages POSTed to /-/sync/send). Every message
// is an object whose "type" names it.
//
// A session: the client sends HelloMessage (its token and the groups it
// wants, each with the position it already holds); the server answers
// WelcomeMessage (or SessionInvalidMessage), replays what each group missed
// since that position, then streams live changes (DeltaMessage) and sends
// CaughtUpMessage once every subscribed group is live. Later
// SubscribeMessage / UnsubscribeMessage change the set of groups.
//
// Positions: every change carries its sync id v; a group's position is the
// highest v the client received in it, raised to the "to" of a delta frame,
// the sync_id of caught_up, pong, barrier_ok and resume_from_cursor for
// every group that was live (caught up) when that message was sent. A
// client resumes a group from its position (GroupRequest.Since); deltas
// are full entity states, applied only when v is newer than what the client
// holds, so replaying overlaps is harmless.

// ProtocolVersion is the version of the sync protocol (WelcomeMessage.Protocol).
// It changes only when a message changes incompatibly; entity DTO changes are
// versioned per model (the Schema* constants, WelcomeMessage.Schemas).
const ProtocolVersion = 1

// MessageType is the "type" of a protocol message.
type MessageType string

// Client → server messages (each has its message type below, and the
// TypeScript union ClientMessage in next/tools/tygo.yaml lists them;
// TestTypeScriptUnions checks both).

const (
	MsgHello       MessageType = "hello"
	MsgSubscribe   MessageType = "subscribe"
	MsgUnsubscribe MessageType = "unsubscribe"
	MsgBarrier     MessageType = "barrier"
	MsgPing        MessageType = "ping"
)

// Server → client messages (the TypeScript union ServerMessage).

const (
	MsgWelcome           MessageType = "welcome"
	MsgSubscribed        MessageType = "subscribed"
	MsgDelta             MessageType = "delta"
	MsgCaughtUp          MessageType = "caught_up"
	MsgBootstrapRequired MessageType = "bootstrap_required"
	MsgGroupRevoked      MessageType = "group_revoked"
	MsgBarrierOK         MessageType = "barrier_ok"
	MsgSessionInvalid    MessageType = "session_invalid"
	MsgNotice            MessageType = "notice"
	MsgPong              MessageType = "pong"
	MsgGrants            MessageType = "grants"
	MsgResumeFromCursor  MessageType = "resume_from_cursor"
	MsgError             MessageType = "error"
	// MsgSession is the first event of the fallback transport (SSE): the
	// session id the client sends its messages with.
	MsgSession MessageType = "session"
)

// GroupRequest asks for a group. Since is the position the client already
// holds in it (the server replays the entries after it, then streams live
// ones); without it the subscription starts live at the server's current
// position (e.g. right after a bootstrap whose watermark is at least that).
type GroupRequest struct {
	Group string `json:"group"`
	Since *int64 `json:"since,omitempty"`
}

// HelloMessage opens a session. It must be the first message: anything
// else first is answered by ErrorMessage{code: ErrorHelloRequired} and the
// session is closed. Over the fallback transport, wait for the hello's
// POST to complete before sending more.
type HelloMessage struct {
	Type MessageType `json:"type" tstype:"'hello'"`
	// Token is an OAuth2 access token or a personal access token, validated
	// like an API v1 bearer token (never sent in the URL).
	Token    string `json:"token"`
	ClientID string `json:"client_id,omitempty"`
	// Protocol is the client's ProtocolVersion (informational).
	Protocol int `json:"protocol,omitempty"`
	// BuildID is the build of the client app; when it differs from the
	// server's, the server sends NoticeMessage{kind: NoticeNewBuild}.
	BuildID string `json:"build_id,omitempty"`
	// LastSyncID is the Since of every group that does not give one.
	LastSyncID *int64         `json:"last_sync_id,omitempty"`
	Groups     []GroupRequest `json:"groups,omitempty"`
}

// SubscribeMessage adds groups to the session (or restarts the replay of an
// already subscribed group from a new Since). Answered by SubscribedMessage.
type SubscribeMessage struct {
	Type   MessageType    `json:"type" tstype:"'subscribe'"`
	Groups []GroupRequest `json:"groups"`
}

// UnsubscribeMessage removes groups from the session (no answer; deltas of
// these groups already on their way may still arrive).
type UnsubscribeMessage struct {
	Type   MessageType `json:"type" tstype:"'unsubscribe'"`
	Groups []string    `json:"groups"`
}

// BarrierMessage asks the server to answer BarrierOKMessage once
// everything committed to the sync log before the barrier arrived has been
// sent for every subscribed group (all of them caught up).
type BarrierMessage struct {
	Type MessageType `json:"type" tstype:"'barrier'"`
	ID   string      `json:"id"`
}

// PingMessage is answered by PongMessage (keep-alive; it also tells the
// client the server's position).
type PingMessage struct {
	Type MessageType `json:"type" tstype:"'ping'"`
	ID   string      `json:"id,omitempty"`
}

// Refusal is a requested group the session did not get. Reason is
// RefusedForbidden (not readable — or not existing, or not a client group:
// the answer never tells these apart) or RefusedLimit (the per-user
// subscription limit is reached).
type Refusal struct {
	Group  string `json:"group"`
	Reason string `json:"reason" tstype:"RefusalReason"`
}

// Reasons of a Refusal (the TypeScript union RefusalReason in
// next/tools/tygo.yaml; TestTypeScriptUnions keeps it complete).

const (
	RefusedForbidden = "forbidden"
	RefusedLimit     = "limit"
)

// WelcomeMessage answers HelloMessage.
type WelcomeMessage struct {
	Type MessageType `json:"type" tstype:"'welcome'"`
	// ServerSyncID is the server's position when the session started.
	ServerSyncID int64 `json:"server_sync_id"`
	ViewerID     int64 `json:"viewer_id"`
	// Granted are the requested groups the session subscribed, with the
	// viewer's units in them; Refused the others.
	Granted []Grant   `json:"granted"`
	Refused []Refusal `json:"refused"`
	// Grants are the viewer's implicit grants (as GET /-/sync/grants): the
	// groups to keep in the workspace. Others are granted on demand.
	Grants   []Grant       `json:"grants"`
	BuildID  string        `json:"build_id"`
	Protocol int           `json:"protocol"`
	Schemas  map[Model]int `json:"schemas"`
	// Profile is the viewer's own User entity (a change with op U). It is
	// sent here, and later changes of it are sent to the viewer's sessions
	// whether or not they subscribed its group, because a viewer may not be
	// able to read the group that holds it (a restricted user with
	// visibility limited cannot read profiles:limited).
	Profile *Change `json:"profile,omitempty"`
}

// SubscribedMessage answers SubscribeMessage.
type SubscribedMessage struct {
	Type    MessageType `json:"type" tstype:"'subscribed'"`
	Granted []Grant     `json:"granted"`
	Refused []Refusal   `json:"refused"`
}

// Change is one sync log entry as sent to clients.
type Change struct {
	// V is the entry's sync id (the entity's version).
	V int64 `json:"v"`
	// G is the group the entry belongs to.
	G string `json:"g"`
	M Model  `json:"m"`
	// ID is the entity's id.
	ID int64 `json:"id"`
	// Op is OpUpsert or OpDelete.
	Op Op `json:"op"`
	// D is the entity (the model's DTO) for OpUpsert; absent for OpDelete.
	D any `json:"d,omitempty" tstype:"unknown"`
}

// DeltaMessage carries changes, in sync id order per group. To is the
// position up to which every caught-up group of the session is complete
// with this frame (it may be below the changes' v).
type DeltaMessage struct {
	Type    MessageType `json:"type" tstype:"'delta'"`
	To      int64       `json:"to"`
	Changes []Change    `json:"changes"`
}

// CaughtUpMessage says that every subscribed group has been replayed and is
// live, complete up to SyncID. Sent after the hello's and each subscribe's
// replays finished; a client may then flush its offline queue.
type CaughtUpMessage struct {
	Type   MessageType `json:"type" tstype:"'caught_up'"`
	SyncID int64       `json:"sync_id"`
}

// BootstrapRequiredMessage says that the client cannot get a group's
// missing changes from the stream: it must drop what it holds of the group
// and load it again (B6's bootstrap). The subscription stays: changes keep
// arriving, and the bootstrap's watermark makes the overlap harmless.
type BootstrapRequiredMessage struct {
	Type   MessageType `json:"type" tstype:"'bootstrap_required'"`
	Group  string      `json:"group"`
	Reason string      `json:"reason" tstype:"BootstrapReason"`
	// Model is set when only the entities of this model are concerned
	// (a re-bootstrap marker in the sync log).
	Model Model `json:"model,omitempty"`
}

// Reasons of a BootstrapRequiredMessage besides the RebootstrapMarker
// reasons (RebootstrapTriggerRepaired, RebootstrapPlacementChanged); all of
// them make the TypeScript union BootstrapReason.

const (
	// BootstrapCursorTrimmed: the group's position is older than the sync
	// log retention.
	BootstrapCursorTrimmed = "cursor_trimmed"
	// BootstrapReplayTooLong: the group has more entries to replay than the
	// server's limit ([livesync] MAX_REPLAY): a bootstrap is cheaper.
	BootstrapReplayTooLong = "replay_too_long"
	// BootstrapPermissionChanged: the viewer's units in the group changed;
	// what they may read of it is no longer what they hold.
	BootstrapPermissionChanged = "permission_changed"
	// BootstrapCursorUnknown: the group's position is ahead of the sync
	// log (it comes from another database, e.g. before a restore).
	BootstrapCursorUnknown = "cursor_unknown"
)

// GroupRevokedMessage says that the viewer may no longer read a group: the
// subscription is gone and the client must purge the group's entities.
type GroupRevokedMessage struct {
	Type  MessageType `json:"type" tstype:"'group_revoked'"`
	Group string      `json:"group"`
}

// BarrierOKMessage answers BarrierMessage: every subscribed group is
// complete up to SyncID.
type BarrierOKMessage struct {
	Type   MessageType `json:"type" tstype:"'barrier_ok'"`
	ID     string      `json:"id"`
	SyncID int64       `json:"sync_id"`
}

// SessionInvalidMessage says that the token is invalid, expired or revoked,
// or that the account may no longer sign in; the server closes the session.
// The client should get a new token (or sign in again) and reconnect.
type SessionInvalidMessage struct {
	Type    MessageType `json:"type" tstype:"'session_invalid'"`
	Message string      `json:"message"`
}

// NoticeMessage informs the client about the server.
type NoticeMessage struct {
	Type MessageType `json:"type" tstype:"'notice'"`
	Kind string      `json:"kind" tstype:"NoticeKind"`
}

// Kinds of a NoticeMessage (the TypeScript union NoticeKind).

const (
	// NoticeNewBuild: the server runs another build than the client's
	// (HelloMessage.BuildID); the client should update itself.
	NoticeNewBuild = "new_build"
	// NoticeShutdown: the server is shutting down; reconnect (with backoff).
	NoticeShutdown = "shutdown"
)

// PongMessage answers PingMessage. SyncID is the server's position: every
// caught-up group is complete up to it.
type PongMessage struct {
	Type   MessageType `json:"type" tstype:"'pong'"`
	ID     string      `json:"id,omitempty"`
	SyncID int64       `json:"sync_id"`
}

// GrantsMessage tells the client that the viewer's implicit grants
// (WelcomeMessage.Grants) changed, e.g. after they were made a
// collaborator: the workspace may subscribe the new groups. Groups that
// are no longer readable are revoked separately (GroupRevokedMessage).
type GrantsMessage struct {
	Type   MessageType `json:"type" tstype:"'grants'"`
	Grants []Grant     `json:"grants"`
}

// ResumeFromCursorMessage says that the client does not read fast enough:
// the server dropped what it had not sent yet and closes the session. Every
// caught-up group is complete up to SyncID; the client reconnects and
// resumes each group from its position.
type ResumeFromCursorMessage struct {
	Type   MessageType `json:"type" tstype:"'resume_from_cursor'"`
	SyncID int64       `json:"sync_id"`
}

// ErrorMessage reports a message the server could not handle (the session
// goes on unless the server closes it).
type ErrorMessage struct {
	Type    MessageType `json:"type" tstype:"'error'"`
	Code    string      `json:"code" tstype:"ErrorCode"`
	Message string      `json:"message"`
}

// Codes of an ErrorMessage (the TypeScript union ErrorCode).

const (
	ErrorBadMessage         = "bad_message"
	ErrorHelloRequired      = "hello_required"
	ErrorTooManyBarriers    = "too_many_barriers"
	ErrorTooManyConnections = "too_many_connections"
	ErrorInternal           = "internal"
)

// SessionMessage is the first event of the fallback transport (GET
// /-/sync/sse): POST client messages to /-/sync/send with the header
// X-Livesync-Session set to Session.
type SessionMessage struct {
	Type    MessageType `json:"type" tstype:"'session'"`
	Session string      `json:"session"`
}

// SessionHeader is the request header of POST /-/sync/send naming the
// fallback session.
const SessionHeader = "X-Livesync-Session"
