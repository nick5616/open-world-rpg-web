package game

// Sealed vaults (CR 023 dungeons; content.yaml dungeons, internal/content
// dungeon.go): one per region under a ruin or shrine. Coming within
// dungeons.discoverM marks it on your map (Event 1021, persisted in the
// content state). While a player is within dungeons.activeM the zone runs
// it: elite packs guard the yard, the seal is a puzzle (levers in an
// order, pressure stones held together, braziers lit with fire magic, a
// font stilled with ice magic); opening it wakes the Vault Keeper (a boss
// with a telegraphed sigil) at the vault door; the keeper's fall clears the
// vault (a story step, a feat) and opens the chest: a guaranteed rare per
// character every chest.cooldownH. Nobody near for dungeons.resetS resets
// it. Event 1020 carries the live state to players near; the zone owning
// the vault's region runs it (WP16: players there are handed to it).

import (
	"encoding/json"
	"math"
	"strconv"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/contentdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/content"
	"lodestone/server/zone/internal/quests"
)

// Vault phases (Event 1020 value).
const (
	VaultSealed  = 0
	VaultOpen    = 1 // the keeper is awake
	VaultCleared = 2
)

const (
	partReachM  = 4.5
	plateRadius = 1.6
	kindleSlack = 2.6
)

type liveVault struct {
	v        *content.Vault
	seal     *content.Seal
	phase    int
	packs    []*combat.Group
	keeper   *combat.Group
	parts    map[uint32]bool // eligible on the keeper's kill
	lastNear uint32
	told     map[string]uint32 // char -> state version told
	ver      uint32
}

type vaultsState struct {
	plans map[int]*content.Vault
	live  map[int]*liveVault
}

func (s *Server) vaultPlan(site int) *content.Vault {
	vs := &s.cnt.vault
	if vs.plans == nil {
		vs.plans = map[int]*content.Vault{}
		cw := s.contentWorld()
		for _, d := range cw.Dungeons {
			for _, c := range cw.Sites { // the plan names the vault from the site's own name
				if c.Index == d.Index {
					vs.plans[d.Index] = content.PlanVault(s.cfg.Seed, c)
				}
			}
		}
	}
	return vs.plans[site]
}

func (s *Server) vaultPlans() map[int]*content.Vault {
	s.vaultPlan(-1)
	return s.cnt.vault.plans
}

// vaultDiscover marks vaults you come near (once a second per player).
func (s *Server) vaultDiscover(sess *session) {
	e := sess.ent
	for site, v := range s.vaultPlans() {
		if math.Hypot(v.Site.X-e.Move.Pos.X, v.Site.Z-e.Move.Pos.Z) > contentdefs.D.Dungeons.DiscoverM {
			continue
		}
		if sess.cnt.st.VaultSeen(site) {
			b, _ := json.Marshal(struct {
				Site int     `json:"site"`
				Name string  `json:"name"`
				X    float64 `json:"x"`
				Z    float64 `json:"z"`
			}{site, v.Name, v.Site.X, v.Site.Z})
			s.sendEvent(sess, &proto.Event{Kind: EventVaultFound, EntityID: e.ID, TargetID: uint32(site), X: cm(v.Site.X), Z: cm(v.Site.Z), Data: b})
			sess.cnt.recheck = true
			s.saveContent(sess)
		}
	}
}

