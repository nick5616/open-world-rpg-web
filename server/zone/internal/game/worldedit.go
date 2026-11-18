package game

// World edits (playtest 3, CR 040): the generated world can be broken and
// reshaped, server-authoritative and persisted.
//
//   - Harvest (Interact 42, action 1, targetId = a scatter record's stable
//     id): trees fall to an axe, rocks shatter to a pickaxe, bushes give way
//     to anything. Each swing does damage; at zero the object is gone for
//     everyone: a world edit (kind object_destroyed, world_edits row, the
//     WorldEdits message to clients near it), its drops land as the
//     breaker's personal pickups, and it grows back after a seeded long
//     time (never inside a player's base: WorldEditSetup.InBase).
//   - Earthworks (Interact 43, targetId = x cm | z cm << 32 of the strike,
//     action 1 = dig, 2 = fill): the shovel lowers or raises the 1 m lattice
//     in small steps (server/pkg/worldedit plans each swing: brush, slope
//     cascade, water floor, protected ground). The deltas live in the
//     worldedit.Overlay every ground query sees (worldhost.Terrain), go to
//     clients as TerrainEdits (message 73) and to the database per chunk
//     (terrain_edits, migration 0031) through the write-behind queue.
//
// Everything is event-driven: nothing here runs per tick except one
// comparison against the earliest regrow time, a tiny pending-grant map
// while someone digs, and the half-second interest scan the WorldEdits of
// mining already do.

import (
	"context"
	"encoding/binary"
	"math"
	"slices"
	"time"

	"lodestone/server/pkg/campdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/worldedit"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/items"
	"lodestone/server/zone/internal/quests"
)

// Interact target kinds owned by world edits (contracts/events.md registry).
const (
	InteractHarvest = 42
	InteractEarth   = 43
)

// Event kinds (contracts/events.md, CR 040 range 1800-1819).
const (
	EventHarvestHit     = 1800 // to the swinger: an object took a hit
	EventHarvestFX      = 1801 // to players near: someone hit an object
	EventHarvestFelled  = 1802 // to players near: an object fell or shattered
	EventHarvestRefused = 1803
	EventEarthFX        = 1805 // to players near (and the digger): the ground was dug or filled
	EventEarthRefused   = 1806
	EventEarthGrant     = 1807 // to the worker: dirt and stone credited (batched)
)

// Harvest refusal reasons (EventHarvestRefused value).
const (
	HarvestFar      = 1
	HarvestUnknown  = 2
	HarvestNeedTool = 3
	HarvestTooFast  = 4
	HarvestGone     = 5
	HarvestFull     = 6
)

// Earthwork refusal reasons (EventEarthRefused value).
const (
	EarthFar       = 1
	EarthNeedTool  = 2
	EarthForbidden = 3
	EarthTooFast   = 4
	EarthNoChange  = 5 // already at the +-6 m cap, the water line, or nothing to fill
	EarthNoDirt    = 6
	EarthFull      = 7
	EarthBadTarget = 8
	EarthTooBig    = 9
)

const (
	harvestReachM = 4.8                    // eye to the nearest point of the object, plus its radius
	earthReachM   = 6.0                    // eye to the struck ground
	workGap       = 170 * time.Millisecond // under the client's 250 ms swing, so tick quantization never refuses an honest one
	// hpResetAfter: a half-chopped tree heals after this long untouched.
	hpResetAfter = 2 * time.Minute
	// maxRemoved bounds removed scatter objects per zone (stored and streamed).
	maxRemoved = 30000
	// editInterestChunks: world edits stream for chunks within this many chunks.
	editInterestChunks = 6
	// fellFXM: how far players see (and hear) a tree come down.
	fellFXM = 150
	hitFXM  = 64
	// grantFlush: batched dirt grants land after this long or at grantBatch items.
	grantFlush = 1500 * time.Millisecond
	grantBatch = 6
)

// ScatterRec is one scatter record as the zone needs it.
type ScatterRec struct {
	ID                          uint64
	X, Y, Z                     float64
	Layer, Kind, Variant, Scale uint8
	Yaw                         uint8
}

// ScatterSource finds a scatter record by its stable id (the generator's
// chunk records; false when the chunk is not cached or the id is unknown).
type ScatterSource interface {
	ScatterRecord(id uint64) (ScatterRec, bool)
}

