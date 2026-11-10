package game

// World events (CR 023, contracts/content.yaml events): timed, zone-owned
// happenings announced to the players near them (Event 1010: a toast, a
// compass and map marker, a progress line): a star falls (a starmetal
// guardian; the shard's ore and a rolled item for everyone who helped), a
// caravan under bandit attack (waves; the caravan's health drops while
// bandits stand near it), the Thornhide Behemoth roaming from region to
// region, the Wild Hunt at night, and the Glintfox that flees with a hoard.
//
// Scheduling: every scheduler.everyS the zone looks at each of its players
// (in id order) with no event within minGapM and none of their own for
// playerCooldownS, and content.PickEvent (seed, slot, player) decides; the
// spot must be open walkable ground outside settlements that this zone owns
// (WP16: whoever owns the region runs the event; players are handed off to
// that zone as they walk there; ghost-band players on the next zone don't
// see the announcement until they cross). Enemies are ordinary combat
// groups at the area's level (CR 012), retired when the event ends.
// Rewards are personal: each participant (eligible on a kill of the
// event's creatures, or within its radius when it is won) rolls their own.
// Nothing is persisted: an event is minutes long and a restart drops it.

import (
	"encoding/json"
	"math"
	"strconv"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/contentdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/weather"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/content"
	"lodestone/server/zone/internal/items"
	"lodestone/server/zone/internal/quests"
)

// Event phases (Event 1010 value).
const (
	EventPhaseActive  = 1
	EventPhaseWon     = 2
	EventPhaseFailed  = 3
	EventPhaseUpdated = 4 // progress changed (same as active for the HUD)
)

type worldEvent struct {
	id         uint32
	kind       *contentdefs.EventKind
	pos        movement.Vec3
	origin     movement.Vec3
	startTick  uint32
	endTick    uint32
	salt       uint64
	groups     []*combat.Group
	wave       int
	waveAt     uint32
	hp         float64 // caravan health
	leg        int     // behemoth roam legs
	legAt      uint32
	parts      map[uint32]bool // participant entity ids
	told       map[string]bool // characters told
	progress   int             // last sent progress (%)
	done       bool
	engaged    bool
	escapeTick uint32 // glintfox: it escapes at this tick once spooked
}

type eventsState struct {
	active   []*worldEvent
	nextID   uint32
	lastFor  map[string]uint32 // char -> tick of the last event started for them
	disabled bool
}

func (s *Server) eventsEnabled() bool {
	return s.cfg.Explore != nil && s.cfg.Towns != nil && s.cbt.w != nil && s.cbt.w.Atlas != nil
}

// SetWorldEvents turns the scheduler on/off (tests, tools).
func (s *Server) SetWorldEvents(on bool) { s.cnt.ev.disabled = !on }

func (s *Server) worldEventsTick(tick uint32) {
	if !s.eventsEnabled() {
		return
	}
	ev := &s.cnt.ev
	sc := &contentdefs.D.Events.Scheduler
	every := uint32(math.Max(1, sc.EveryS*constants.TickRateHz))
	if tick%every == 0 && len(s.sessions) > 0 && !ev.disabled {
		s.scheduleEvents(int64(tick / every))
	}
	if tick%15 == 0 {
		for _, w := range ev.active {
			s.stepEvent(w, tick)
		}
		keep := ev.active[:0]
		for _, w := range ev.active {
			if !w.done {
				keep = append(keep, w)
			}
		}
		ev.active = keep
	}
}

func (s *Server) isNightNow() bool { return weather.IsNight(s.worldTimeS()) }

func (s *Server) ownsPoint(x, z float64) bool {
	if !s.clusterOn() {
		return true
	}
	own := s.cl.c.Owners()
	if own == nil {
		return true
	}
	o := own.OwnerAt(x, z)
	return o == "" || o == s.cl.self
}

// eventSpotOK: open walkable ground, in the world, away from towns, owned here.
func (s *Server) eventSpotOK(x, z float64) bool {
	ws := float64(constants.WorldSizeM)
	if x < 40 || z < 40 || x > ws-40 || z > ws-40 || !s.ownsPoint(x, z) {
		return false
	}
	g := s.cfg.Ground
	y := g.HeightAt(x, z)
	if movement.WaterAt(g, x, z) > y-0.3 || movement.SlopeAt(g, x, z).T2 > constants.WalkableTanSq {
		return false
	}
	for i := range s.cfg.Towns.T.Settlements {
		st := &s.cfg.Towns.T.Settlements[i]
		if math.Hypot(st.X-x, st.Z-z) < st.Radius+80 {
			return false
		}
	}
	return true
}

