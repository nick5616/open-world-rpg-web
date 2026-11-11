package difficulty

// Playtest 2 vibe explorer (docs/cr/036-vibe-explorer.md): a local
// developer's override of an area's level, for listening to a place at a
// chosen difficulty. Only the zone's dev console calls these (a zone started
// with LODESTONE_ZONE_DEV=1). The override sits on top of the stamp: it is
// never written to the store, a stamp arriving meanwhile still lands
// underneath, and clearing it gives back exactly what was there (the
// stamp, the Haven's 1, or unknown).

// DevOverride sets (level > 0) or clears (level <= 0) an area's override.
// It reports the level the area showed before and whether it was known.
func (m *Map) DevOverride(c, level int) (prev int, prevKnown bool) {
	if c < 0 || c >= len(m.level) {
		return 0, false
	}
	prev, prevKnown = m.Level(c)
	if level <= 0 {
		if m.over != nil {
			m.over[c] = 0
		}
		return prev, prevKnown
	}
	if m.over == nil {
		m.over = make([]int16, len(m.level))
	}
	m.over[c] = int16(max(1, min(m.Def.MaxLevel, level)))
	return prev, prevKnown
}

// DevOverridden is an area's override level (0: none).
func (m *Map) DevOverridden(c int) int {
	if m.over == nil || c < 0 || c >= len(m.over) {
		return 0
	}
	return int(m.over[c])
}

// DevOverrides lists the overridden areas (ascending).
func (m *Map) DevOverrides() []int {
	var out []int
	for c, l := range m.over {
		if l > 0 {
			out = append(out, c)
		}
	}
	return out
}

// Square is an area's square in metres (x0, z0, x1, z1).
func (m *Map) Square(c int) (x0, z0, x1, z1 float64) {
	cx, cz := m.XZ(c)
	x0, z0 = float64(cx)*m.CellM, float64(cz)*m.CellM
	return x0, z0, x0 + m.CellM, z0 + m.CellM
}

// Projected is the level an unknown area would be stamped at by a player of
// playerLevel now (the stamp rule over the known neighbours); a known area's
// own level.
func (m *Map) Projected(c, playerLevel int) int {
	if l, ok := m.Level(c); ok {
		return l
	}
	var ns []int
	for _, n := range m.Neighbours(c) {
		if l, ok := m.Level(n); ok {
			ns = append(ns, l)
		}
	}
	return Propose(m.Def, playerLevel, ns, m.Danger(c))
}
