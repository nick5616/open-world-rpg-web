package explore

// Playtest 2 dev console (docs/cr/032-dev-console.md): reveal the map,
// attune every tower crystal without climbing, set XP, start over. Only the
// game package's dev console calls these (LODESTONE_ZONE_DEV zones).

// DevReveal unlocks every tower (the map of its region, fast travel to it)
// and activates every waypoint; returns how many were new.
func (w *World) DevReveal(p *Progress) int {
	p.ensure(w.siteCount)
	n := 0
	for _, t := range w.Towers {
		if !p.Towers.Has(t.Site) {
			p.Towers.Set(t.Site)
			n++
		}
	}
	for _, si := range w.waypointSites {
		if !p.Waypoints.Has(si) {
			p.Waypoints.Set(si)
			n++
		}
	}
	if n > 0 {
		p.dirty = true
	}
	return n
}

// DevAttuneAll attunes every tower crystal (unlocking the towers too);
// returns how many attunements were new (the caller grants their boons).
func (w *World) DevAttuneAll(p *Progress) int {
	p.ensure(w.siteCount)
	n := 0
	for _, t := range w.Towers {
		p.Towers.Set(t.Site)
		if !p.Attuned.Has(t.Site) {
			p.Attuned.Set(t.Site)
			n++
		}
	}
	if n > 0 {
		p.dirty = true
	}
	return n
}

// DevReset forgets every tower, waypoint, discovery, attunement, pin and
// all XP: a new character's map.
func (p *Progress) DevReset() {
	*p = Progress{Level: 1, LastWaypoint: -1, Towers: make(Bitset, len(p.Towers)), Waypoints: make(Bitset, len(p.Waypoints)),
		Discoveries: make(Bitset, len(p.Discoveries)), Attuned: make(Bitset, len(p.Attuned)), dirty: true}
}

// DevSetXP sets the total XP (and the level that follows from it).
func (p *Progress) DevSetXP(xp int64) {
	p.XP = max(0, xp)
	p.Level = LevelForXP(p.XP)
	p.dirty = true
}

// XPForLevel is the total XP at the start of level n.
func XPForLevel(n int) int64 {
	var xp int64
	for l := 1; l < n && l < 255; l++ {
		xp += XPForNextLevel(l)
	}
	return xp
}