func (s *Server) scheduleEvents(slot int64) {
	ev := &s.cnt.ev
	sc := &contentdefs.D.Events.Scheduler
	if ev.lastFor == nil {
		ev.lastFor = map[string]uint32{}
	}
	night := s.isNightNow()
	cool := uint32(sc.PlayerCooldownS * constants.TickRateHz)
	for _, sess := range s.sessions {
		if len(ev.active) >= sc.MaxActive {
			return
		}
		e := sess.ent
		if e == nil || sess.cnt == nil {
			continue
		}
		if t, ok := ev.lastFor[e.CharacterID]; ok && s.tick-t < cool {
			continue
		}
		p := e.Move.Pos
		if s.cfg.Ground.HeightAt(p.X, p.Z)-p.Y > 6 {
			continue // underground
		}
		near := false
		for _, w := range ev.active {
			near = near || math.Hypot(w.pos.X-p.X, w.pos.Z-p.Z) < sc.MinGapM
		}
		if near {
			continue
		}
		pick, ok := content.PickEvent(s.cfg.Seed, slot, hashString64(e.CharacterID), night)
		if !ok {
			continue
		}
		s.startEventNear(sess, pick)
	}
}

func (s *Server) startEventNear(sess *session, pick content.EventPick) *worldEvent {
	p := sess.ent.Move.Pos
	for k := 0; k < 6; k++ {
		a := pick.Angle + float64(k)*math.Pi/3
		x, z := p.X+pick.Dist*math.Cos(a), p.Z+pick.Dist*math.Sin(a)
		if s.eventSpotOK(x, z) {
			s.cnt.ev.lastFor[sess.ent.CharacterID] = s.tick
			return s.startEvent(pick.Kind, movement.Vec3{X: x, Y: s.cfg.Ground.HeightAt(x, z), Z: z}, pick.Salt)
		}
	}
	return nil
}

// devStartEvent starts kind (1-based id; 0 = a seeded pick) ~60 m ahead of you (dev builds).
func (s *Server) devStartEvent(sess *session, kind int) bool {
	if !s.eventsEnabled() {
		return false
	}
	var k *contentdefs.EventKind
	if kind >= 1 && kind <= len(contentdefs.D.Events.Kinds) {
		k = &contentdefs.D.Events.Kinds[kind-1]
	} else {
		k = &contentdefs.D.Events.Kinds[0]
	}
	if s.cnt.ev.lastFor == nil {
		s.cnt.ev.lastFor = map[string]uint32{}
	}
	e := sess.ent
	salt := content.Mix(uint64(s.tick) ^ hashString64(e.CharacterID))
	for k2 := 0; k2 < 12; k2++ {
		a := -e.Yaw - math.Pi/2 + float64(k2)*math.Pi/6 // ahead of the camera first
		fx, fz := -math.Sin(e.Yaw), -math.Cos(e.Yaw)
		if k2 > 0 {
			fx, fz = math.Cos(a), math.Sin(a)
		}
		x, z := e.Move.Pos.X+fx*60, e.Move.Pos.Z+fz*60
		if s.eventSpotOK(x, z) {
			s.startEvent(k, movement.Vec3{X: x, Y: s.cfg.Ground.HeightAt(x, z), Z: z}, salt)
			return true
		}
	}
	return false
}

// WorldEventsDebug lists active events (tests, tools).
func (s *Server) WorldEventsDebug() []map[string]any {
	var out []map[string]any
	for _, w := range s.cnt.ev.active {
		out = append(out, map[string]any{"id": w.id, "kind": w.kind.Key, "x": w.pos.X, "z": w.pos.Z, "wave": w.wave, "hp": w.hp, "done": w.done})
	}
	return out
}

func (s *Server) addEventGroup(w *worldEvent, comp []string, at movement.Vec3, radius float64, elite string) *combat.Group {
	g := s.cbt.w.AddGroup(&combat.Group{Kind: combat.GroupTest, Anchor: at, Radius: radius, Comp: comp, Elite: elite, Site: -1,
		Name: w.kind.Name, AreaLevel: true, Level: s.lootLevelAt(at.X, at.Z, 1), Biome: s.biomeAt(at.X, at.Z), Element: 8})
	w.groups = append(w.groups, g)
	return g
}

