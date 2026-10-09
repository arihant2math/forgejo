// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package protocol

// Serving the Next UI (PLAN §4.9, §4.10; routers/livesync/spa.go).
//
// The built UI (next/dist) is served below {app_sub_url}/-/next/:
// assets/* immutable, sw.js with Service-Worker-Allowed: {app_sub_url}/,
// index.html for every other path below /-/next/ (the SPA's own routes,
// /-/next/callback included) and, for document navigations of a browser
// that opted in (cookie NextUICookie=NextUICookieValue, set by
// GET|POST /-/next/opt-in and cleared by /-/next/opt-out, both taking
// ?redirect=<same-site path>), on the canonical Forgejo URLs the UI
// supports (the table in routers/livesync/spa.go), unless the URL has
// ?ui=classic (the UI's links to the classic page of one of its own
// routes; the opt-in stays). Under an AppSubURL every
// "/-/next/" string literal of the build (Vite's base, also
// import.meta.env.BASE_URL) and every attribute of index.html that starts
// with it is rewritten to {app_sub_url}/-/next/ when served; never build a
// URL by concatenating "/-/next" with something else.
//
// index.html carries the server's configuration as a JSON data block
// <script type="application/json" id="NextConfigElementID"> (NextConfig;
// also served as GET /-/next/config). The document's CSP allows scripts
// from the origin and the build's inline scripts by hash only, and
// enforces Trusted Types: DOM XSS sinks need values from the policy named
// TrustedTypesPolicy, the only one allowed (no "default" policy: one would
// apply to every sink implicitly, and a permissive one anywhere in the
// bundle would cancel the enforcement).

const (
	// NextConfigElementID is the id of the JSON data block with NextConfig
	// in index.html.
	NextConfigElementID = "forgejo-next-config"
	// NextUICookie / NextUICookieValue: the opt-in cookie.
	NextUICookie      = "ui"
	NextUICookieValue = "next"
	// TrustedTypesPolicy is the only Trusted Types policy name the CSP
	// allows.
	TrustedTypesPolicy = "forgejo-next"
)

// NextConfig is the server configuration of the Next UI.
type NextConfig struct {
	// AppURL is Forgejo's public URL (ends with "/"), AppSubURL its path
	// ("" or "/sub", no trailing slash), Base the UI's base path
	// (AppSubURL + "/-/next/").
	AppURL    string `json:"app_url"`
	AppSubURL string `json:"app_sub_url"`
	Base      string `json:"base"`
	// AppName is the instance's name ([DEFAULT] APP_NAME).
	AppName string `json:"app_name"`
	// Version is Forgejo's version (WelcomeMessage.build_id).
	Version string `json:"version"`
	// Protocol is ProtocolVersion.
	Protocol int `json:"protocol"`
	// OAuth is the UI's OAuth2 client; null when the UI cannot sign in
	// (Forgejo's OAuth2 provider is disabled).
	OAuth *NextOAuth `json:"oauth" tstype:"NextOAuth | null,required"`
}

// NextOAuth describes the Next UI's OAuth2 client (a public client: PKCE
// with S256 is required, there is no secret). Send exactly Scope (as is):
// an authorization with another scope string fails while the user has a
// grant. Forgejo shows the consent page at every authorization of a public
// client. Access tokens expire ([oauth2] ACCESS_TOKEN_EXPIRATION_TIME, 1 h
// by default); refresh them with the refresh token at TokenURL
// (grant_type=refresh_token, client_id). There is no revocation endpoint
// for the client: signing out forgets the tokens (the grant stays listed
// in the user's settings until revoked there).
type NextOAuth struct {
	ClientID     string `json:"client_id"`
	RedirectURI  string `json:"redirect_uri"`
	Scope        string `json:"scope"`
	AuthorizeURL string `json:"authorize_url"`
	TokenURL     string `json:"token_url"`
}

// RUMReport is the body of POST /-/sync/rum (Content-Type
// application/json, at most 8 KiB, anonymous allowed, rate-limited per
// client address; 204 on success, 400/413/415/429 otherwise): browser
// timings in milliseconds by mark, and event counts. Unknown marks and
// events are ignored (counted as rejected); values must be finite, timings
// between 0 and 10 minutes, counts between 0 and 1000. They feed
// Prometheus histograms and counters only; nothing is stored.
type RUMReport struct {
	Marks  map[RUMMark]float64 `json:"marks,omitempty"`
	Events map[RUMEvent]int    `json:"events,omitempty"`
}

// RUMMark names a timing (milliseconds; boot marks from appStart, mutation
// marks from the local apply).
type RUMMark string

const (
	RUMFirstPaintFromCache RUMMark = "firstPaintFromCache"
	RUMDataOpen            RUMMark = "dataOpen"
	RUMWSOpen              RUMMark = "wsOpen"
	RUMCaughtUp            RUMMark = "caughtUp"
	RUMHydrateRoute        RUMMark = "hydrateRoute"
	RUMHydrateAll          RUMMark = "hydrateAll"
	RUMMutationLocal       RUMMark = "mutationLocal"
	RUMMutationAcked       RUMMark = "mutationAcked"
	RUMMutationConfirmed   RUMMark = "mutationConfirmed"
	RUMInteraction         RUMMark = "inp"
)

// RUMEvent names a counted client event (offline queue outcomes).
type RUMEvent string

const (
	RUMIntentFlushed     RUMEvent = "intentFlushed"
	RUMIntentRetried     RUMEvent = "intentRetried"
	RUMIntentFailed      RUMEvent = "intentFailed"
	RUMConflictMerged    RUMEvent = "conflictMerged"
	RUMConflictOverride  RUMEvent = "conflictOverride"
	RUMConflictDiscarded RUMEvent = "conflictDiscarded"
)