func (s *Server) vaultsTick(tick uint32) {
	if s.cfg.Explore == nil || s.cbt.w == nil {
		return
	}
	vs := &s.cnt.vault
	if vs.live == nil {
		vs.live = map[int]*liveVault{}
	}
	dg := &contentdefs.D.Dungeons
	if tick%30 == 0 {
		// Wake vaults with a player near; reset the abandoned.
		for site, v := range s.vaultPlans() {
			near := len(s.playersNear(v.Site.X, v.Site.Z, dg.ActiveM)) > 0
			lv := vs.live[site]
			if near && lv == nil && s.ownsPoint(v.Site.X, v.Site.Z) {
				lv = s.wakeVault(v)
				vs.live[site] = lv
			}
			if lv == nil {
				continue
			}
			if near {
				lv.lastNear = tick
			} else if tick-lv.lastNear > uint32(dg.ResetS*constants.TickRateHz) {
				s.resetVault(lv)
				delete(vs.live, site)
			}
		}
	}
	if len(vs.live) == 0 {
		return
	}
	now := float64(tick) / constants.TickRateHz
	for _, lv := range vs.live {
		if tick%5 == 0 && lv.phase == VaultSealed && lv.v.Puzzle.Key == "plates" {
			for _, p := range lv.v.Parts {
				for _, e := range s.playersNear(p.X, p.Z, plateRadius) {
					_ = e
					lv.seal.Press(p.ID, now)
				}
			}
			if lv.seal.Lowered(now) {
				lv.seal.Changed = true
			}
		}
		if lv.seal.Changed {
			lv.seal.Changed = false
			if lv.seal.Open && lv.phase == VaultSealed {
				s.openVault(lv)
			}
			lv.ver++
		}
		if lv.phase == VaultOpen && lv.keeper != nil && (lv.keeper.Spawned || lv.keeper.Cleared()) && groupDead(lv.keeper) {
			s.vaultCleared(lv)
		}
		if tick%15 == 0 {
			s.tellVault(lv, false)
		}
	}
}

func (s *Server) wakeVault(v *content.Vault) *liveVault {
	lv := &liveVault{v: v, seal: content.NewSeal(v), parts: map[uint32]bool{}, told: map[string]uint32{}, lastNear: s.tick, ver: 1}
	dg := &contentdefs.D.Dungeons
	for i, at := range v.Packs {
		comp := dg.Packs[int(content.Mix(s.cfg.Seed^uint64(v.Site.Index)^uint64(i)*0x51)%uint64(len(dg.Packs)))]
		elite := []string{"shielded", "fast", "splitting"}[int(content.Mix(uint64(v.Site.Index)+uint64(i))%3)]
		p := movement.Vec3{X: at[0], Y: s.cfg.Ground.HeightAt(at[0], at[1]), Z: at[1]}
		g := s.cbt.w.AddGroup(&combat.Group{Kind: combat.GroupTest, Anchor: p, Radius: 6, Comp: comp, Elite: elite, Site: -1, Name: v.Name,
			AreaLevel: true, Level: s.lootLevelAt(p.X, p.Z, 1), Element: 8})
		lv.packs = append(lv.packs, g)
	}
	s.log.Info("vault awake", "site", v.Site.Index, "name", v.Name, "puzzle", v.Puzzle.Key)
	return lv
}

func (s *Server) resetVault(lv *liveVault) {
	for _, g := range lv.packs {
		s.cbt.w.RetireGroup(g)
	}
	s.cbt.w.RetireGroup(lv.keeper)
	s.log.Info("vault reset", "site", lv.v.Site.Index)
}

func (s *Server) openVault(lv *liveVault) {
	lv.phase = VaultOpen
	v := lv.v
	dg := &contentdefs.D.Dungeons
	bd := combatdefs.D.BossByKey(dg.Boss)
	at := movement.Vec3{X: v.Door.X, Y: s.cfg.Ground.HeightAt(v.Door.X, v.Door.Z), Z: v.Door.Z}
	arena := combat.Arena{Center: movement.Vec3{X: v.Site.X, Y: s.cfg.Ground.HeightAt(v.Site.X, v.Site.Z), Z: v.Site.Z}, Radius: math.Max(bd.ArenaRadius, v.Site.R+6), Kind: "test"}
	g := s.cbt.w.AddGroup(&combat.Group{Kind: combat.GroupBoss, Anchor: at, Radius: arena.Radius, Element: 8, Level: s.lootLevelAt(at.X, at.Z, 1), Site: -1,
		Boss: dg.Boss, Arena: &arena, Name: v.Name})
	lv.keeper = g
	for _, e := range s.playersNear(v.Site.X, v.Site.Z, dg.ActiveM) {
		s.sendEventTo(e, &proto.Event{Kind: EventVaultNote, EntityID: e.ID, TargetID: uint32(v.Site.Index), Value: 1, Data: []byte("The seal breaks. Something stirs behind the vault door...")})
	}
	s.log.Info("vault open", "site", v.Site.Index)
}

