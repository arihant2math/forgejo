// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"net/http"
	"strings"

	auth_model "forgejo.org/models/auth"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/translation"
	"forgejo.org/services/livesync/protocol"
	user_service "forgejo.org/services/user"
)

// The viewer's settings (protocol/user.go): what the UI's settings pages
// need beside API v1.

// apiUserOptions answers GET /-/sync/api/user/options: the themes and
// languages the appearance settings offer (routers/web/user/setting
// Appearance, the language menu of the classic footer).
func apiUserOptions(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, "")
	if a == nil {
		return
	}
	l := translation.NewLocale(a.viewer.Language)
	name := func(key string) (string, bool) {
		if !l.HasKey(key) {
			return "", false
		}
		return l.TrString(key), true
	}
	a.json(http.StatusOK, userOptions(setting.UI.Themes, setting.UI.DefaultTheme, translation.AllLangs(), name))
}

// userOptions lists themes (named by their "themes.names.<theme>"
// translation when there is one, as the classic page names them) and
// languages.
func userOptions(themes []string, defaultTheme string, langs []*translation.LangType, name func(key string) (string, bool)) *protocol.APIUserOptions {
	out := &protocol.APIUserOptions{Themes: []protocol.APIOption{}, DefaultTheme: defaultTheme, Languages: []protocol.APIOption{}}
	for _, t := range themes {
		n, ok := name("themes.names." + t)
		if !ok || strings.TrimSpace(n) == "" {
			n = t
		}
		out.Themes = append(out.Themes, protocol.APIOption{ID: t, Name: n})
	}
	for _, lang := range langs {
		out.Languages = append(out.Languages, protocol.APIOption{ID: lang.Lang, Name: lang.Name})
	}
	return out
}

// apiPrimaryEmail answers PUT /-/sync/api/user/emails/primary (API v1 adds
// and deletes addresses but cannot make one primary): as the classic
// account page's "Set as primary" (EmailPost, _method=PRIMARY), which
// offers it for verified addresses only.
func apiPrimaryEmail(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, auth_model.AccessTokenScopeWriteUser)
	if a == nil {
		return
	}
	var body protocol.APIPrimaryEmail
	if !a.decode(&body) {
		return
	}
	address := strings.TrimSpace(body.Email)
	if address == "" {
		a.error(http.StatusBadRequest, "no email address")
		return
	}
	email, err := user_model.GetEmailAddressOfUser(a.ctx, address, a.viewer.ID)
	if err != nil {
		if user_model.IsErrEmailAddressNotExist(err) {
			a.notFound()
		} else {
			a.internal("load the email address", err)
		}
		return
	}
	switch {
	case email.IsPrimary:
		a.noContent()
		return
	case !email.IsActivated:
		a.error(http.StatusUnprocessableEntity, "only a verified email address can be the primary one")
		return
	}
	if err := user_service.MakeEmailAddressPrimary(a.ctx, a.viewer, email, true); err != nil {
		a.internal("make the email address primary", err)
		return
	}
	a.noContent()
}
