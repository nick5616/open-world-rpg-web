package game

// Playtest 2 achievements (CR 031, docs/cr/031-achievements.md): the zone's
// half. The table is contracts/achievements.yaml (contentdefs.D.
// Achievements); the per-character state and the earning rule are
// internal/content/achievements.go. Here:
//
//   - the counters, fed from every system through small hooks (ach*):
//     spells cast per school, dashes and metres dashed per dash, magma jet
//     flight (seconds high up, the best height, flights), magma dives,
//     deaths, players downed in PvP, lightning survived, nights seen
//     through, gold earned, items found by rarity, things crafted per
//     station, veins broken, emotes, pets petted, metres ridden, songs,
//     world events by kind. Per-tick ones (distance, airtime) add up in the
//     session (achAcc) and reach the state once a second, so the saved
//     state changes at most once a second and is written like every other
//     content change (coalesced by the write-behind queue, contentSaveEvery);
//   - earning (contentAchievements): rewards (gold, XP, an item: one grant
//     marked "feat:<key>", the CR 023 marker, so nothing is paid twice),
//     Event 1002 to the player only, Event 1240 to their party and players
//     near for gold and platinum tiers, and Event 1241 once for a character
//     saved before achievements whose old counters already earned some;
//   - "Tony Stark built this in a cave with scraps": the first time a held
//     magma jet (the zone paid the hold: combat.Player.DashHolding) keeps the
//     player more than flightUpM above the ground or water for over
//     flightS seconds in one dash.
//
// Everything is per session with content on (atlas worlds); the scale
// scenario's worlds have none, so its wire digest is unchanged, and players
// who do nothing cost a nil check per tick.

import (
	"encoding/json"
	"math"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/contentdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/items"
	"lodestone/server/zone/internal/quests"
)

// Event kinds 1240-1259 (CR 031).
const (
	EventAchievementAnnounce = 1240
	EventAchievementsCaught  = 1241
)

const (
	flightUpM       = 6.0  // "take flight": feet this far above the ground or water...
	flightS         = 2.0  // ...for longer than this, thrusting, in one magma dash
	achAnnounceM    = 64.0 // gold and platinum unlocks are told to players this close (and the party)
	achStepJumpM    = 12.0 // a dash step longer than this is a teleport, not distance
	achTickS        = 1.0 / constants.TickRateHz
	achMagmaDashKey = "magma_dash"
)

// achAcc is what a session adds up between flushes into the state.
type achAcc struct {
	dashM      map[string]float64 // dash key -> metres since the last flush
	last       movement.Vec3      // where the dasher was last tick
	lastOK     bool
	jetHighS   float64 // this dash: seconds thrusting high up, in a row
	flew       bool    // this dash already counted as a flight
	flightS    float64 // seconds of high jet flight since the last flush
	best       float64 // best height above ground on a jet since the last flush
	gallopM    float64 // metres ridden since the last flush
	dashes     int     // combat.Player.Dashes at the last flush
	slams      int     // combat.Player.Slams at the last flush
	down       bool    // downed at the last look
	duskNight  int64   // the night (index + 1) this session saw fall, 0 none
	flightNote bool    // a flight was counted this tick: check at once
}

// achAdd adds n to counter stat and asks for a check (at the next second).
func (s *Server) achAdd(sess *session, stat string, n int) {
	if sess == nil || sess.cnt == nil || n <= 0 {
		return
	}
	sess.cnt.st.Add(stat, n)
	sess.cnt.recheck = true
}

// achStat answers an achievement stat that lives outside the content state.
func (s *Server) achStat(sess *session, stat string) int {
	switch stat {
	case "petlevel": // CR 029 (pets.go)
		if sess.pets == nil {
			return 0
		}
		return sess.pets.st.BestLevel()
	case "towers", "level":
		x := sess.x
		if x == nil || x.prog == nil {
			return 0
		}
		if stat == "towers" {
			return x.prog.Attuned.Count()
		}
		return x.prog.Level
	}
	return 0
}

