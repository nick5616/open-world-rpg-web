package game

// Sky activities (CR 044): the Glide Ring Race at every sky town's
// challenge stand (the towns ACTIVITY prop, Interact 151). E at the stand
// arms a race: a course of twelve gold rings spiralling down round the town's
// island, a few metres wider than you are, each lower than the last by what a
// glider loses. The clock starts when you fly through the first ring (so the
// walk to the rim is free) and stops at the last; landing, leaving the sky
// or the time limit ends the run. Medals (gold / silver / bronze by time) pay
// gold and XP once per half hour per stand per character, a gold medal also
// rolls a relic once per twenty hours; best times are kept per stand
// (migration 0034, sky_race_times) and the top five ride along with every
// arming. Server-authoritative end to end: the course is a pure function of
// the stand and its island, the zone checks your real position every tick
// while you are in a run (nothing runs for anyone else), the client only
// draws the rings it is told about. Event 1706 carries the state.

import (
	"context"
	"encoding/json"
	"math"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/vertical"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/quests"
)

// EventRaceState is the Glide Ring Race's state to its racer (contracts/events.md).
const EventRaceState = 1706

// Race states (Event 1706 value).
const (
	RaceArmed    = 1 // data: the course and the board
	RaceRing     = 2 // a ring flown: data [ring, elapsed ms (u32 LE)]
	RaceFinished = 3 // data: the result
	RaceFailed   = 4 // data: the reason
	RaceDisarmed = 5 // you walked away (or asked to stop)
)

const (
	raceRings   = 12
	raceSpacing = 34.0 // m between rings along the spiral
	raceDrop    = 5.0  // m each ring is lower than the last (a glider loses 2 m per 9 m)
	raceRingR   = 7.5  // m ring radius (drawn)
	racePassM   = 8.5  // m: within this of a ring's centre counts as through it
	raceArmS    = 75   // s to fly the first ring after arming
	raceLimitS  = 110  // s from the first ring to the last
	raceReachM  = 6.0  // m from the stand to arm
	raceKeepTop = 5
	// Medal limits, as multiples of the ideal time (rings-1 intervals at glide speed).
	raceGold   = 1.25
	raceSilver = 1.6
	raceBronze = 2.1
	racePayMin = 30 * 60 // s between payouts per stand per character
	raceItemH  = 20      // h between relic rolls per stand per character
)

var raceIdealS = float64(raceRings-1) * raceSpacing / constants.GlideSpeed

type raceRing struct{ X, Y, Z, NX, NZ float64 }

type raceCourse struct {
	stand uint64
	rings []raceRing
}

type liveRace struct {
	ent      *Entity
	char     string
	name     string
	course   *raceCourse
	next     int
	armedAt  uint32
	startAt  uint32
	lastRing uint32
}

// RaceRow is one stored best time.
type RaceRow struct {
	Stand uint64
	Char  string
	Name  string
	MS    int
	At    time.Time
}

// RaceStore persists best times (nil: zone memory only).
type RaceStore interface {
	LoadRaces(ctx context.Context, worldID string) ([]RaceRow, error)
	SaveRace(ctx context.Context, worldID string, row RaceRow) error
}

type raceState struct {
	live    map[uint32]*liveRace
	courses map[uint64]*raceCourse
	board   map[uint64][]RaceRow // per stand, best per character, fastest first
}

type raceWire struct {
	Stand uint64       `json:"stand"`
	Rings [][5]float64 `json:"rings"`
	R     float64      `json:"r"`
	Gold  int          `json:"gold"`
	Silv  int          `json:"silver"`
	Bron  int          `json:"bronze"`
	Arm   int          `json:"armS"`
	Limit int          `json:"limitS"`
	Best  int          `json:"best"`
	Board []raceTop    `json:"board"`
}

type raceTop struct {
	Name string `json:"n"`
	MS   int    `json:"ms"`
}

func cs2(v float64) float64 { return math.Round(v*100) / 100 }

