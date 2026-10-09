// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package protocol

// Gap endpoints (PLAN §4.8): what API v1 lacks, under /-/sync/api/. They
// are authenticated like every livesync endpoint (an OAuth2 or personal
// access token in "Authorization: Bearer"/"token"; the token needs the
// read scopes of GET /-/sync/grants, and writes also the write scope named
// below), and decide permissions as the classic web UI does for the same
// action. Errors are JSON APIError bodies:
//
//   - 401 no/invalid token; 403 an account API v1 refuses, a token without
//     the scope, or an object the viewer may read but not change;
//   - 404 an object that does not exist or that the viewer may not read
//     (never told apart), and every non-SHA "commit" of the immutable git
//     endpoints;
//   - 400 a malformed request; 409 a conflict (APIBodyConflict for body
//     edits); 422 a request the object's state refuses (e.g. deleting the
//     default column); 503 + Retry-After while livesync is not running.
//
// Writes (POST, PUT, PATCH, DELETE except POST /markdown, which only
// reads) answer like keyed API v1 writes (writes.go): with
// HeaderSyncID once their changes are in the sync log (whether or not the
// request has an Idempotency-Key), so the client drops its overlay when the
// groups' positions reach it; the response bodies are small
// acknowledgements, the entities themselves arrive as deltas. With
// HeaderIdempotencyKey a write is reserved, stored and replayed exactly
// like an API v1 write (same headers, statuses and TTL); no crash-window
// check applies to them (a column created by an attempt that was
// interrupted by a crash is created again by the retry).
//
// Routes ({id}s are database ids, not issue numbers; {commit}, {base},
// {head} and {sha} are full hexadecimal object ids):
//
//	POST   /-/sync/api/projects/{id}/columns                APIColumnCreate → 201 APICreated; 422 at 20 columns (write:issue)
//	PATCH  /-/sync/api/projects/{id}/columns/{column}       APIColumnEdit   → 200 APICreated   (write:issue)
//	DELETE /-/sync/api/projects/{id}/columns/{column}       → 204; 422 for the default column   (write:issue)
//	PUT    /-/sync/api/projects/{id}/column-order           APIColumnOrder  → 204              (write:issue)
//	POST   /-/sync/api/projects/{id}/columns/{column}/cards APICardMove     → 204; 503 + Retry-After when concurrent moves kept it from completing (write:issue)
//	PATCH  /-/sync/api/issues/{id}/body                     APIBodyEdit     → 200 APIBodyEdited, 409 APIBodyConflict (write:issue)
//	PATCH  /-/sync/api/comments/{id}/body                   APIBodyEdit     → 200 APIBodyEdited, 409 APIBodyConflict (write:issue)
//	GET    /-/sync/api/bodies/{model}/{id}                  → 200 APIBody (model IssueBody, Comment, Review or Release)
//	GET    /-/sync/api/issues/{id}/viewed[?head={sha}]      → 200 APIViewedFiles (a pull request's issue)
//	PUT    /-/sync/api/issues/{id}/viewed                   APIViewedUpdate → 200 APIViewedFiles (write:repository)
//	PUT    /-/sync/api/issues/{id}/project                  APIIssueProject → 204              (write:issue)
//	POST   /-/sync/api/markdown                             APIMarkdownRequest → 200 APIMarkdownResponse
//	POST   /-/sync/api/markup                               APIMarkupRequest → 200 APIMarkupResponse (code unit)
//	GET    /-/sync/api/repos/{id}/tree/{commit}[/{path}]    → 200 APITree               (immutable)
//	GET    /-/sync/api/repos/{id}/raw/{commit}/{path}       → 200 the file's bytes      (immutable, ETag = blob SHA)
//	GET    /-/sync/api/repos/{id}/blobs/{sha}               → 200 the blob's bytes      (immutable)
//	GET    /-/sync/api/repos/{id}/blame/{commit}/{path}     → 200 APIBlame              (immutable)
//	GET    /-/sync/api/repos/{id}/diff/{commit}             → 200 unified diff against the first parent (immutable)
//	GET    /-/sync/api/repos/{id}/diff/{base}/{head}        → 200 unified diff base..head (immutable)
//
// Immutable responses (HeaderImmutable): "Cache-Control: private,
// max-age=31536000, immutable", "Vary: Authorization", a strong ETag (tree:
// the tree's SHA; raw and blobs: the blob's SHA; blame: a hex SHA-256 of
// the commit, the path and ?bypass_ignore — paths may hold characters an
// entity tag cannot; diff: the commit, or "base..head") and 304 for a
// matching If-None-Match. They need the code unit of the repository (as
// the classic file view). Abbreviated SHAs, branch and tag names are 404:
// the address must be content-addressed. Raw and blob bodies are sent as
// application/octet-stream with "X-Content-Type-Options: nosniff" and a
// sandboxing CSP; their size is in Content-Length. Diffs are streamed
// (no Content-Length): when git fails before its first byte the answer is
// a 500 without the immutable headers; when it fails later the response is
// cut (the connection closed without the final chunk, an HTTP/2 stream
// reset), so reading the body fails — a body that was read to its end
// without an error is the complete diff. (Forgejo served over FastCGI
// cannot cut a response: there a diff cut by a git failure, logged, ends
// like a complete one.) Only a complete response may be cached. The body
// of a blame is immutable except APIBlameCommit.AuthorID (see there).
const (
	// APIPrefix is the path prefix of the gap endpoints.
	APIPrefix = "/-/sync/api"
	// CacheImmutable is the Cache-Control of the SHA-addressed responses.
	CacheImmutable = "private, max-age=31536000, immutable"
)