// contentAchievements earns what can be earned now and pays it.
func (s *Server) contentAchievements(sess *session) {
	cs := sess.cnt
	if cs == nil || sess.ent == nil {
		return
	}
	cs.recheck = false
	titled := cs.st.TitleText()
	now := s.cfg.Now().UnixMilli()
	got, caughtUp := cs.st.NewAchievements(func(stat string) int { return s.achStat(sess, stat) }, now)
	var caught []string
	var caughtGold, caughtPts int
	var caughtXP int64
	for _, a := range got {
		s.achReward(sess, a)
		s.log.Info("achievement earned", "character", sess.ent.CharacterID, "achievement", a.Key, "catchUp", caughtUp)
		if caughtUp {
			caught = append(caught, a.Key)
			caughtGold, caughtXP, caughtPts = caughtGold+a.Gold, caughtXP+a.XP, caughtPts+a.Pts
			continue
		}
		b, _ := json.Marshal(struct {
			Key   string `json:"key"`
			Name  string `json:"name"`
			Desc  string `json:"desc"`
			Title string `json:"title"`
			Gold  int    `json:"gold"`
			XP    int64  `json:"xp"`
			Tier  int    `json:"tier"`
			Cat   int    `json:"cat"`
			Pts   int    `json:"pts"`
			Item  string `json:"item"`
			Qty   int    `json:"qty"`
			At    int64  `json:"at"`
		}{a.Key, a.Name, a.Desc, a.Title, a.Gold, a.XP, a.Tier, a.Cat, a.Pts, a.Item, a.Qty, now})
		s.sendEvent(sess, &proto.Event{Kind: EventFeatEarned, EntityID: sess.ent.ID, TargetID: uint32(a.ID), Value: int32(cs.st.Points()), Data: b})
		if a.Tier >= 0 && a.Tier < len(contentdefs.D.AchievementTiers) && contentdefs.D.AchievementTiers[a.Tier].Announce {
			s.achAnnounce(sess, a)
		}
	}
	if len(caught) > 0 {
		b, _ := json.Marshal(struct {
			Keys []string `json:"keys"`
			Gold int      `json:"gold"`
			XP   int64    `json:"xp"`
			Pts  int      `json:"pts"`
		}{caught, caughtGold, caughtXP, caughtPts})
		s.sendEvent(sess, &proto.Event{Kind: EventAchievementsCaught, EntityID: sess.ent.ID, Value: int32(len(caught)), Data: b})
	}
	if cs.st.TitleText() != titled {
		s.contentTitleChanged(sess)
	}
	if cs.st.Dirty() {
		s.saveContent(sess)
	}
}

// achReward pays an achievement: gold and its item in one grant (marked
// like the CR 023 feats, so a reward is never paid twice), then XP.
func (s *Server) achReward(sess *session, a *contentdefs.Achievement) {
	var list []quests.ItemQty
	if a.Gold > 0 {
		list = append(list, quests.ItemQty{Item: "currency:gold", Qty: a.Gold})
	}
	if a.Item != "" && a.Qty > 0 {
		list = append(list, quests.ItemQty{Item: a.Item, Qty: a.Qty})
	}
	if len(list) > 0 {
		s.questGrant(sess, list, "feat:"+a.Key, "achievement "+a.Key)
	}
	if a.XP > 0 {
		s.grantCombatXP(combat.XPGrant{Player: sess.ent.ID, XP: a.XP, Reason: "achievement"})
	}
}

// achAnnounce tells the earner's party (anywhere on this zone) and players
// within achAnnounceM about a gold or platinum unlock (Event 1240).
func (s *Server) achAnnounce(sess *session, a *contentdefs.Achievement) {
	e := sess.ent
	b := proto.Encode(&proto.Event{Kind: EventAchievementAnnounce, EntityID: e.ID, TargetID: uint32(a.ID), Value: int32(a.Tier), X: cm(e.Move.Pos.X), Y: cm(e.Move.Pos.Y), Z: cm(e.Move.Pos.Z), Data: []byte(e.Name)})
	for _, o := range s.sessions {
		oe := o.ent
		if o == sess || oe == nil {
			continue
		}
		party := e.PartyID != 0 && oe.PartyID == e.PartyID
		if !party && math.Hypot(oe.Move.Pos.X-e.Move.Pos.X, oe.Move.Pos.Z-e.Move.Pos.Z) > achAnnounceM {
			continue
		}
		if err := o.conn.SendReliable(b); err != nil {
			o.closed.Store(true)
		}
	}
}

// ---- per tick: dashes, magma flight ----

// achTick follows every running dash of a player with content (combatTick,
// after the combat world's step): metres per dash and the magma jet's
// flight. Nothing for players who are not dashing.
func (s *Server) achTick() {
	for _, sess := range s.sessions {
		e, cs := sess.ent, sess.cnt
		if e == nil || cs == nil || e.cbt == nil {
			continue
		}
		a := &cs.ach
		d, holding, ok := e.cbt.DashHolding()
		if !ok {
			a.lastOK, a.jetHighS, a.flew = false, 0, false
			continue
		}
		pos := e.Move.Pos
		if a.lastOK {
			if step := math.Sqrt(sq(pos.X-a.last.X) + sq(pos.Y-a.last.Y) + sq(pos.Z-a.last.Z)); step <= achStepJumpM {
				if a.dashM == nil {
					a.dashM = map[string]float64{}
				}
				a.dashM[d.Key] += step
			}
		}
		a.last, a.lastOK = pos, true
		if d.Key != achMagmaDashKey {
			continue
		}
		up := pos.Y - s.achSurface(pos.X, pos.Z)
		if holding && up > flightUpM {
			a.jetHighS += achTickS
			a.flightS += achTickS
			a.best = math.Max(a.best, up)
			if a.jetHighS > flightS && !a.flew {
				// Took flight: counted once per dash, checked at once (the toast
				// should come while the player is still up there).
				a.flew = true
				cs.st.Add("magmaflight", 1)
				a.flightNote = true
			}
		} else {
			a.jetHighS = 0
		}
		if a.flightNote {
			a.flightNote = false
			s.achFlush(sess)
			s.contentAchievements(sess)
		}
	}
}

