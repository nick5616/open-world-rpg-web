package game

// Leveling that matters and the tower crystals (playtest 1, CR 012,
// docs/decisions/0021-discovery-difficulty.md).
//
//   - A character level gives health, damage, stamina and spell skill points
//     (combat.yaml leveling): combat.Player.SetLevel applies health and the
//     damage multiplier; the stamina wheel is the movement state's
//     StaminaMax (it rides SelfState, so the client's prediction adopts it).
//   - A level-up is a moment: full health and stamina, Event 604 as before,
//     and Event 900 character_stats with reason 1 so the client can list
//     what was gained.
//   - Towers (WP12): standing on the top still unlocks the tower (map reveal,
//     fast travel, XP). The crystal up there can now be attuned (Interact 10
//     action 2): the first attunement of each tower gives a permanent boon
//     (combat.yaml leveling.attune: stamina, health, a skill point, XP),
//     recorded in character_progress.attuned (migration 0021), and Event 902
//     tower_attuned, the hook for the client's grand discovery moment.
//
// Everything here runs on the tick and touches only in-memory state; saves
// ride WP12's progress write-behind.

import (
	"encoding/binary"
	"math"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/explore"
)

// Event kinds 900-949 (contracts/events.md, playtest 1 progression).
const (
	EventCharacterStats = 900
	EventArea           = 901
	EventTowerAttuned   = 902
	EventAttuneRefused  = 903
)

// ActionAttune is Interact 10 (site) action 2: attune to a tower's crystal.
const ActionAttune = 2

// character_stats reasons (Event 900 data byte 1).
const (
	StatsSync    = 0
	StatsLevelUp = 1
	StatsAttuned = 2
	// StatsHotbar (CR 039): once after a join, when the character's level
	// opened spell slots or a loadout it was never told about (a character
	// saved before CR 039); previous level = the level last told.
	StatsHotbar = 3
)

// hotbarNews reports whether going from level from to level to opens a
// spell slot or a loadout (CR 039).
func hotbarNews(from, to int) bool {
	d := combatdefs.D
	return d.SpellSlots(to) > d.SpellSlots(from) || d.LoadoutsOpen(to) > d.LoadoutsOpen(from)
}

// hotbarJoin is CR 039's migration: a character whose level opened spell
// slots or the third loadout before it was ever told (saved before CR 039,
// or levelled on a zone that never said) hears it once, in Event 900
// reason 3; the level told is saved with the loadouts.
func (s *Server) hotbarJoin(sess *session) {
	e := sess.ent
	if e == nil || e.x == nil || e.cbt == nil {
		return
	}
	pr, lvl := e.cbt.Profile, e.x.prog.Level
	seen := max(1, pr.HotbarSeen)
	if lvl <= pr.HotbarSeen {
		return
	}
	news := hotbarNews(seen, lvl)
	pr.SeeHotbar(lvl)
	if news {
		s.sendStats(sess, StatsHotbar, seen)
		s.log.Info("hotbar unlocks told", "entity", e.ID, "level", lvl, "since", seen, "slots", combatdefs.D.SpellSlots(lvl), "loadouts", combatdefs.D.LoadoutsOpen(lvl))
	}
	s.saveCombat(sess, false)
}

// attunedCount is the number of tower crystals a character attuned.
func attunedCount(p *explore.Progress) int { return explore.Bitset(p.Attuned).Count() }

// staminaPoints is a character's stamina wheel in points: the start wheel,
// the level's growth and the attunement boons.
func staminaPoints(level, attuned int) float64 {
	lv := &combatdefs.D.Leveling
	return constants.StaminaMax + combatdefs.D.StaminaBonus(level) + lv.Attune.Stamina*float64(attuned)
}

