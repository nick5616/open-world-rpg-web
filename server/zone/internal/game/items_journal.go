package game

// The item journal (WP14): every change to an account character's items is
// one ItemOp, applied by one worker goroutine as ONE Postgres transaction,
// strictly in the order the tick made the changes. Why not the write-behind
// queue: it coalesces by key and re-queues a failed op at the back, both of
// which would reorder or drop item changes; items need "the database is
// always a prefix of the zone's history". With that:
//
//   - every op writes absolute state (full rows, deletes), so re-running an
//     op whose COMMIT reply was lost is harmless;
//   - ops that create items from a roll (or take one from the world) carry
//     a loot_grants marker; the marker insert is the first statement, a
//     conflict means "already granted" and nothing else runs (spec 11: a
//     crash can lose a roll but never duplicate one). A conflict with our
//     own op id is a retry of our committed op: success;
//   - the head op is retried (backoff 100 ms .. 5 s) until it commits,
//     never skipped past, so later ops can't land without earlier ones;
//   - an op that can never commit (a genuine duplicate grant, a row that
//     should exist but doesn't) quarantines its character: their remaining
//     queued ops are dropped and the tick kicks them, so memory is discarded
//     and reloaded from the database on reconnect. Lose, never duplicate.
//
// Zone memory stays authoritative for the live game (spec 11); the tick
// never waits on any of this (Enqueue is a mutex and an append).

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"lodestone/server/zone/internal/items"
)

// ItemRow is one row's full state in an op.
type ItemRow struct {
	Item  *items.Item // snapshot (Clone)
	Owner string      // character id; "" = lying in the world
	World *WorldSpot  // set while in the world
}

// WorldSpot is where a dropped item lies and when it despawns.
type WorldSpot struct {
	WorldID   string
	X, Y, Z   float64
	DespawnAt time.Time
	// Chest (CR 025 camps): the item is in this camp storage chest (never
	// despawns, never restored as a pickup; items.camp_piece_id, 0026).
	Chest uint64
}

// GrantMark is the exactly-once marker of a roll or a take.
type GrantMark struct {
	Key  string
	Seed int64
}

// ItemOp is one transaction.
type ItemOp struct {
	ID      string // op uuid (marker retry detection)
	Char    string // the character whose state this is ("" = world-only op)
	Epoch   int64  // WP16 ownership epoch of the writing zone (0 = unfenced, single zone)
	Sync    bool   // full state: rows of Char not in Upsert are deleted, Markers inserted
	Markers []string
	Grant   *GrantMark
	Upsert  []ItemRow // created rows: INSERT .. ON CONFLICT (id) DO UPDATE
	Update  []ItemRow // existing rows: UPDATE (must exist)
	Delete  []string  // DELETE by id
	Take    []string  // world rows that must still lie in the world (owner NULL): taken
	Before  func(ctx context.Context) error
	// Done runs on the tick after the op committed (local-profile takes
	// add the item only once the world row is gone).
	Done    func()
	Note    string // log context
	created time.Time
}

// ItemStore persists items (PGStore implements it).
type ItemStore interface {
	// LoadItems returns a character's items and loot markers (container:,
	// boss:, starter keys). found=false: no character row (bots, dev
	// tickets): items live in memory only.
	LoadItems(ctx context.Context, characterID string) (inv []*items.Item, markers []string, found bool, err error)
	// ApplyItemOp runs one op as a single transaction.
	ApplyItemOp(ctx context.Context, op *ItemOp) error
	// LoadWorldItems returns the items lying in a world (restored as
	// pickups after a restart) and deletes the expired ones.
	LoadWorldItems(ctx context.Context, worldID string, now time.Time) ([]ItemRow, error)
}

// Journal errors.
var (
	// ErrDuplicateGrant: the marker exists with another op id.
	ErrDuplicateGrant = errors.New("items: roll already granted")
	// ErrRowMissing: an update or take found no row in the expected state.
	ErrRowMissing = errors.New("items: row not in the expected state")
	// errLocalGone: a local profile left before its drop's blob could be
	// issued; the world copy is not created (lose, never duplicate).
	errLocalGone = errors.New("items: local profile gone before its save was issued")
	// errItemsFenced: a newer owner (WP16 epoch) already wrote this
	// character; this zone's op is stale and must not land.
	errItemsFenced = errors.New("items: superseded by a newer owner")
)

type journalResult struct {
	char string
	err  error
	op   *ItemOp
}

type itemJournal struct {
	store ItemStore
	log   *slog.Logger

	mu      sync.Mutex
	ops     []*ItemOp
	busy    bool
	pending map[string]int // queued ops per character (WP16 handoff: flushed before the next zone loads)
	results []journalResult
	notify  chan struct{}
	poison  map[string]bool

	applied, retries, quarantined atomic.Int64
	maxDepth                      int
	runDone                       chan struct{} // closed when Run returns (Flush waits for it)
}

func newItemJournal(store ItemStore, log *slog.Logger) *itemJournal {
	return &itemJournal{store: store, log: log, pending: map[string]int{}, notify: make(chan struct{}, 1), poison: map[string]bool{}, maxDepth: 100000, runDone: make(chan struct{})}
}

// Enqueue appends an op (tick goroutine). false: the backlog is full (the
// database has been down a long time); the caller refuses the action.
func (j *itemJournal) Enqueue(op *ItemOp) bool {
	if op.ID == "" {
		op.ID = items.NewID()
	}
	op.created = time.Now()
	j.mu.Lock()
	if len(j.ops) >= j.maxDepth || j.poison[op.Char] {
		j.mu.Unlock()
		return false
	}
	j.ops = append(j.ops, op)
	j.pending[op.Char]++
	j.mu.Unlock()
	select {
	case j.notify <- struct{}{}:
	default:
	}
	return true
}