// TerrainEditStore persists the terrain edit blocks (migration 0031).
type TerrainEditStore interface {
	LoadTerrainBlocks(ctx context.Context, worldID string) (map[[2]int32][]byte, error)
	SaveTerrainBlock(ctx context.Context, worldID string, cx, cz int32, entries []byte, vertices int) error
	DeleteTerrainBlock(ctx context.Context, worldID string, cx, cz int32) error
}

// WorldEditSetup configures world edits; nil Config.WorldEdit turns them off.
type WorldEditSetup struct {
	// Overlay holds the terrain deltas (main installs the same one on the
	// worldhost.Terrain every ground query goes through).
	Overlay *worldedit.Overlay
	Scatter ScatterSource
	// Plan answers the dig planner's questions about the generated world.
	Plan worldedit.World
	// Store persists terrain blocks (nil: memory only); scatter removals use Config.EditStore.
	Store TerrainEditStore
	// RegrowScale multiplies regrow times (0 = 1; tests shorten it).
	RegrowScale float64
	// InBase reports ground inside a player's base (base building, CR 041):
	// what is removed there never grows back. nil: no bases.
	InBase func(x, z float64) bool
}

type removedObj struct {
	id         uint64
	editID     int64
	cx, cz     int32
	x, y, z    float64
	at         time.Time // regrows then; zero = never
	rec        proto.EditRecord
	layer, kin uint8
}

type objHP struct {
	hp   float64
	last time.Time
}

type grantPend struct {
	dirt, stone int
	since       time.Time
}

type worldEdits struct {
	removed map[uint64]*removedObj
	byChunk map[[2]int32][]*removedObj
	hp      map[uint64]*objHP
	regrow  []*removedObj // by regrow time
	pend    map[uint32]*grantPend
	acc     map[uint32]int // volume remainder per digger
	felled  int64
	dug     int64
	filled  int64
	hpSweep time.Time
}

func (w *worldEdits) init() {
	if w.removed == nil {
		w.removed = map[uint64]*removedObj{}
		w.byChunk = map[[2]int32][]*removedObj{}
		w.hp = map[uint64]*objHP{}
		w.pend = map[uint32]*grantPend{}
		w.acc = map[uint32]int{}
	}
}

func (s *Server) weOn() bool { return s.cfg.WorldEdit != nil && s.cfg.WorldEdit.Overlay != nil }

// worldEditInteract handles Interact 42 and 43 (tick goroutine).
func (s *Server) worldEditInteract(sess *session, in *proto.Interact, now time.Time) {
	e := sess.ent
	if e == nil || !s.weOn() {
		return
	}
	s.we.init()
	switch in.TargetKind {
	case InteractHarvest:
		if in.Action == ActionUse {
			s.harvest(sess, e, in.TargetID, now)
		}
	case InteractEarth:
		if in.Action == 1 || in.Action == 2 {
			s.earthwork(sess, e, in, now)
		}
	}
}

// hasTool: the character carries the tool (the pickaxe has always been
// implicit; items are optional in tests without an item system).
func hasTool(sess *session, tool string) bool {
	if sess.items == nil {
		return true
	}
	return sess.items.inv.Count(tool) > 0
}

func (s *Server) harvestRefuse(e *Entity, id uint64, reason int32, extra string) {
	s.sendEventTo(e, &proto.Event{Kind: EventHarvestRefused, EntityID: e.ID, Value: reason, Data: veinData(id, []byte(extra)...)})
}

// segDist is the distance from a point to the vertical segment (x, y0..y1, z).
func segDist(p movement.Vec3, x, y0, y1, z float64) float64 {
	cy := math.Max(y0, math.Min(y1, p.Y))
	return math.Sqrt(sq(p.X-x) + sq(p.Y-cy) + sq(p.Z-z))
}

