// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
	"time"

	actions_model "forgejo.org/models/actions"
	"forgejo.org/models/db"
	"forgejo.org/models/unit"
	user_model "forgejo.org/models/user"
	actions_service "forgejo.org/services/actions"
	"forgejo.org/services/context"
	livesync_service "forgejo.org/services/livesync"
	"forgejo.org/services/livesync/protocol"
)

// Download tickets carry no access token and expire before a copied URL can become a lasting grant.
var artifactTicketKey = func() []byte {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		panic(err)
	}
	return key
}()

type artifactTicket struct{ User, Repo, Artifact, Expires int64 }

func signArtifactTicket(t artifactTicket) string {
	payload := fmt.Sprintf("%d:%d:%d:%d", t.User, t.Repo, t.Artifact, t.Expires)
	mac := hmac.New(sha256.New, artifactTicketKey)
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func parseArtifactTicket(s string, now int64) (artifactTicket, bool) {
	var t artifactTicket
	parts := strings.Split(s, ".")
	if len(parts) != 2 {
		return t, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return t, false
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return t, false
	}
	mac := hmac.New(sha256.New, artifactTicketKey)
	mac.Write(payload)
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return t, false
	}
	n, err := fmt.Sscanf(string(payload), "%d:%d:%d:%d", &t.User, &t.Repo, &t.Artifact, &t.Expires)
	return t, err == nil && n == 4 && t.User > 0 && t.Repo > 0 && t.Artifact > 0 && t.Expires > now
}

func apiArtifactTicket(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, "")
	if a == nil {
		return
	}
	repo, ok := a.id("id")
	if !ok || !a.readable(protocol.RepoGroup(repo), protocol.UnitActions) {
		return
	}
	artifact, ok := a.id("artifact")
	if !ok {
		return
	}
	meta, err := actions_model.GetAggregatedArtifactByID(a.ctx, repo, artifact)
	if err != nil || meta.ExpiredUnix.AsTime().Before(time.Now()) {
		a.notFound()
		return
	}
	ticket := signArtifactTicket(artifactTicket{a.viewer.ID, repo, artifact, time.Now().Add(time.Minute).Unix()})
	a.json(http.StatusOK, map[string]string{"ticket": ticket})
}

func apiArtifactDownload(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	t, ok := parseArtifactTicket(req.URL.Query().Get("ticket"), time.Now().Unix())
	if !ok {
		notFound(w, req)
		return
	}
	viewer, err := user_model.GetUserByID(req.Context(), t.User)
	if err != nil || checkAccount(req.Context(), viewer) != nil {
		notFound(w, req)
		return
	}
	perms := livesync_service.Permissions()
	if perms == nil {
		writeJSON(w, http.StatusServiceUnavailable, errorResponse{Message: "livesync is not running"})
		return
	}
	a := &apiRequest{w: w, req: req, ctx: req.Context(), viewer: viewer, perms: perms}
	// Recheck access on redemption: a ticket is not a way around revoked repository permissions.
	_, permission, ok := a.repoPermission(t.Repo)
	if !ok {
		return
	}
	if !permission.CanRead(unit.TypeActions) {
		a.notFound()
		return
	}
	meta, err := actions_model.GetAggregatedArtifactByID(a.ctx, t.Repo, t.Artifact)
	if err != nil || meta.ExpiredUnix.AsTime().Before(time.Now()) {
		a.notFound()
		return
	}
	artifacts, err := db.Find[actions_model.ActionArtifact](a.ctx, actions_model.FindArtifactsOptions{RunID: meta.RunID, ArtifactName: meta.ArtifactName})
	if err != nil {
		a.internal("load artifact", err)
		return
	}
	for _, art := range artifacts {
		if art.Status != int64(actions_model.ArtifactStatusUploadConfirmed) {
			a.notFound()
			return
		}
	}
	base, close := context.NewBaseContext(w, req)
	defer close()
	if err := actions_service.ServeArtifact(base, artifacts); err != nil && !base.Written() {
		a.internal("download artifact", err)
	}
}
