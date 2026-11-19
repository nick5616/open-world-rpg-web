package game

// Playtest 2 dev console (docs/cr/032-dev-console.md): a local developer's
// cheats, as Interact 250 commands (contracts/events.md). The zone accepts
// them only when started with LODESTONE_ZONE_DEV=1 (Config.Dev: scripts/dev.mjs
// sets it for `npm run dev`, the deploys never do, and main.go refuses it
// without the insecure development ticket key). Every command goes through
// the ordinary code paths (inventory adds and commits, Profile.Grant,
// levelChanged, Teleport, the quest happenings, the pet and steed records),
// so state stays consistent and persists like play does; every one is
// logged. Events 1400 (status) and 1401 (result) answer.

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"math"
	"slices"
	"strings"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/contentdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/weather"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/content"
	"lodestone/server/zone/internal/explore"
	"lodestone/server/zone/internal/items"
	"lodestone/server/zone/internal/quests"
)

// InteractDev is the dev console's Interact target kind.
const InteractDev = 250

// Interact 250 actions (contracts/events.md has the targetId/arg layouts).
const (
	DevActStatus      = 1  // send 1400 (silently ignored on a zone without dev mode)
	DevActGive        = 2  // targetId: fnv1a32(item key) | level << 32 | rarity+1 << 40 | gem+1 << 44 | cut << 48 | affix+1 << 50; arg: qty | equip << 16 | loadout << 17
	DevActLearn       = 3  // targetId: spell id (0 = every spell)
	DevActUnlearn     = 4  // targetId: spell id (0 = all but the starting kit)
	DevActLevel       = 5  // arg: character level
	DevActXP          = 6  // targetId: total XP
	DevActGold        = 7  // arg: gold in the purse
	DevActSkillPoints = 8  // arg: extra skill points (this session)
	DevActWeaponSkill = 9  // targetId: combat.yaml skill id (0 = all); arg: level
	DevActRefill      = 10 // health, mana, stamina
	DevActFlags       = 11 // arg: DevFlag* bits
	DevActSpeed       = 12 // arg: fly speed x100
	DevActReset       = 13 // a new character (level, map, spells, inventory, quests)
	DevActTeleport    = 14 // targetId: x cm | z cm << 32 (u32 each); arg: y cm (0 = the ground; never below it), or devExactY | (y cm + devExactYBias): exactly that height (the Underground)
	DevActTime        = 15 // arg: hour x100
	DevActWeather     = 16 // arg: state + 1 (0 = the seeded weather)
	DevActSpawn       = 17 // targetId: enemy id, or boss index; arg: count | level << 8 | boss << 16 | elite affix id << 17
	DevActDespawn     = 18 // remove everything the console spawned
	DevActEvent       = 19 // arg: world event kind (1-based)
	DevActTameable    = 20 // targetId: taming species id
	DevActPet         = 21 // targetId: taming species id; arg: variant | element+1 << 4 | level << 8
	DevActSteed       = 22 // arg: colour
	DevActQuest       = 23 // targetId: quest id (0 = every active one); arg: 1 finish the step, 2 finish the quest, 3 abandon
	DevActReveal      = 24 // every tower and waypoint
	DevActAttune      = 25 // every tower crystal (boons, XP)
	DevActPlaces      = 26 // send 1402: towers, towns, vaults (teleport targets)
	DevActAchieve     = 27 // targetId: achievement id (0 = every one): unlocked, rewards paid
	DevActStory       = 28 // CR 035 main story: arg = DevStory*; targetId: act | step << 8 (jump), percent (hush)
)

// Event kinds 1400-1419 (contracts/events.md, playtest 2 dev console).
const (
	EventDevStatus = 1400
	EventDevResult = 1401
	EventDevPlaces = 1402
)

// Event 1401 value.
const (
	DevOK      = 0
	DevOff     = 1 // the zone is not in dev mode
	DevBadArg  = 2
	DevFailed  = 3
	DevUnknown = 4
)

// devExactY marks a teleport arg that carries an exact height (playtest 3, CR 042 evidence runs): the low 31 bits are y cm + devExactYBias.
const (
	devExactY     = 1 << 31
	devExactYBias = 1 << 30
)

// Dev flags (DevActFlags arg, Event 1400 value).
const (
	DevFlagGod        = 1 << 0 // nothing hurts you
	DevFlagMana       = 1 << 1 // mana stays full
	DevFlagStamina    = 1 << 2 // stamina stays full (every step, the client too)
	DevFlagCooldowns  = 1 << 3 // no cooldowns
	DevFlagFly        = 1 << 4 // fly (the client's debug fly step, server-checked)
	DevFlagFreeLearn  = 1 << 5 // the skill tree ignores points, prerequisites and tier levels
	DevFlagFreezeTime = 1 << 6 // the world clock holds (zone-wide)
)

// devFlySpeed is the client's FLY_SPEED (client/src/sim/fly.ts).
const (
	devFlySpeed  = 20.0
	devFlySprint = 4.0
)

// devSess is one session's dev state (nil until its first dev command).
type devSess struct {
	flags      uint32
	speed      float64 // fly speed multiplier
	skillBonus int     // extra skill points (this session)
	// invulnUntil: the vibe explorer's landing invulnerability (vibe.go).
	invulnUntil uint32
}

// devGlue is the zone's dev state.
type devGlue struct {
	byHash  map[uint32]string // fnv1a32(item key) -> key
	groups  []*combat.Group   // what the console spawned
	frozen  bool
	frozenS float64  // the time of day it holds (seconds into the day)
	vibe    vibeGlue // playtest 2 vibe explorer (vibe.go)
}

// DevHash is fnv1a32 of an item key (the client's devconsole/events.ts).
func DevHash(key string) uint32 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(key))
	return h.Sum32()
}