func (s *Server) harvest(sess *session, e *Entity, id uint64, now time.Time) {
	we := s.cfg.WorldEdit
	if now.Sub(e.lastWork) < workGap {
		s.harvestRefuse(e, id, HarvestTooFast, "")
		return
	}
	if s.we.removed[id] != nil {
		s.harvestRefuse(e, id, HarvestGone, "")
		return
	}
	rec, ok := we.Scatter.ScatterRecord(id)
	if !ok {
		s.harvestRefuse(e, id, HarvestUnknown, "")
		return
	}
	def, ok := worldedit.DefFor(rec.Layer, rec.Kind)
	if !ok {
		s.harvestRefuse(e, id, HarvestUnknown, "")
		return
	}
	sf := worldedit.ScaleFactor(rec.Scale)
	eye := e.Move.Pos
	eye.Y += constants.PlayerHeight
	if segDist(eye, rec.X, rec.Y, rec.Y+def.Height*sf, rec.Z) > harvestReachM+def.Radius*sf {
		s.harvestRefuse(e, id, HarvestFar, "")
		return
	}
	dmg := def.Damage
	switch {
	case def.Tool != "" && !hasTool(sess, def.Tool):
		s.harvestRefuse(e, id, HarvestNeedTool, def.Tool)
		return
	case def.Tool == "" && !(hasTool(sess, worldedit.ToolAxe) || hasTool(sess, worldedit.ToolPickaxe) || hasTool(sess, worldedit.ToolShovel)):
		dmg *= 0.4 // bare hands clear a bush slowly
	}
	if len(s.we.removed) >= maxRemoved {
		s.harvestRefuse(e, id, HarvestFull, "")
		return
	}
	e.lastWork = now
	st := s.we.hp[id]
	if st == nil || now.Sub(st.last) > hpResetAfter {
		st = &objHP{hp: def.MaxHP(rec.Scale)}
		s.we.hp[id] = st
	}
	st.hp -= dmg
	st.last = now
	maxHP := def.MaxHP(rec.Scale)
	pct := int32(math.Max(0, math.Ceil(st.hp/maxHP*100)))
	extra := make([]byte, 2)
	binary.LittleEndian.PutUint16(extra, uint16(maxHP))
	cmx, cmy, cmz := proto.MetersToCm(rec.X), proto.MetersToCm(rec.Y+def.Height*sf*0.4), proto.MetersToCm(rec.Z)
	s.sendEventTo(e, &proto.Event{Kind: EventHarvestHit, EntityID: e.ID, Value: pct, X: cmx, Y: cmy, Z: cmz, Data: veinData(id, extra...)})
	var fx *proto.Event
	for _, o := range s.sessions {
		if o.ent == nil || o == sess || dist3(o.ent.Move.Pos, e.Move.Pos) > hitFXM {
			continue
		}
		if fx == nil {
			fx = &proto.Event{Kind: EventHarvestFX, EntityID: e.ID, Value: pct, X: cmx, Y: cmy, Z: cmz, Data: veinData(id, byte(rec.Layer), rec.Kind)}
		}
		s.sendEvent(o, fx)
	}
	if st.hp <= 0 {
		delete(s.we.hp, id)
		s.fell(sess, e, rec, def, now)
		if def.Tool == worldedit.ToolAxe {
			s.questsDeed(sess, quests.DeedFell) // CR 051: the timber errand
		}
	}
	if now.Sub(s.we.hpSweep) > time.Minute {
		s.we.hpSweep = now
		for k, h := range s.we.hp {
			if now.Sub(h.last) > hpResetAfter {
				delete(s.we.hp, k)
			}
		}
	}
}

func (s *Server) regrowDelay(def worldedit.Def, id uint64, editID int64, x, z float64) time.Duration {
	we := s.cfg.WorldEdit
	if s.inBase(x, z) {
		return 0
	}
	d := def.Regrow(s.cfg.Seed ^ mix64(id) ^ uint64(editID))
	if we.RegrowScale > 0 {
		d = time.Duration(float64(d) * we.RegrowScale)
	}
	return d
}

// baseRecheck: how long a due regrowth waits when a base now stands on it.
const baseRecheck = 30 * time.Minute

// baseNearM: a building piece this close makes the spot part of a base.
const baseNearM = 6.0

// inBase reports ground inside a player's base: within a warding hearth's
// circle or a few metres of any building piece (CR 041), or whatever the
// setup's InBase hook says. Spatially bucketed (piecesNear), evaluated only
// when an object falls and when its regrowth is due, never per tick.
func (s *Server) inBase(x, z float64) bool {
	if we := s.cfg.WorldEdit; we != nil && we.InBase != nil && we.InBase(x, z) {
		return true
	}
	for _, p := range s.piecesNear(x, z, max(baseNearM, campdefs.D.Build.Hearth.WardRadiusM)) {
		d := campdefs.D.ByID(p.Kind)
		if d == nil || d.Build == nil {
			continue
		}
		r := baseNearM
		if d.Build.Use == "hearth" {
			r = max(r, campdefs.D.Build.Hearth.WardRadiusM)
		}
		if math.Hypot(p.X-x, p.Z-z) <= r {
			return true
		}
	}
	return false
}