func (s *Server) startEvent(k *contentdefs.EventKind, at movement.Vec3, salt uint64) *worldEvent {
	ev := &s.cnt.ev
	ev.nextID++
	id := uint32(hashString64(s.cfg.ZoneID)&0xff)<<24 | ev.nextID&0xffffff
	hz := float64(constants.TickRateHz)
	w := &worldEvent{id: id, kind: k, pos: at, origin: at, startTick: s.tick, endTick: s.tick + uint32(k.DurationS*hz), salt: salt,
		parts: map[uint32]bool{}, told: map[string]bool{}, hp: k.CaravanHP, progress: -1}
	switch k.Key {
	case "caravan":
		// waves spawn as the fight goes (stepEvent)
	case "behemoth":
		s.addEventGroup(w, k.Comp, at, 6, k.Elite)
	default:
		s.addEventGroup(w, k.Comp, at, math.Min(k.Radius*0.4, 10), k.Elite)
	}
	ev.active = append(ev.active, w)
	s.log.Info("world event", "id", id, "kind", k.Key, "x", math.Round(at.X), "z", math.Round(at.Z))
	s.announceEvent(w, EventPhaseActive, true)
	return w
}

func (s *Server) eventData(w *worldEvent, phase int) []byte {
	k := w.kind
	left := int64(0)
	if w.endTick > s.tick {
		left = int64(w.endTick-s.tick) * 1000 / constants.TickRateHz
	}
	text := k.Announce
	switch phase {
	case EventPhaseWon:
		text = k.Success
	case EventPhaseFailed:
		text = k.Fail
	}
	where := "here"
	if tw := s.cfg.Towns; tw != nil {
		best, bd := -1, math.Inf(1)
		for i := range tw.T.Settlements {
			if d := math.Hypot(tw.T.Settlements[i].X-w.pos.X, tw.T.Settlements[i].Z-w.pos.Z); d < bd {
				best, bd = i, d
			}
		}
		if best >= 0 {
			st := &tw.T.Settlements[best]
			where = quests.Where(st.X, st.Z, w.pos.X, w.pos.Z, s.settlementName(best))
		}
	}
	text = content.Fill(text, map[string]string{"where": where})
	b, _ := json.Marshal(struct {
		ID       uint32  `json:"id"`
		Kind     string  `json:"kind"`
		Name     string  `json:"name"`
		Text     string  `json:"text"`
		Phase    int     `json:"phase"`
		EndsInMs int64   `json:"endsInMs"`
		Progress int     `json:"progress"`
		X        float64 `json:"x"`
		Y        float64 `json:"y"`
		Z        float64 `json:"z"`
		R        float64 `json:"r"`
		Wave     int     `json:"wave,omitempty"`
		Waves    int     `json:"waves,omitempty"`
		HP       int     `json:"hp,omitempty"`
	}{w.id, k.Key, k.Name, text, phase, left, w.progress, math.Round(w.pos.X*10) / 10, math.Round(w.pos.Y*10) / 10, math.Round(w.pos.Z*10) / 10, k.Radius,
		w.wave, len(k.Waves), int(math.Ceil(w.hp))})
	return b
}

// announceEvent sends Event 1010 to the players in range (all = also those
// told before; else only newcomers).
func (s *Server) announceEvent(w *worldEvent, phase int, all bool) {
	sc := &contentdefs.D.Events.Scheduler
	r := sc.AnnounceM
	if phase == EventPhaseWon || phase == EventPhaseFailed {
		r *= 1.5
	}
	var data []byte
	for _, sess := range s.sessions {
		e := sess.ent
		if e == nil || sess.cnt == nil {
			continue
		}
		in := math.Hypot(e.Move.Pos.X-w.pos.X, e.Move.Pos.Z-w.pos.Z) <= r
		told := w.told[e.CharacterID]
		if !(in && (all || !told)) && !(told && all && (phase == EventPhaseWon || phase == EventPhaseFailed)) {
			continue
		}
		if data == nil {
			data = s.eventData(w, phase)
		}
		w.told[e.CharacterID] = true
		s.sendEvent(sess, &proto.Event{Kind: EventWorldEvent, EntityID: e.ID, TargetID: w.id, Value: int32(phase),
			X: cm(w.pos.X), Y: cm(w.pos.Y), Z: cm(w.pos.Z), Data: data})
	}
}