func (s *Server) devItem(h uint32) string {
	if s.dev.byHash == nil {
		var spells []string
		for i := range combatdefs.D.Spells {
			spells = append(spells, combatdefs.D.Spells[i].Key)
		}
		s.dev.byHash = map[uint32]string{}
		for _, k := range items.DevItemKeys(spells) {
			s.dev.byHash[DevHash(k)] = k
		}
	}
	return s.dev.byHash[h]
}

func devName(a uint8) string {
	names := map[uint8]string{DevActStatus: "status", DevActGive: "give", DevActLearn: "learn", DevActUnlearn: "unlearn", DevActLevel: "level", DevActXP: "xp",
		DevActGold: "gold", DevActSkillPoints: "skillpoints", DevActWeaponSkill: "weaponskill", DevActRefill: "refill", DevActFlags: "flags", DevActSpeed: "speed",
		DevActReset: "reset", DevActTeleport: "teleport", DevActTime: "time", DevActWeather: "weather", DevActSpawn: "spawn", DevActDespawn: "despawn",
		DevActEvent: "event", DevActTameable: "tameable", DevActPet: "pet", DevActSteed: "steed", DevActQuest: "quest", DevActReveal: "reveal", DevActAttune: "attune", DevActPlaces: "places", DevActAchieve: "achieve", DevActStory: "story",
		DevActVibeFind: "vibe find", DevActVibeGo: "vibe go", DevActVibeLevel: "vibe level", DevActVibeSpawn: "vibe spawn", DevActVibeFreeze: "vibe freeze", DevActVibeDemons: "vibe demons", DevActVibeHere: "vibe here", DevActRift: "rift"}
	if n, ok := names[a]; ok {
		return n
	}
	return fmt.Sprintf("action %d", a)
}

// devInteract handles Interact 250 (tick goroutine).
func (s *Server) devInteract(sess *session, m *proto.Interact) {
	e := sess.ent
	if e == nil {
		return
	}
	if !s.cfg.Dev {
		if m.Action == DevActStatus {
			return // every debug client asks once; a normal zone just has no console
		}
		s.log.Warn("dev command refused: zone not in dev mode", "character", e.CharacterID, "action", devName(m.Action))
		s.sendEvent(sess, &proto.Event{Kind: EventDevResult, EntityID: e.ID, TargetID: uint32(m.Action), Value: DevOff, Data: []byte("dev mode is off on this zone (LODESTONE_ZONE_DEV)")})
		return
	}
	if sess.dev == nil {
		sess.dev = &devSess{speed: 1}
	}
	if m.Action == DevActStatus {
		s.sendDevStatus(sess)
		return
	}
	if m.Action == DevActPlaces {
		s.sendDevPlaces(sess)
		return
	}
	if m.Action == DevActVibeHere {
		s.sendVibeHere(sess) // playtest 2 vibe explorer (vibe.go)
		return
	}
	code, msg := s.devApply(sess, m)
	s.log.Info("dev command", "character", e.CharacterID, "action", devName(m.Action), "target", m.TargetID, "arg", m.Arg, "code", code, "result", msg)
	s.sendEvent(sess, &proto.Event{Kind: EventDevResult, EntityID: e.ID, TargetID: uint32(m.Action), Value: code, Data: []byte(msg)})
	switch m.Action {
	case DevActFlags, DevActSpeed, DevActSkillPoints, DevActReset, DevActWeather, DevActTime, DevActSpawn, DevActDespawn:
		s.sendDevStatus(sess)
	}
	switch m.Action {
	case DevActVibeGo, DevActVibeFind, DevActVibeLevel, DevActVibeSpawn, DevActVibeFreeze, DevActVibeDemons, DevActTeleport, DevActLevel, DevActWeather, DevActTime:
		s.sendVibeHere(sess) // the vibe tab's "here" (vibe.go)
	}
}

// devStatusJSON is Event 1400's data.
type devStatusJSON struct {
	Flags      uint32  `json:"flags"`
	Speed      float64 `json:"speed"`
	SkillBonus int     `json:"skillBonus"`
	Frozen     bool    `json:"frozen"`
	Hour       float64 `json:"hour"`
	Weather    int     `json:"weather"` // forced state, -1 seeded
	Spawned    int     `json:"spawned"`
	VibeFrozen bool    `json:"vibeFrozen"` // the vibe explorer's freeze (vibe.go)
}

func (s *Server) sendDevStatus(sess *session) {
	d := sess.dev
	j := devStatusJSON{Flags: d.flags, Speed: d.speed, SkillBonus: d.skillBonus, Frozen: s.dev.frozen, Hour: math.Round(weather.Hour(s.worldTimeS())*100) / 100, Weather: -1, Spawned: len(s.dev.groups), VibeFrozen: s.dev.vibe.frozen}
	if j.Frozen {
		j.Flags |= DevFlagFreezeTime
	} else {
		j.Flags &^= DevFlagFreezeTime
	}
	if s.cfg.Weather != nil {
		j.Weather = s.cfg.Weather.Override
	}
	b, _ := json.Marshal(j)
	s.sendEvent(sess, &proto.Event{Kind: EventDevStatus, EntityID: sess.ent.ID, TargetID: uint32(math.Round(d.speed * 100)), Value: int32(j.Flags), Data: b})
}

// devSkillBonus is the session's extra skill points (applyProgression).
func (s *Server) devSkillBonus(e *Entity) int {
	if !s.cfg.Dev || e == nil {
		return 0
	}
	if sess := s.byChar[e.CharacterID]; sess != nil && sess.dev != nil {
		return sess.dev.skillBonus
	}
	return 0
}

// devFreeLearn: the session's skill tree ignores points, prerequisites and tiers.
func (s *Server) devFreeLearn(sess *session) bool {
	return s.cfg.Dev && sess.dev != nil && sess.dev.flags&DevFlagFreeLearn != 0
}

