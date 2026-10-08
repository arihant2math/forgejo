// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Package idempotency is the store behind the Idempotency-Key layer in front
// of API v1 (PLAN §4.8; the HTTP part is routers/livesync/idempotency.go).
//
// A write carrying Idempotency-Key reserves (user, key) in
// livesync_idempotency before it runs (Begin); the response is stored when it
// completes (Complete) and replayed to every retry with the same key; a retry
// while the first attempt runs gets 409. Each attempt is owned by
// "<instance>/<token>"; an instance holds a database lock named after its id
// for as long as it lives (PostgreSQL advisory lock / MySQL GET_LOCK on a
// pinned connection), so a retry can tell an attempt that is still running
// from one a crash interrupted: the lock of a dead instance is free. An
// interrupted attempt, or one that ended with a 5xx (Release), has an unknown
// outcome: the retry takes the record over (Reservation.Recovered) and, for
// the creates the plan names (issue, comment, review), first looks for the
// entity the earlier attempt may have created (FindDuplicate) before running
// the request again.
//
// The same package waits for the materializer (WaitSynced): the outbox rows
// of a write lie between the outbox positions read before and after it, and
// once none of them is left in the outbox, every sync log entry they produced
// is at or below the log head.
package idempotency

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/log"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/timeutil"
)

// Defaults of Config.
const (
	DefaultTTL      = 7 * 24 * time.Hour
	DefaultSyncWait = 2 * time.Second
)

// MaxKeyLength is the longest Idempotency-Key accepted (the column's size).
const MaxKeyLength = 255

// leasePrefix + an instance id names the database lock an instance holds
// while it lives (MySQL lock names are at most 64 characters: the prefix,
// 16 hex digits, '.' and the 32 digits of MD5(DATABASE()) are 63).
const leasePrefix = "livesync.idem."

// leaseCheckInterval is how often the instance lock's connection is pinged
// (MySQL would otherwise close it after wait_timeout) and, if it died,
// taken again.
var leaseCheckInterval = 30 * time.Second

// Config configures the store.
type Config struct {
	// TTL is how long a record is kept ([livesync] IDEMPOTENCY_TTL).
	TTL time.Duration
	// SyncWait bounds how long a write waits for the materializer before
	// it answers without X-Livesync-Sync-Id ([livesync]
	// IDEMPOTENCY_SYNC_WAIT).
	SyncWait time.Duration
}

// Service is one running instance's idempotency store.
type Service struct {
	cfg Config
	id  string // instance id, 16 hex digits

	mu    sync.Mutex
	lease *livesync_model.Lease // nil while lost

	running sync.Map // owner -> struct{}: attempts running in this process
	signal  Signal
	done    chan struct{}
}

// Start takes the instance lock and keeps it until ctx is done; Stop waits
// for that.
func Start(ctx context.Context, cfg Config) (*Service, error) {
	if cfg.TTL <= 0 {
		cfg.TTL = DefaultTTL
	}
	if cfg.SyncWait < 0 {
		cfg.SyncWait = 0
	}
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return nil, err
	}
	s := &Service{cfg: cfg, id: hex.EncodeToString(b[:]), done: make(chan struct{})}
	lease, err := livesync_model.TryLease(ctx, leasePrefix+s.id)
	if err != nil {
		return nil, fmt.Errorf("livesync: idempotency instance lock: %w", err)
	}
	s.lease = lease
	go s.keepLease(ctx)
	return s, nil
}

// keepLease pings the instance lock's connection and takes the lock again
// if the connection died. While it is lost, a retry on another instance
// takes this instance's running attempts for interrupted ones.
func (s *Service) keepLease(ctx context.Context) {
	defer close(s.done)
	t := time.NewTicker(leaseCheckInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			// Attempts still running hold their records: releasing the
			// lock now would let a retry on another instance take them
			// for crashed ones and run the write a second time.
			s.drain(drainTimeout)
			s.mu.Lock()
			if s.lease != nil {
				s.lease.Release()
				s.lease = nil
			}
			s.mu.Unlock()
			return
		case <-t.C:
		}
		s.mu.Lock()
		if s.lease != nil {
			if err := s.lease.Check(ctx); err != nil && ctx.Err() == nil {
				log.Warn("livesync: idempotency instance lock lost: %v; taking it again", err)
				s.lease.Release()
				s.lease = nil
			}
		}
		if s.lease == nil && ctx.Err() == nil {
			lease, err := livesync_model.TryLease(ctx, leasePrefix+s.id)
			if err != nil {
				log.Error("livesync: idempotency instance lock: %v", err)
			} else {
				s.lease = lease
			}
		}
		s.mu.Unlock()
	}
}