// APIError is the body of an error response.
type APIError struct {
	Message string `json:"message"`
}

// APICreated acknowledges a create or edit: the id of the object (the
// entity follows as a delta).
type APICreated struct {
	ID int64 `json:"id"`
}

// APIColumnCreate adds a column at the end of a project board.
//
// Permission (as the classic board): a repository project needs write
// access to the repository's projects unit (and an unarchived repository);
// an organization project needs the projects unit with write access in one
// of the viewer's teams; a user's project its owner. Color is "" or
// "#rrggbb".
type APIColumnCreate struct {
	Title string `json:"title"`
	Color string `json:"color,omitempty"`
}

// APIColumnEdit changes a column; absent fields stay. Default true makes
// the column the board's default (the others lose it; false is ignored).
// Color "" removes the colour.
type APIColumnEdit struct {
	Title   *string `json:"title,omitempty"`
	Color   *string `json:"color,omitempty"`
	Default *bool   `json:"default,omitempty"`
}

// APIColumnOrder orders a board's columns: every column of the project,
// exactly once, in the new order (a request that misses one is 409: the
// client's view is stale; load the board again).
type APIColumnOrder struct {
	ColumnIDs []int64 `json:"column_ids"`
}

// APICardMove moves cards into a column (or within it). Either IssueID
// (one card) with Position — its 0-based index among the column's cards
// that the viewer may read (the ones the board and the synced pool show),
// after the move; absent or past the end: last — or Cards, the target
// column's complete new order (sorting values ascending; cards of the
// column that are not listed go after them, as the classic board does).
// A position is applied to the column as it is when the move runs (read
// and written in one transaction, its cards locked): the card goes right
// before the readable card at Position, and the cards the viewer may not
// read keep their places; a card another request moved out of the column
// meanwhile stays out. Every issue must already be on the project's board
// (409 otherwise) and readable by the viewer (404). A move that concurrent
// changes of the same cards kept failing (deadlocks, retried by the
// server) is 503 with Retry-After: send it again.
type APICardMove struct {
	IssueID  int64     `json:"issue_id,omitempty"`
	Position *int      `json:"position,omitempty"`
	Cards    []APICard `json:"cards,omitempty"`
}