func devOK(format string, a ...any) (int32, string) { return DevOK, fmt.Sprintf(format, a...) }
func devBad(format string, a ...any) (int32, string) {
	return DevBadArg, fmt.Sprintf(format, a...)
}
func devFailed(format string, a ...any) (int32, string) {
	return DevFailed, fmt.Sprintf(format, a...)
}

// devApply runs one command; returns the 1401 value and a line for the console.
func (s *Server) devApply(sess *session, m *proto.Interact) (int32, string) {
	e := sess.ent
	switch m.Action {
	case DevActGive:
		return s.devGive(sess, m)
	case DevActLearn, DevActUnlearn:
		return s.devSpells(sess, m)
	case DevActLevel:
		if m.Arg < 1 || m.Arg > 255 || sess.x == nil {
			return devBad("level 1-255")
		}
		return s.devSetXP(sess, explore.XPForLevel(int(m.Arg)))
	case DevActXP:
		if sess.x == nil || m.TargetID > math.MaxInt32*1000 {
			return devBad("xp")
		}
		return s.devSetXP(sess, int64(m.TargetID))
	case DevActGold:
		return s.devGold(sess, int(m.Arg))
	case DevActSkillPoints:
		if m.Arg > 1000 {
			return devBad("0-1000 extra skill points")
		}
		sess.dev.skillBonus = int(m.Arg)
		s.devProgressSync(sess)
		return devOK("+%d skill points (this session)", m.Arg)
	case DevActWeaponSkill:
		return s.devWeaponSkill(sess, int(m.TargetID), int(m.Arg))
	case DevActRefill:
		if p := e.cbt; p != nil {
			p.HP, p.Mana = p.HPMax, p.ManaMax
			syncPlayerHealth(e)
		}
		e.Move.Stamina = e.Move.StaminaMax
		e.Move.Flags &^= movement.FlagExhausted
		e.prevValid.Stamina, e.prevValid.Flags = e.Move.Stamina, e.Move.Flags
		return devOK("health, mana and stamina full")
	case DevActFlags:
		return s.devFlags(sess, m.Arg)
	case DevActSpeed:
		v := float64(m.Arg) / 100
		if v < 0.1 || v > 50 {
			return devBad("speed 0.1-50")
		}
		sess.dev.speed = v
		return devOK("fly speed x%g", v)
	case DevActReset:
		return s.devReset(sess)
	case DevActTeleport:
		x := proto.CmToMeters(int32(uint32(m.TargetID)))
		z := proto.CmToMeters(int32(uint32(m.TargetID >> 32)))
		if x < 0 || z < 0 || x >= constants.WorldSizeM || z >= constants.WorldSizeM {
			return devBad("outside the world (0-%d m)", constants.WorldSizeM)
		}
		y := s.cfg.Ground.HeightAt(x, z)
		if m.Arg&devExactY != 0 {
			// Playtest 3: an exact height, below the terrain too (the Underground): offset binary in the low 31 bits.
			y = proto.CmToMeters(int32(m.Arg&^devExactY) - devExactYBias)
		} else if m.Arg != 0 {
			y = math.Max(y, proto.CmToMeters(int32(m.Arg)))
		}
		s.Teleport(e, movement.Vec3{X: x, Y: y, Z: z})
		return devOK("teleported to %.0f %.0f %.0f", x, y, z)
	case DevActTime:
		if m.Arg > 2400 {
			return devBad("hour 0-24")
		}
		h := float64(m.Arg) / 100
		s.devSetHour(h)
		return devOK("time %02d:%02d", int(h)%24, int(math.Round((h-math.Floor(h))*60))%60)
	case DevActWeather:
		return s.devWeather(int(m.Arg) - 1)
	case DevActSpawn:
		return s.devSpawn(sess, m)
	case DevActDespawn:
		n := 0
		if w := s.cbt.w; w != nil {
			for _, g := range s.dev.groups {
				n += len(g.Members)
				w.RemoveGroup(g)
			}
		}
		s.dev.groups = nil
		return devOK("removed the console's spawns (%d alive)", n)
	case DevActEvent:
		if !s.devStartEvent(sess, int(m.Arg)) {
			return devFailed("no world event started (events off, or no open ground near you)")
		}
		return devOK("world event started near you")
	case DevActTameable:
		sp := contentdefs.D.PetByID(int(m.TargetID))
		if sp == nil || s.cbt.w == nil {
			return devBad("unknown species")
		}
		x, z := ahead(e, 7)
		g := s.cbt.w.TestGroup(movement.Vec3{X: x, Z: z}, []string{sp.Enemy}, 1, "")
		if s.petsG.devWeaken == nil {
			s.petsG.devWeaken = map[*combat.Group]string{}
		}
		s.petsG.devWeaken[g] = e.CharacterID
		s.dev.groups = append(s.dev.groups, g)
		return devOK("a weakened %s ahead: feed it %s", sp.Key, sp.Foods[0])
	case DevActPet:
		return s.devPet(sess, m)
	case DevActSteed:
		return s.devSteed(sess, int(m.Arg))
	case DevActQuest:
		return s.devQuest(sess, uint32(m.TargetID), int(m.Arg))
	case DevActAchieve:
		return s.devAchieve(sess, int(m.TargetID))
	case DevActStory:
		return s.devStory(sess, int(m.Arg), int(m.TargetID)) // CR 035 (story_dev.go)
	case DevActVibeFind, DevActVibeGo, DevActVibeLevel, DevActVibeSpawn, DevActVibeFreeze, DevActVibeDemons:
		return s.vibeApply(sess, m) // playtest 2 vibe explorer (vibe.go)
	case DevActReveal, DevActAttune:
		return s.devMap(sess, m.Action == DevActAttune)
	case DevActRift:
		return s.devRift(sess, m) // CR 040 (rift_dev.go)
	}
	return DevUnknown, "unknown dev command"
}