// drainTimeout bounds how long a stopping instance keeps its lock for the
// attempts still running.
var drainTimeout = 10 * time.Second

// drain waits until no attempt runs in this process, at most timeout.
func (s *Service) drain(timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		busy := false
		s.running.Range(func(any, any) bool {
			busy = true
			return false
		})
		if !busy {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	log.Warn("livesync: stopping with idempotent writes still running; a retry may run them again")
}

// Stop waits (at most timeout) until the instance lock is released; the
// context given to Start must be done.
func (s *Service) Stop(timeout time.Duration) bool {
	select {
	case <-s.done:
		return true
	case <-time.After(timeout):
		return false
	}
}

// Notify wakes the writes waiting in WaitSynced: the materializer committed
// a batch, or the tailer delivered entries.
func (s *Service) Notify() { s.signal.Broadcast() }

// Request identifies one keyed request.
type Request struct {
	UserID int64
	Key    string
	Method string
	Path   string // stored for operators; the hash decides
	Hash   string // RequestHash
}

// RequestHash is the fingerprint that tells a retry from another request
// sent with the same key: method, path, query, content type, what the
// credentials may do (scope, repository restriction: a stored response must
// not reach a token that could not have made the request) and body. The
// token itself is not part of it: a client refreshes it between retries.
func RequestHash(method, path, rawQuery, contentType, credentials string, body []byte) string {
	h := sha256.New()
	for _, part := range []string{method, path, rawQuery, contentType, credentials} {
		fmt.Fprintf(h, "%d:%s\n", len(part), part)
	}
	h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}

// ValidKey reports whether key may be used as an Idempotency-Key: 1 to
// MaxKeyLength printable ASCII characters.
func ValidKey(key string) bool {
	if key == "" || len(key) > MaxKeyLength {
		return false
	}
	for i := 0; i < len(key); i++ {
		if key[i] < 0x20 || key[i] > 0x7e {
			return false
		}
	}
	return true
}

// Outcome is what Begin decided.
type Outcome int

const (
	// Run: the caller owns the reservation and must run the request, then
	// Complete or Release it.
	Run Outcome = iota
	// Replay: the key completed; answer with the stored response.
	Replay
	// InFlight: another attempt with the key is running (409).
	InFlight
	// Mismatch: the key was used for a different request (422).
	Mismatch
)

// Begun is Begin's result.
type Begun struct {
	Outcome     Outcome
	Record      *livesync_model.Idempotency // Replay: the completed record
	Reservation *Reservation                // Run
}

// Reservation is a running attempt's claim on a record.
type Reservation struct {
	id    int64
	owner string
	// Low is the outbox position before the record's first attempt ran.
	Low int64
	// Recovered: an earlier attempt with this key was interrupted (crash)
	// or ended with a server error; it may have committed its write.
	Recovered bool
	// Since is when the first attempt was reserved: anything an earlier
	// attempt created was created after it.
	Since timeutil.TimeStamp
}

// errBusy makes Begin start over (a record changed under it).
var errBusy = errors.New("livesync: idempotency record changed concurrently")

// Begin reserves req's key for an attempt of this instance, or says why the
// request must not run.
func (s *Service) Begin(ctx context.Context, req Request) (*Begun, error) {
	for range 3 {
		b, err := s.begin(ctx, req)
		if !errors.Is(err, errBusy) {
			return b, err
		}
	}
	// Records that keep changing under us: someone else is working on
	// the key.
	return &Begun{Outcome: InFlight}, nil
}

func (s *Service) begin(ctx context.Context, req Request) (*Begun, error) {
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return nil, err
	}
	// The outbox position before the attempt: every outbox row the request
	// writes gets a higher id.
	low, err := Position(ctx)
	if err != nil {
		return nil, err
	}
	owner := s.newOwner()
	// Registered before the insert: a concurrent request of this process
	// that reads the record must find its owner running.
	s.running.Store(owner, struct{}{})
	now := timeutil.TimeStampNow()
	path := req.Path
	if len(path) > 1024 {
		path = path[:1024]
	}
	query := `INSERT INTO livesync_idempotency (user_id, idem_key, state, method, path, request_hash, status, sync_id, owner, outbox_low, outbox_high, created_unix, updated_unix)
		VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, ?, ?)`
	if setting.Database.Type.IsMySQL() {
		query += " ON DUPLICATE KEY UPDATE id = id"
	} else {
		query += " ON CONFLICT (user_id, idem_key) DO NOTHING"
	}
	if _, err := e.Exec(query, req.UserID, req.Key, livesync_model.IdempotencyInFlight, req.Method, path, req.Hash, owner, low, now, now); err != nil {
		s.running.Delete(owner)
		return nil, fmt.Errorf("livesync: reserve idempotency key: %w", err)
	}
	rec, has, err := getRecord(ctx, req.UserID, req.Key)
	if err != nil || !has {
		s.running.Delete(owner)
		if err == nil {
			err = errBusy // deleted meanwhile (expired)
		}
		return nil, err
	}
	if rec.Owner == owner && rec.State == livesync_model.IdempotencyInFlight {
		return &Begun{Outcome: Run, Reservation: &Reservation{id: rec.ID, owner: owner, Low: rec.OutboxLow, Since: rec.CreatedUnix}}, nil
	}

	// The key exists already.
	if rec.CreatedUnix < timeutil.TimeStamp(time.Now().Add(-s.cfg.TTL).Unix()) {
		// Expired, not cleaned up yet: as if it did not exist.
		s.running.Delete(owner)
		if _, err := e.Exec("DELETE FROM livesync_idempotency WHERE id = ? AND updated_unix = ?", rec.ID, rec.UpdatedUnix); err != nil {
			return nil, fmt.Errorf("livesync: delete expired idempotency record: %w", err)
		}
		return nil, errBusy
	}
	if rec.RequestHash != req.Hash {
		s.running.Delete(owner)
		return &Begun{Outcome: Mismatch}, nil
	}
	if rec.State == livesync_model.IdempotencyCompleted {
		s.running.Delete(owner)
		return &Begun{Outcome: Replay, Record: rec}, nil
	}
	if s.alive(ctx, rec.Owner) {
		s.running.Delete(owner)
		return &Begun{Outcome: InFlight}, nil
	}
	// The earlier attempt was interrupted or failed: take the record over.
	// Its outbox_low stays: the earlier attempt's rows lie above it too.
	n, err := e.Exec("UPDATE livesync_idempotency SET owner = ?, updated_unix = ? WHERE id = ? AND state = ? AND owner = ?",
		owner, timeutil.TimeStampNow(), rec.ID, livesync_model.IdempotencyInFlight, rec.Owner)
	if err != nil {
		s.running.Delete(owner)
		return nil, fmt.Errorf("livesync: take over idempotency record: %w", err)
	}
	if affected, err := n.RowsAffected(); err != nil || affected != 1 {
		s.running.Delete(owner)
		if err != nil {
			return nil, err
		}
		return nil, errBusy
	}
	return &Begun{Outcome: Run, Reservation: &Reservation{id: rec.ID, owner: owner, Low: rec.OutboxLow, Recovered: true, Since: rec.CreatedUnix}}, nil
}

