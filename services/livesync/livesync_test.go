// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"errors"
	"strconv"
	"testing"
	"time"

	"forgejo.org/modules/setting"
	"forgejo.org/modules/test"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoadSettings(t *testing.T) {
	const hole = 30 * time.Second
	// def returns the default settings changed by fn.
	def := func(fn func(s *Settings)) Settings {
		s := Settings{
			InstallMode: InstallModeAuto, HoleTimeout: hole,
			LogRetention: 30 * 24 * time.Hour, LogMaxRows: 1_000_000, HotCoalesce: time.Second,
			PermCacheTTL: 10 * time.Minute,
			SendBuffer:   4 << 20, MaxSubscriptions: 1000, MaxConnections: 16, MaxReplay: 10000,
			SessionCheckInterval: 5 * time.Minute,
			SummaryRecency:       90 * 24 * time.Hour, WorkspaceMaxRepos: 200,
		}
		fn(&s)
		return s
	}
	same := func(*Settings) {}
	cases := []struct {
		ini     string
		want    Settings
		wantErr bool
	}{
		{"", def(same), false},
		{"[livesync]\nENABLED = true\n", def(func(s *Settings) { s.Enabled = true }), false},
		{"[livesync]\nENABLED = true\nINSTALL_MODE = verify\n", def(func(s *Settings) { s.Enabled, s.InstallMode = true, InstallModeVerify }), false},
		{"[livesync]\nINSTALL_MODE = \" Verify \"\n", def(func(s *Settings) { s.InstallMode = InstallModeVerify }), false},
		{"[livesync]\nINSTALL_MODE = AUTO\n", def(same), false},
		{"[livesync]\nINSTALL_MODE = manual\n", Settings{}, true},
		{"[livesync]\nPOLL_INTERVAL = 50ms\nHOLE_TIMEOUT = 2s\n", def(func(s *Settings) { s.PollInterval, s.HoleTimeout = 50*time.Millisecond, 2*time.Second }), false},
		{"[livesync]\nPOLL_INTERVAL = soon\n", Settings{}, true},
		{"[livesync]\nPOLL_INTERVAL = -1s\n", Settings{}, true},
		{"[livesync]\nHOLE_TIMEOUT = 0\n", Settings{}, true},
		{"[livesync]\nLOG_RETENTION = 0\nLOG_MAX_ROWS = 0\nHOT_COALESCE = 0\n", def(func(s *Settings) { s.LogRetention, s.LogMaxRows, s.HotCoalesce = 0, 0, 0 }), false},
		{"[livesync]\nLOG_RETENTION = 48h\nLOG_MAX_ROWS = 500\nHOT_COALESCE = 250ms\n", def(func(s *Settings) {
			s.LogRetention, s.LogMaxRows, s.HotCoalesce = 48*time.Hour, 500, 250*time.Millisecond
		}), false},
		{"[livesync]\nLOG_RETENTION = forever\n", Settings{}, true},
		{"[livesync]\nLOG_MAX_ROWS = -1\n", Settings{}, true},
		{"[livesync]\nHOT_COALESCE = -1s\n", Settings{}, true},
		{"[livesync]\nPERM_CACHE_TTL = 30s\n", def(func(s *Settings) { s.PermCacheTTL = 30 * time.Second }), false},
		{"[livesync]\nPERM_CACHE_TTL = 0\n", Settings{}, true},
		{"[livesync]\nSEND_BUFFER = 65536\nMAX_SUBSCRIPTIONS = 10\nMAX_CONNECTIONS_PER_USER = 2\nMAX_REPLAY = 50\nSESSION_CHECK_INTERVAL = 1m\n", def(func(s *Settings) {
			s.SendBuffer, s.MaxSubscriptions, s.MaxConnections, s.MaxReplay, s.SessionCheckInterval = 65536, 10, 2, 50, time.Minute
		}), false},
		{"[livesync]\nSEND_BUFFER = 0\n", Settings{}, true},
		{"[livesync]\nMAX_SUBSCRIPTIONS = -1\n", Settings{}, true},
		{"[livesync]\nSESSION_CHECK_INTERVAL = never\n", Settings{}, true},
		{"[livesync]\nSUMMARY_RECENCY = 720h\nWORKSPACE_MAX_REPOS = 20\n", def(func(s *Settings) { s.SummaryRecency, s.WorkspaceMaxRepos = 720*time.Hour, 20 }), false},
		{"[livesync]\nSUMMARY_RECENCY = 0\n", Settings{}, true},
		{"[livesync]\nSUMMARY_RECENCY = later\n", Settings{}, true},
		{"[livesync]\nWORKSPACE_MAX_REPOS = 0\n", Settings{}, true},
	}
	for _, c := range cases {
		t.Run(c.ini, func(t *testing.T) {
			cfg, err := setting.NewConfigProviderFromData(c.ini)
			require.NoError(t, err)
			got, err := loadSettings(cfg)
			if c.wantErr {
				assert.Error(t, err)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, c.want, got)
		})
	}
}

// TestInitWithoutDatabase covers the Init outcomes decided before any
// database access, and the lifecycle helpers in the stopped state.
func TestInitWithoutDatabase(t *testing.T) {
	set := func(t *testing.T, ini string, dbType setting.DatabaseType) {
		cfg, err := setting.NewConfigProviderFromData(ini)
		require.NoError(t, err)
		t.Cleanup(test.MockVariableValue(&setting.CfgProvider, cfg))
		t.Cleanup(test.MockVariableValue(&setting.Database.Type, dbType))
	}

	t.Run("disabled", func(t *testing.T) {
		set(t, "", "postgres")
		assert.ErrorIs(t, Init(t.Context()), ErrDisabled)
	})
	t.Run("sqlite", func(t *testing.T) {
		set(t, "[livesync]\nENABLED = true\n", "sqlite3")
		err := Init(t.Context())
		require.ErrorIs(t, err, ErrUnsupportedDatabase)
		assert.Contains(t, err.Error(), "sqlite3")
	})
	t.Run("invalid", func(t *testing.T) {
		set(t, "[livesync]\nENABLED = true\nINSTALL_MODE = x\n", "mysql")
		err := Init(t.Context())
		require.Error(t, err)
		assert.False(t, errors.Is(err, ErrDisabled) || errors.Is(err, ErrUnsupportedDatabase))
	})

	assert.False(t, Running())
	require.Error(t, Context().Err(), "Context of a stopped livesync is done")
	Shutdown() // idempotent when stopped
	assert.False(t, Running())
}

func TestCheckTablesVersion(t *testing.T) {
	require.NoError(t, checkTablesVersion("", false))
	require.NoError(t, checkTablesVersion(strconv.Itoa(TablesVersion), true))
	require.NoError(t, checkTablesVersion("0", true))
	require.Error(t, checkTablesVersion(strconv.Itoa(TablesVersion+1), true))
	require.Error(t, checkTablesVersion("x", true))
}