func (s *Server) vaultsOnKill(k combat.KillInfo) {
	en := k.Enemy
	if en.Group == nil {
		return
	}
	for _, lv := range s.cnt.vault.live {
		if lv.keeper == en.Group {
			for _, id := range k.Eligible {
				lv.parts[id] = true
			}
		}
	}
}

func (s *Server) vaultCleared(lv *liveVault) {
	lv.phase = VaultCleared
	s.cbt.w.RetireGroup(lv.keeper) // never respawns while the vault stands open
	lv.ver++
	v := lv.v
	for _, e := range s.playersNear(v.Site.X, v.Site.Z, contentdefs.D.Dungeons.ActiveM) {
		lv.parts[e.ID] = true
	}
	for id := range lv.parts {
		pe := s.entityByID(id)
		if pe == nil || pe.Kind != proto.EntityKindPlayer {
			continue
		}
		sess := s.byChar[pe.CharacterID]
		if sess == nil || sess.cnt == nil {
			continue
		}
		sess.cnt.st.Add("dungeons", 1)
		sess.cnt.recheck = true
		if sess.quests != nil && sess.quests.log.Needs(quests.ObjDungeon) {
			s.questsAdvance(sess, &quests.Signal{Kind: quests.ObjDungeon, Site: v.Site.Index})
		}
		s.sendEvent(sess, &proto.Event{Kind: EventVaultNote, EntityID: pe.ID, TargetID: uint32(v.Site.Index), Value: 2, Data: []byte("The Vault Keeper falls. The vault chest stands open to you.")})
	}
	s.log.Info("vault cleared", "site", v.Site.Index, "players", len(lv.parts))
}

// vaultUse is Interact 80/4: pull a lever, open the chest (or ask the door).
func (s *Server) vaultUse(sess *session, site, part int, refuse func(int32)) {
	lv := s.cnt.vault.live[site]
	if lv == nil {
		refuse(ContentRefuseUnknown)
		return
	}
	p := lv.v.Part(part)
	if p == nil {
		refuse(ContentRefuseUnknown)
		return
	}
	e := sess.ent
	y := s.cfg.Ground.HeightAt(p.X, p.Z)
	if eyeDist(e, p.X, y+1.0, p.Z) > partReachM {
		refuse(ContentRefuseTooFar)
		return
	}
	switch p.Kind {
	case content.PartLever:
		ok, wrong := lv.seal.Lever(part)
		if !ok {
			refuse(ContentRefuseNotYet)
			return
		}
		if wrong {
			for _, o := range s.playersNear(lv.v.Site.X, lv.v.Site.Z, contentdefs.D.Dungeons.ActiveM) {
				s.sendEventTo(o, &proto.Event{Kind: EventVaultNote, EntityID: o.ID, TargetID: uint32(site), Value: 0, Data: []byte(lv.v.Puzzle.Wrong)})
			}
		}
	case content.PartDoor:
		if lv.phase == VaultSealed {
			s.sendEvent(sess, &proto.Event{Kind: EventVaultNote, EntityID: e.ID, TargetID: uint32(site), Value: 0, Data: []byte(contentdefs.D.Dungeons.Door + " " + lv.v.Hint)})
			return
		}
		refuse(ContentRefuseNotYet)
	case content.PartChest:
		s.openVaultChest(sess, lv, refuse)
	default:
		refuse(ContentRefuseNotYet) // plates are stood on, braziers and fonts take magic
	}
}