// ahead is a point d metres in front of the player's camera.
func ahead(e *Entity, d float64) (float64, float64) {
	return e.Move.Pos.X - math.Sin(e.Yaw)*d, e.Move.Pos.Z - math.Cos(e.Yaw)*d
}

// ---- items ----

func (s *Server) devGive(sess *session, m *proto.Interact) (int32, string) {
	ci, e := sess.items, sess.ent
	if ci == nil {
		return devFailed("no inventory")
	}
	key := s.devItem(uint32(m.TargetID))
	def := items.D.Item(key)
	if def == nil {
		return devBad("unknown item")
	}
	level := int(m.TargetID >> 32 & 0xff)
	rar := int(m.TargetID>>40&0xf) - 1
	gem := int(m.TargetID>>44&0xf) - 1
	cut := int(m.TargetID >> 48 & 0x3)
	affix := int(m.TargetID>>50&0xff) - 1
	qty := max(1, int(m.Arg&0xffff))
	equip := m.Arg>>16&1 != 0
	loadout := int(m.Arg >> 17 & 3) // CR 039: loadout 3 too
	gear := def.Kind == "weapon" || def.Kind == "armor"
	var d items.Delta
	var got []*items.Item
	prov := []items.Prov{{Ev: "dev_grant", Char: e.CharacterID, Src: "dev console", At: s.cfg.Now().UnixMilli()}}
	var first *items.Item
	if gear {
		g := items.DevGear{Base: key, Level: level, Rarity: max(0, rar)}
		if affix >= 0 && affix < len(items.D.Affixes) {
			g.Affix = items.D.Affixes[affix].Key
		}
		if gem >= 0 && gem < len(items.D.Gems) && cut < len(items.D.Cuts) {
			g.Gem = "gem:" + items.D.Gems[gem].Key + ":" + items.D.Cuts[cut].Key
		}
		for i := 0; i < min(qty, 10); i++ {
			seed := items.Mix64(uint64(time.Now().UnixNano()) + uint64(i))
			it := items.DevRoll(items.NewRNG(seed), g)
			it.Seed = int64(seed >> 1)
			it.Prov = prov
			if ci.inv.Add(it, &d) > 0 {
				break
			}
			got = append(got, it)
			if first == nil {
				first = it
			}
		}
	} else {
		it := items.Stack(key, qty)
		it.Prov = prov
		left := ci.inv.Add(it, &d)
		if left < qty {
			got = append(got, &items.Item{Base: key, Qty: qty - left})
		}
		for _, x := range ci.inv.Items {
			if x.Base == key && !x.IsEquipped() {
				first = x
			}
		}
	}
	if len(got) == 0 {
		return devFailed("no room for %s", key)
	}
	note := ""
	if equip && first != nil {
		var err error
		switch def.Kind {
		case "weapon":
			err = ci.inv.Equip(first, items.MainSlot(loadout), &d)
			note = fmt.Sprintf(", equipped in loadout %d", loadout+1)
		case "armor":
			err = ci.inv.Equip(first, items.ArmorSlot(def), &d)
			note = ", equipped"
		default:
			if def.Kind == "tome" && e.cbt != nil && e.cbt.Profile.Knows(strings.TrimPrefix(key, "tome:")) {
				note = ", already known (kept)"
				break
			}
			err = s.useItem(sess, first, &d) // tomes learn, arrows load, draughts go on the drink key
			note = ", used"
		}
		if err != nil {
			note = ", could not equip it"
		}
	}
	s.commitItems(sess, &d, nil, "dev give "+key)
	s.sendGranted(sess, SourceDev, got)
	if sess.quests != nil {
		sess.quests.recheck = true
	}
	n := 0
	for _, it := range got {
		n += it.Qty
	}
	if gear && first != nil {
		return devOK("gave %s (%s, level %d)%s", first.DisplayName(), items.D.Rarities[first.Rarity].Name, first.Level, note)
	}
	return devOK("gave %d x %s%s", n, def.Name, note)
}

// SourceDev is Event 401's source for dev console grants.
const SourceDev = 11

func (s *Server) devGold(sess *session, n int) (int32, string) {
	ci := sess.items
	if ci == nil || n < 0 || n > 100000000 {
		return devBad("gold 0-100000000")
	}
	var d items.Delta
	have := ci.inv.Gold()
	switch {
	case n > have:
		it := items.Stack("currency:gold", n-have)
		it.Prov = []items.Prov{{Ev: "dev_grant", Char: sess.ent.CharacterID, Src: "dev console", At: s.cfg.Now().UnixMilli()}}
		ci.inv.Add(it, &d)
	case n < have:
		ci.inv.Spend("currency:gold", have-n, &d)
	}
	s.commitItems(sess, &d, nil, "dev gold")
	return devOK("%d gold", n)
}

// ---- spells and skills ----

func (s *Server) devSpells(sess *session, m *proto.Interact) (int32, string) {
	p := sess.ent.cbt
	if p == nil {
		return devFailed("no combat state")
	}
	pr := p.Profile
	id := int(m.TargetID)
	var sp *combatdefs.Spell
	if id != 0 {
		if sp = combatdefs.D.SpellByID(id); sp == nil {
			return devBad("unknown spell %d", id)
		}
	}
	msg := ""
	switch {
	case m.Action == DevActLearn && sp == nil:
		n := 0
		for i := range combatdefs.D.Spells {
			if pr.Grant(combatdefs.D.Spells[i].Key) {
				n++
			}
		}
		msg = fmt.Sprintf("learned %d spells (all %d known)", n, len(pr.Known))
	case m.Action == DevActLearn:
		if !pr.Grant(sp.Key) {
			return devOK("%s already known", sp.Name)
		}
		learnedSpellIntoSlot(p, sp.Key)
		msg = "learned " + sp.Name
	case sp == nil:
		msg = fmt.Sprintf("unlearned %d spells (the starting kit stays)", pr.DevForgetAll())
	default:
		if !pr.DevForget(sp.Key) {
			return devOK("%s was not known", sp.Name)
		}
		msg = "unlearned " + sp.Name
	}
	s.sendCombatSync(sess)
	s.saveCombat(sess, false)
	s.sendStats(sess, StatsSync, sess.ent.x.levelOr(1))
	if sess.quests != nil {
		sess.quests.recheck = true
	}
	return devOK("%s", msg)
}

