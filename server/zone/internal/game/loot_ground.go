package game

// Playtest 2 ground loot: most loot lands on the ground as pickups instead
// of going straight into the bag, because picking it up is the satisfying
// part (Nicole).
//
//   - Kill loot already dropped as personal pickups (WP14); it now scatters
//     wider around the corpse (0.9-2.1 m) so each item reads on its own.
//   - Containers: gold still goes straight into the purse inside the
//     container's own grant (spec 11: the open marker and the gold commit
//     together), every other item pops out of the chest onto the ground
//     around it as a personal pickup (keys container:<id>:<i>, granted
//     exactly once on take like kill loot).
//   - Walking over a personal pickup takes it only when autoCollects says
//     so: gold always, WP09 vein drops always (mining is unchanged), common
//     and uncommon materials / consumables / ammo / ore / gems when the
//     player's "auto-collect" setting is on (Interact 21/10, echoed back in
//     Event 400 "auto"); equipment, tomes, blueprints, tools and anything
//     rare or better need E (Interact 41). A fresh drop settles for
//     groundSettle first so its pop-out arc plays before it is vacuumed.
//   - Ownership (unchanged from WP14, documented in CR 037): rolled loot is
//     personal, only its owner sees it (snapshot filter) and only they can
//     take it, so nobody can steal it; items a player drops (G / drag out)
//     are public pickups everyone near sees in the same place, first E wins
//     (the tick is single-threaded: the loser hears "That item is gone").
//   - Inventory full: auto-collect leaves the item where it lies (one quiet
//     "inventory full" toast every fullToastGap, never a stream); E says so
//     every time; a partial stack takes what fits and the rest stays.

import (
	"math"
	"time"

	"lodestone/server/pkg/movement"
)

const (
	// groundSettle: a fresh kill or container drop is not auto-collected
	// before this (the client's pop-out arc lasts ~0.6 s).
	groundSettle = 800 * time.Millisecond
	// autoMaxRarity: the rarest tier walking over still collects (1 uncommon).
	autoMaxRarity = 1
	// fullToastGap: auto-collect's "inventory full" reminder at most this often.
	fullToastGap = 10 * time.Second
	// takenMemory: how long a taken world pickup's id is remembered so a
	// second taker gets "That item is gone" instead of silence.
	takenMemory = 5 * time.Second
	// ItemActAutoLoot: Interact 21/10, arg 1 = auto-collect on, 0 = off.
	ItemActAutoLoot = 10
)

// autoCollects says whether walking over a personal pickup takes it (no E).
func autoCollects(d *itemDrop, autoLoot bool) bool {
	if d == nil {
		return true // WP09 pickups granted by an external Granter
	}
	if d.world {
		return false // public drops: E only
	}
	if d.source == SourceVein {
		return true // WP09 mining keeps its walk-over pickup
	}
	def := d.item.Def()
	if def == nil {
		return false
	}
	if def.Kind == "currency" {
		return true
	}
	if !autoLoot || d.item.Rarity > autoMaxRarity {
		return false
	}
	switch def.Kind {
	case "material", "ore", "ingot", "gem", "ammo", "consumable":
		return true
	}
	return false
}

// scatterOffset is where drop i of n lands around a corpse or chest: a
// golden-angle spiral (no two items on top of each other) between rMin and
// rMax, rotated by the seed; around=false (a chest) keeps them on the half
// facing `toward` (the opener), so they fall out of the chest toward you.
func scatterOffset(i, n int, seed uint64, rMin, rMax float64, toward float64, around bool) (dx, dz float64) {
	const golden = 2.399963229728653
	base := float64(seed%6283) / 1000
	a := base + float64(i)*golden
	if !around {
		// Spread over 200 degrees centred on the opener.
		span := 200.0 * math.Pi / 180
		f := 0.5
		if n > 1 {
			f = float64(i) / float64(n-1)
		}
		a = toward - span/2 + span*f + (float64(seed%97)/97-0.5)*0.3
	}
	t := 0.5
	if n > 1 {
		t = math.Mod(float64(i)*0.618034+float64(seed%13)/13, 1)
	}
	r := rMin + (rMax-rMin)*t
	return r * math.Cos(a), r * math.Sin(a)
}

// groundSpot puts a drop on the ground at (x, z) near height refY.
func (s *Server) groundSpot(x, z, refY float64) movement.Vec3 {
	return movement.Vec3{X: x, Y: movement.GroundAt(s.cfg.Ground, x, refY+1.5, z) + 0.3, Z: z}
}

// autoTake: the walk-over check for owner o standing on personal pickup p.
func (s *Server) autoTake(sess *session, p *Entity, now time.Time) bool {
	d := p.drop
	if d == nil {
		return true
	}
	if now.Before(d.readyAt) || now.Before(d.refused) {
		return false
	}
	ci := sess.items
	if ci == nil || !autoCollects(d, ci.autoLoot) {
		return false
	}
	if !ci.inv.CanFit(d.item.Base, 1) {
		d.refused = now.Add(pickupRefuseGap)
		if now.After(ci.refuseAt) {
			ci.refuseAt = now.Add(fullToastGap)
			s.refuseItem(sess, InteractPickup, ActionUse, ItemRefuseFull)
		}
		return false
	}
	return true
}

// setAutoLoot: Interact 21/10.
func (s *Server) setAutoLoot(sess *session, on bool) {
	ci := sess.items
	if ci.autoLoot == on {
		s.sendInventory(sess) // echo anyway: the client stops asking
		return
	}
	ci.autoLoot = on
	s.log.Info("auto-collect", "character", sess.ent.CharacterID, "on", on)
	s.sendInventory(sess)
}

// noteTaken remembers who took world pickup id (race: one wins, the other
// is told it is gone).
func (s *Server) noteTaken(id, by uint32, now time.Time) {
	if s.itm.taken == nil {
		s.itm.taken = map[uint32]takenBy{}
	}
	for k, v := range s.itm.taken {
		if now.Sub(v.at) > takenMemory {
			delete(s.itm.taken, k)
		}
	}
	s.itm.taken[id] = takenBy{by: by, at: now}
}

type takenBy struct {
	by uint32
	at time.Time
}