// raceCourseFor builds (and caches) the stand's course: a descending spiral
// round its island, outside the rim, clear of every other island of the
// archipelago. Pure function of the stand and the descriptor.
func (s *Server) raceCourseFor(stand uint64, x, y, z float64) *raceCourse {
	if c := s.race.courses[stand]; c != nil {
		return c
	}
	vw := s.vertical()
	if vw == nil {
		return nil
	}
	v := vw.Vertical()
	home := -1
	for i := range v.Islands {
		is := &v.Islands[i]
		if math.Hypot(x-is.X, z-is.Z) <= is.R+6 && math.Abs(y-is.Top) < 25 {
			home = i
			break
		}
	}
	if home < 0 {
		return nil
	}
	hi := &v.Islands[home]
	clear := func(rx, ry, rz float64) bool {
		for i := range v.Islands {
			is := &v.Islands[i]
			if i == home {
				if math.Hypot(rx-is.X, rz-is.Z) < is.R+10 {
					return false
				}
				continue
			}
			if math.Hypot(rx-is.X, rz-is.Z) < is.R+14 && ry > is.Top-is.Thick-14 && ry < is.Top+16 {
				return false
			}
		}
		return true
	}
	a0 := math.Atan2(z-hi.Z, x-hi.X)
	for _, extra := range []float64{26, 46, 70, 100} {
		rho := hi.R + extra
		for _, dir := range []float64{1, -1} {
			c := &raceCourse{stand: stand}
			ok := true
			for k := 0; k < raceRings && ok; k++ {
				a := a0 + dir*float64(k+1)*raceSpacing/rho
				rx, rz := hi.X+rho*math.Cos(a), hi.Z+rho*math.Sin(a)
				ry := hi.Top + 4 - raceDrop*float64(k)
				if !clear(rx, ry, rz) {
					ok = false
					break
				}
				// The ring faces along the spiral (the tangent).
				c.rings = append(c.rings, raceRing{X: rx, Y: ry, Z: rz, NX: -dir * math.Sin(a), NZ: dir * math.Cos(a)})
			}
			if ok {
				if s.race.courses == nil {
					s.race.courses = map[uint64]*raceCourse{}
				}
				s.race.courses[stand] = c
				return c
			}
		}
	}
	return nil
}

func (s *Server) raceTopFor(stand uint64) []raceTop {
	var out []raceTop
	for i, r := range s.race.board[stand] {
		if i >= raceKeepTop {
			break
		}
		out = append(out, raceTop{r.Name, r.MS})
	}
	return out
}

func (s *Server) raceBest(stand uint64, char string) int {
	for _, r := range s.race.board[stand] {
		if r.Char == char {
			return r.MS
		}
	}
	return 0
}

// raceInteract is Interact 151 at a stand (reach already checked): arm a run,
// or stop the one you are in.
func (s *Server) raceInteract(sess *session, stand uint64, x, y, z float64) {
	e := sess.ent
	if r := s.race.live[e.ID]; r != nil {
		delete(s.race.live, e.ID)
		s.sendEvent(sess, &proto.Event{Kind: EventRaceState, EntityID: e.ID, TargetID: uint32(stand), Value: RaceDisarmed})
		return
	}
	c := s.raceCourseFor(stand, x, y, z)
	if c == nil {
		s.sendEvent(sess, &proto.Event{Kind: EventActivitySpot, EntityID: e.ID, TargetID: uint32(stand), Value: 0, X: cm(x), Y: cm(y), Z: cm(z), Data: binaryID(stand)})
		return
	}
	if s.race.live == nil {
		s.race.live = map[uint32]*liveRace{}
	}
	s.race.live[e.ID] = &liveRace{ent: e, char: e.CharacterID, name: e.Name, course: c, armedAt: s.tick}
	w := raceWire{Stand: stand, R: raceRingR, Gold: int(raceGold * raceIdealS * 1000), Silv: int(raceSilver * raceIdealS * 1000), Bron: int(raceBronze * raceIdealS * 1000),
		Arm: raceArmS, Limit: raceLimitS, Best: s.raceBest(stand, e.CharacterID), Board: s.raceTopFor(stand)}
	for _, r := range c.rings {
		w.Rings = append(w.Rings, [5]float64{cs2(r.X), cs2(r.Y), cs2(r.Z), cs2(r.NX), cs2(r.NZ)})
	}
	b, _ := json.Marshal(w)
	s.sendEvent(sess, &proto.Event{Kind: EventRaceState, EntityID: e.ID, TargetID: uint32(stand), Value: RaceArmed, X: cm(x), Y: cm(y), Z: cm(z), Data: b})
}

func (s *Server) raceEnd(r *liveRace, state int32, text string) {
	delete(s.race.live, r.ent.ID)
	s.sendEventTo(r.ent, &proto.Event{Kind: EventRaceState, EntityID: r.ent.ID, TargetID: uint32(r.course.stand), Value: state, Data: []byte(text)})
}

