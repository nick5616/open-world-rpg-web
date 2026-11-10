package combat

import "lodestone/server/pkg/movement"

// posAt is the recorded position nearest tick (CR 020 homing re-flights).
func (e *Enemy) posAt(tick uint32) movement.Vec3 {
	best, bd := e.Pos, uint32(1<<31)
	for i := 0; i < min(e.nHist, histLen); i++ {
		s := e.hist[i]
		d := s.tick - tick
		if tick > s.tick {
			d = tick - s.tick
		}
		if d < bd {
			best, bd = s.pos, d
		}
	}
	return best
}

// posAt is a player's recorded position nearest tick (PvP homing re-flights).
func (p *Player) posAt(tick uint32) movement.Vec3 {
	best, bd := p.Pos, uint32(1<<31)
	for i := 0; i < min(p.nHist, pvpHist); i++ {
		s := p.hist[i]
		d := s.tick - tick
		if tick > s.tick {
			d = tick - s.tick
		}
		if d < bd {
			best, bd = s.pos, d
		}
	}
	return best
}