func objectParams(x, y, z float64) []byte {
	p := make([]byte, 12)
	binary.LittleEndian.PutUint32(p[0:], math.Float32bits(float32(x)))
	binary.LittleEndian.PutUint32(p[4:], math.Float32bits(float32(y)))
	binary.LittleEndian.PutUint32(p[8:], math.Float32bits(float32(z)))
	return p
}

// fell removes a broken object for everyone, rolls the breaker's drops and
// stores the edit.
func (s *Server) fell(sess *session, e *Entity, rec ScatterRec, def worldedit.Def, now time.Time) {
	editID := int64(mix64(rec.ID^uint64(now.UnixNano())) >> 1)
	delay := s.regrowDelay(def, rec.ID, editID, rec.X, rec.Z)
	cx, cz := chunkOf(rec.X, rec.Z)
	ro := &removedObj{id: rec.ID, editID: editID, cx: cx, cz: cz, x: rec.X, y: rec.Y, z: rec.Z, layer: rec.Layer, kin: rec.Kind}
	exp := 0.0
	if delay > 0 {
		ro.at = now.Add(delay)
		exp = float64(ro.at.UnixMicro()) / 1000
	}
	ro.rec = proto.EditRecord{EditID: uint64(editID), Kind: proto.EditKindObjectDestroyed, TargetID: rec.ID, Params: objectParams(rec.X, rec.Y, rec.Z), Tick: s.tick, ExpiresAt: exp}
	s.we.add(ro)
	s.we.felled++
	s.broadcastObjectEdit(ro)
	s.persistObject(ro, now)

	// The fall: toward away from the breaker.
	away := math.Atan2(rec.Z-e.Move.Pos.Z, rec.X-e.Move.Pos.X)
	turn := byte(int(math.Mod(away/(2*math.Pi)+1, 1)*256) & 255)
	ev := &proto.Event{Kind: EventHarvestFelled, EntityID: e.ID, Value: int32(rec.Layer)<<8 | int32(rec.Kind),
		X: proto.MetersToCm(rec.X), Y: proto.MetersToCm(rec.Y), Z: proto.MetersToCm(rec.Z), Data: veinData(rec.ID, rec.Scale, rec.Yaw, turn)}
	for _, o := range s.sessions {
		if o.ent != nil && dist3(o.ent.Move.Pos, e.Move.Pos) <= fellFXM+30 {
			s.sendEvent(o, ev)
		}
	}

	// Drops: the breaker's own roll (personal, like mining).
	seed := mix64(s.cfg.Seed ^ mix64(rec.ID) ^ uint64(editID) ^ hashString(e.CharacterID))
	yields := def.Roll(rec.Scale, seed)
	for i, y := range yields {
		dx, dz := scatterOffset(i, len(yields), seed, 0.6, 1.8, 0, true)
		x, z := rec.X+dx, rec.Z+dz
		p := s.spawnWorkPickup(e, x, z, y.Item, y.Qty, seed+uint64(i), now)
		s.sendEventTo(e, &proto.Event{Kind: EventDropSpawned, EntityID: p.ID, TargetID: e.ID, Value: int32(y.Qty), Data: []byte(y.Item)})
	}
	s.log.Info("object felled", "id", rec.ID, "layer", rec.Layer, "kind", rec.Kind, "character", e.CharacterID, "edit", editID, "regrowIn", delay.Round(time.Second).String(), "drops", len(yields))
}

// spawnWorkPickup drops a personal pickup of a world-edit yield on the ground.
func (s *Server) spawnWorkPickup(owner *Entity, x, z float64, item string, qty int, seed uint64, now time.Time) *Entity {
	p := &Entity{ID: s.nextID, Kind: proto.EntityKindPickup, Name: item, Level: uint8(min(qty, 255)), Owner: owner.ID,
		Item: item, Qty: qty, RollSeed: seed, DespawnAt: now.Add(constants.PickupDespawnS * time.Second)}
	s.nextID++
	p.Move.Pos = movement.Vec3{X: x, Y: s.cfg.Ground.HeightAt(x, z) + 0.35, Z: z}
	p.prevValid = p.Move
	p.view = p.Move
	p.drop = s.veinDrop(item, qty, seed, owner)
	s.insertEntity(p)
	return p
}

