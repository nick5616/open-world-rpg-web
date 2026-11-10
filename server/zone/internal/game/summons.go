package game

// Allies from summon spells (playtest 2 spell mechanics, CR 020). The
// combat world owns them (internal/combat/summon.go); this glue names their
// entities ("Nicole's Wraith Hound", EntityKind effect) and lets them fight
// players only where the PvP rules let their caster (pvp.go: both flagged,
// not one party, no safe zone; or the two duelists of a duel), keeping the
// duel and kill-feed bookkeeping a player's own hit gets.

import "lodestone/server/zone/internal/combat"

func (s *Server) summonName(en *combat.Enemy) string {
	name := en.AllyName()
	if o := s.entityByID(en.Owner()); o != nil && o.Name != "" {
		return o.Name + "'s " + name
	}
	return name
}

func (s *Server) summonHooks(w *combat.World) {
	w.SummonPvP = func(owner, victim uint32) (combat.PvPHit, bool) {
		e, t := s.entityByID(owner), s.entityByID(victim)
		if e == nil || t == nil || e == t || e.cbt == nil || t.cbt == nil {
			return combat.PvPHit{}, false
		}
		how, _, ok := s.pvpVerdict(e, t)
		return how, ok
	}
	w.OnSummonPvP = func(owner, victim uint32, res combat.PvPResult) {
		e, t := s.entityByID(owner), s.entityByID(victim)
		if e == nil || t == nil {
			return
		}
		syncPlayerHealth(t)
		if e.pvp != nil && e.pvp.duel != nil && e.pvp.duel.other(e) == t {
			d := e.pvp.duel
			d.taken[d.index(t)] += res.Dealt
			if res.DuelFloor {
				s.endDuel(d, d.index(e), duelDefeated)
			}
			return
		}
		s.pvpEngaged(e)
		s.pvpEngaged(t)
		if res.Downed {
			s.pvpKillFeed(e, t)
		}
	}
}
