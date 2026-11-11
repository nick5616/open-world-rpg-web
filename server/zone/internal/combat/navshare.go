package combat

// Shared answers (playtest 2 pathfinding): a pack chasing one player round
// one house asks the same question five times in a tick. The nav pass keeps
// the last navRecent answers; an ask for (nearly) the same goal is answered
// from one when the walker can see a point of that path within
// navReuseJoin (it joins the leg furthest along), or when that search
// failed from nearby. Same order every run: the ring is filled and read on
// the tick goroutine in queue order.

import "lodestone/server/pkg/movement"

// remember files a finished search's answer (newest replaces oldest).
func (n *navWorld) remember(class uint8, tick uint32, from, goal movement.Vec3, wps []movement.Vec3, ok bool) {
	c := &n.recent[n.nextRc]
	n.nextRc = (n.nextRc + 1) % navRecent
	c.class, c.ok, c.tick, c.from, c.goal = class, ok, tick, from, goal
	c.pts = append(c.pts[:0], from)
	c.pts = append(c.pts, wps...)
}

// navShared answers an ask from a recent search for the same goal: a path
// the walker can join, or that search's failure when it started nearby.
// hit false: search.
func (w *World) navShared(class uint8, from, to movement.Vec3) (wps []movement.Vec3, hit, ok bool) {
	n := w.nav
	for i := 0; i < navRecent; i++ { // newest first
		c := &n.recent[(n.nextRc-1-i+2*navRecent)%navRecent]
		if len(c.pts) == 0 || w.tick-c.tick > navReuseTicks || c.class != class || hdist(c.goal, to) > navReuseGoal {
			continue
		}
		if !c.ok {
			if hdist(c.from, from) < 4 {
				return nil, true, false
			}
			continue
		}
		// join at the point of a leg nearest the walker, the leg furthest
		// along first (a pack along a wall joins the first leg anywhere)
		for j := len(c.pts) - 1; j >= 1; j-- {
			a, b := c.pts[j-1], c.pts[j]
			q := segPoint(from, a, b)
			if hdist(q, from) < navReuseJoin && w.navPeekLOS(from, q, class) {
				out := make([]movement.Vec3, 0, len(c.pts)-j+1)
				if hdist(q, b) > 0.5 {
					out = append(out, q)
				}
				return append(out, c.pts[j:]...), true, true
			}
		}
	}
	return nil, false, false
}

// navPeekLOS is navLOS on built chunks only (false where one is missing).
// Read-only: AI workers call it (navFollow's shortcut).
func (w *World) navPeekLOS(a, b movement.Vec3, class uint8) bool {
	n := w.nav
	if n == nil {
		return false
	}
	bit := uint8(1) << class
	steps := int(hdist(a, b)/0.2) + 1
	var c *navChunkData
	ck := int32(-1)
	cell := func(x, z int32) (float32, uint8, bool) {
		if x < 0 || z < 0 || x >= navPerEdge*navChunk || z >= navPerEdge*navChunk {
			return 0, 0, false
		}
		if k := (z/navChunk)*navPerEdge + x/navChunk; k != ck {
			ck, c = k, n.chunks[k]
		}
		if c == nil {
			return 0, 0, false
		}
		i := (z%navChunk)*navChunk + x%navChunk
		return c.h[i], c.walk[i], true
	}
	px, pz := navCellOf(a.X), navCellOf(a.Z)
	prevH, wk, ok := cell(px, pz)
	if !ok || wk&bit == 0 {
		return false
	}
	for k := 1; k <= steps; k++ {
		t := float64(k) / float64(steps)
		x, z := navCellOf(a.X+(b.X-a.X)*t), navCellOf(a.Z+(b.Z-a.Z)*t)
		if x == px && z == pz {
			continue
		}
		h, wk, ok := cell(x, z)
		if !ok || wk&bit == 0 || h-prevH > navLOSRise {
			return false
		}
		px, pz, prevH = x, z, h
	}
	return true
}