func (w *worldEdits) add(o *removedObj) {
	w.removed[o.id] = o
	k := [2]int32{o.cx, o.cz}
	w.byChunk[k] = append(w.byChunk[k], o)
	if !o.at.IsZero() {
		i, _ := slices.BinarySearchFunc(w.regrow, o.at, func(x *removedObj, t time.Time) int { return x.at.Compare(t) })
		w.regrow = slices.Insert(w.regrow, i, o)
	}
}

func (w *worldEdits) drop(o *removedObj) {
	delete(w.removed, o.id)
	k := [2]int32{o.cx, o.cz}
	if l := w.byChunk[k]; l != nil {
		if i := slices.Index(l, o); i >= 0 {
			w.byChunk[k] = slices.Delete(l, i, i+1)
		}
		if len(w.byChunk[k]) == 0 {
			delete(w.byChunk, k)
		}
	}
	if i := slices.Index(w.regrow, o); i >= 0 {
		w.regrow = slices.Delete(w.regrow, i, i+1)
	}
}

func (s *Server) broadcastObjectEdit(o *removedObj) {
	msg := proto.Encode(&proto.WorldEdits{Cx: o.cx, Cz: o.cz, Edits: []proto.EditRecord{o.rec}})
	k := [2]int32{o.cx, o.cz}
	for _, sess := range s.sessions {
		if sess.weChunks[k] {
			_ = sess.conn.SendReliable(msg)
		}
	}
}

func (s *Server) persistObject(o *removedObj, now time.Time) {
	if s.cfg.EditStore == nil || s.cfg.Queue == nil {
		return
	}
	row := StoredEdit{EditID: o.editID, ChunkX: o.cx, ChunkZ: o.cz, Kind: "object_destroyed", TargetID: o.id, X: float32(o.x), Y: float32(o.y), Z: float32(o.z), Tick: s.tick, ExpiresAt: o.at}
	store, world := s.cfg.EditStore, s.cfg.WorldID
	s.cfg.Queue.Enqueue(writebehind.Op{Key: "edit:" + itoa64(o.editID), Run: func(ctx context.Context) error {
		return store.SaveEdit(ctx, world, row)
	}})
}

// ---- earthworks ----

func (s *Server) earthRefuse(e *Entity, op uint8, reason int32) {
	s.sendEventTo(e, &proto.Event{Kind: EventEarthRefused, EntityID: e.ID, TargetID: uint32(op), Value: reason})
}