// APIIssueProject puts an issue on a project's board (in ColumnID, or the
// project's default column when 0; at the column's end) or, with
// ProjectID 0, takes it off its project. An issue is on one project at a
// time (Forgejo's rule): another project takes it off the first. The
// classic issue sidebar's checks: the viewer writes the repository's issues
// (403), the project is the repository's or its owner's and readable (404).
type APIIssueProject struct {
	ProjectID int64 `json:"project_id"`
	ColumnID  int64 `json:"column_id,omitempty"`
}

// APICard is a card's position in APICardMove.Cards.
type APICard struct {
	IssueID int64 `json:"issue_id"`
	Sorting int64 `json:"sorting"`
}

// APIBodyEdit replaces the body of an issue / pull request or of a
// comment if its content_version (IssueBody.content_version,
// Comment.content_version) is still ExpectedVersion. API v1 has no such
// check (it overwrites whatever is there): offline edits need it to
// merge (PLAN §5.4).
//
// Permission (as the classic UI): the poster, or a writer of the issues
// (pull requests) unit; the repository must not be archived; only
// comments with content (comment, code comment, review) can be edited
// (422 otherwise).
type APIBodyEdit struct {
	Body            string `json:"body"`
	ExpectedVersion int    `json:"expected_version"`
}

// APIBodyEdited answers a successful body edit: the new content_version.
type APIBodyEdited struct {
	ContentVersion int `json:"content_version"`
}

// APIBodyConflict is the 409 body of a body edit whose ExpectedVersion is
// stale: the current text and version, the client's 3-way merge base for
// the next attempt.
type APIBodyConflict struct {
	Message        string `json:"message"`
	Body           string `json:"body"`
	ContentVersion int    `json:"content_version"`
}

// APIBody is the complete body of an entity whose sync log payload has
// BodyTruncated (see MaxBodyBytes), with its HTML rendered now exactly as
// the sync log renders body_html (but without the size limits). BodyHTML is
// empty and Truncated true only when even this rendering exceeded the
// server's time budget. ContentVersion is the entity's content_version
// (0 for Review and Release, which have none). Readable by whoever may read
// the entity in its group (404 otherwise).
type APIBody struct {
	Body           string `json:"body"`
	BodyHTML       string `json:"body_html"`
	Truncated      bool   `json:"truncated,omitempty"`
	ContentVersion int    `json:"content_version"`
}

// APIViewedFiles is the viewer's newest "viewed files" state of a pull
// request (the ReviewState entity of user:{viewer}, as the classic files
// view reads it). CommitSHA is the head commit the state was saved for
// ("" with no state). With ?head=<sha> (another commit), the files that
// changed between CommitSHA and head are reported as ViewedHasChanged
// (nothing is stored; the classic view stores that when it renders).
type APIViewedFiles struct {
	PullID    int64             `json:"pull_id"`
	CommitSHA string            `json:"commit_sha"`
	Files     map[string]string `json:"files" tstype:"{ [path: string]: ViewedState }"`
}

// States of a file in APIViewedFiles (the TypeScript union ViewedState).

const (
	ViewedViewed     = "viewed"
	ViewedUnviewed   = "unviewed"
	ViewedHasChanged = "has_changed"
)

// APIViewedUpdate marks files of a pull request viewed (true) or not
// (false) for the viewer at the head commit CommitSHA (a full SHA; default:
// the pull request's current head). Other files keep their state (merged
// as the classic UI does). Permission: read access to the pull request.
type APIViewedUpdate struct {
	CommitSHA string          `json:"commit_sha,omitempty"`
	Files     map[string]bool `json:"files"`
}

// APIMarkupRequest renders a repository file's markup (markdown, by the
// path's extension) as the classic file view does: relative links and
// images resolve from the file's directory at Ref ("branch/main",
// "tag/v1.0", "commit/<sha>"), root-relative ones from the repository's
// root at Ref. Permission: the repository's code unit.
//
// With Commit (a full SHA) the server reads the file at Commit/Path itself
// and Text is ignored: a repository's README renders in one round trip,
// without the client fetching its tree and its blob first (the client asks
// for README.md with the tree, before it knows the name: no such file is
// an answer, Missing, not an error; 404 for no such commit, 413 for a file
// too large to display).
type APIMarkupRequest struct {
	RepoID int64  `json:"repo_id"`
	Ref    string `json:"ref"`
	Path   string `json:"path"`
	Text   string `json:"text"`
	Commit string `json:"commit,omitempty"`
}