func (s *Server) openVaultChest(sess *session, lv *liveVault, refuse func(int32)) {
	e := sess.ent
	if lv.phase != VaultCleared {
		refuse(ContentRefuseSealed)
		return
	}
	dg := &contentdefs.D.Dungeons
	site := lv.v.Site.Index
	now := s.cfg.Now().UnixMilli()
	if last := sess.cnt.st.VaultChest(site); last > 0 && float64(now-last) < dg.Chest.CooldownH*3600e3 {
		refuse(ContentRefuseOpened)
		return
	}
	marker := "vault:" + strconv.Itoa(site) + ":" + strconv.FormatInt(now/3600000, 10)
	gold := dg.Chest.Gold[0] + int(content.Mix(uint64(now)^hashString64(e.CharacterID))%uint64(dg.Chest.Gold[1]-dg.Chest.Gold[0]+1))
	s.questGrant(sess, []quests.ItemQty{{Item: "currency:gold", Qty: gold}}, marker+":gold", "vault chest")
	got := s.rollRewards(sess, dg.Chest.Items, dg.Chest.Luck, dg.Chest.MinRarity, marker, "vault chest")
	sess.cnt.st.VaultSeen(site)
	sess.cnt.st.OpenVaultChest(site, now)
	s.saveContent(sess)
	names := []string{}
	for _, it := range got {
		names = append(names, it.Base)
	}
	s.sendEvent(sess, &proto.Event{Kind: EventVaultNote, EntityID: e.ID, TargetID: uint32(site), Value: 3, Data: []byte("You open the vault chest.")})
	s.log.Info("vault chest", "character", e.CharacterID, "site", site, "gold", gold, "items", names)
	s.tellVault(lv, true)
}

// vaultMagic: a fire or ice spell landing near a brazier or font (combat.go,
// after the WP15 chemistry hook).
func (s *Server) vaultMagic(sess *session, a *combat.Action) {
	if a == nil || !a.Legal || len(s.cnt.vault.live) == 0 || sess.ent == nil {
		return
	}
	var element int
	var radius, rng, speed, gravity float64
	self := false
	switch {
	case a.Spell != nil:
		sp := a.Spell
		element, radius, rng, speed, gravity, self = sp.Element, sp.Radius, sp.Range, sp.Speed, sp.Gravity, sp.SelfCast
	case a.Form != nil:
		element, radius, rng, self = a.Form.Element, math.Max(a.Form.Radius, 2), math.Max(a.Form.Reach, 3)*0.6, a.Form.SelfCast
	default:
		return
	}
	el := ""
	switch element {
	case combatdefs.Fire:
		el = "fire"
	case combatdefs.Ice:
		el = "ice"
	default:
		return
	}
	at := a.Pos
	if !self {
		at = s.impactPoint(a, rng, speed, gravity)
	}
	for _, lv := range s.cnt.vault.live {
		if lv.phase != VaultSealed || math.Hypot(lv.v.Site.X-at.X, lv.v.Site.Z-at.Z) > lv.v.Site.R+40 {
			continue
		}
		for _, p := range lv.v.Parts {
			if (p.Kind == content.PartBrazier || p.Kind == content.PartFont) && math.Hypot(p.X-at.X, p.Z-at.Z) <= math.Max(radius, 0.5)+kindleSlack {
				lv.seal.Kindle(p.ID, el)
			}
			// A self-cast form or nova around you counts when you stand at it.
			if self && (p.Kind == content.PartBrazier || p.Kind == content.PartFont) && math.Hypot(p.X-a.Pos.X, p.Z-a.Pos.Z) <= radius+kindleSlack {
				lv.seal.Kindle(p.ID, el)
			}
		}
	}
}