func groupDead(g *combat.Group) bool {
	if g == nil || g.Retired {
		return true
	}
	if g.Spawned {
		for _, m := range g.Members {
			if m.Alive() {
				return false
			}
		}
		return true
	}
	return g.Cleared()
}

func groupAlive(g *combat.Group) int {
	n := 0
	if g != nil && g.Spawned {
		for _, m := range g.Members {
			if m.Alive() {
				n++
			}
		}
	}
	return n
}

// stepEvent runs one event twice a second.
func (s *Server) stepEvent(w *worldEvent, tick uint32) {
	if w.done {
		return
	}
	k := w.kind
	hz := float64(constants.TickRateHz)
	won := false
	progress := w.progress
	switch k.Key {
	case "caravan":
		players := len(s.playersNear(w.pos.X, w.pos.Z, k.Radius+30))
		if players > 0 {
			w.engaged = true
		}
		if w.engaged {
			if w.wave == 0 || (w.wave < len(k.Waves) && groupDead(w.groups[len(w.groups)-1]) && tick >= w.waveAt) {
				a := float64(w.salt%628)/100 + float64(w.wave)*2.1
				at := movement.Vec3{X: w.pos.X + 9*math.Cos(a), Z: w.pos.Z + 9*math.Sin(a)}
				at.Y = s.cfg.Ground.HeightAt(at.X, at.Z)
				s.addEventGroup(w, k.Waves[w.wave], at, 5, "")
				w.wave++
				w.waveAt = tick + uint32(4*hz)
			}
			bandits := 0
			for _, g := range w.groups {
				for _, m := range g.Members {
					if m.Alive() && math.Hypot(m.Pos.X-w.pos.X, m.Pos.Z-w.pos.Z) <= 18 {
						bandits++
					}
				}
			}
			w.hp = math.Max(0, w.hp-float64(bandits)*k.DamagePerBandit*0.5)
			if w.hp <= 0 {
				s.endEvent(w, false)
				return
			}
			if w.wave == len(k.Waves) && groupDead(w.groups[len(w.groups)-1]) {
				won = true
			}
		}
		progress = int(math.Round(w.hp / math.Max(1, k.CaravanHP) * 100))
	case "behemoth":
		g := w.groups[0]
		if (g.Spawned || g.Cleared()) && groupDead(g) {
			won = true
			break
		}
		// Roam: a new leg every ~12 s while it isn't fighting.
		fighting := false
		for _, m := range g.Members {
			fighting = fighting || (m.Alive() && m.State != combat.Idle && m.State != combat.Asleep)
		}
		if !fighting && tick >= w.legAt {
			for turn := 0; turn < 6; turn++ {
				x, z := content.RoamLeg(w.salt, w.leg, w.pos.X, w.pos.Z, k.RoamLegM*0.25, turn)
				if s.eventSpotOK(x, z) {
					w.pos = movement.Vec3{X: x, Y: s.cfg.Ground.HeightAt(x, z), Z: z}
					s.cbt.w.MoveGroup(g, w.pos)
					break
				}
			}
			w.leg++
			w.legAt = tick + uint32(k.RoamLegM*0.25/math.Max(0.5, k.RoamSpeed)*hz)
			s.announceEvent(w, EventPhaseUpdated, true)
		}
		if g.Spawned && len(g.Members) > 0 {
			hp, max := 0.0, 0.0
			for _, m := range g.Members {
				hp, max = hp+math.Max(0, m.HP), max+m.HPMax
			}
			if max > 0 {
				progress = int(math.Round(hp / max * 100))
			}
		}
	case "glintfox":
		g := w.groups[0]
		if (g.Spawned || g.Cleared()) && groupDead(g) {
			won = true
			break
		}
		if g.Spawned && len(g.Members) > 0 {
			m := g.Members[0]
			w.pos = m.Pos
			if m.AggroTick != 0 && w.escapeTick == 0 {
				w.escapeTick = tick + uint32(45*hz) // spooked: 45 s to catch it
				if w.escapeTick < w.endTick {
					w.endTick = w.escapeTick
				}
			}
			if hp := int(math.Round(m.HP / math.Max(1, m.HPMax) * 100)); hp != progress {
				progress = hp
			}
		}
	default: // starfall, wildhunt
		g := w.groups[0]
		if g.Spawned && groupDead(g) || g.Cleared() {
			won = true
			break
		}
		if g.Spawned {
			alive := groupAlive(g)
			progress = int(math.Round(float64(alive) / float64(max(1, len(g.Members))) * 100))
		}
	}
	if won {
		s.endEvent(w, true)
		return
	}
	if tick >= w.endTick {
		s.endEvent(w, false)
		return
	}
	if progress != w.progress && (w.progress < 0 || absI(progress-w.progress) >= 10 || progress == 0) {
		w.progress = progress
		s.announceEvent(w, EventPhaseUpdated, true)
	} else {
		s.announceEvent(w, EventPhaseActive, false) // newcomers in range
	}
}

