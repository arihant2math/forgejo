// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/setting"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/services/livesync/catalog"
	"forgejo.org/services/livesync/hub"
	"forgejo.org/services/livesync/materialize"
	"forgejo.org/services/livesync/oauthapp"
	"forgejo.org/services/livesync/synclog"

	"github.com/prometheus/client_golang/prometheus"
)

// States of livesync on this instance (Status.State, the up metric).
const (
	// StateRunning: livesync serves.
	StateRunning = "running"
	// StateDegraded: livesync is enabled but Init failed (e.g. capture
	// triggers missing in INSTALL_MODE verify); Forgejo serves the classic
	// UI and the admin page says why.
	StateDegraded = "degraded"
	// StateStopped: livesync was shut down (or never started).
	StateStopped = "stopped"
)

// State returns this instance's livesync state.
func State() string {
	mu.Lock()
	defer mu.Unlock()
	switch {
	case current != nil && current.ctx.Err() == nil:
		return StateRunning
	case initErr != nil && !errors.Is(initErr, ErrDisabled) && !errors.Is(initErr, ErrUnsupportedDatabase) && !errors.Is(initErr, ErrInvalidSettings):
		return StateDegraded
	}
	return StateStopped
}

// Status is what /-/sync/admin shows: the state of this instance, the
// capture triggers with the DDL to repair or remove them, the positions
// of the pipeline (outbox, sync log, hub) and the sync sessions. Each part
// that cannot be read (e.g. livesync's tables do not exist) is left empty
// and its error listed in Errors.
type Status struct {
	State       string   `json:"state"`
	Error       string   `json:"error,omitempty"`
	InstallMode string   `json:"install_mode"`
	Errors      []string `json:"errors,omitempty"`

	Triggers *TriggerStatus `json:"triggers,omitempty"`
	Outbox   *OutboxStatus  `json:"outbox,omitempty"`
	Log      *LogStatus     `json:"log,omitempty"`
	// Writer: this instance holds the sync log writer lease (runs the
	// outbox reader and the materializer).
	Writer bool `json:"writer"`
	// BackfillPending lists the tracked tables whose entity index walk is
	// not done (their bootstraps answer 503 meanwhile).
	BackfillPending []string      `json:"backfill_pending,omitempty"`
	Hub             *hub.Stats    `json:"hub,omitempty"`
	OAuth           *oauthapp.App `json:"oauth,omitempty"`
}

// TriggerStatus is capture.Inspect's result for the admin page.
type TriggerStatus struct {
	Dialect string `json:"dialect"`
	Schema  string `json:"schema"`
	User    string `json:"user,omitempty"`
	Healthy bool   `json:"healthy"`
	// Counts of objects by state (ok, missing, stale, extra).
	Counts map[capture.State]int `json:"counts"`
	// Problems are the objects that are not ok.
	Problems []TriggerProblem `json:"problems,omitempty"`
	Warnings []string         `json:"warnings,omitempty"`
	// Pending are the tables found broken earlier whose schema epochs are
	// bumped once they are healthy (capture_pending).
	Pending []string `json:"pending,omitempty"`
	// InstallScript is the DDL that installs or repairs the triggers
	// (empty when healthy); UninstallScript the DDL that removes them.
	InstallScript   string `json:"install_script,omitempty"`
	UninstallScript string `json:"uninstall_script,omitempty"`
}

// TriggerProblem is one capture object that is not ok.
type TriggerProblem struct {
	Kind   string        `json:"kind"`
	Table  string        `json:"table,omitempty"`
	Name   string        `json:"name"`
	State  capture.State `json:"state"`
	Detail string        `json:"detail,omitempty"`
}

// OutboxStatus: the capture outbox (livesync_change).
type OutboxStatus struct {
	// LastAssigned is the last id the outbox handed out, Cursor the
	// reader's cursor (everything at or below it is consumed or given up),
	// Backlog their difference: the changes captured but not materialized
	// yet (an upper bound: rolled-back ids count until given up).
	LastAssigned int64 `json:"last_assigned"`
	Cursor       int64 `json:"cursor"`
	Backlog      int64 `json:"backlog"`
}