// levelOr is the progress level (or def without exploration state).
func (x *exploreState) levelOr(def int) int {
	if x == nil || x.prog == nil {
		return def
	}
	return x.prog.Level
}

func (s *Server) devWeaponSkill(sess *session, id, level int) (int32, string) {
	p := sess.ent.cbt
	if p == nil {
		return devFailed("no combat state")
	}
	if level < 1 || level > 100 {
		return devBad("skill level 1-100")
	}
	var names []string
	for _, sk := range combatdefs.D.Skills.List {
		if id == 0 || sk.ID == id {
			p.Profile.DevSetSkillXP(sk.Key, combatdefs.D.XPForLevel(level))
			names = append(names, sk.Key)
		}
	}
	if len(names) == 0 {
		return devBad("unknown skill %d", id)
	}
	s.sendCombatSync(sess)
	s.saveCombat(sess, false)
	return devOK("%s at level %d", strings.Join(names, ", "), level)
}

// ---- level, XP, progression ----

func (s *Server) devSetXP(sess *session, xp int64) (int32, string) {
	x, e := sess.x, sess.ent
	before := x.prog.Level
	x.prog.DevSetXP(xp)
	if x.prog.Level > before {
		s.levelChanged(sess, before) // the ordinary level-up: 604, stats, refill, feats
	} else {
		e.Level = uint8(min(255, x.prog.Level))
		s.devProgressSync(sess)
	}
	if s.cfg.Explore != nil {
		s.sendProgress(sess)
	}
	s.saveProgressSoon(sess, false)
	return devOK("level %d (%d XP)", x.prog.Level, x.prog.XP)
}

// devProgressSync pushes level, boons and skill points everywhere they show.
func (s *Server) devProgressSync(sess *session) {
	e := sess.ent
	s.applyProgression(e, false)
	if e.cbt != nil {
		s.sendCombatSync(sess)
	}
	s.sendStats(sess, StatsSync, sess.x.levelOr(1))
}

func (s *Server) devMap(sess *session, attune bool) (int32, string) {
	w, x, e := s.cfg.Explore, sess.x, sess.ent
	if w == nil || x == nil {
		return devFailed("no map on this world")
	}
	if !attune {
		n := w.DevReveal(x.prog)
		s.sendProgress(sess)
		s.saveProgressSoon(sess, false)
		return devOK("map revealed (%d towers and waypoints unlocked)", n)
	}
	before := x.prog.Level
	n := w.DevAttuneAll(x.prog)
	x.prog.AddXP(combatdefs.D.Leveling.Attune.XP * int64(n))
	if x.prog.Level != before {
		s.levelChanged(sess, before)
	} else {
		s.applyProgression(e, false)
		if e.cbt != nil {
			s.sendCombatSync(sess)
		}
	}
	s.sendStats(sess, StatsAttuned, before)
	s.sendProgress(sess)
	s.saveProgressSoon(sess, false)
	s.contentAttuned(sess, -1)
	return devOK("attuned %d tower crystals (%d in all)", n, attunedCount(x.prog))
}

// ---- flags, the tick, fly ----

func (s *Server) devFlags(sess *session, f uint32) (int32, string) {
	d, e := sess.dev, sess.ent
	was := d.flags
	d.flags = f &^ DevFlagFreezeTime
	if e.cbt != nil {
		e.cbt.DevGod = f&DevFlagGod != 0
	}
	if was&DevFlagFly != 0 && f&DevFlagFly == 0 {
		// Landing from fly: never inside the ground.
		g := movement.GroundAt(s.cfg.Ground, e.Move.Pos.X, e.Move.Pos.Y, e.Move.Pos.Z)
		if e.Move.Pos.Y < g {
			s.Teleport(e, movement.Vec3{X: e.Move.Pos.X, Y: g, Z: e.Move.Pos.Z})
		}
	}
	frozen := f&DevFlagFreezeTime != 0
	if frozen != s.dev.frozen {
		s.dev.frozen = frozen
		s.dev.frozenS = weather.TimeOfDayS(s.worldTimeS())
		for _, o := range s.sessions {
			if o != sess && o.dev != nil && o.ent != nil {
				s.sendDevStatus(o)
			}
		}
	}
	var on []string
	for _, n := range []struct {
		bit  uint32
		name string
	}{{DevFlagGod, "god"}, {DevFlagMana, "infinite mana"}, {DevFlagStamina, "infinite stamina"}, {DevFlagCooldowns, "no cooldowns"}, {DevFlagFly, "fly"}, {DevFlagFreeLearn, "free skill tree"}, {DevFlagFreezeTime, "time frozen"}} {
		if f&n.bit != 0 {
			on = append(on, n.name)
		}
	}
	if len(on) == 0 {
		return devOK("all cheats off")
	}
	return devOK("on: %s", strings.Join(on, ", "))
}