// APIMarkupResponse is the rendered (sanitized) HTML; Missing: the request
// named a Commit and there is no file at Path.
type APIMarkupResponse struct {
	HTML    string `json:"html"`
	Missing bool   `json:"missing,omitempty"`
}

// APIMarkdownRequest renders markdown previews in one request (at most 64
// items and 1 MiB of text). With RepoID (a repository the viewer may read)
// references, SHAs and links resolve as in that repository's issues; the
// HTML is exactly what the sync log's body_html of an issue or comment
// with that text would be (rendered without a viewer: @mentions link
// public users only, see materialize.renderMarkdown). Without RepoID the
// text is rendered as plain markdown. It does not write: an
// Idempotency-Key is ignored.
type APIMarkdownRequest struct {
	RepoID int64    `json:"repo_id,omitempty"`
	Items  []string `json:"items"`
}

// APIMarkdownResponse holds the rendered HTML of each item, in order.
type APIMarkdownResponse struct {
	HTML []string `json:"html"`
}

// APITree lists a directory of a commit (not recursive). Path is "" for
// the root; SHA is the tree's object id.
type APITree struct {
	Commit  string         `json:"commit"`
	Path    string         `json:"path"`
	SHA     string         `json:"sha"`
	Entries []APITreeEntry `json:"entries"`
}

// APITreeEntry is one entry of APITree. Type is "blob", "tree", "commit"
// (a submodule) or "symlink"; Mode the git file mode in octal ("100644");
// Size the blob size in bytes (blobs and symlinks only).
type APITreeEntry struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Mode string `json:"mode"`
	SHA  string `json:"sha"`
	Size *int64 `json:"size,omitempty"`
}

// APIBlame is the blame of a file at a commit, as consecutive parts: Lines
// lines (from StartLine, 1-based) last changed by commit SHA. The line text
// is the file's (raw/{commit}/{path}). Commits holds each part commit once.
// PreviousSHA/PreviousPath name the commit before it that touched the
// lines (for "blame prior to this change"). UsesIgnoreRevs: the file's
// .git-blame-ignore-revs was applied (?bypass_ignore=1 turns it off);
// FaultyIgnoreRevsFile: it could not be applied.
type APIBlame struct {
	Commit               string                    `json:"commit"`
	Path                 string                    `json:"path"`
	Parts                []APIBlamePart            `json:"parts"`
	Commits              map[string]APIBlameCommit `json:"commits"`
	UsesIgnoreRevs       bool                      `json:"uses_ignore_revs"`
	FaultyIgnoreRevsFile bool                      `json:"faulty_ignore_revs_file"`
}

// APIBlamePart is a run of lines of APIBlame.
type APIBlamePart struct {
	SHA          string `json:"sha"`
	StartLine    int    `json:"start_line"`
	Lines        int    `json:"lines"`
	PreviousSHA  string `json:"previous_sha,omitempty"`
	PreviousPath string `json:"previous_path,omitempty"`
}

// APIBlameCommit describes a commit of APIBlame. AuthorID is the Forgejo
// user whose activated email matched the author's when the response was
// made (0: none), as the classic blame page links it: a display hint (an
// avatar, a profile link), not an identity. It can go stale in a cached
// copy (the address added to or removed from an account, the account
// deleted); the rest of the response cannot.
type APIBlameCommit struct {
	Summary     string `json:"summary"`
	AuthorName  string `json:"author_name"`
	AuthorEmail string `json:"author_email"`
	AuthorID    int64  `json:"author_id"`
	AuthoredAt  string `json:"authored_at"`
	CommittedAt string `json:"committed_at"`
}
