package game

// Discovery-stamped area difficulty in the zone (playtest 1, CR 012,
// docs/decisions/0021-discovery-difficulty.md). The pure rules and the
// stores live in internal/difficulty; this file is the glue:
//
//   - The tick (2 Hz per player, staggered) asks for every unstamped area
//     within difficulty.stampReachM of a player. The claim goes over a
//     channel to one worker goroutine, which reads the stamped neighbours,
//     proposes a level from the player's and inserts it first-writer-wins
//     (Postgres area_difficulty; MemStore without a database). Results come
//     back over another channel and land in the Map (a flat array): every
//     lookup on the tick is O(1) and no tick ever waits on the database.
//   - combat.World reads the Map (World.Areas): atlas groups spawn only in
//     known areas, at the area's level, with its tier's beginner share and
//     elite chance; boss arenas stay empty in the Haven.
//   - Night (night.go) reads it for demon pacing: hunters, greater demons,
//     lords, defense events and demon speed by the area's tier.
//   - Event 901 `area` tells a player the area they stand in (on entering a
//     new one, and when it gets stamped).
//
// A failed claim (database down) falls back to a provisional level from
// what the zone knows; it is used at once and claimed again 30 s later.

import (
	"context"
	"encoding/binary"
	"math"
	"sync/atomic"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/difficulty"
)

// DifficultySetup configures discovery-stamped difficulty (main.go fills
// it; nil = the WP13 region danger curve, as before playtest 1).
type DifficultySetup struct {
	Map   *difficulty.Map
	Store difficulty.Store // nil: an in-process MemStore
}

const (
	diffEveryTicks = 15 // per player, staggered: 2 Hz
	// Event 901 flags.
	AreaFlagHaven        = 1
	AreaFlagStampedByYou = 2
	AreaFlagProvisional  = 4
)

type areaSeen struct {
	cell int
	sent bool
}

type diffState struct {
	on    bool
	m     *difficulty.Map
	geo   *difficulty.Geometry
	store difficulty.Store
	reqs  chan difficulty.Claim
	res   chan difficulty.Stamp
	seen  map[*session]*areaSeen
	near  []int
	// counters (metrics, debug; written by the worker)
	claims, won, lost, failed atomic.Int64
	loaded                    atomic.Bool
}

func (s *Server) initDifficulty() {
	d := s.cfg.Difficulty
	if d == nil || d.Map == nil {
		return
	}
	st := d.Store
	if st == nil {
		st = difficulty.NewMemStore()
	}
	s.diff = diffState{on: true, m: d.Map, geo: d.Map.Geometry(s.cfg.WorldID), store: st,
		reqs: make(chan difficulty.Claim, 512), res: make(chan difficulty.Stamp, 1024), seen: map[*session]*areaSeen{}}
	s.cbt.w.Areas = d.Map
	s.log.Info("difficulty ready", "areas", d.Map.Cells(), "cellM", d.Map.CellM, "store", storeKind(st))
}

func storeKind(st difficulty.Store) string {
	switch st.(type) {
	case *difficulty.PGStore:
		return "postgres"
	case *difficulty.MemStore:
		return "memory"
	}
	return "custom"
}

// startDifficulty starts the claim worker and loads the stamps (off tick).
func (s *Server) startDifficulty() {
	if !s.diff.on {
		return
	}
	d := &s.diff
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		stamps, err := d.store.LoadAll(ctx, d.geo)
		cancel()
		if err != nil {
			s.log.Warn("difficulty: loading stamps failed; areas are claimed as players arrive", "err", err)
		}
		for _, st := range stamps {
			select {
			case d.res <- st:
			case <-s.stopped:
				return
			}
		}
		d.loaded.Store(true)
		s.log.Info("difficulty stamps loaded", "areas", len(stamps))
		for {
			select {
			case <-s.stopped:
				return
			case c := <-d.reqs:
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				st, err := d.store.Claim(ctx, d.geo, c)
				cancel()
				d.claims.Add(1)
				switch {
				case err != nil:
					d.failed.Add(1)
					s.log.Warn("difficulty claim failed; provisional level", "cell", c.Cell, "err", err)
					st = difficulty.Stamp{Cell: c.Cell, Level: d.geo.Propose(c, c.Known), By: c.CharID, ByName: c.Name, ByLevel: c.PlayerLevel, Provisional: true}
				case st.Won:
					d.won.Add(1)
					s.log.Info("area stamped", "cell", c.Cell, "level", st.Level, "by", c.Name, "byLevel", c.PlayerLevel)
				default:
					d.lost.Add(1)
				}
				select {
				case d.res <- st:
				case <-s.stopped:
					return
				}
			}
		}
	}()
}

