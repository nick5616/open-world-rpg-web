package game

// Terrain hooks (WP07). The zone's ground is a movement.Ground; when it is
// the wasm terrain (server/pkg/worldhost.Terrain) it also knows where new
// characters start and wants to hear where players are so it can generate
// chunks ahead of them. Both are optional interfaces, so tests and the
// flat-ground fallback keep working unchanged, and Config needs no new
// fields.

import (
	"lodestone/server/pkg/accountapi"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
)

// spawner is a ground that can place a character with no saved position
// (worldhost.Terrain: a dry point near the atlas spawn settlement).
type spawner interface {
	SpawnPoint(key string) movement.Vec3
}

// wanter is a ground with a chunk cache fed by interest.
type wanter interface {
	Want(x, z, marginM float64)
}

const (
	// Each player re-announces its interest twice a second, staggered by
	// entity id, so 150 players cost ~10 Want calls per tick.
	wantEveryTicks = constants.TickRateHz / 2
	// Interest square: 48 m around the player (always covers the chunk
	// they stand in plus the near neighbors) plus 3 s of travel at their
	// current speed, so a sprinting player's next chunks are generated
	// seconds before they arrive (a chunk takes ~4 ms).
	wantMarginM    = 48
	wantLookaheadS = 3
)

// terrainTick feeds the chunk cache (tick goroutine; Want never blocks).
func (s *Server) terrainTick(tick uint32) {
	w, ok := s.cfg.Ground.(wanter)
	if !ok {
		return
	}
	for _, e := range s.ents {
		if (tick+e.ID)%wantEveryTicks == 0 {
			w.Want(e.Move.Pos.X, e.Move.Pos.Z, wantMarginM+movement.HorizontalSpeed(e.Move)*wantLookaheadS)
		}
	}
}

// newCharacterSpawn places a character without a saved position: near the
// atlas spawn on terrain, or WP03's scatter around the world center on flat
// ground. Connection goroutine (may generate a chunk, ~5 ms).
func (s *Server) newCharacterSpawn(characterID string) movement.Vec3 {
	if sp, ok := s.cfg.Ground.(spawner); ok {
		return sp.SpawnPoint(characterID)
	}
	return defaultSpawn(characterID)
}

// savedSpawn respects a character's saved position, except WP04's creation
// placeholder: account characters are created at accountapi.SpawnPosition()
// (world center, y = 0, "snap to ground" until worldgen supplies a spawn).
// A position exactly equal to it has never been checkpointed by a zone, so
// it is a new character and starts at the atlas spawn instead of wherever
// the world center happens to be (often a mountain or a lake).
func (s *Server) savedSpawn(characterID string, p movement.Vec3) movement.Vec3 {
	if wp4 := accountapi.SpawnPosition(); p.X == wp4.X && p.Y == wp4.Y && p.Z == wp4.Z {
		return s.newCharacterSpawn(characterID)
	}
	return p // join() lifts it onto the ground if it is below
}

// hintSpawn puts a dev spawn hint (bots' ?spawn=x,z) on the ground.
func (s *Server) hintSpawn(h movement.Vec3) movement.Vec3 {
	h.Y = s.cfg.Ground.HeightAt(h.X, h.Z)
	return h
}

// verticalOK is the terrain half of movement validation (spec 9: validated
// against max speed for the current mode). The horizontal bound lives in
// applyFrame; vertically, a grounded-or-airborne player's new height is
// either physics (at most the previous height plus one step at the faster
// of its vertical velocity and a jump) or the ground it snapped onto, and
// never below the ground. Both hold exactly for movement.Step, so this only
// trips on bugs and on modes the server doesn't simulate yet (climb, glide,
// updrafts: WP10 must extend it). Checked on the step's own result, before
// the world-edge clamp moves x/z.
func verticalOK(prev, next movement.State, g movement.Ground) bool {
	const eps = 1e-6
	ground := g.HeightAt(next.Pos.X, next.Pos.Z)
	if next.Pos.Y < ground-eps {
		return false
	}
	rise := max(prev.Vel.Y, constants.JumpForce) * movement.Dt
	return next.Pos.Y <= max(prev.Pos.Y+rise, ground)+eps
}
