package game

// The sky palaces (CR 044): the white-and-gold palace on a sky island is a
// building (server/pkg/palace appends its walls and floors to the towns'
// collision) and a dungeon. A player within palace.activeM wakes it: guard
// packs (wisps, harpies, sentinels, moths) take the halls. The trial is three
// wards (the sun and the moon in the galleries, the wind high over the atrium,
// reached by riding the atrium's updraft); the third wakes the Sky Guardian
// in the throne hall; its fall opens the chest (a guaranteed relic per
// character every chest.cooldownH, server-rolled). Nobody near for resetS puts
// it back to sleep. Interact 150 (the doors) wakes it early and tells the
// state (Event 1702); Interact 152 strikes a ward / opens the chest. Event
// 1704 carries the live state to players near (per character, on change),
// Event 1705 a line of text. Cost: a scan of the (one or two) palaces every
// 30 ticks, and nothing in between until a palace is awake.

import (
	"encoding/json"
	"math"
	"strconv"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/palace"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/vertical"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/content"
	"lodestone/server/zone/internal/quests"
)

// Events (contracts/events.md) and the Interact target.
const (
	EventPalaceState = 1704
	EventPalaceNote  = 1705

	InteractPalacePart = 152
)

// Palace phases (Event 1702 / 1704 value).
const (
	PalaceAsleep  = 0
	PalaceTrial   = 1 // awake: packs in the halls, wards to strike
	PalaceBoss    = 2 // the guardian is awake
	PalaceCleared = 3
)

const palacePartChest = 4

type livePalace struct {
	site     palace.Site
	name     string
	phase    int
	wards    [3]bool
	packs    []*combat.Group
	boss     *combat.Group
	lastNear uint32
	ver      uint32
	told     map[string]uint32
	parts    map[uint32]bool
}

type palaceState struct {
	sites []palace.Site
	init  bool
	cols  movement.Columns // the atriums' updraft shafts
	live  map[int]*livePalace
}

func (s *Server) palaceSites() []palace.Site {
	ps := &s.pal
	if !ps.init {
		ps.init = true
		if vw := s.vertical(); vw != nil {
			ps.sites = palace.SitesOf(vw.Vertical())
			ps.cols = palace.Wind(ps.sites)
		}
	}
	return ps.sites
}

// palaceWind is the vertical world's wind plus each palace's atrium shaft.
type palaceWind struct {
	vertical.Wind
	cols movement.Columns
}

func (w palaceWind) LiftAt(x, y, z float64) float64 {
	return math.Max(w.Wind.LiftAt(x, y, z), w.cols.LiftAt(x, y, z))
}

func (s *Server) palaceName(site int) string {
	if ex := s.cfg.Explore; ex != nil && ex.Atlas != nil && site >= 0 && site < len(ex.Atlas.Sites) {
		if n := ex.Atlas.Sites[site].Name; n != "" {
			return n
		}
	}
	return "the Sky Palace"
}

func (s *Server) palaceNear3D(ps palace.Site, r float64) bool {
	for _, sess := range s.sessions {
		e := sess.ent
		if e == nil {
			continue
		}
		p := e.Move.Pos
		if math.Hypot(p.X-ps.X, p.Z-ps.Z) <= r && math.Abs(p.Y-ps.Floor) <= r {
			return true
		}
	}
	return false
}

// palaceTick wakes palaces with a player near, resets the abandoned, watches
// the guardian and tells players near about changes (tick goroutine).
func (s *Server) palaceTick(tick uint32) {
	if s.cbt.w == nil || len(s.palaceSites()) == 0 {
		return
	}
	pl := &s.pal
	if pl.live == nil {
		pl.live = map[int]*livePalace{}
	}
	d := palace.D
	if tick%30 == 0 {
		for _, ps := range pl.sites {
			near := s.palaceNear3D(ps, d.ActiveM)
			lp := pl.live[ps.Index]
			if near && lp == nil && s.ownsPoint(ps.X, ps.Z) {
				lp = s.wakePalace(ps)
			}
			if lp == nil {
				continue
			}
			if near {
				lp.lastNear = tick
			} else if tick-lp.lastNear > uint32(d.ResetS*constants.TickRateHz) {
				s.resetPalace(lp)
			}
		}
	}
	for _, lp := range pl.live {
		if lp.phase == PalaceBoss && groupDead(lp.boss) {
			s.palaceCleared(lp)
		}
		if tick%15 == 0 {
			s.tellPalace(lp, false)
		}
	}
}