// AreaTier is the tier and level of the area at (x, z); known=false while
// unstamped. Without difficulty: known=false.
func (s *Server) AreaTier(x, z float64) (*combatdefs.DifficultyTier, int, bool) {
	if !s.diff.on {
		return nil, 0, false
	}
	m := s.diff.m
	c := m.Cell(x, z)
	l, ok := m.Level(c)
	if !ok {
		return nil, 0, false
	}
	t, _, _ := m.Tier(c)
	return t, l, true
}

// difficultyTick drains stamps and sends claims (tick goroutine).
func (s *Server) difficultyTick(tick uint32) {
	d := &s.diff
	if !d.on {
		return
	}
	m := d.m
	for drained := 0; drained < 256; drained++ {
		var st difficulty.Stamp
		select {
		case st = <-d.res:
		default:
			drained = 256
			continue
		}
		m.Set(st, tick)
		for _, sess := range s.sessions {
			if e := sess.ent; e != nil && m.Cell(e.Move.Pos.X, e.Move.Pos.Z) == st.Cell {
				byYou := st.Won && st.By == e.CharacterID
				s.sendArea(sess, st.Cell, byYou)
			}
		}
	}
	if tick%30 == 0 {
		for sess := range d.seen {
			if sess.left {
				delete(d.seen, sess)
			}
		}
	}
	reach := combatdefs.D.Difficulty.StampReachM
	for _, sess := range s.sessions {
		e := sess.ent
		if e == nil || (tick+e.ID)%diffEveryTicks != 0 {
			continue
		}
		x, z := e.Move.Pos.X, e.Move.Pos.Z
		level := int(e.Level)
		if e.x != nil {
			level = e.x.prog.Level
		}
		d.near = m.Near(x, z, reach, d.near[:0])
		for _, c := range d.near {
			if !m.NeedsClaim(c, tick) {
				continue
			}
			known := map[int]int{}
			for _, n := range m.Neighbours(c) {
				if l, ok := m.Level(n); ok {
					known[n] = l
				}
			}
			select {
			case d.reqs <- difficulty.Claim{Cell: c, PlayerLevel: max(1, level), CharID: e.CharacterID, Name: e.Name, Known: known}:
				m.SetPending(c, true)
			default: // the worker is behind: ask again on the next pass
			}
		}
		c := m.Cell(x, z)
		sn := d.seen[sess]
		if sn == nil {
			sn = &areaSeen{cell: -1}
			d.seen[sess] = sn
		}
		if sn.cell != c {
			sn.cell, sn.sent = c, false
		}
		if !sn.sent {
			if _, ok := m.Level(c); ok {
				s.sendArea(sess, c, false)
			}
		}
	}
}

// difficultyJoin tells a joining player their area (if it is known yet).
func (s *Server) difficultyJoin(sess *session) {
	if !s.diff.on || sess.ent == nil {
		return
	}
	c := s.diff.m.Cell(sess.ent.Move.Pos.X, sess.ent.Move.Pos.Z)
	s.diff.seen[sess] = &areaSeen{cell: c}
	if _, ok := s.diff.m.Level(c); ok {
		s.sendArea(sess, c, false) // marks it sent: the tick won't repeat it
	}
}

// EncodeArea is the area (901) payload: u8 version (1) | u8 tier index |
// u8 flags (1 Haven, 2 stamped just now by you, 4 provisional) | u16 cell
// size m | u16 discoverer's level then | UTF-8 discoverer name (rest).
func EncodeArea(tier, flags, cellM, byLevel int, by string) []byte {
	b := []byte{1, byte(tier), byte(flags)}
	b = binary.LittleEndian.AppendUint16(b, uint16(cellM))
	b = binary.LittleEndian.AppendUint16(b, uint16(max(0, byLevel)))
	return append(b, by...)
}

func (s *Server) sendArea(sess *session, c int, byYou bool) {
	d := &s.diff
	m := d.m
	l, ok := m.Level(c)
	if !ok || sess.ent == nil {
		return
	}
	_, ti, _ := m.Tier(c)
	flags := 0
	if m.Haven(c) {
		flags |= AreaFlagHaven
	}
	if byYou {
		flags |= AreaFlagStampedByYou
	}
	if !m.Haven(c) && !m.Stamped(c) {
		flags |= AreaFlagProvisional
	}
	x, z := m.Center(c)
	by := m.By(c)
	byLevel := 0
	if byYou && sess.x != nil {
		byLevel = sess.x.prog.Level
	}
	s.sendEvent(sess, &proto.Event{Kind: EventArea, EntityID: sess.ent.ID, TargetID: uint32(c), Value: int32(l), X: cm(x), Z: cm(z),
		Data: EncodeArea(ti, flags, int(m.CellM), byLevel, by)})
	if sn := d.seen[sess]; sn != nil && sn.cell == c {
		sn.sent = true
	}
}

// ---- demon pacing (night.go asks) ----

