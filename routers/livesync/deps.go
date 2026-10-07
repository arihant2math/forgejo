// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

// The WebSocket library of the sync hub (PLAN §4.6). It is pinned in go.mod
// from B1 on so that the dependency diff stays in one place; the hub (B5)
// imports it for real and removes this blank import.
import _ "github.com/coder/websocket" // keeps the dependency in go.mod until the hub (B5) uses it