func (s *Server) palaceFloorPoint(ps palace.Site, lx, lz, ly float64) movement.Vec3 {
	x, z := ps.World(lx, lz)
	return movement.Vec3{X: x, Y: ps.Floor + ly, Z: z}
}

func (s *Server) wakePalace(ps palace.Site) *livePalace {
	lp := &livePalace{site: ps, name: s.palaceName(ps.Index), phase: PalaceTrial, lastNear: s.tick, ver: 1, told: map[string]uint32{}, parts: map[uint32]bool{}}
	for _, p := range palace.D.Packs {
		at := s.palaceFloorPoint(ps, p.X, p.Z, p.Y)
		g := s.cbt.w.AddGroup(&combat.Group{Kind: combat.GroupTest, Anchor: at, Radius: 5, Comp: p.Comp, Elite: p.Elite, Site: -1, Name: lp.name,
			AreaLevel: true, Level: s.lootLevelAt(at.X, at.Z, 10), Element: 4, Layer: int(vertical.LayerSky)})
		lp.packs = append(lp.packs, g)
	}
	s.pal.live[ps.Index] = lp
	s.log.Info("palace awake", "site", ps.Index, "name", lp.name, "packs", len(lp.packs))
	return lp
}

func (s *Server) resetPalace(lp *livePalace) {
	for _, g := range lp.packs {
		s.cbt.w.RetireGroup(g)
	}
	s.cbt.w.RetireGroup(lp.boss)
	delete(s.pal.live, lp.site.Index)
	s.log.Info("palace asleep", "site", lp.site.Index)
}

func (s *Server) palaceNote(lp *livePalace, val int32, text string) {
	ps := lp.site
	for _, sess := range s.sessions {
		if e := sess.ent; e != nil && math.Hypot(e.Move.Pos.X-ps.X, e.Move.Pos.Z-ps.Z) <= palace.D.ActiveM+30 && math.Abs(e.Move.Pos.Y-ps.Floor) <= palace.D.ActiveM {
			s.sendEvent(sess, &proto.Event{Kind: EventPalaceNote, EntityID: e.ID, TargetID: uint32(ps.Index), Value: val, Data: []byte(text)})
		}
	}
}

// wardStruck: ward i (0-2) was struck; the third wakes the guardian.
func (s *Server) wardStruck(lp *livePalace, i int, by *Entity) {
	if lp.wards[i] {
		return
	}
	lp.wards[i] = true
	lp.ver++
	w := palace.D.Wards[i]
	s.palaceNote(lp, 1, w.Name+" answers. "+strconv.Itoa(wardCount(lp))+" of 3.")
	if wardCount(lp) < 3 || lp.phase != PalaceTrial {
		return
	}
	lp.phase = PalaceBoss
	ar := palace.D.Arena
	at := s.palaceFloorPoint(lp.site, ar.X, ar.Z, ar.Y)
	lvl := s.lootLevelAt(at.X, at.Z, 14)
	if _, l, ok := s.AreaTierLayer(at.X, at.Z, int(vertical.LayerSky)); ok {
		lvl = max(lvl, l)
	}
	arena := combat.Arena{Center: at, Radius: ar.R, Kind: "test"}
	lp.boss = s.cbt.w.AddGroup(&combat.Group{Kind: combat.GroupBoss, Anchor: at, Radius: ar.R, Element: 5, Level: max(14, lvl), Site: -1,
		Boss: palace.D.Boss, Arena: &arena, Name: lp.name, Layer: int(vertical.LayerSky)})
	s.palaceNote(lp, 2, "The three wards blaze. In the throne hall, something rises from the light.")
}

func wardCount(lp *livePalace) int {
	n := 0
	for _, w := range lp.wards {
		if w {
			n++
		}
	}
	return n
}

func (s *Server) palacesOnKill(k combat.KillInfo) {
	en := k.Enemy
	if en == nil || en.Group == nil {
		return
	}
	for _, lp := range s.pal.live {
		if lp.boss != nil && lp.boss == en.Group {
			for _, id := range k.Eligible {
				lp.parts[id] = true
			}
		}
	}
}