// tellVault sends Event 1020 to the players near (all: everyone, else only
// those who haven't seen this version).
func (s *Server) tellVault(lv *liveVault, all bool) {
	v := lv.v
	r := contentdefs.D.Dungeons.ActiveM + 30
	now := float64(s.tick) / constants.TickRateHz
	var data []byte
	for _, e := range s.playersNear(v.Site.X, v.Site.Z, r) {
		sess := s.byChar[e.CharacterID]
		if sess == nil || sess.cnt == nil {
			continue
		}
		if !all && lv.told[e.CharacterID] == lv.ver {
			continue
		}
		lv.told[e.CharacterID] = lv.ver
		if data == nil {
			data = s.vaultData(lv, now)
		}
		// The chest flag is per player: patch it in.
		opened := sess.cnt.st.VaultChest(v.Site.Index) > 0 && float64(s.cfg.Now().UnixMilli()-sess.cnt.st.VaultChest(v.Site.Index)) < contentdefs.D.Dungeons.Chest.CooldownH*3600e3
		val := int32(lv.phase)
		if opened {
			val |= 0x10
		}
		s.sendEvent(sess, &proto.Event{Kind: EventVaultState, EntityID: e.ID, TargetID: uint32(v.Site.Index), Value: val, X: cm(v.Site.X), Z: cm(v.Site.Z), Data: data})
	}
}

type vaultPartWire struct {
	ID    int     `json:"id"`
	Kind  string  `json:"kind"`
	Label string  `json:"label"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	Z     float64 `json:"z"`
	On    bool    `json:"on"`
	Glyph int     `json:"glyph"`
}

func (s *Server) vaultData(lv *liveVault, now float64) []byte {
	v := lv.v
	wire := func(p content.Part, on bool) vaultPartWire {
		return vaultPartWire{ID: p.ID, Kind: p.Kind, Label: p.Label, X: math.Round(p.X*100) / 100, Y: math.Round(s.cfg.Ground.HeightAt(p.X, p.Z)*100) / 100, Z: math.Round(p.Z*100) / 100, On: on, Glyph: p.Glyph}
	}
	var parts []vaultPartWire
	for _, p := range v.Parts {
		on := false
		switch p.Kind {
		case content.PartLever:
			for _, g := range lv.seal.Pulled {
				on = on || g == p.Glyph
			}
		case content.PartPlate:
			on = lv.seal.Down(p.ID, now)
		default:
			on = lv.seal.Lit[p.ID-1]
		}
		if lv.seal.Open {
			on = true
		}
		parts = append(parts, wire(p, on))
	}
	parts = append(parts, wire(v.Door, lv.phase != VaultSealed), wire(v.Chest, lv.phase == VaultCleared))
	keeperHP := -1
	if lv.keeper != nil && lv.keeper.Spawned {
		for _, m := range lv.keeper.Members {
			if m.Boss != nil {
				keeperHP = int(math.Round(math.Max(0, m.HP) / math.Max(1, m.HPMax) * 100))
			}
		}
	}
	b, _ := json.Marshal(struct {
		Site     int             `json:"site"`
		Name     string          `json:"name"`
		Phase    int             `json:"phase"`
		Puzzle   string          `json:"puzzle"`
		Title    string          `json:"title"`
		Hint     string          `json:"hint"`
		Parts    []vaultPartWire `json:"parts"`
		Keeper   int             `json:"keeper"`
		X        float64         `json:"x"`
		Z        float64         `json:"z"`
		R        float64         `json:"r"`
		HoldS    float64         `json:"holdS,omitempty"`
		Element  string          `json:"element,omitempty"`
	}{v.Site.Index, v.Name, lv.phase, v.Puzzle.Key, v.Puzzle.Name, v.Hint, parts, keeperHP, v.Site.X, v.Site.Z, v.Site.R, v.Puzzle.HoldS, v.Puzzle.Element})
	return b
}

// VaultDebug lists vault plans and live states (tests, tools, evidence).
func (s *Server) VaultDebug() []map[string]any {
	var out []map[string]any
	for site, v := range s.vaultPlans() {
		m := map[string]any{"site": site, "name": v.Name, "puzzle": v.Puzzle.Key, "x": v.Site.X, "z": v.Site.Z, "order": v.Order}
		if lv := s.cnt.vault.live[site]; lv != nil {
			m["phase"] = lv.phase
		}
		out = append(out, m)
	}
	return out
}