func (s *Server) earthwork(sess *session, e *Entity, in *proto.Interact, now time.Time) {
	we := s.cfg.WorldEdit
	op := worldedit.Dig
	if in.Action == 2 {
		op = worldedit.Fill
	}
	if now.Sub(e.lastWork) < workGap {
		s.earthRefuse(e, in.Action, EarthTooFast)
		return
	}
	cxm, czm := uint32(in.TargetID), uint32(in.TargetID>>32)
	px, pz := float64(cxm)/100, float64(czm)/100
	if px < 1 || pz < 1 || px > 4094 || pz > 4094 {
		s.earthRefuse(e, in.Action, EarthBadTarget)
		return
	}
	if !hasTool(sess, worldedit.ToolShovel) {
		s.earthRefuse(e, in.Action, EarthNeedTool)
		return
	}
	eye := e.Move.Pos
	eye.Y += constants.PlayerHeight
	gy := s.cfg.Ground.HeightAt(px, pz)
	if math.Sqrt(sq(eye.X-px)+sq(eye.Y-gy)+sq(eye.Z-pz)) > earthReachM {
		s.earthRefuse(e, in.Action, EarthFar)
		return
	}
	plan, r := worldedit.PlanSwing(we.Overlay, we.Plan, op, px, pz)
	switch r {
	case worldedit.Forbidden:
		s.earthRefuse(e, in.Action, EarthForbidden)
		return
	case worldedit.AtLimit, worldedit.Bedrock:
		s.earthRefuse(e, in.Action, EarthNoChange)
		return
	case worldedit.TooBig:
		s.earthRefuse(e, in.Action, EarthTooBig)
		return
	}
	pend := s.we.pend[e.ID]
	if pend == nil {
		pend = &grantPend{since: now}
		s.we.pend[e.ID] = pend
	}
	cost := 0
	if op == worldedit.Fill {
		cost = worldedit.CostFor(plan.Raised)
		have := pend.dirt
		if sess.items != nil {
			have += sess.items.inv.Count("earth:dirt") + sess.items.inv.Count("stone:block")
		} else {
			have = 1 << 20
		}
		if have < cost {
			s.earthRefuse(e, in.Action, EarthNoDirt)
			return
		}
	}
	blocks, err := we.Overlay.Apply(plan.Changes)
	if err != nil {
		s.earthRefuse(e, in.Action, EarthFull)
		return
	}
	e.lastWork = now
	if op == worldedit.Fill {
		s.we.filled++
		pend.dirt -= cost
	} else {
		s.we.dug++
		n, rest := worldedit.ItemsFor(plan.Lowered, s.we.acc[e.ID])
		s.we.acc[e.ID] = rest
		// Deep or rocky ground gives stone as well as dirt.
		stone := 0
		if n > 0 && we.Overlay.Delta(plan.CenterX, plan.CenterZ) <= -10 {
			stone = n / 2
		}
		pend.dirt += n - stone
		pend.stone += stone
	}
	if pend.dirt != 0 || pend.stone != 0 {
		if pend.since.IsZero() {
			pend.since = now
		}
	}
	s.broadcastTerrain(blocks, plan.Changes)
	s.persistTerrain(blocks)
	s.flushPend(sess, e, pend, now, false)
	ev := &proto.Event{Kind: EventEarthFX, EntityID: e.ID, TargetID: uint32(in.Action), Value: int32(plan.Lowered + plan.Raised),
		X: proto.MetersToCm(float64(plan.CenterX)), Y: proto.MetersToCm(gy), Z: proto.MetersToCm(float64(plan.CenterZ))}
	for _, o := range s.sessions {
		if o.ent != nil && dist3(o.ent.Move.Pos, e.Move.Pos) <= hitFXM {
			s.sendEvent(o, ev)
		}
	}
}