func (s *Server) palaceCleared(lp *livePalace) {
	lp.phase = PalaceCleared
	lp.ver++
	s.cbt.w.RetireGroup(lp.boss)
	ps := lp.site
	for _, sess := range s.sessions {
		if e := sess.ent; e != nil && math.Hypot(e.Move.Pos.X-ps.X, e.Move.Pos.Z-ps.Z) <= palace.D.ActiveM && math.Abs(e.Move.Pos.Y-ps.Floor) <= palace.D.ActiveM {
			lp.parts[e.ID] = true
		}
	}
	n := 0
	for id := range lp.parts {
		pe := s.entityByID(id)
		if pe == nil || pe.Kind != proto.EntityKindPlayer {
			continue
		}
		sess := s.byChar[pe.CharacterID]
		if sess == nil || sess.cnt == nil {
			continue
		}
		n++
		sess.cnt.st.Add("dungeons", 1)
		sess.cnt.st.Add("palaces", 1)
		sess.cnt.recheck = true
		if sess.quests != nil && sess.quests.log.Needs(quests.ObjDungeon) {
			s.questsAdvance(sess, &quests.Signal{Kind: quests.ObjDungeon, Site: lp.site.Index})
		}
		s.sendEvent(sess, &proto.Event{Kind: EventPalaceNote, EntityID: pe.ID, TargetID: uint32(ps.Index), Value: 3, Data: []byte("The Sky Guardian falls, and the light goes out of its eyes. The treasure chest stands open to you.")})
	}
	s.log.Info("palace cleared", "site", ps.Index, "players", n)
}

type palaceWire struct {
	Site   int     `json:"site"`
	Name   string  `json:"name"`
	Phase  int     `json:"phase"`
	Wards  [3]bool `json:"wards"`
	Boss   int     `json:"boss"` // guardian health %, -1 not awake
	Opened bool    `json:"opened"`
}

func (s *Server) palaceWireOf(lp *livePalace, sess *session) palaceWire {
	w := palaceWire{Site: lp.site.Index, Name: lp.name, Phase: lp.phase, Wards: lp.wards, Boss: -1}
	if lp.phase == PalaceBoss && lp.boss != nil && lp.boss.Spawned {
		for _, m := range lp.boss.Members {
			if m.Boss != nil {
				w.Boss = int(math.Round(math.Max(0, m.HP) / math.Max(1, m.HPMax) * 100))
			}
		}
	}
	if sess != nil && sess.cnt != nil {
		last := sess.cnt.st.VaultChest(lp.site.Index)
		w.Opened = last > 0 && float64(s.cfg.Now().UnixMilli()-last) < palace.D.Chest.CooldownH*3600e3
	}
	return w
}

// tellPalace sends the live state to players near whose copy is old (or all of them).
func (s *Server) tellPalace(lp *livePalace, all bool) {
	ps := lp.site
	for _, sess := range s.sessions {
		e := sess.ent
		if e == nil || sess.cnt == nil || math.Hypot(e.Move.Pos.X-ps.X, e.Move.Pos.Z-ps.Z) > palace.D.ActiveM+30 || math.Abs(e.Move.Pos.Y-ps.Floor) > palace.D.ActiveM {
			continue
		}
		boss := lp.phase == PalaceBoss
		if !all && !boss && lp.told[e.CharacterID] == lp.ver {
			continue
		}
		if boss && !all && (s.tick%30) != 0 && lp.told[e.CharacterID] == lp.ver {
			continue // the guardian's health bar: twice a second at most
		}
		lp.told[e.CharacterID] = lp.ver
		b, _ := json.Marshal(s.palaceWireOf(lp, sess))
		s.sendEvent(sess, &proto.Event{Kind: EventPalaceState, EntityID: e.ID, TargetID: uint32(ps.Index), Value: int32(lp.phase), X: cm(ps.X), Z: cm(ps.Z), Data: b})
	}
}

// palaceByDeco finds the palace (and its decoration) for an atlas site.
func (s *Server) palaceSite(site int) (palace.Site, bool) {
	for _, ps := range s.palaceSites() {
		if ps.Index == site {
			return ps, true
		}
	}
	return palace.Site{}, false
}

