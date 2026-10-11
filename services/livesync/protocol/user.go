// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package protocol

// The viewer's settings pages (next/src/features/usersettings) write
// through API v1 (PATCH /user/settings, /user/emails, /user/keys,
// /user/gpg_keys, /user/avatar); these gap endpoints (api.go) are what
// it lacks:
//
//	GET /-/sync/api/user/options        → 200 APIUserOptions
//	PUT /-/sync/api/user/emails/primary APIPrimaryEmail → 204; 404 not the viewer's address; 422 not verified (write:user)

// APIUserOptions are the choices of the appearance settings: the
// instance's themes ([ui] THEMES, in that order) and languages ([i18n]
// LANGS, by name), as the classic appearance page offers them. API v1's
// PATCH /user/settings stores any theme and language it is sent, so a
// client offers only these. Names are in the viewer's language.
// DefaultTheme is [ui] DEFAULT_THEME (an account without a theme of its
// own shows it).
type APIUserOptions struct {
	Themes       []APIOption `json:"themes"`
	DefaultTheme string      `json:"default_theme"`
	Languages    []APIOption `json:"languages"`
}

// APIOption is a choice: the value stored (ID) and its display name.
type APIOption struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// APIPrimaryEmail is the body of PUT /user/emails/primary: one of the
// viewer's verified addresses (case-insensitive) becomes the account's
// primary address, as the classic account page's "Set as primary" does
// (Forgejo mails the former primary address about the change).
type APIPrimaryEmail struct {
	Email string `json:"email"`
}