// flushPend writes batched dirt grants (positive) and fill costs (negative)
// to the inventory once enough piled up or they waited long enough.
func (s *Server) flushPend(sess *session, e *Entity, p *grantPend, now time.Time, force bool) {
	if p.dirt == 0 && p.stone == 0 {
		return
	}
	if !force && abs(p.dirt)+p.stone < grantBatch && now.Sub(p.since) < grantFlush {
		return
	}
	ci := sess.items
	dirt, stone := p.dirt, p.stone
	p.dirt, p.stone, p.since = 0, 0, now
	if ci == nil {
		return
	}
	var d items.Delta
	if dirt < 0 {
		need := -dirt
		take := min(need, ci.inv.Count("earth:dirt"))
		ci.inv.Spend("earth:dirt", take, &d)
		if rest := need - take; rest > 0 {
			ci.inv.Spend("stone:block", min(rest, ci.inv.Count("stone:block")), &d)
		}
	} else if dirt > 0 {
		s.addOrDrop(sess, e, "earth:dirt", dirt, &d)
	}
	if stone > 0 {
		s.addOrDrop(sess, e, "stone:block", stone, &d)
	}
	s.commitItems(sess, &d, nil, "earthworks")
	if dirt > 0 || stone > 0 {
		s.sendEventTo(e, &proto.Event{Kind: EventEarthGrant, EntityID: e.ID, Value: int32(dirt), TargetID: uint32(stone)})
	}
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// addOrDrop adds to the bag and drops what does not fit at the worker's feet.
func (s *Server) addOrDrop(sess *session, e *Entity, item string, qty int, d *items.Delta) {
	left := sess.items.inv.Add(items.Stack(item, qty), d)
	if left > 0 {
		s.spawnWorkPickup(e, e.Move.Pos.X+0.8, e.Move.Pos.Z, item, left, mix64(uint64(s.tick)), s.cfg.Now())
	}
}

// ---- streaming ----

// broadcastTerrain sends the changed vertices (new values) of each touched
// chunk to the clients that hold it.
func (s *Server) broadcastTerrain(blocks [][2]int32, changes []worldedit.Change) {
	by := map[[2]int32][]worldedit.Entry{}
	for _, c := range changes {
		k := [2]int32{c.X >> 6, c.Z >> 6}
		by[k] = append(by[k], worldedit.Entry{I: uint16((c.Z&63)*64 + (c.X & 63)), D: c.D})
	}
	for k, es := range by {
		msg := proto.Encode(&proto.TerrainEdits{Cx: k[0], Cz: k[1], Data: worldedit.EncodeEntries(es)})
		for _, sess := range s.sessions {
			if sess.weChunks[k] {
				_ = sess.conn.SendReliable(msg)
			}
		}
	}
}

// persistTerrain queues each touched chunk's whole block (coalesced by chunk:
// a burst of swings writes once).
func (s *Server) persistTerrain(blocks [][2]int32) {
	we := s.cfg.WorldEdit
	if we.Store == nil || s.cfg.Queue == nil {
		return
	}
	for _, k := range blocks {
		es := we.Overlay.BlockEntries(k[0], k[1])
		store, world, cx, cz := we.Store, s.cfg.WorldID, k[0], k[1]
		key := "terr:" + itoa64(int64(cx)) + ":" + itoa64(int64(cz))
		if len(es) == 0 {
			s.cfg.Queue.Enqueue(writebehind.Op{Key: key, Run: func(ctx context.Context) error { return store.DeleteTerrainBlock(ctx, world, cx, cz) }})
			continue
		}
		data, n := worldedit.EncodeEntries(es), len(es)
		s.cfg.Queue.Enqueue(writebehind.Op{Key: key, Run: func(ctx context.Context) error {
			return store.SaveTerrainBlock(ctx, world, cx, cz, data, n)
		}})
	}
}

// worldEditTick: regrowth, batched grants and the interest scan. Cheap when
// idle: one comparison against the earliest regrow time, an empty map.
func (s *Server) worldEditTick(tick uint32, now time.Time) {
	if !s.weOn() {
		return
	}
	s.we.init()
	for len(s.we.regrow) > 0 && !now.Before(s.we.regrow[0].at) {
		o := s.we.regrow[0]
		if s.inBase(o.x, o.z) {
			// A base was built here since it fell (CR 041): look again later, cheaply, instead of growing back inside it.
			s.we.drop(o)
			o.at = now.Add(baseRecheck)
			s.we.add(o)
			continue
		}
		s.we.drop(o)
		o.rec.ExpiresAt = s.serverTimeMs()
		s.broadcastObjectEdit(o)
		if s.cfg.EditStore != nil && s.cfg.Queue != nil {
			store, world, eid := s.cfg.EditStore, s.cfg.WorldID, o.editID
			s.cfg.Queue.Enqueue(writebehind.Op{Key: "edit-del:" + itoa64(eid), Run: func(ctx context.Context) error {
				return store.DeleteEdit(ctx, world, eid)
			}})
		}
		s.log.Info("object regrown", "id", o.id, "edit", o.editID)
	}
	if len(s.we.pend) > 0 {
		for id, p := range s.we.pend {
			sess := s.sessionOf(id)
			if sess == nil {
				delete(s.we.pend, id)
				delete(s.we.acc, id)
				continue
			}
			s.flushPend(sess, sess.ent, p, now, false)
			if p.dirt == 0 && p.stone == 0 && now.Sub(p.since) > 30*time.Second {
				delete(s.we.pend, id)
			}
		}
	}
	if tick%editEveryTicks == 0 {
		for _, sess := range s.sessions {
			s.worldEditInterest(sess)
		}
	}
}

func (s *Server) sessionOf(entID uint32) *session {
	for _, sess := range s.sessions {
		if sess.ent != nil && sess.ent.ID == entID {
			return sess
		}
	}
	return nil
}

// worldEditInterest sends a chunk's removed objects and terrain edits when it
// enters a client's interest square, and forgets chunks that left it.
func (s *Server) worldEditInterest(sess *session) {
	e := sess.ent
	if e == nil {
		return
	}
	if sess.weChunks == nil {
		sess.weChunks = map[[2]int32]bool{}
	}
	cx, cz := chunkOf(e.Move.Pos.X, e.Move.Pos.Z)
	r := int32(editInterestChunks)
	for k := range sess.weChunks {
		if abs32(k[0]-cx) > r+1 || abs32(k[1]-cz) > r+1 {
			delete(sess.weChunks, k)
		}
	}
	ov := s.cfg.WorldEdit.Overlay
	for dz := -r; dz <= r; dz++ {
		for dx := -r; dx <= r; dx++ {
			k := [2]int32{cx + dx, cz + dz}
			if sess.weChunks[k] {
				continue
			}
			sess.weChunks[k] = true
			if list := s.we.byChunk[k]; len(list) > 0 {
				for len(list) > 0 {
					n := min(len(list), 200)
					recs := make([]proto.EditRecord, n)
					for i, o := range list[:n] {
						recs[i] = o.rec
					}
					list = list[n:]
					_ = sess.conn.SendReliable(proto.Encode(&proto.WorldEdits{Cx: k[0], Cz: k[1], Edits: recs}))
				}
			}
			if es := ov.BlockEntries(k[0], k[1]); len(es) > 0 {
				_ = sess.conn.SendReliable(proto.Encode(&proto.TerrainEdits{Cx: k[0], Cz: k[1], Data: worldedit.EncodeEntries(es)}))
			}
		}
	}
}

// RestoreWorldEdits re-applies persisted removals and terrain blocks at
// startup (before Start). Returns (objects, terrain chunks).
func (s *Server) RestoreWorldEdits(ctx context.Context) (int, int, error) {
	if !s.weOn() {
		return 0, 0, nil
	}
	s.we.init()
	we := s.cfg.WorldEdit
	objs, blocks := 0, 0
	if s.cfg.EditStore != nil {
		rows, err := s.cfg.EditStore.LoadEdits(ctx, s.cfg.WorldID, s.cfg.Now())
		if err != nil {
			return 0, 0, err
		}
		for _, r := range rows {
			if r.Kind != "object_destroyed" {
				continue
			}
			cx, cz := chunkOf(float64(r.X), float64(r.Z))
			exp := 0.0
			if !r.ExpiresAt.IsZero() {
				exp = float64(r.ExpiresAt.UnixMicro()) / 1000
			}
			o := &removedObj{id: r.TargetID, editID: r.EditID, cx: cx, cz: cz, x: float64(r.X), y: float64(r.Y), z: float64(r.Z), at: r.ExpiresAt}
			o.rec = proto.EditRecord{EditID: uint64(r.EditID), Kind: proto.EditKindObjectDestroyed, TargetID: r.TargetID, Params: objectParams(float64(r.X), float64(r.Y), float64(r.Z)), Tick: r.Tick, ExpiresAt: exp}
			s.we.add(o)
			objs++
		}
	}
	if we.Store != nil {
		m, err := we.Store.LoadTerrainBlocks(ctx, s.cfg.WorldID)
		if err != nil {
			return objs, 0, err
		}
		for k, raw := range m {
			es, err := worldedit.DecodeEntries(raw)
			if err != nil {
				s.log.Warn("terrain edit block unreadable; skipped", "cx", k[0], "cz", k[1], "err", err)
				continue
			}
			if err := we.Overlay.SetBlock(k[0], k[1], es); err != nil {
				s.log.Warn("terrain edit block not restored", "cx", k[0], "cz", k[1], "err", err)
				continue
			}
			blocks++
		}
	}
	return objs, blocks, nil
}

// WorldEditStatus is a debug snapshot.
type WorldEditStatus struct {
	Removed       int   `json:"removedObjects"`
	Felled        int64 `json:"felledTotal"`
	Dug           int64 `json:"digSwings"`
	Filled        int64 `json:"fillSwings"`
	TerrainChunks int   `json:"terrainChunks"`
	TerrainVerts  int64 `json:"terrainVertices"`
}

// WorldEditStatus returns the world-edit counters (taken on the tick goroutine).
func (s *Server) WorldEditStatus(ctx context.Context) (WorldEditStatus, error) {
	var st WorldEditStatus
	err := s.Do(ctx, func() { st = s.worldEditStatus() })
	return st, err
}

func (s *Server) worldEditStatus() WorldEditStatus {
	st := WorldEditStatus{Removed: len(s.we.removed), Felled: s.we.felled, Dug: s.we.dug, Filled: s.we.filled}
	if s.weOn() {
		st.TerrainChunks, st.TerrainVerts = s.cfg.WorldEdit.Overlay.Blocks(), s.cfg.WorldEdit.Overlay.Vertices()
	}
	return st
}