// devTick applies the running cheats (after the inputs, every tick).
func (s *Server) devTick(tick uint32) {
	if !s.cfg.Dev {
		return
	}
	for _, sess := range s.sessions {
		d, e := sess.dev, sess.ent
		if d == nil || e == nil || e.cbt == nil {
			continue
		}
		p := e.cbt
		if d.flags&DevFlagMana != 0 {
			p.Mana = p.ManaMax
		}
		if d.flags&DevFlagCooldowns != 0 {
			p.DevClearCooldowns()
		}
		if d.flags&DevFlagGod != 0 && !p.DevGod {
			p.DevGod = true // a respawn or handoff rebuilt the player
		}
		s.vibeTick(tick, sess) // landing invulnerability (vibe.go)
	}
	s.vibeZoneTick(tick)
	if s.dev.frozen && tick%constants.TickRateHz == 0 {
		// Hold the clock: pull it back whenever it drifted 20 s (a few
		// in-game minutes at most; a SetClockOffset tells every client).
		drift := weather.TimeOfDayS(s.worldTimeS()) - s.dev.frozenS
		if drift < -constants.DayLengthS/2 {
			drift += constants.DayLengthS
		}
		if math.Abs(drift) >= 20 {
			s.SetClockOffset(s.clockOffset() - drift)
		}
	}
}

// devFrame applies one input frame for a session with fly or infinite
// stamina on; false = not handled (the ordinary applyFrame runs).
func (s *Server) devFrame(sess *session, f proto.InputFrame) bool {
	d, e := sess.dev, sess.ent
	if d == nil || d.flags&(DevFlagFly|DevFlagStamina) == 0 {
		return false
	}
	if d.flags&DevFlagStamina != 0 && e.Move.StaminaMax > 0 {
		// The client does the same before each step (sim/devStep.ts).
		e.Move.Stamina = e.Move.StaminaMax
		e.Move.Flags &^= movement.FlagExhausted
	}
	if d.flags&DevFlagFly == 0 {
		return false
	}
	next := DevFlyStep(e.Move, f, d.speed)
	const maxXZ = float64(constants.WorldSizeM) - 0.01
	next.Pos.X = math.Max(0, math.Min(maxXZ, next.Pos.X))
	next.Pos.Z = math.Max(0, math.Min(maxXZ, next.Pos.Z))
	e.Yaw = proto.U16ToYaw(f.Yaw)
	e.Pitch = proto.I16ToPitch(f.Pitch)
	e.LastSeq = f.Seq
	e.lastFrame = f
	e.applied++
	e.Move = next
	e.prevValid = next
	return true
}

// DevFlyStep is client/src/sim/fly.ts stepFly: camera-relative flight
// (forward follows pitch, jump rises, crouch sinks), no gravity or ground,
// FLY_SPEED x mult (x4 sprinting).
func DevFlyStep(st movement.State, f proto.InputFrame, mult float64) movement.State {
	yaw := proto.U16ToYaw(f.Yaw)
	pitch := proto.I16ToPitch(f.Pitch)
	cp := math.Cos(pitch)
	fx, fy, fz := -math.Sin(yaw)*cp, math.Sin(pitch), -math.Cos(yaw)*cp
	rx, rz := math.Cos(yaw), -math.Sin(yaw)
	var dx, dy, dz float64
	fl := f.Flags
	if fl&proto.InputFlagForward != 0 {
		dx, dy, dz = dx+fx, dy+fy, dz+fz
	}
	if fl&proto.InputFlagBack != 0 {
		dx, dy, dz = dx-fx, dy-fy, dz-fz
	}
	if fl&proto.InputFlagRight != 0 {
		dx, dz = dx+rx, dz+rz
	}
	if fl&proto.InputFlagLeft != 0 {
		dx, dz = dx-rx, dz-rz
	}
	if fl&proto.InputFlagJump != 0 {
		dy++
	}
	if fl&proto.InputFlagCrouch != 0 {
		dy--
	}
	l := math.Sqrt(dx*dx + dy*dy + dz*dz)
	if !(mult > 0) {
		mult = 1
	}
	speed := devFlySpeed * mult
	if fl&proto.InputFlagSprint != 0 {
		speed *= devFlySprint
	}
	k := 0.0
	if l > 0 {
		k = speed / l
	}
	v := movement.Vec3{X: dx * k, Y: dy * k, Z: dz * k}
	st.Pos = movement.Vec3{X: st.Pos.X + v.X*movement.Dt, Y: st.Pos.Y + v.Y*movement.Dt, Z: st.Pos.Z + v.Z*movement.Dt}
	st.Vel = v
	st.AirJumps = 0
	st.Mode = movement.ModeAir
	st.Lunge = 0
	return st
}

// ---- world ----

func (s *Server) devSetHour(h float64) {
	t := s.worldTimeS()
	want := math.Mod(h, 24) / 24 * constants.DayLengthS
	delta := want - weather.TimeOfDayS(t)
	s.SetClockOffset(s.clockOffset() + delta)
	if s.dev.frozen {
		s.dev.frozenS = want
	}
}

func (s *Server) devWeather(st int) (int32, string) {
	if st >= weather.NumStates {
		return devBad("weather 0-%d", weather.NumStates)
	}
	name := "the seeded weather"
	if st >= 0 {
		name = weather.StateKeys[st]
	}
	if s.weatherOn() {
		s.cfg.Weather.Override = st
		s.wx.field = nil
	} else {
		// A world without the weather grid: WP10's global rain switch.
		if st < 0 {
			s.cfg.Rain = nil
		} else {
			wet := weather.IsWet(st)
			s.cfg.Rain = &wet
		}
	}
	s.env = s.stepEnv()
	for _, o := range s.sessions {
		if o.ent != nil {
			s.sendClock(o)
		}
	}
	return devOK("weather: %s (zone-wide)", name)
}