// achSurface is the height under (x, z): the ground (with structures) or
// the water over it.
func (s *Server) achSurface(x, z float64) float64 {
	g := s.cfg.Ground.HeightAt(x, z)
	if w := movement.WaterAt(s.cfg.Ground, x, z); w > g {
		return w
	}
	return g
}

// achFlush moves what the session added up into the state (once a second,
// and at once for a flight).
func (s *Server) achFlush(sess *session) {
	cs, e := sess.cnt, sess.ent
	a := &cs.ach
	for k, m := range a.dashM {
		if n := int(m); n > 0 {
			s.achAdd(sess, "dashm:"+k, n)
			a.dashM[k] -= float64(n)
		}
	}
	if n := int(a.flightS); n > 0 {
		s.achAdd(sess, "flight", n)
		a.flightS -= float64(n)
	}
	if a.best > 0 {
		if cs.st.SetMax("flighthigh", int(a.best)) {
			cs.recheck = true
		}
		a.best = 0
	}
	if n := int(a.gallopM); n > 0 {
		s.achAdd(sess, "gallop", n)
		a.gallopM -= float64(n)
	}
	if e.cbt != nil {
		if n := e.cbt.Dashes - a.dashes; n > 0 {
			s.achAdd(sess, "dashes", n)
		}
		if n := e.cbt.Slams - a.slams; n > 0 {
			s.achAdd(sess, "slams", n)
		}
		a.dashes, a.slams = e.cbt.Dashes, e.cbt.Slams
		if e.cbt.Downed && !a.down {
			s.achAdd(sess, "deaths", 1)
		}
		a.down = e.cbt.Downed
	}
}

// achJoin starts the session's counts from the combat player's (a rejoin
// or a handoff does not count old dashes again).
func (s *Server) achJoin(sess *session) {
	if sess.cnt == nil || sess.ent == nil || sess.ent.cbt == nil {
		return
	}
	sess.cnt.ach.dashes, sess.cnt.ach.slams, sess.cnt.ach.down = sess.ent.cbt.Dashes, sess.ent.cbt.Slams, sess.ent.cbt.Downed
}

// ---- hooks from the other systems ----

// achCast counts a legal spell cast by school (combatFrame).
func (s *Server) achCast(sess *session, a *combat.Action) {
	if a == nil || !a.Legal || a.Spell == nil || sess.cnt == nil || a.Spell.Dash != 0 {
		return
	}
	s.achAdd(sess, "casts", 1)
	if el := a.Spell.Element; el >= 0 && el < len(combatdefs.D.Elements) {
		s.achAdd(sess, "cast:"+combatdefs.D.Elements[el], 1)
	}
}

// achKill counts a creature's element (contentOnKill; families are the
// content state's own).
func (s *Server) achKill(sess *session, element int) {
	if element >= 0 && element < len(combatdefs.D.Elements) {
		s.achAdd(sess, "killel:"+combatdefs.D.Elements[element], 1)
	}
}

// achGranted counts gold earned and items found by rarity (sendGranted).
// Purchases, the starter kit, crafting and picking up a dropped item are
// not "found".
func (s *Server) achGranted(sess *session, source int, got []*items.Item) {
	if sess.cnt == nil || source == SourcePurchase || source == SourceStarter || source == SourceDropped {
		return
	}
	for _, it := range got {
		if it.Base == "currency:gold" {
			s.achAdd(sess, "gold", it.Qty)
			continue
		}
		if source != SourceCraft && it.Rarity > 0 && it.Rarity < len(items.D.Rarities) {
			s.achAdd(sess, "loot:"+items.D.Rarities[it.Rarity].Key, 1)
		}
	}
}

// achByChar runs fn for character id's session with content.
func (s *Server) achByChar(id string, fn func(sess *session)) {
	if sess := s.byChar[id]; sess != nil && sess.cnt != nil && sess.ent != nil {
		fn(sess)
	}
}

// achLightning: a bolt struck e and e is still standing (weather.go strike).
func (s *Server) achLightning(e *Entity, flags uint8) {
	if e == nil || e.cbt == nil || e.cbt.Downed {
		return
	}
	s.achByChar(e.CharacterID, func(sess *session) {
		s.achAdd(sess, "lightning", 1)
		if flags&BoltDrawn != 0 {
			s.achAdd(sess, "lightningmetal", 1)
		}
	})
}

// achDusk / achDawn: a night seen through from dusk to dawn on this zone.
func (s *Server) achDusk(idx int64) {
	for _, sess := range s.sessions {
		if sess.cnt != nil {
			sess.cnt.ach.duskNight = idx + 1
		}
	}
}

func (s *Server) achDawn() {
	for _, sess := range s.sessions {
		if sess.cnt != nil && sess.cnt.ach.duskNight != 0 {
			sess.cnt.ach.duskNight = 0
			s.achAdd(sess, "nights", 1)
		}
	}
}