// applyProgression puts the level and boons into combat and movement (join,
// level-up, attunement). refill gives full health and stamina (a level-up).
func (s *Server) applyProgression(e *Entity, refill bool) {
	if e == nil || e.x == nil {
		return
	}
	p := e.x.prog
	n := attunedCount(p)
	lv := &combatdefs.D.Leveling
	if c := e.cbt; c != nil {
		if c.Level != p.Level {
			c.SetLevel(p.Level)
		}
		c.SetBoons(combat.Boons{Health: lv.Attune.Health * float64(n), SkillPoints: lv.Attune.SkillPoints*n + s.devSkillBonus(e)}) // CR 032: dev skill points
		if refill && !c.Downed {
			c.HP = c.HPMax
		}
		syncPlayerHealth(e)
	}
	want := int(math.Round((staminaPoints(p.Level, n) + s.campRestedStamina(e)) * constants.StaminaFinePerPoint)) // CR 025: Rested
	if old := e.Move.StaminaMax; want != old && want > 0 {
		e.Move.StaminaMax = want
		if want > old {
			e.Move.Stamina += want - old // the new part of the wheel arrives full
		}
		e.Move.Stamina = min(e.Move.Stamina, want)
		e.prevValid.StaminaMax, e.prevValid.Stamina = e.Move.StaminaMax, min(e.prevValid.Stamina, want)
	}
	if refill {
		e.Move.Stamina = e.Move.StaminaMax
	}
}

// progressionJoin runs after combatJoin: level and boons applied, stats sent.
func (s *Server) progressionJoin(sess *session) {
	e := sess.ent
	if e == nil || e.x == nil {
		return
	}
	s.applyProgression(e, false)
	s.sendStats(sess, StatsSync, int(e.Level))
	s.hotbarJoin(sess) // CR 039
}

// levelChanged is every level-up's path (discovery, combat XP, attunement,
// defense rewards): Event 604, the new stats in combat and movement, a full
// refill, combat_sync (skill points, mana max) and Event 900 (reason 1).
func (s *Server) levelChanged(sess *session, before int) {
	e := sess.ent
	if e == nil || e.x == nil || e.x.prog.Level == before {
		return
	}
	e.Level = uint8(min(255, e.x.prog.Level))
	s.sendEvent(sess, &proto.Event{Kind: EventLevelUp, EntityID: e.ID, Value: int32(e.x.prog.Level)})
	s.applyProgression(e, true)
	if e.cbt != nil {
		e.cbt.Profile.SeeHotbar(e.x.prog.Level) // CR 039: the fanfare tells new spell slots and loadouts
		s.sendCombatSync(sess)
	}
	s.sendStats(sess, StatsLevelUp, before)
	s.contentLevel(sess) // CR 023: level feats (content.go)
	s.log.Info("level up", "character", e.CharacterID, "from", before, "to", e.x.prog.Level)
}

// levelProgress is the XP into the current level and the XP the next needs.
func levelProgress(xp int64) (level int, into, next int64) {
	level = 1
	rem := xp
	for rem >= explore.XPForNextLevel(level) && level < 255 {
		rem -= explore.XPForNextLevel(level)
		level++
	}
	return level, rem, explore.XPForNextLevel(level)
}

// EncodeStats is the character_stats (900) payload:
//
//	u8 version (1) | u8 reason (0 sync, 1 level-up, 2 attuned) | u16 level | u16 previous level
//	| u64 xp | u32 xp into the level | u32 xp the next level needs
//	| u16 health max | u16 mana max | u16 stamina max (points) | u16 damage bonus (x10 %)
//	| u8 skill points free | u8 skill points total | u8 towers attuned
//	| u16 n + n bytes attuned bitset (bit i = site i, like progress_sync)
func EncodeStats(reason, level, prev int, xp int64, hpMax, manaMax, staminaMax, dmgPct float64, free, total, attuned int, set []byte) []byte {
	_, into, next := levelProgress(xp)
	b := []byte{1, byte(reason)}
	b = binary.LittleEndian.AppendUint16(b, uint16(level))
	b = binary.LittleEndian.AppendUint16(b, uint16(max(1, prev)))
	b = binary.LittleEndian.AppendUint64(b, uint64(max(0, xp)))
	b = binary.LittleEndian.AppendUint32(b, uint32(into))
	b = binary.LittleEndian.AppendUint32(b, uint32(next))
	b = binary.LittleEndian.AppendUint16(b, uint16(math.Min(65535, math.Round(hpMax))))
	b = binary.LittleEndian.AppendUint16(b, uint16(math.Min(65535, math.Round(manaMax))))
	b = binary.LittleEndian.AppendUint16(b, uint16(math.Min(65535, math.Round(staminaMax))))
	b = binary.LittleEndian.AppendUint16(b, uint16(math.Min(65535, math.Round(dmgPct*10))))
	b = append(b, byte(min(255, max(0, free))), byte(min(255, max(0, total))), byte(min(255, attuned)))
	b = binary.LittleEndian.AppendUint16(b, uint16(len(set)))
	return append(b, set...)
}