func (s *Server) devSpawn(sess *session, m *proto.Interact) (int32, string) {
	w, e := s.cbt.w, sess.ent
	if w == nil {
		return devFailed("no combat on this zone")
	}
	n := min(max(1, int(m.Arg&0xff)), 20)
	level := int(m.Arg >> 8 & 0xff)
	if level == 0 {
		level = max(1, sess.x.levelOr(1))
	}
	boss := m.Arg>>16&1 != 0
	if boss {
		bi := int(m.TargetID)
		if bi < 0 || bi >= len(combatdefs.D.Bosses) {
			return devBad("unknown boss %d", bi)
		}
		b := &combatdefs.D.Bosses[bi]
		x, z := ahead(e, 22)
		x, z = w.WalkableNear(x, z, 80, 12)
		g := w.TestBoss(movement.Vec3{X: x, Z: z}, b.Key, level, combatdefs.Physical)
		if g == nil {
			return devFailed("could not place %s", b.Key)
		}
		s.dev.groups = append(s.dev.groups, g)
		return devOK("boss %s (level %d) at %.0f %.0f", b.Key, level, x, z)
	}
	en := combatdefs.D.EnemyByID(int(m.TargetID))
	if en == nil {
		return devBad("unknown enemy %d", m.TargetID)
	}
	elite := ""
	if a := combatdefs.D.AffixByID(int(m.Arg >> 17 & 0xf)); a != nil && m.Arg>>17&0xf != 0 {
		elite = a.Key
	}
	keys := make([]string, n)
	for i := range keys {
		keys[i] = en.Key
	}
	x, z := ahead(e, 10)
	x, z = w.WalkableNear(x, z, 40, 3)
	g := w.TestGroup(movement.Vec3{X: x, Z: z}, keys, level, elite)
	s.dev.groups = append(s.dev.groups, g)
	what := en.Key
	if elite != "" {
		what = elite + " " + what
	}
	return devOK("%d x %s (level %d) at %.0f %.0f", n, what, level, x, z)
}

// ---- pets, steed, quests ----

func (s *Server) devPet(sess *session, m *proto.Interact) (int32, string) {
	ps, e := sess.pets, sess.ent
	sp := contentdefs.D.PetByID(int(m.TargetID))
	if ps == nil || sp == nil {
		return devBad("unknown species")
	}
	if ps.st.Full() {
		return devFailed("your stable is full (release a pet first)")
	}
	variant := int(m.Arg & 0xf)
	el := int(m.Arg>>4&0xf) - 1
	level := min(max(1, int(m.Arg>>8&0xff)), contentdefs.D.Taming.LevelMax)
	if variant != content.VariantElemental {
		el = -1
	} else if el < 0 || el > 7 {
		el = 0
	}
	name := sp.Key
	if d := combatdefs.D.EnemyByKey(sp.Enemy); d != nil {
		name = d.Name
	}
	if variant == content.VariantShiny {
		name = "Shiny " + name
	}
	rec, added := ps.st.Add(content.PetRec{Species: sp.Key, Name: name, Variant: variant, Element: el, Level: level, HP: 1, TamedAt: s.cfg.Now().UnixMilli()})
	if !added {
		return devFailed("your stable is full")
	}
	ps.dirty = true
	id, active := rec.ID, ps.st.Active == rec.ID
	if active {
		x, z := ahead(e, 3)
		s.petEnsureOut(sess, true, movement.Vec3{X: x, Y: s.cfg.Ground.HeightAt(x, z), Z: z})
	} else {
		s.petNote(sess, PetNoteStabled, id, name+" waits for you in your stable")
	}
	s.petChanged(sess)
	return devOK("%s (level %d) is yours", name, level)
}

func (s *Server) devSteed(sess *session, colour int) (int32, string) {
	st, ci := sess.steed, sess.items
	if st == nil || ci == nil {
		return devFailed("no steed state")
	}
	if colour < 0 || colour >= SteedColours {
		return devBad("colour 0-%d", SteedColours-1)
	}
	if !s.hasWhistle(sess) {
		var d items.Delta
		it := items.Stack(steedWhistle, 1)
		it.Prov = []items.Prov{{Ev: "dev_grant", Char: sess.ent.CharacterID, Src: "dev console", At: s.cfg.Now().UnixMilli()}}
		if ci.inv.Add(it, &d) > 0 {
			return devFailed("no room for the whistle")
		}
		s.commitItems(sess, &d, nil, "dev steed whistle")
		s.sendGranted(sess, SourceDev, []*items.Item{it})
	}
	if len(st.owned) == 0 {
		st.owned = []SteedRec{{Kind: steedKindSpirit, Name: steedDefaultName, Colour: colour, BondedAt: s.cfg.Now().UnixMilli()}}
	} else {
		st.owned[0].Colour = colour
	}
	s.steedChanged(sess)
	return devOK("your steed (colour %d): whistle with 5", colour)
}

func (s *Server) devQuest(sess *session, id uint32, op int) (int32, string) {
	q := sess.quests
	if q == nil {
		return devFailed("no quest log")
	}
	var ids []uint32
	if id != 0 {
		ids = []uint32{id}
	} else {
		for _, a := range q.log.Active {
			ids = append(ids, a.ID)
		}
	}
	if len(ids) == 0 {
		return devFailed("no active quests")
	}
	if op == 3 {
		for _, qid := range ids {
			s.questInteract(sess, &proto.Interact{TargetKind: InteractQuest, TargetID: uint64(qid), Action: QuestActAbandon})
		}
		return devOK("abandoned %d quest(s)", len(ids))
	}
	if op != 1 && op != 2 {
		return devBad("1 step, 2 finish, 3 abandon")
	}
	steps, done := 0, 0
	handoff := false
	for _, qid := range ids {
		for {
			h, adv := q.log.DevAdvance(qid)
			if !adv {
				break
			}
			steps++
			s.questHappened(sess, h)
			if h.Finished {
				done++
				handoff = handoff || h.Quest.Key == quests.MeadowsKey || quests.IsErrand(h.Quest.Key) // CR 051
				break
			}
			if op == 1 {
				break
			}
		}
	}
	if steps == 0 {
		return devBad("no such active quest")
	}
	if handoff {
		s.questsWardHandoff(sess)
	}
	q.recheck = true
	s.sendQuestLog(sess)
	s.saveQuests(sess)
	return devOK("%d step(s) done, %d quest(s) finished", steps, done)
}

