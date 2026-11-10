package game

// Playtest 2 dash overhaul (CR 021): the chemistry a dash leaves behind.
// The combat world follows every running dash (combat/dashes.go: damage,
// heal trail, slam); here the zone schedules what the dash does to the
// terrain, server-side like a spell impact (nightAction): magma dash sets
// grass alight along its path (chem ignite), glacier step freezes the water
// it skates over (chem freeze). One op every dashChemTicks per dasher, at
// its feet; nothing for players who are not dashing (no per-tick bytes).

import (
	"os"
	"strings"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/zone/internal/chem"
	"lodestone/server/zone/internal/combat"
)

// devGrantSpells: LODESTONE_ZONE_DEBUG_SPELLS="key,key,..." teaches every
// joining character these spells (dev combat zones only: the dash evidence
// run equips spells a new character does not know).
func (s *Server) devGrantSpells(p *combat.Profile) {
	if !s.cbt.setup.Dev || p == nil {
		return
	}
	for _, k := range strings.Split(os.Getenv("LODESTONE_ZONE_DEBUG_SPELLS"), ",") {
		if k = strings.TrimSpace(k); combatdefs.D.SpellByKey(k) != nil {
			p.Grant(k)
		}
	}
}

// dashChemTicks: a trail op every 0.2 s (a 30 m/s jet: one every 6 m; the
// ops spread over a radius of 2 cells).
const dashChemTicks = 6

// dashChemRadius is the trail's width (m) at each op.
const dashChemRadius = 3.0

// dashEnvTick schedules running dashes' chemistry (combatTick, after the
// combat world's step).
func (s *Server) dashEnvTick(tick uint32) {
	if s.night.cfg.Chem == nil {
		return
	}
	for _, sess := range s.sessions {
		e := sess.ent
		if e == nil || e.cbt == nil {
			continue
		}
		d, ok := e.cbt.DashTrail()
		if !ok || d.Trail == nil || d.Trail.Chem == "" || (tick+e.ID)%dashChemTicks != 0 {
			continue
		}
		pos := e.Move.Pos
		switch d.Trail.Chem {
		case "ignite":
			g := s.cfg.Ground.HeightAt(pos.X, pos.Z)
			if pos.Y-g > 4 || movement.WaterAt(s.cfg.Ground, pos.X, pos.Z) > g {
				continue // flying high or over water: nothing to burn
			}
			s.chemAt(chem.OpIgnite, pos, dashChemRadius)
		case "freeze":
			if movement.WaterAt(s.cfg.Ground, pos.X, pos.Z) <= s.cfg.Ground.HeightAt(pos.X, pos.Z) {
				continue // the frozen path is over water
			}
			s.chemAt(chem.OpFreeze, pos, dashChemRadius)
		}
	}
}
