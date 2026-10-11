// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"net/http"
	"net/url"
	"strings"

	"forgejo.org/modules/setting"
	"forgejo.org/services/livesync/protocol"
)

// A classic page asked for with ?ui=classic may redirect to another of the
// UI's canonical routes: an Actions run (/{owner}/{repo}/actions/runs/{n},
// …/jobs/{j}) redirects to its latest attempt (…/jobs/{j}/attempt/{a},
// RedirectToLatestAttempt) without the query. The browser (and the service
// worker) would then serve the UI there again, and "Open in the classic UI"
// would seem to do nothing. keepClassic carries ?ui=classic over to such a
// redirect.

// keepClassic wraps w so that a redirect to one of the UI's canonical
// routes on this instance keeps asking for the classic page.
func keepClassic(w http.ResponseWriter) http.ResponseWriter {
	return &classicRedirect{ResponseWriter: w}
}

type classicRedirect struct {
	http.ResponseWriter
	wrote bool
}

func (c *classicRedirect) WriteHeader(status int) {
	if !c.wrote {
		c.wrote = true
		if status >= 300 && status < 400 {
			if loc, ok := classicLocation(c.Header().Get("Location")); ok {
				c.Header().Set("Location", loc)
			}
		}
	}
	c.ResponseWriter.WriteHeader(status)
}

func (c *classicRedirect) Write(b []byte) (int, error) {
	if !c.wrote {
		c.WriteHeader(http.StatusOK)
	}
	return c.ResponseWriter.Write(b)
}

func (c *classicRedirect) Flush() {
	if f, ok := c.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap lets http.ResponseController reach the server's writer.
func (c *classicRedirect) Unwrap() http.ResponseWriter { return c.ResponseWriter }

// classicLocation returns loc with ?ui=classic when it is a page of this
// instance (absolute below setting.AppURL, or a local path) that the UI
// would serve; ok is false when loc is to be left alone.
func classicLocation(loc string) (string, bool) {
	if loc == "" {
		return "", false
	}
	u, err := url.Parse(loc)
	if err != nil || u.Opaque != "" || u.User != nil {
		return "", false
	}
	switch {
	case u.Scheme == "" && u.Host == "":
		if !strings.HasPrefix(u.Path, "/") || strings.HasPrefix(loc, "//") {
			return "", false
		}
	case u.Scheme != "" && u.Host != "":
		app, err := url.Parse(setting.AppURL)
		if err != nil || !strings.EqualFold(app.Host, u.Host) || app.Scheme != u.Scheme {
			return "", false
		}
	default:
		return "", false
	}
	p := normalizeSlashes(u.Path)
	if sub := setting.AppSubURL; sub != "" {
		if !strings.HasPrefix(p, sub+"/") {
			return "", false
		}
		p = p[len(sub):]
	}
	q := u.Query()
	if q.Has(protocol.NextUICookie) || !spaRoute(p) {
		return "", false
	}
	q.Set(protocol.NextUICookie, "classic")
	u.RawQuery = q.Encode()
	return u.String(), true
}