// devPlace is one teleport target (Event 1402).
type devPlace struct {
	Name string  `json:"n"`
	X    float64 `json:"x"`
	Z    float64 `json:"z"`
}

// sendDevPlaces lists the towers, towns and vaults (Event 1402 data JSON
// {towers, towns, vaults}: [{n, x, z}]).
func (s *Server) sendDevPlaces(sess *session) {
	out := map[string][]devPlace{"towers": {}, "towns": {}, "vaults": {}}
	r2 := func(v float64) float64 { return math.Round(v*10) / 10 }
	if w := s.cfg.Explore; w != nil {
		for _, t := range w.Towers {
			name := fmt.Sprintf("Tower %d", t.Site)
			if st := &w.Atlas.Sites[t.Site]; int(st.Region) < len(w.Atlas.Regions) {
				name = w.Atlas.Regions[st.Region].Name + " tower"
			}
			out["towers"] = append(out["towers"], devPlace{name, r2(t.Shape.CX), r2(t.Shape.CZ)})
		}
	}
	if tw := s.cfg.Towns; tw != nil {
		for i := range tw.T.Settlements {
			st := &tw.T.Settlements[i]
			out["towns"] = append(out["towns"], devPlace{s.settlementName(i), r2(st.X), r2(st.Z)})
		}
	}
	if s.cfg.Explore != nil {
		for _, v := range s.vaultPlans() {
			out["vaults"] = append(out["vaults"], devPlace{v.Name, r2(v.Door.X), r2(v.Door.Z)})
		}
		slices.SortFunc(out["vaults"], func(a, b devPlace) int { return strings.Compare(a.Name, b.Name) })
	}
	b, _ := json.Marshal(out)
	s.sendEvent(sess, &proto.Event{Kind: EventDevPlaces, EntityID: sess.ent.ID, Data: b})
}

// devAchieve unlocks achievement id (0 = every one) the way an unlock pays:
// gold, item and XP (achReward), Event 1002 for one, 1241 (the catch-up
// summary) for many, the title, a save.
func (s *Server) devAchieve(sess *session, id int) (int32, string) {
	cs := sess.cnt
	if cs == nil {
		return devFailed("no achievements state")
	}
	var keys []string
	if id != 0 {
		a := contentdefs.D.AchievementByID(id)
		if a == nil {
			return devBad("unknown achievement %d", id)
		}
		keys = []string{a.Key}
	}
	titled := cs.st.TitleText()
	now := s.cfg.Now().UnixMilli()
	got := cs.st.DevEarn(keys, now)
	if len(got) == 0 {
		return devOK("nothing new (already unlocked)")
	}
	var names []string
	gold, pts, xp := 0, 0, int64(0)
	for _, a := range got {
		s.achReward(sess, a)
		names = append(names, a.Key)
		gold, pts, xp = gold+a.Gold, pts+a.Pts, xp+a.XP
	}
	if len(got) == 1 {
		a := got[0]
		b, _ := json.Marshal(map[string]any{"key": a.Key, "name": a.Name, "desc": a.Desc, "title": a.Title, "gold": a.Gold, "xp": a.XP, "tier": a.Tier, "cat": a.Cat, "pts": a.Pts, "item": a.Item, "qty": a.Qty, "at": now})
		s.sendEvent(sess, &proto.Event{Kind: EventFeatEarned, EntityID: sess.ent.ID, TargetID: uint32(a.ID), Value: int32(cs.st.Points()), Data: b})
	} else {
		b, _ := json.Marshal(map[string]any{"keys": names, "gold": gold, "xp": xp, "pts": pts})
		s.sendEvent(sess, &proto.Event{Kind: EventAchievementsCaught, EntityID: sess.ent.ID, Value: int32(len(got)), Data: b})
	}
	if cs.st.TitleText() != titled {
		s.contentTitleChanged(sess)
	}
	s.saveContent(sess)
	s.sendContentSync(sess)
	if len(got) == 1 {
		return devOK("unlocked %s (+%d points)", got[0].Name, got[0].Pts)
	}
	return devOK("unlocked %d achievements (+%d points, %d gold, %d XP)", len(got), pts, gold, xp)
}

// ---- reset ----

func (s *Server) devReset(sess *session) (int32, string) {
	e, x, ci := sess.ent, sess.x, sess.items
	if x == nil || e.cbt == nil {
		return devFailed("nothing to reset")
	}
	x.prog.DevReset()
	e.cbt.Profile.DevReset()
	sess.dev.skillBonus = 0
	if ci != nil {
		var d items.Delta
		for _, it := range slices.Clone(ci.inv.Items) {
			ci.inv.Take(it, it.Qty, &d)
			d.Delete(it)
		}
		for _, q := range items.D.Starter {
			it := items.Stack(q.Item, q.Qty)
			it.Prov = []items.Prov{{Ev: "starter", Char: e.CharacterID, Src: "dev reset", At: s.cfg.Now().UnixMilli()}}
			ci.inv.Add(it, &d)
		}
		ci.quick = ""
		s.commitItems(sess, &d, nil, "dev reset")
	}
	if q := sess.quests; q != nil {
		q.log = quests.NewLog()
		q.log.MarkDirty()
		q.recheck = true
		s.sendQuestLog(sess)
		s.saveQuests(sess)
	}
	e.Level = 1
	s.applyProgression(e, true)
	e.cbt.HP, e.cbt.Mana = e.cbt.HPMax, e.cbt.ManaMax
	syncPlayerHealth(e)
	s.sendCombatSync(sess)
	s.saveCombat(sess, true)
	s.sendStats(sess, StatsSync, 1)
	if s.cfg.Explore != nil {
		s.sendProgress(sess)
	}
	s.saveProgressSoon(sess, true)
	return devOK("character reset: level 1, starting kit, no spells, map or quests (pets, steed, feats and camps stay)")
}