// Depth is the number of queued ops.
func (j *itemJournal) Depth() int {
	j.mu.Lock()
	defer j.mu.Unlock()
	n := len(j.ops)
	if j.busy {
		n++
	}
	return n
}

// Pending is the number of queued ops for one character.
func (j *itemJournal) Pending(char string) int {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.pending[char]
}

// drainResults hands finished failures to the tick.
func (j *itemJournal) drainResults() []journalResult {
	j.mu.Lock()
	r := j.results
	j.results = nil
	j.mu.Unlock()
	return r
}

// clearPoison lets a quarantined character's new session write again.
func (j *itemJournal) clearPoison(char string) {
	j.mu.Lock()
	delete(j.poison, char)
	j.mu.Unlock()
}

func (j *itemJournal) head() *ItemOp {
	j.mu.Lock()
	defer j.mu.Unlock()
	if len(j.ops) == 0 {
		return nil
	}
	j.busy = true
	return j.ops[0]
}

func (j *itemJournal) pop(op *ItemOp, err error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.busy = false
	if len(j.ops) > 0 && j.ops[0] == op {
		j.ops = j.ops[1:]
	}
	if j.pending[op.Char]--; j.pending[op.Char] <= 0 {
		delete(j.pending, op.Char)
	}
	if err == nil {
		if op.Done != nil {
			j.results = append(j.results, journalResult{char: op.Char, op: op})
		}
		return
	}
	if op.Char == "" {
		// World-only and local-profile ops have nobody to quarantine.
		j.log.Error("item op failed for good", "op", op.ID, "note", op.Note, "err", err)
		return
	}
	if errors.Is(err, errItemsFenced) {
		// The character moved on to a newer owner: this zone's queued ops
		// for it up to this epoch are all stale. Newer ones (it came back)
		// stay.
		keep := j.ops[:0]
		dropped := 0
		for _, o := range j.ops {
			if o.Char == op.Char && o.Epoch <= op.Epoch {
				dropped++
				if j.pending[o.Char]--; j.pending[o.Char] <= 0 {
					delete(j.pending, o.Char)
				}
				continue
			}
			keep = append(keep, o)
		}
		j.ops = keep
		j.results = append(j.results, journalResult{char: op.Char, err: err, op: op})
		j.log.Info("stale item ops fenced (a newer zone owns the character)", "character", op.Char, "epoch", op.Epoch, "dropped", dropped+1)
		return
	}
	// Quarantine: drop the character's remaining ops (they assume this one
	// landed) and tell the tick to kick them.
	j.poison[op.Char] = true
	keep := j.ops[:0]
	dropped := 0
	for _, o := range j.ops {
		if o.Char == op.Char && op.Char != "" {
			dropped++
			if j.pending[o.Char]--; j.pending[o.Char] <= 0 {
				delete(j.pending, o.Char)
			}
			continue
		}
		keep = append(keep, o)
	}
	j.ops = keep
	j.results = append(j.results, journalResult{char: op.Char, err: err, op: op})
	j.quarantined.Add(1)
	j.log.Error("item op failed for good: character quarantined (memory reloads from the database on reconnect)",
		"character", op.Char, "op", op.ID, "note", op.Note, "err", err, "droppedOps", dropped)
}

func permanent(err error) bool {
	return errors.Is(err, ErrDuplicateGrant) || errors.Is(err, ErrRowMissing) || errors.Is(err, errLocalGone) || errors.Is(err, errItemsFenced)
}

// apply runs one op with retries until it commits or fails for good.
// ctxDone stops retrying (shutdown with a deadline).
func (j *itemJournal) apply(ctx context.Context, op *ItemOp) error {
	backoff := 100 * time.Millisecond
	for attempt := 1; ; attempt++ {
		octx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		err := func() error {
			if op.Before != nil {
				if err := op.Before(octx); err != nil {
					return err
				}
				op.Before = nil // done once: a retry must not issue a second blob
			}
			return j.store.ApplyItemOp(octx, op)
		}()
		cancel()
		if err == nil || permanent(err) {
			return err
		}
		j.retries.Add(1)
		if attempt == 1 || attempt%10 == 0 {
			j.log.Warn("item op failed, retrying", "op", op.ID, "character", op.Char, "attempt", attempt, "err", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 5*time.Second)
	}
}

// Run drains the journal until ctx ends.
func (j *itemJournal) Run(ctx context.Context) {
	defer close(j.runDone)
	for {
		op := j.head()
		if op == nil {
			j.mu.Lock()
			j.busy = false
			j.mu.Unlock()
			select {
			case <-ctx.Done():
				return
			case <-j.notify:
			case <-time.After(time.Second):
			}
			continue
		}
		err := j.apply(ctx, op)
		if ctx.Err() != nil && err != nil && !permanent(err) {
			j.mu.Lock()
			j.busy = false
			j.mu.Unlock()
			return // shutdown mid-retry: Flush continues from this op
		}
		if err == nil {
			j.applied.Add(1)
		}
		j.pop(op, err)
	}
}

// Flush applies everything left (shutdown, after the tick stopped) until
// ctx expires.
func (j *itemJournal) Flush(ctx context.Context) error {
	select { // never race Run for the head op
	case <-j.runDone:
	case <-ctx.Done():
		return ctx.Err()
	}
	for {
		op := j.head()
		if op == nil {
			j.mu.Lock()
			j.busy = false
			j.mu.Unlock()
			return nil
		}
		err := j.apply(ctx, op)
		if ctx.Err() != nil && err != nil && !permanent(err) {
			j.log.Error("item journal flush incomplete", "left", j.Depth())
			return ctx.Err()
		}
		if err == nil {
			j.applied.Add(1)
		}
		j.pop(op, err)
	}
}