func (s *Service) newOwner() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return s.id + "/" + hex.EncodeToString(b[:])
}

// alive reports whether the attempt owner may still be running: it runs in
// this process, or its instance still holds its lock. Errors count as
// alive (the retry gets 409 and tries again).
func (s *Service) alive(ctx context.Context, owner string) bool {
	if owner == "" {
		return false // released: the attempt ended without an outcome
	}
	if _, ok := s.running.Load(owner); ok {
		return true
	}
	instance, _, _ := strings.Cut(owner, "/")
	if instance == s.id {
		return false // this process, not running any more
	}
	lease, err := livesync_model.TryLease(ctx, leasePrefix+instance)
	if errors.Is(err, livesync_model.ErrLeaseHeld) {
		return true
	}
	if err != nil {
		log.Warn("livesync: check idempotency instance %s: %v", instance, err)
		return true
	}
	lease.Release()
	return false
}

func getRecord(ctx context.Context, userID int64, key string) (*livesync_model.Idempotency, bool, error) {
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return nil, false, err
	}
	rec := &livesync_model.Idempotency{}
	has, err := e.Where("user_id = ? AND idem_key = ?", userID, key).Get(rec)
	if err != nil {
		return nil, false, fmt.Errorf("livesync: read idempotency record: %w", err)
	}
	return rec, has, nil
}