// huntersFor is how many lesser demons hunt e tonight and the greater-demon
// chance multiplier: the WP15 numbers scaled by the area's tier (playtest
// 1). ok=false: none (an unknown area, a tier without demons, or a
// low-level player near a ward).
func (s *Server) huntersFor(e *Entity, base int, scale float64) (want int, greater float64, ok bool) {
	if !s.diff.on {
		return base, 1, base > 0
	}
	t, _, known := s.AreaTier(e.Move.Pos.X, e.Move.Pos.Z)
	if !known || t.Demons <= 0 {
		return 0, 0, false
	}
	def := &combatdefs.D.Difficulty
	if e.x != nil && e.x.prog.Level < def.DemonSafeBelow && s.night.cfg.World.NearWard(e.Move.Pos.X, e.Move.Pos.Z, def.DemonSafeMarginM) >= 0 {
		return 0, 0, false // towns stay safe havens a little past their gardens for low-level players
	}
	want = int(math.Round(constants.DemonPerPlayer * scale * t.Demons))
	return want, t.Greater, want > 0 || t.Greater > 0
}

// demonSpotOK: demons never rise in an unknown area or one whose tier has
// none (the Haven next door, quiet lands).
func (s *Server) demonSpotOK(x, z float64) bool {
	if !s.diff.on {
		return true
	}
	t, _, ok := s.AreaTier(x, z)
	return ok && t.Demons > 0
}

// demonSpeed slows demons in gentle tiers (playtest 1).
func (s *Server) demonSpeed(x, z float64) float64 {
	if t, _, ok := s.AreaTier(x, z); ok && t.DemonSpeed > 0 {
		return t.DemonSpeed
	}
	return 1
}

// lordsAllowed / defenseAllowed: the area's tier lets lords rise / a town's
// ward falter (without difficulty: always).
func (s *Server) lordsAllowed(x, z float64) bool {
	if !s.diff.on {
		return true
	}
	t, _, ok := s.AreaTier(x, z)
	return ok && t.Lords
}

func (s *Server) defenseAllowed(x, z float64) bool {
	if !s.diff.on {
		return true
	}
	t, _, ok := s.AreaTier(x, z)
	return ok && t.Defense
}

// DifficultyDebug is the /debug/difficulty snapshot (tick goroutine via Do).
type DifficultyDebug struct {
	On      bool              `json:"on"`
	CellM   float64           `json:"cellM"`
	PerEdge int               `json:"perEdge"`
	Loaded  bool              `json:"loaded"`
	Claims  int64             `json:"claims"`
	Won     int64             `json:"won"`
	Lost    int64             `json:"lost"`
	Failed  int64             `json:"failed"`
	Areas   []AreaDebug       `json:"areas"`
	Players []AreaPlayerDebug `json:"players"`
}

// AreaDebug is one known area.
type AreaDebug struct {
	Cell        int    `json:"cell"`
	CX          int    `json:"cx"`
	CZ          int    `json:"cz"`
	Level       int    `json:"level"`
	Tier        string `json:"tier"`
	Haven       bool   `json:"haven,omitempty"`
	Provisional bool   `json:"provisional,omitempty"`
	By          string `json:"by,omitempty"`
}

// AreaPlayerDebug is where a player stands.
type AreaPlayerDebug struct {
	Name  string `json:"name"`
	Level int    `json:"level"`
	Cell  int    `json:"cell"`
}

// Difficulty returns the debug snapshot (any goroutine).
func (s *Server) Difficulty(ctx context.Context) (DifficultyDebug, error) {
	var out DifficultyDebug
	err := s.Do(ctx, func() { out = s.difficultyDebug() })
	return out, err
}

func (s *Server) difficultyDebug() DifficultyDebug {
	d := &s.diff
	out := DifficultyDebug{On: d.on}
	if !d.on {
		return out
	}
	m := d.m
	out.CellM, out.PerEdge, out.Loaded = m.CellM, m.PerEdge, d.loaded.Load()
	out.Claims, out.Won, out.Lost, out.Failed = d.claims.Load(), d.won.Load(), d.lost.Load(), d.failed.Load()
	for c := 0; c < m.Cells(); c++ {
		l, ok := m.Level(c)
		if !ok {
			continue
		}
		t, _, _ := m.Tier(c)
		cx, cz := m.XZ(c)
		out.Areas = append(out.Areas, AreaDebug{Cell: c, CX: cx, CZ: cz, Level: l, Tier: t.Key, Haven: m.Haven(c), Provisional: !m.Haven(c) && !m.Stamped(c), By: m.By(c)})
	}
	for _, sess := range s.sessions {
		if e := sess.ent; e != nil {
			out.Players = append(out.Players, AreaPlayerDebug{Name: e.Name, Level: int(e.Level), Cell: m.Cell(e.Move.Pos.X, e.Move.Pos.Z)})
		}
	}
	return out
}