// LogStatus: the sync log and this instance's position in it.
type LogStatus struct {
	Head  int64 `json:"head"`
	Floor int64 `json:"floor"`
	// WriterToken is the fencing token of the current writer.
	WriterToken string `json:"writer_token,omitempty"`
	// HubPosition is the last sync id this instance's hub received (0 when
	// not running); Lag = Head - HubPosition.
	HubPosition int64 `json:"hub_position,omitempty"`
	Lag         int64 `json:"lag,omitempty"`
}

// statusTopUsers is the number of viewers the admin page lists.
const statusTopUsers = 20

// CollectStatus gathers the admin page's Status. It only reads.
func CollectStatus(ctx context.Context) *Status {
	st := &Status{State: State(), InstallMode: string(Setting.InstallMode)}
	if err := InitError(); err != nil && st.State != StateRunning {
		st.Error = err.Error()
	}
	fail := func(what string, err error) { st.Errors = append(st.Errors, what+": "+err.Error()) }

	if !setting.Database.Type.IsPostgreSQL() && !setting.Database.Type.IsMySQL() {
		return st
	}
	if ins, err := capture.Inspect(ctx); err != nil {
		fail("capture triggers", err)
	} else {
		ts := &TriggerStatus{
			Dialect: ins.Dialect, Schema: ins.Schema, User: ins.User, Healthy: ins.Healthy(),
			Counts: map[capture.State]int{}, Warnings: ins.Warnings,
			InstallScript: ins.Script(), UninstallScript: ins.UninstallScript(),
		}
		for _, o := range ins.Objects {
			ts.Counts[o.State]++
			if o.State != capture.StateOK {
				ts.Problems = append(ts.Problems, TriggerProblem{Kind: o.Kind, Table: o.Table, Name: o.Name, State: o.State, Detail: o.Detail})
			}
		}
		st.Triggers = ts
	}
	exists, err := livesync_model.MetaTableExists(ctx)
	if err != nil {
		fail("livesync tables", err)
	}
	if exists {
		if v, _, err := livesync_model.GetMeta(ctx, capture.MetaPending); err != nil {
			fail("pending repairs", err)
		} else if v != "" && st.Triggers != nil {
			st.Triggers.Pending = splitList(v)
		}
		if ob, err := outboxStatus(ctx); err != nil {
			fail("outbox", err)
		} else {
			st.Outbox = ob
		}
		if ls, err := logStatus(ctx); err != nil {
			fail("sync log", err)
		} else {
			st.Log = ls
		}
		tables := make([]string, 0, len(catalog.Tracked()))
		for _, t := range catalog.Tracked() {
			tables = append(tables, t.Name)
		}
		if pending, err := materialize.BackfillPending(ctx, tables); err != nil {
			fail("entity index backfill", err)
		} else {
			st.BackfillPending = pending
		}
	}

	mu.Lock()
	inst := current
	mu.Unlock()
	if inst != nil && inst.ctx.Err() == nil {
		st.Writer = inst.writing.Load()
		stats := inst.hub.Stats(statusTopUsers)
		st.Hub = &stats
		st.OAuth = inst.oauth
		if st.Log != nil {
			st.Log.HubPosition = stats.Position
			st.Log.Lag = max(st.Log.Head-stats.Position, 0)
		}
	}
	return st
}

func outboxStatus(ctx context.Context) (*OutboxStatus, error) {
	last, err := capture.LastAssignedID(ctx)
	if err != nil {
		return nil, err
	}
	cursor, err := metaInt64(ctx, capture.MetaCursor)
	if err != nil {
		return nil, err
	}
	return &OutboxStatus{LastAssigned: last, Cursor: cursor, Backlog: max(last-cursor, 0)}, nil
}