func absI(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// eventsOnKill records participants of event fights.
func (s *Server) eventsOnKill(k combat.KillInfo) {
	en := k.Enemy
	if en.Group == nil {
		return
	}
	for _, w := range s.cnt.ev.active {
		for _, g := range w.groups {
			if g == en.Group {
				for _, id := range k.Eligible {
					w.parts[id] = true
				}
				return
			}
		}
	}
}

func (s *Server) endEvent(w *worldEvent, won bool) {
	w.done = true
	k := w.kind
	phase := EventPhaseFailed
	if won {
		phase = EventPhaseWon
		for _, e := range s.playersNear(w.pos.X, w.pos.Z, k.Radius+30) {
			w.parts[e.ID] = true
		}
	}
	w.progress = 0
	s.announceEvent(w, phase, true)
	for _, g := range w.groups {
		if !won || g.Spawned {
			s.cbt.w.RetireGroup(g)
		} else {
			s.cbt.w.RetireGroup(g) // cleared groups must not respawn either
		}
	}
	n := 0
	if won {
		for id := range w.parts {
			if pe := s.entityByID(id); pe != nil && pe.Kind == proto.EntityKindPlayer {
				if sess := s.byChar[pe.CharacterID]; sess != nil && sess.cnt != nil {
					s.eventReward(sess, w)
					n++
				}
			}
		}
	}
	s.log.Info("world event ended", "id", w.id, "kind", k.Key, "won", won, "rewarded", n)
}

func (s *Server) eventReward(sess *session, w *worldEvent) {
	k := w.kind
	e := sess.ent
	marker := "event:" + strconv.FormatUint(uint64(w.id), 16) + ":" + strconv.FormatUint(uint64(w.startTick), 16)
	gold, ore, gems := content.Rewards(k, w.salt, hashString64(e.CharacterID))
	var list []quests.ItemQty
	if gold > 0 {
		list = append(list, quests.ItemQty{Item: "currency:gold", Qty: gold})
	}
	if k.Reward.Ore != "" && ore > 0 {
		list = append(list, quests.ItemQty{Item: k.Reward.Ore, Qty: ore})
	}
	if len(list) > 0 {
		s.questGrant(sess, list, marker, "event "+k.Key)
	}
	if gems > 0 && sess.items != nil {
		r := items.NewRNG(items.Mix64(w.salt ^ hashString(e.CharacterID)))
		var d items.Delta
		var got []*items.Item
		for i := 0; i < gems; i++ {
			g := items.RollGem(r, -1, k.Reward.Luck)
			if g != nil && sess.items.inv.CanFit(g.Base, g.Qty) {
				sess.items.inv.Add(g, &d)
				got = append(got, g)
			}
		}
		s.commitItems(sess, &d, nil, "event gems")
		s.sendGranted(sess, SourceContent, got)
	}
	if k.Reward.Items > 0 {
		s.rollRewards(sess, k.Reward.Items, k.Reward.Luck, 1, marker+":roll", "event "+k.Key)
	}
	if k.Reward.XP > 0 {
		s.grantCombatXP(combat.XPGrant{Player: e.ID, XP: k.Reward.XP, Reason: "event"})
	}
	sess.cnt.st.Add("events", 1)
	sess.cnt.st.Add("event:"+k.Key, 1) // CR 031: Every Event Under the Sun
	sess.cnt.recheck = true
	b, _ := json.Marshal(struct {
		Name string `json:"name"`
		Gold int    `json:"gold"`
		XP   int64  `json:"xp"`
		Ore  int    `json:"ore,omitempty"`
		Gems int    `json:"gems,omitempty"`
	}{k.Name, gold, k.Reward.XP, ore, gems})
	s.sendEvent(sess, &proto.Event{Kind: EventWorldEventPrize, EntityID: e.ID, TargetID: w.id, Value: int32(gold), Data: b})
}