// raceTick checks the racers (tick goroutine). Nothing when nobody races.
func (s *Server) raceTick(tick uint32) {
	if len(s.race.live) == 0 {
		return
	}
	for _, r := range s.race.live {
		e := r.ent
		if s.entityByID(e.ID) != e || s.byChar[r.char] == nil || s.byChar[r.char].ent != e {
			delete(s.race.live, e.ID)
			continue
		}
		p := e.Move.Pos
		if r.next == 0 {
			if float64(tick-r.armedAt)/constants.TickRateHz > raceArmS {
				s.raceEnd(r, RaceDisarmed, "")
				continue
			}
		} else {
			el := float64(tick-r.startAt) / constants.TickRateHz
			if el > raceLimitS {
				s.raceEnd(r, RaceFailed, "Out of time.")
				continue
			}
			if e.Move.Mode == movement.ModeGround || e.Move.Mode == movement.ModeSwim || e.layer == layerUnder || e.layer == layerDepths {
				s.raceEnd(r, RaceFailed, "You touched down.")
				continue
			}
			if last := r.course.rings[r.next-1]; p.Y < last.Y-45 {
				s.raceEnd(r, RaceFailed, "You fell out of the course.")
				continue
			}
		}
		g := r.course.rings[r.next]
		if math.Sqrt((p.X-g.X)*(p.X-g.X)+(p.Y-g.Y)*(p.Y-g.Y)+(p.Z-g.Z)*(p.Z-g.Z)) > racePassM {
			continue
		}
		if r.next == 0 {
			r.startAt = tick
		}
		ms := uint32(float64(tick-r.startAt) / constants.TickRateHz * 1000)
		d := []byte{byte(r.next), byte(ms), byte(ms >> 8), byte(ms >> 16), byte(ms >> 24)}
		r.next++
		s.sendEventTo(e, &proto.Event{Kind: EventRaceState, EntityID: e.ID, TargetID: uint32(r.course.stand), Value: RaceRing, Data: d})
		if r.next == len(r.course.rings) {
			s.raceFinish(r, int(ms))
		}
	}
}

type raceResult struct {
	MS    int       `json:"ms"`
	Medal string    `json:"medal"`
	Gold  int       `json:"gold"`
	XP    int       `json:"xp"`
	Rank  int       `json:"rank"`
	PB    bool      `json:"pb"`
	Best  int       `json:"best"`
	Paid  bool      `json:"paid"`
	Relic bool      `json:"relic"`
	Board []raceTop `json:"board"`
}

func raceMedal(ms int) (string, int, int) {
	t := float64(ms) / 1000
	switch {
	case t <= raceGold*raceIdealS:
		return "gold", 100, 140
	case t <= raceSilver*raceIdealS:
		return "silver", 55, 80
	case t <= raceBronze*raceIdealS:
		return "bronze", 25, 40
	}
	return "", 0, 0
}

func (s *Server) raceFinish(r *liveRace, ms int) {
	delete(s.race.live, r.ent.ID)
	e := r.ent
	stand := r.course.stand
	sess := s.byChar[r.char]
	res := raceResult{MS: ms}
	prev := s.raceBest(stand, r.char)
	if prev == 0 || ms < prev {
		res.PB = true
		s.raceRecord(stand, r, ms)
	}
	res.Best = s.raceBest(stand, r.char)
	res.Board = s.raceTopFor(stand)
	for i, row := range s.race.board[stand] {
		if row.Char == r.char {
			res.Rank = i + 1
		}
	}
	medal, gold, xp := raceMedal(ms)
	res.Medal = medal
	if medal != "" && sess != nil && sess.items != nil {
		now := s.cfg.Now()
		marker := "race:" + strconv.FormatUint(stand, 10) + ":" + strconv.FormatInt(now.Unix()/racePayMin, 10)
		if !sess.items.markers[marker] {
			s.questGrant(sess, []quests.ItemQty{{Item: "currency:gold", Qty: gold}}, marker, "glide ring race")
			s.grantCombatXP(combat.XPGrant{Player: e.ID, XP: int64(xp), Reason: "race"})
			res.Gold, res.XP, res.Paid = gold, xp, true
			if medal == "gold" {
				rm := "race-relic:" + strconv.FormatUint(stand, 10) + ":" + strconv.FormatInt(now.Unix()/(raceItemH*3600), 10)
				if got := s.rollRewards(sess, 1, 2.5, 2, rm, "glide ring race"); len(got) > 0 {
					res.Relic = true
				}
			}
		}
	}
	b, _ := json.Marshal(res)
	s.sendEventTo(e, &proto.Event{Kind: EventRaceState, EntityID: e.ID, TargetID: uint32(stand), Value: RaceFinished, Data: b})
}