// palaceDoorInteract is Interact 150: the doors. Wakes the palace and tells
// the state (Event 1702).
func (s *Server) palaceDoorInteract(sess *session, site int) {
	ps, ok := s.palaceSite(site)
	if !ok {
		return
	}
	e := sess.ent
	p := e.Move.Pos
	if math.Hypot(p.X-ps.X, p.Z-ps.Z) > palace.D.Half.Z+30 || math.Abs(p.Y-ps.Floor) > 40 {
		return
	}
	lp := s.pal.live[site]
	if lp == nil && s.ownsPoint(ps.X, ps.Z) {
		lp = s.wakePalace(ps)
	}
	phase := int32(PalaceAsleep)
	if lp != nil {
		phase = int32(lp.phase)
		lp.lastNear = s.tick
	}
	s.sendEvent(sess, &proto.Event{Kind: EventPalaceDoor, EntityID: e.ID, TargetID: uint32(site), Value: phase, X: cm(ps.X), Y: cm(ps.Floor), Z: cm(ps.Z)})
	if lp != nil {
		s.tellPalace(lp, true)
	}
}

// palacePartInteract is Interact 152: target = site << 4 | part (1-3 the
// wards, 4 the chest).
func (s *Server) palacePartInteract(sess *session, target uint64) {
	site, part := int(target>>4), int(target&15)
	lp := s.pal.live[site]
	if lp == nil || part < 1 || part > 4 {
		return
	}
	e := sess.ent
	ps := lp.site
	var lx, lz, ly float64
	if part == palacePartChest {
		c := palace.D.Chest
		lx, lz, ly = c.X, c.Z, c.Y
	} else {
		w := palace.D.Wards[part-1]
		lx, lz, ly = w.X, w.Z, w.Y
	}
	at := s.palaceFloorPoint(ps, lx, lz, ly)
	if eyeDist(e, at.X, at.Y+1.0, at.Z) > palace.D.ReachM {
		return
	}
	if part == palacePartChest {
		s.openPalaceChest(sess, lp)
		return
	}
	if lp.phase != PalaceTrial {
		return
	}
	s.wardStruck(lp, part-1, e)
}

func (s *Server) openPalaceChest(sess *session, lp *livePalace) {
	e := sess.ent
	if lp.phase != PalaceCleared {
		s.sendEvent(sess, &proto.Event{Kind: EventPalaceNote, EntityID: e.ID, TargetID: uint32(lp.site.Index), Value: 4, Data: []byte("The chest is sealed with light. Something still guards this palace.")})
		return
	}
	c := palace.D.Chest
	site := lp.site.Index
	now := s.cfg.Now().UnixMilli()
	if last := sess.cnt.st.VaultChest(site); last > 0 && float64(now-last) < c.CooldownH*3600e3 {
		s.sendEvent(sess, &proto.Event{Kind: EventPalaceNote, EntityID: e.ID, TargetID: uint32(site), Value: 4, Data: []byte("You have already taken this palace's treasure. It will refill in time.")})
		return
	}
	marker := "palace:" + strconv.Itoa(site) + ":" + strconv.FormatInt(now/3600000, 10)
	gold := c.Gold[0] + int(content.Mix(uint64(now)^hashString64(e.CharacterID))%uint64(c.Gold[1]-c.Gold[0]+1))
	s.questGrant(sess, []quests.ItemQty{{Item: "currency:gold", Qty: gold}}, marker+":gold", "palace chest")
	got := s.rollRewards(sess, c.Items, c.Luck, c.MinRarity, marker, "palace chest")
	sess.cnt.st.OpenVaultChest(site, now)
	s.saveContent(sess)
	names := []string{}
	for _, it := range got {
		names = append(names, it.Base)
	}
	s.sendEvent(sess, &proto.Event{Kind: EventPalaceNote, EntityID: e.ID, TargetID: uint32(site), Value: 5, Data: []byte("You open the palace chest: " + strconv.Itoa(gold) + " gold and " + strconv.Itoa(len(got)) + " relics of the sky.")})
	s.log.Info("palace chest", "character", e.CharacterID, "site", site, "gold", gold, "items", names)
	lp.ver++
	s.tellPalace(lp, true)
}

var _ = combatdefs.Physical