// Response is what Complete stores.
type Response struct {
	Status  int
	Headers string // JSON object of header name -> values
	Body    []byte
	// SyncID is the X-Livesync-Sync-Id sent, or -1 when it is not known
	// (the wait timed out): a replay computes it from Low and High then.
	SyncID int64
	High   int64 // the outbox position after the attempt
}

// Complete stores the attempt's response; later requests with the key get
// it replayed. It reports false if the reservation was taken over meanwhile
// (this instance looked dead to another one): the response is not stored.
func (s *Service) Complete(ctx context.Context, r *Reservation, resp Response) (bool, error) {
	defer s.running.Delete(r.owner)
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return false, err
	}
	n, err := e.Exec(`UPDATE livesync_idempotency SET state = ?, status = ?, headers = ?, body = ?, sync_id = ?, outbox_high = ?, owner = '', updated_unix = ?
		WHERE id = ? AND owner = ?`,
		livesync_model.IdempotencyCompleted, resp.Status, resp.Headers, resp.Body, resp.SyncID, resp.High, timeutil.TimeStampNow(), r.id, r.owner)
	if err != nil {
		return false, fmt.Errorf("livesync: store idempotent response: %w", err)
	}
	affected, err := n.RowsAffected()
	return affected == 1, err
}

// Release ends the attempt without storing a response: its outcome is
// unknown (a server error, a panic), so the next attempt takes the record
// over as Recovered.
func (s *Service) Release(ctx context.Context, r *Reservation) error {
	defer s.running.Delete(r.owner)
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return err
	}
	if _, err := e.Exec("UPDATE livesync_idempotency SET owner = '', updated_unix = ? WHERE id = ? AND owner = ?", timeutil.TimeStampNow(), r.id, r.owner); err != nil {
		return fmt.Errorf("livesync: release idempotency record: %w", err)
	}
	return nil
}

// StoreSyncID records the sync id a replay computed for a record completed
// without one.
func StoreSyncID(ctx context.Context, rec *livesync_model.Idempotency, syncID int64) error {
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return err
	}
	if _, err := e.Exec("UPDATE livesync_idempotency SET sync_id = ? WHERE id = ? AND sync_id < 0", syncID, rec.ID); err != nil {
		return fmt.Errorf("livesync: store idempotency sync id: %w", err)
	}
	return nil
}

// Cleanup deletes the records older than ttl, in chunks, and returns how
// many it deleted. The sync log writer runs it with the log retention.
func Cleanup(ctx context.Context, ttl time.Duration) (int, error) {
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return 0, err
	}
	cutoff := timeutil.TimeStamp(time.Now().Add(-ttl).Unix())
	deleted := 0
	for {
		var ids []int64
		if err := e.Table("livesync_idempotency").Cols("id").Where("created_unix < ?", cutoff).Limit(1000).Find(&ids); err != nil {
			return deleted, fmt.Errorf("livesync: find expired idempotency records: %w", err)
		}
		if len(ids) == 0 {
			return deleted, nil
		}
		n, err := e.In("id", ids).Delete(&livesync_model.Idempotency{})
		if err != nil {
			return deleted, fmt.Errorf("livesync: delete expired idempotency records: %w", err)
		}
		deleted += int(n)
		if len(ids) < 1000 {
			return deleted, nil
		}
	}
}