// raceRecord files a new personal best on the stand's board and persists it.
func (s *Server) raceRecord(stand uint64, r *liveRace, ms int) {
	rows := s.race.board[stand]
	rows = slices.DeleteFunc(rows, func(x RaceRow) bool { return x.Char == r.char })
	row := RaceRow{Stand: stand, Char: r.char, Name: r.name, MS: ms, At: s.cfg.Now()}
	rows = append(rows, row)
	slices.SortFunc(rows, func(a, b RaceRow) int { return a.MS - b.MS })
	if len(rows) > 200 {
		rows = rows[:200]
	}
	if s.race.board == nil {
		s.race.board = map[uint64][]RaceRow{}
	}
	s.race.board[stand] = rows
	if st := s.cfg.RaceStore; st != nil {
		wid := s.cfg.WorldID
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := st.SaveRace(ctx, wid, row); err != nil {
				s.log.Warn("race time not saved", "err", err)
			}
		}()
	}
}

// RestoreRaces loads the world's best times before the zone ticks.
func (s *Server) RestoreRaces(ctx context.Context) (int, error) {
	if s.cfg.RaceStore == nil {
		return 0, nil
	}
	rows, err := s.cfg.RaceStore.LoadRaces(ctx, s.cfg.WorldID)
	if err != nil {
		return 0, err
	}
	if s.race.board == nil {
		s.race.board = map[uint64][]RaceRow{}
	}
	for _, r := range rows {
		s.race.board[r.Stand] = append(s.race.board[r.Stand], r)
	}
	for _, l := range s.race.board {
		slices.SortFunc(l, func(a, b RaceRow) int { return a.MS - b.MS })
	}
	return len(rows), nil
}

// ---- persistence (migration 0034) ----

// PGRaceStore implements RaceStore on the shared Postgres.
type PGRaceStore struct{ Pool *pgxpool.Pool }

func (p *PGRaceStore) LoadRaces(ctx context.Context, worldID string) ([]RaceRow, error) {
	if !uuidRe.MatchString(worldID) {
		return nil, nil
	}
	rows, err := p.Pool.Query(ctx, `SELECT stand_id, character_id, name, best_ms, set_at FROM sky_race_times WHERE world_id = $1::uuid ORDER BY best_ms`, worldID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RaceRow
	for rows.Next() {
		var r RaceRow
		var id int64
		if err := rows.Scan(&id, &r.Char, &r.Name, &r.MS, &r.At); err != nil {
			return nil, err
		}
		r.Stand = uint64(id)
		out = append(out, r)
	}
	return out, rows.Err()
}

func (p *PGRaceStore) SaveRace(ctx context.Context, worldID string, r RaceRow) error {
	if !uuidRe.MatchString(worldID) {
		return errNotUUID
	}
	_, err := p.Pool.Exec(ctx, `INSERT INTO sky_race_times (world_id, stand_id, character_id, name, best_ms, set_at)
		VALUES ($1::uuid, $2, $3, $4, $5, $6)
		ON CONFLICT (world_id, stand_id, character_id) DO UPDATE SET name = EXCLUDED.name, best_ms = EXCLUDED.best_ms, set_at = EXCLUDED.set_at
		WHERE EXCLUDED.best_ms < sky_race_times.best_ms`, worldID, int64(r.Stand), r.Char, r.Name, r.MS, r.At)
	return err
}

// MemRaceStore is an in-process RaceStore (tests; zones of one world may share it).
type MemRaceStore struct {
	mu   sync.Mutex
	rows map[string]map[string]RaceRow // world -> stand:char
}

func NewMemRaceStore() *MemRaceStore { return &MemRaceStore{rows: map[string]map[string]RaceRow{}} }

func (m *MemRaceStore) LoadRaces(_ context.Context, worldID string) ([]RaceRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []RaceRow
	for _, r := range m.rows[worldID] {
		out = append(out, r)
	}
	return out, nil
}

func (m *MemRaceStore) SaveRace(_ context.Context, worldID string, r RaceRow) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	w := m.rows[worldID]
	if w == nil {
		w = map[string]RaceRow{}
		m.rows[worldID] = w
	}
	k := strconv.FormatUint(r.Stand, 10) + ":" + r.Char
	if old, ok := w[k]; !ok || r.MS < old.MS {
		w[k] = r
	}
	return nil
}

var _ = combatdefs.Physical
var _ = vertical.LayerSky