// sendStats sends Event 900 to the player.
func (s *Server) sendStats(sess *session, reason, prev int) {
	e := sess.ent
	if e == nil || e.x == nil {
		return
	}
	p := e.x.prog
	hp, mana, free, total := combatdefs.D.MaxHealth(p.Level), combatdefs.D.MaxMana(p.Level), 0, combat.SkillPoints(p.Level)
	if c := e.cbt; c != nil {
		hp, mana, total = c.HPMax, c.ManaMax, c.SkillPointsTotal()
		free = total - c.Profile.Spent()
	}
	dmg := (combatdefs.D.DamageMult(p.Level) - 1) * 100
	st := float64(e.Move.StaminaMax) / constants.StaminaFinePerPoint
	s.sendEvent(sess, &proto.Event{Kind: EventCharacterStats, EntityID: e.ID, TargetID: uint32(reason), Value: int32(p.Level),
		Data: EncodeStats(reason, p.Level, prev, p.XP, hp, mana, st, dmg, free, total, attunedCount(p), p.Attuned)})
}

// attune handles Interact 10 action 2 (tick goroutine).
func (s *Server) attune(sess *session, site int) {
	w := s.cfg.Explore
	e := sess.ent
	x := sess.x
	if w == nil || e == nil || x == nil {
		return
	}
	before := x.prog.Level
	var reason explore.AttuneError
	s.hap, reason = w.Attune(x.prog, e.Move.Pos, site, s.hap[:0])
	for _, h := range s.hap { // standing on the top unlocked it just now
		s.announce(sess, h)
	}
	if reason != explore.AttuneOK {
		s.sendEvent(sess, &proto.Event{Kind: EventAttuneRefused, EntityID: e.ID, TargetID: uint32(max(0, site)), Value: int32(reason)})
		if reason == explore.AttuneAlready {
			s.contentAttuned(sess, site) // CR 035: an attuned crystal answers the main story again
		}
		if len(s.hap) > 0 {
			s.levelChanged(sess, before)
			s.sendProgress(sess)
			s.saveProgressSoon(sess, false)
		}
		return
	}
	lv := &combatdefs.D.Leveling
	x.prog.AddXP(lv.Attune.XP)
	st := &w.Atlas.Sites[site]
	region := int(st.Region)
	name := ""
	if region >= 0 && region < len(w.Atlas.Regions) {
		name = w.Atlas.Regions[region].Name
	}
	ev := &proto.Event{Kind: EventTowerAttuned, EntityID: e.ID, TargetID: uint32(site), Value: int32(region), X: cm(st.X), Y: cm(st.Y), Z: cm(st.Z), Data: []byte(name)}
	if t, ok := w.TowerOfSite(site); ok {
		ev.X, ev.Y, ev.Z = cm(t.Shape.CX), cm(t.Shape.TopY), cm(t.Shape.CZ)
	}
	s.sendEvent(sess, ev)
	if x.prog.Level != before {
		s.levelChanged(sess, before) // refills and sends 900 (level-up) with the boon included
	} else {
		s.applyProgression(e, false)
		if e.cbt != nil {
			s.sendCombatSync(sess) // skill points
		}
	}
	s.sendStats(sess, StatsAttuned, before)
	s.sendProgress(sess)
	s.saveProgressSoon(sess, false)
	s.log.Info("tower attuned", "character", e.CharacterID, "site", site, "region", name, "attuned", attunedCount(x.prog))
	s.contentAttuned(sess, site) // CR 023: story steps, feats (content.go)
}
