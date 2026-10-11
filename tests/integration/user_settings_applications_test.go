// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"net/http"
	"strings"
	"testing"

	auth_model "forgejo.org/models/auth"
	"forgejo.org/modules/translation"
	"forgejo.org/tests"

	"github.com/PuerkitoBio/goquery"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The applications settings page for a security review: empty lists say so, each token's row summarises what it
// may access, the confirmations name the token, and a new token's value is labelled and can be copied.
func TestUserSettingsApplications(t *testing.T) {
	defer tests.PrepareTestEnv(t)()
	locale := translation.NewLocale("en-US")

	t.Run("Empty lists", func(t *testing.T) {
		// user4 has neither access tokens nor OAuth2 grants.
		session := loginUser(t, "user4")
		resp := session.MakeRequest(t, NewRequest(t, "GET", "/user/settings/applications"), http.StatusOK)
		doc := NewHTMLParser(t, resp.Body)
		doc.AssertSelection(t, doc.FindByTextTrim(".user-setting-content p", locale.TrString("settings.access_token.none")), true)
		doc.AssertSelection(t, doc.FindByTextTrim(".user-setting-content p", locale.TrString("settings.oauth2_grants.none")), true)
		// The grants' description speaks of "these third party applications": only with some listed.
		assert.NotContains(t, resp.Body.String(), locale.TrString("settings.authorized_oauth2_applications_description"))
		doc.AssertElement(t, "#new-access-token", false)
	})

	t.Run("Grants listed", func(t *testing.T) {
		// user1 has an OAuth2 grant and access tokens.
		session := loginUser(t, "user1")
		resp := session.MakeRequest(t, NewRequest(t, "GET", "/user/settings/applications"), http.StatusOK)
		body := resp.Body.String()
		assert.Contains(t, body, locale.TrString("settings.authorized_oauth2_applications_description"))
		assert.NotContains(t, body, locale.TrString("settings.oauth2_grants.none"))
		assert.NotContains(t, body, locale.TrString("settings.access_token.none"))
	})

	t.Run("New token", func(t *testing.T) {
		session := loginUser(t, "user2")
		createApplicationSettingsToken(t, session, "audit-token", auth_model.AccessTokenScopeReadRepository, auth_model.AccessTokenScopeWriteIssue)

		resp := session.MakeRequest(t, NewRequest(t, "GET", "/user/settings/applications"), http.StatusOK)
		doc := NewHTMLParser(t, resp.Body)
		// The value: labelled, with a copy button, not a bare generic message.
		box := doc.Find("#new-access-token")
		require.Equal(t, 1, box.Length())
		assert.Equal(t, locale.TrString("settings.access_token.new_value"), strings.TrimSpace(box.Find(".header").Text()))
		token := strings.TrimSpace(doc.Find("#new-access-token-value").Text())
		assert.Regexp(t, `^[0-9a-f]{40}$`, token)
		copyButton := box.Find("button[data-clipboard-text]")
		require.Equal(t, 1, copyButton.Length())
		value, _ := copyButton.Attr("data-clipboard-text")
		assert.Equal(t, token, value)
		label, _ := copyButton.Attr("aria-label")
		assert.Equal(t, locale.TrString("settings.access_token.copy_value"), label)
		doc.AssertElement(t, ".flash-info", false)

		// Its row: what it may access at a glance, and confirmations that name it.
		row := doc.FindByTextTrim(".flex-item-title", "audit-token").Closest(".flex-item")
		require.Equal(t, 1, row.Length())
		summary := strings.Join(strings.Fields(row.Find(".access-token-summary").Text()), " ")
		assert.Contains(t, summary, locale.TrString("settings.repo_and_org_access")+": "+locale.TrString("settings.permissions_access_all"))
		assert.ElementsMatch(t, []string{"read:repository", "write:issue"}, row.Find(".access-token-summary .label").Map(func(_ int, s *goquery.Selection) string {
			return s.Text()
		}))
		for _, modal := range []string{"delete-token", "regenerate-token"} {
			button := row.Find(`.delete-button[data-modal-id="` + modal + `"]`)
			name, _ := button.Attr("data-name")
			assert.Equal(t, "audit-token", name, modal)
			doc.AssertElement(t, "#"+modal+" .content strong.name", true)
		}
		// Never used: no "used in the last 7 days" state.
		assert.Equal(t, 0, row.Find(".flex-item-leading .green").Length())
		assert.Contains(t, row.Text(), locale.TrString("settings.no_activity"))

		// The value is shown once only.
		resp = session.MakeRequest(t, NewRequest(t, "GET", "/user/settings/applications"), http.StatusOK)
		NewHTMLParser(t, resp.Body).AssertElement(t, "#new-access-token", false)
	})

	t.Run("Specific repositories", func(t *testing.T) {
		createFineGrainedRepoAccessToken(t, "user2", []auth_model.AccessTokenScope{auth_model.AccessTokenScopeReadIssue}, []int64{2})
		session := loginUser(t, "user2")
		resp := session.MakeRequest(t, NewRequest(t, "GET", "/user/settings/applications"), http.StatusOK)
		doc := NewHTMLParser(t, resp.Body)
		want := locale.TrString("settings.repo_and_org_access") + ": " + string(locale.TrPluralString(1, "settings.access_token.specific_repositories", 1))
		found := false
		doc.Find(".access-token-summary").Each(func(_ int, s *goquery.Selection) {
			if strings.Contains(strings.Join(strings.Fields(s.Text()), " "), want) {
				found = true
			}
		})
		assert.True(t, found, "a summary says %q", want)
	})

	t.Run("New token form", func(t *testing.T) {
		session := loginUser(t, "user2")
		resp := session.MakeRequest(t, NewRequest(t, "GET", "/user/settings/applications/tokens/new"), http.StatusOK)
		doc := NewHTMLParser(t, resp.Body)
		// "Repository and organization access" is required: marked, and the browser asks for a choice.
		doc.AssertElement(t, `#scoped-access-form fieldset > label.required`, true)
		assert.Equal(t, 3, doc.Find(`input[name="resource"][required]`).Length())
	})
}