func logStatus(ctx context.Context) (*LogStatus, error) {
	head, err := synclog.Head(ctx)
	if err != nil {
		return nil, err
	}
	floor, err := synclog.Floor(ctx)
	if err != nil {
		return nil, err
	}
	token, _, err := livesync_model.GetMeta(ctx, synclog.MetaWriter)
	if err != nil {
		return nil, err
	}
	return &LogStatus{Head: head, Floor: floor, WriterToken: token}, nil
}

func metaInt64(ctx context.Context, name string) (int64, error) {
	v, ok, err := livesync_model.GetMeta(ctx, name)
	if err != nil || !ok || v == "" {
		return 0, err
	}
	return strconv.ParseInt(v, 10, 64)
}

func splitList(v string) []string {
	var res []string
	for t := range strings.SplitSeq(v, ",") {
		if t != "" {
			res = append(res, t)
		}
	}
	return res
}

// collector exports the state gauges at scrape time (metrics.Register).
type collector struct{}

var (
	descUp = prometheus.NewDesc("forgejo_livesync_up",
		"1 for livesync's current state on this instance (running, degraded: enabled but not serving, stopped).", []string{"state"}, nil)
	descBacklog = prometheus.NewDesc("forgejo_livesync_outbox_backlog",
		"Changes captured in the outbox but not materialized yet (last assigned outbox id minus the reader's cursor).", nil, nil)
	descHead = prometheus.NewDesc("forgejo_livesync_log_head",
		"The newest sync id of the sync log.", nil, nil)
	descPosition = prometheus.NewDesc("forgejo_livesync_hub_position",
		"The last sync id delivered to this instance's hub (log_head minus it is the fan-out lag in entries).", nil, nil)
	descWriter = prometheus.NewDesc("forgejo_livesync_writer",
		"1 when this instance holds the sync log writer lease.", nil, nil)
	descSessions = prometheus.NewDesc("forgejo_livesync_sessions",
		"Open sync sessions on this instance, by transport.", []string{"transport"}, nil)
	descSubscriptions = prometheus.NewDesc("forgejo_livesync_subscriptions",
		"Group subscriptions of the sync sessions on this instance.", nil, nil)
)

// collectTimeout bounds the database reads of one scrape.
const collectTimeout = 2 * time.Second

func (collector) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range []*prometheus.Desc{descUp, descBacklog, descHead, descPosition, descWriter, descSessions, descSubscriptions} {
		ch <- d
	}
}

func (collector) Collect(ch chan<- prometheus.Metric) {
	state := State()
	for _, s := range []string{StateRunning, StateDegraded, StateStopped} {
		v := 0.0
		if s == state {
			v = 1
		}
		ch <- prometheus.MustNewConstMetric(descUp, prometheus.GaugeValue, v, s)
	}
	if state == StateStopped {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), collectTimeout)
	defer cancel()
	if exists, err := livesync_model.MetaTableExists(ctx); err == nil && exists {
		if ob, err := outboxStatus(ctx); err == nil {
			ch <- prometheus.MustNewConstMetric(descBacklog, prometheus.GaugeValue, float64(ob.Backlog))
		}
		if head, err := synclog.Head(ctx); err == nil {
			ch <- prometheus.MustNewConstMetric(descHead, prometheus.GaugeValue, float64(head))
		}
	}
	mu.Lock()
	inst := current
	mu.Unlock()
	if inst == nil || inst.ctx.Err() != nil {
		return
	}
	writing := 0.0
	if inst.writing.Load() {
		writing = 1
	}
	ch <- prometheus.MustNewConstMetric(descWriter, prometheus.GaugeValue, writing)
	stats := inst.hub.Stats(0)
	ch <- prometheus.MustNewConstMetric(descPosition, prometheus.GaugeValue, float64(stats.Position))
	for transport, n := range stats.Sessions {
		ch <- prometheus.MustNewConstMetric(descSessions, prometheus.GaugeValue, float64(n), transport)
	}
	ch <- prometheus.MustNewConstMetric(descSubscriptions, prometheus.GaugeValue, float64(stats.Subscriptions))
}
