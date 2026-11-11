package game

// Mining (WP09, spec 7 "Mining"): server-authoritative ore veins.
//
//   - A vein takes damage from a pickaxe swing (Interact), Earth spells, or
//     any spell impact at half rate (DamageVein is the hook combat, WP13,
//     calls).
//   - When it breaks the zone rolls drops for every player who damaged it
//     (personal drops, spec 8: miners never fight over a gem), each from a
//     seeded roll that is logged, and spawns them as pickups only their
//     owner sees. Picking one up calls Config.Granter (inventory is WP14).
//   - It records a world edit vein_mined(id, respawnAt) whose params carry
//     the 1.5 m carve sphere, applies it to the cave cells (collision changes
//     at once), sends WorldEdits to clients with that chunk in interest and
//     persists it to world_edits through the write-behind queue.
//   - After a seeded 6-24 h (Config.VeinRespawnMin/Max) the vein and its
//     carve are restored: the edit is removed everywhere, clients get a
//     WorldEdits delta with the edit expired, the row is deleted.
//
// Wire conventions (contracts/events.md 700-799; Interact in
// server/zone/README.md "Mining"): Interact{targetKind 40 = vein, action 1 =
// swing, targetId = vein id}, Interact{targetKind 41 = pickup, action 1 =
// take, targetId = pickup entity id}.

import (
	"context"
	"encoding/binary"
	"hash/fnv"
	"math"
	"slices"
	"time"

	"lodestone/server/pkg/caves"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/writebehind"
)

// Interact target kinds and actions owned by mining.
const (
	InteractVein   = 40 // contracts/events.md Interact registry (1-9 are core)
	InteractPickup = 41
	ActionUse      = 1
)

// Event kinds (contracts/events.md, WP09 range 700-799).
const (
	EventVeinHit     = 701
	EventVeinBreak   = 702
	EventDropSpawned = 703
	EventItemGranted = 704
	EventMineRefused = 706
	EventMineSwing   = 707 // CR 018: another player swung a pickaxe (observers within mineSwingM)
)

// mineSwingM: how far other players see a pickaxe swing (the combat FX radius, Event 214).
const mineSwingM = 64

// Refusal reasons (EventMineRefused value).
const (
	RefuseFar     = 1
	RefuseMined   = 2
	RefuseUnknown = 3
	RefuseTooFast = 4
)

// DamageSource scales vein damage (spec 7).
type DamageSource uint8

// Damage sources: a pickaxe and Earth spells do full damage, any other
// spell's impact half.
const (
	SourcePickaxe DamageSource = 1
	SourceEarth   DamageSource = 2
	SourceSpell   DamageSource = 3
)

func (d DamageSource) scale() float64 {
	if d == SourceSpell {
		return 0.5
	}
	return 1
}

const (
	// CarveRadiusM is the sphere a broken vein carves (spec 7).
	CarveRadiusM = 1.5
	// mineReachM: from the eye to the vein point. Generous (PvE, favor the
	// player): a swing at a vein you can clearly touch never fails.
	mineReachM = 4.5
	// pickaxeDamage per swing, swingGap the fastest legit swing rate.
	pickaxeDamage = 25.0
	swingGap      = 250 * time.Millisecond // under the client's 300 ms swing so tick quantization (33 ms) never refuses an honest one
	// pickupReachM: auto-pickup when the owner walks within this.
	pickupReachM     = 1.6
	pickupTakeReachM = 3.5
	// contribution window: players who hit the vein this recently share
	// in its drops.
	contributionWindow = 2 * time.Minute
)

// Granter receives items from pickups (WP14 replaces the default, which
// only logs and tells the client with EventItemGranted).
type Granter interface {
	Grant(characterID string, item string, qty int, rollSeed uint64) error
}

// EditStore persists world edits (spec 11 world_edits).
type EditStore interface {
	LoadEdits(ctx context.Context, worldID string, now time.Time) ([]StoredEdit, error)
	SaveEdit(ctx context.Context, worldID string, e StoredEdit) error
	DeleteEdit(ctx context.Context, worldID string, editID int64) error
}

// StoredEdit is one world_edits row.
type StoredEdit struct {
	EditID         int64
	ChunkX, ChunkZ int32
	Kind           string
	TargetID       uint64
	X, Y, Z, R     float32
	Tick           uint32
	ExpiresAt      time.Time
}

type veinState struct {
	hp        float64
	maxHP     float64
	mined     bool
	editID    int64
	respawnAt time.Time
	minedAt   time.Time
	hitters   map[uint32]time.Time // entity id -> last hit
	chunkX    int32
	chunkZ    int32
}

// edit is an active world edit as the zone keeps it.
type edit struct {
	rec    proto.EditRecord
	cx, cz int32
	carve  caves.Edit
}

type mining struct {
	veins   map[uint64]*veinState
	byChunk map[[2]int32][]*edit
	byVein  map[uint64]*edit
	mined   int64
	loaded  bool
}

func (m *mining) init() {
	if m.veins == nil {
		m.veins = map[uint64]*veinState{}
		m.byChunk = map[[2]int32][]*edit{}
		m.byVein = map[uint64]*edit{}
	}
}

func chunkOf(x, z float64) (int32, int32) {
	return int32(math.Floor(x / 64)), int32(math.Floor(z / 64))
}

func mix64(z uint64) uint64 {
	z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9
	z = (z ^ (z >> 27)) * 0x94D049BB133111EB
	return z ^ (z >> 31)
}

func unit(h uint64) float64 { return float64(h>>11) / float64(uint64(1)<<53) }

func (s *Server) vein(cw caveWorld, id uint64) (caves.Vein, *veinState, bool) {
	v, ok := cw.CaveGraph().Vein(id)
	if !ok {
		if v, ok = s.layerVein(id); !ok { // CR 038: the Underground's and the Depths' veins (vertical.go)
			return v, nil, false
		}
	}
	s.mine.init()
	st := s.mine.veins[id]
	if st == nil {
		cx, cz := chunkOf(v.X, v.Z)
		st = &veinState{hp: float64(v.HP), maxHP: float64(v.HP), hitters: map[uint32]time.Time{}, chunkX: cx, chunkZ: cz}
		s.mine.veins[id] = st
	}
	return v, st, true
}

func (s *Server) sendEventTo(e *Entity, ev *proto.Event) {
	if sess := s.byChar[e.CharacterID]; sess != nil && sess.ent == e {
		_ = sess.conn.SendReliable(proto.Encode(ev))
	}
}

func veinData(id uint64, extra ...byte) []byte {
	b := make([]byte, 8, 8+len(extra))
	binary.LittleEndian.PutUint64(b, id)
	return append(b, extra...)
}

func (s *Server) refuse(e *Entity, id uint64, reason int32) {
	s.sendEventTo(e, &proto.Event{Kind: EventMineRefused, EntityID: e.ID, Value: reason, Data: veinData(id)})
}

// interact handles an Interact message (tick goroutine).
func (s *Server) interact(e *Entity, in *proto.Interact, now time.Time) {
	switch {
	case in.TargetKind == InteractVein && in.Action == ActionUse:
		cw := s.caves()
		if cw == nil {
			return
		}
		v, st, ok := s.vein(cw, in.TargetID)
		if !ok {
			s.refuse(e, in.TargetID, RefuseUnknown)
			return
		}
		if st.mined {
			s.refuse(e, in.TargetID, RefuseMined)
			return
		}
		eye := e.Move.Pos
		eye.Y += constants.PlayerHeight
		if math.Sqrt(sq(eye.X-v.X)+sq(eye.Y-v.Y)+sq(eye.Z-v.Z)) > mineReachM {
			s.refuse(e, in.TargetID, RefuseFar)
			return
		}
		if now.Sub(e.lastSwing) < swingGap {
			s.refuse(e, in.TargetID, RefuseTooFast)
			return
		}
		e.lastSwing = now
		s.mineSwingFX(e, v.X, v.Y, v.Z)
		s.DamageVein(e, in.TargetID, pickaxeDamage, SourcePickaxe)
	case in.TargetKind == InteractPickup && in.Action == ActionUse:
		for _, p := range s.ents {
			if p.ID == uint32(in.TargetID) && p.Kind == proto.EntityKindPickup && p.Owner == e.ID {
				if dist3(p.Move.Pos, e.Move.Pos) <= pickupTakeReachM+constants.PlayerHeight {
					s.takePickup(e, p)
				}
				return
			}
		}
	}
}

// mineSwingFX tells the players near a miner (not the miner, who swung
// locally) about a pickaxe swing, so their avatar animates it (CR 018):
// entityId = miner, x/y/z = the vein (cm).
func (s *Server) mineSwingFX(miner *Entity, x, y, z float64) {
	var ev *proto.Event
	for _, sess := range s.sessions {
		o := sess.ent
		if o == nil || o == miner || dist3(o.Move.Pos, miner.Move.Pos) > mineSwingM {
			continue
		}
		if ev == nil {
			ev = &proto.Event{Kind: EventMineSwing, EntityID: miner.ID, X: proto.MetersToCm(x), Y: proto.MetersToCm(y), Z: proto.MetersToCm(z)}
		}
		s.sendEvent(sess, ev)
	}
}

func sq(v float64) float64 { return v * v }

func dist3(a, b movement.Vec3) float64 { return math.Sqrt(sq(a.X-b.X) + sq(a.Y-b.Y) + sq(a.Z-b.Z)) }

// DamageVein is the hook combat (WP13) and tools call: amount before the
// source scale (spell impacts count half). Tick goroutine only.
func (s *Server) DamageVein(player *Entity, veinID uint64, amount float64, src DamageSource) {
	cw := s.caves()
	if cw == nil || amount <= 0 {
		return
	}
	v, st, ok := s.vein(cw, veinID)
	if !ok || st.mined {
		return
	}
	now := s.cfg.Now()
	st.hp -= amount * src.scale()
	if player != nil {
		st.hitters[player.ID] = now
	}
	hp := int32(math.Max(0, math.Ceil(st.hp)))
	if player != nil {
		extra := make([]byte, 2)
		binary.LittleEndian.PutUint16(extra, uint16(st.maxHP))
		s.sendEventTo(player, &proto.Event{Kind: EventVeinHit, EntityID: player.ID, Value: hp,
			X: proto.MetersToCm(v.X), Y: proto.MetersToCm(v.Y), Z: proto.MetersToCm(v.Z), Data: veinData(veinID, extra...)})
	}
	if st.hp <= 0 {
		s.breakVein(cw, v, st, player, now)
	}
}

// Sunsteel (playtest 2): the official world has six sunsteel veins, one per
// cave, each at the bottom of a sunlit shaft, and the starter quest sends
// every new character to the nearest one for a blade's worth of ore (2
// ingots = 4 ore). So a sunsteel vein always yields at least that, and
// grows back within the hour instead of 6-24 h: whoever mined it first must
// not lock everyone else out of the starter quest for a day.
const (
	sunsteelMinOre     = 4
	sunsteelRespawnMin = 20 * time.Minute
	sunsteelRespawnMax = 40 * time.Minute
)

func isSunsteel(v caves.Vein) bool { return v.Kind == caves.KindOre && v.MaterialName() == "sunsteel" }

func (s *Server) respawnDelay(v caves.Vein, editID int64) time.Duration {
	veinID := v.ID
	lo, hi := s.cfg.VeinRespawnMin, s.cfg.VeinRespawnMax
	if isSunsteel(v) {
		lo, hi = min(lo, sunsteelRespawnMin), min(hi, sunsteelRespawnMax)
	}
	if hi < lo {
		hi = lo
	}
	u := unit(mix64(s.cfg.Seed ^ mix64(veinID) ^ uint64(editID)*0x9E3779B97F4A7C15))
	return lo + time.Duration(float64(hi-lo)*u)
}

func (s *Server) breakVein(cw caveWorld, v caves.Vein, st *veinState, breaker *Entity, now time.Time) {
	st.mined = true
	st.minedAt = now
	st.editID = int64(mix64(v.ID^uint64(now.UnixNano())) >> 1)
	st.respawnAt = now.Add(s.respawnDelay(v, st.editID))
	s.mine.mined++
	s.m.veinsMined.Add(1)
	if breaker != nil {
		s.achByChar(breaker.CharacterID, func(sess *session) { s.achAdd(sess, "mined", 1) }) // CR 031
	}

	// The edit: carve + mined flag, everywhere at once.
	carve := caves.Edit{VeinID: v.ID, X: float32(v.X), Y: float32(v.Y), Z: float32(v.Z), R: CarveRadiusM}
	if isLayerVein(v) {
		carve.R = 0 // CR 038: a cavern floor is a heightfield: the vein just goes (no carve)
	}
	ed := s.addEdit(carve, st.editID, st.respawnAt)
	cw.SetEdit(carve)
	s.broadcastEdit(ed)
	if s.cfg.EditStore != nil && s.cfg.Queue != nil {
		row := StoredEdit{EditID: st.editID, ChunkX: ed.cx, ChunkZ: ed.cz, Kind: "vein_mined", TargetID: v.ID,
			X: carve.X, Y: carve.Y, Z: carve.Z, R: carve.R, Tick: s.tick, ExpiresAt: st.respawnAt}
		store, world := s.cfg.EditStore, s.cfg.WorldID
		s.cfg.Queue.Enqueue(writebehind.Op{Key: "edit:" + itoa64(st.editID), Run: func(ctx context.Context) error {
			return store.SaveEdit(ctx, world, row)
		}})
	}

	// Personal drops for everyone who helped, each a logged, seeded roll.
	var owners []*Entity
	for id, t := range st.hitters {
		if now.Sub(t) > contributionWindow {
			continue
		}
		for _, e := range s.ents {
			if e.ID == id && e.Kind == proto.EntityKindPlayer {
				owners = append(owners, e)
			}
		}
	}
	slices.SortFunc(owners, func(a, b *Entity) int { return cmpU32(a.ID, b.ID) })
	respawnS := int32(st.respawnAt.Sub(now) / time.Second)
	for _, o := range owners {
		seed := mix64(s.cfg.Seed ^ mix64(v.ID) ^ uint64(st.editID) ^ hashString(o.CharacterID))
		item, qty := rollDrop(v, seed)
		s.log.Info("vein drop", "vein", v.ID, "material", v.MaterialName(), "character", o.CharacterID, "item", item, "qty", qty, "rollSeed", seed, "edit", st.editID)
		p := s.spawnPickup(o, v, item, qty, seed, now)
		s.sendEventTo(o, &proto.Event{Kind: EventVeinBreak, EntityID: o.ID, TargetID: p.ID, Value: respawnS, Data: veinData(v.ID)})
		s.sendEventTo(o, &proto.Event{Kind: EventDropSpawned, EntityID: p.ID, TargetID: o.ID, Value: int32(qty), Data: []byte(item)})
	}
	st.hitters = map[uint32]time.Time{}
	s.log.Info("vein mined", "vein", v.ID, "material", v.MaterialName(), "edit", st.editID, "respawnAt", st.respawnAt.UTC().Format(time.RFC3339), "owners", len(owners))
}

func hashString(s string) uint64 {
	h := fnv.New64a()
	h.Write([]byte(s))
	return h.Sum64()
}

func itoa64(v int64) string {
	b := make([]byte, 0, 20)
	if v == 0 {
		return "0"
	}
	neg := v < 0
	u := uint64(v)
	if neg {
		u = uint64(-v)
	}
	for u > 0 {
		b = append(b, byte('0'+u%10))
		u /= 10
	}
	if neg {
		b = append(b, '-')
	}
	slices.Reverse(b)
	return string(b)
}

// rollDrop: what one player gets from a vein. Ore: 1-4 of it (bigger
// clusters give more). Gem: one stone, usually rough, sometimes cut or
// brilliant (deeper is better). Item ids are "ore:<name>" and
// "gem:<name>:<cut>" until WP14 defines items.
func rollDrop(v caves.Vein, seed uint64) (string, int) {
	u1, u2 := unit(mix64(seed^1)), unit(mix64(seed^2))
	if v.Kind == caves.KindGem {
		cut := "rough"
		bonus := 0.02 * float64(v.Band)
		switch {
		case u1 < 0.03+bonus:
			cut = "brilliant"
		case u1 < 0.18+2*bonus:
			cut = "cut"
		}
		qty := 1
		if u2 < 0.2 {
			qty = 2
		}
		return "gem:" + v.MaterialName() + ":" + cut, qty
	}
	qty := 1 + int(v.Size)/3
	if u2 < 0.35 {
		qty++
	}
	if isSunsteel(v) {
		qty = max(qty, sunsteelMinOre) // a blade's worth (see sunsteelMinOre)
	}
	return "ore:" + v.MaterialName(), qty
}

func (s *Server) spawnPickup(owner *Entity, v caves.Vein, item string, qty int, seed uint64, now time.Time) *Entity {
	p := &Entity{ID: s.nextID, Kind: proto.EntityKindPickup, Name: item, Level: uint8(min(qty, 255)), Owner: owner.ID,
		Item: item, Qty: qty, RollSeed: seed, DespawnAt: now.Add(constants.PickupDespawnS * time.Second)}
	s.nextID++
	// Pop out of the wall toward the miner a little, so it is reachable.
	p.Move.Pos = movement.Vec3{X: v.X + v.NX*0.7, Y: v.Y + v.NY*0.7 + 0.2, Z: v.Z + v.NZ*0.7}
	p.prevValid = p.Move
	p.view = p.Move
	p.drop = s.veinDrop(item, qty, seed, owner) // WP14: granted through the item system (loot.go)
	s.insertEntity(p)                           // WP16: player ids are not in join order any more
	return p
}

func (s *Server) removeEntity(e *Entity) {
	if i, ok := slices.BinarySearchFunc(s.ents, e.ID, func(x *Entity, id uint32) int { return cmpU32(x.ID, id) }); ok {
		s.ents = slices.Delete(s.ents, i, i+1)
	}
}

func (s *Server) takePickup(owner, p *Entity) {
	if p.drop != nil { // WP14: rolled loot and dropped items (loot.go)
		s.takeDrop(owner, p)
		return
	}
	if s.cfg.Granter != nil {
		if err := s.cfg.Granter.Grant(owner.CharacterID, p.Item, p.Qty, p.RollSeed); err != nil {
			s.log.Warn("grant failed", "character", owner.CharacterID, "item", p.Item, "err", err)
			return
		}
	}
	s.log.Info("item granted", "character", owner.CharacterID, "item", p.Item, "qty", p.Qty, "rollSeed", p.RollSeed)
	s.sendEventTo(owner, &proto.Event{Kind: EventItemGranted, EntityID: owner.ID, TargetID: p.ID, Value: int32(p.Qty), Data: []byte(p.Item)})
	s.removeEntity(p)
	s.m.itemsGranted.Add(1)
}

// miningTick: auto-pickup, pickup despawn, vein respawns, edit interest.
func (s *Server) miningTick(tick uint32, now time.Time) {
	// Pickups (iterate a copy: taking one removes it from s.ents).
	var pickups []*Entity
	for _, e := range s.ents {
		if e.Kind == proto.EntityKindPickup {
			pickups = append(pickups, e)
		}
	}
	for _, p := range pickups {
		if now.After(p.DespawnAt) {
			s.removeEntity(p)
			continue
		}
		for _, sess := range s.sessions {
			if o := sess.ent; o != nil && o.ID == p.Owner {
				feet := o.Move.Pos
				mid := movement.Vec3{X: feet.X, Y: feet.Y + 0.9, Z: feet.Z}
				if dist3(mid, p.Move.Pos) <= pickupReachM+0.9 {
					s.takePickup(o, p)
				}
			}
		}
	}
	if s.mine.veins != nil {
		for id, st := range s.mine.veins {
			if st.mined && !now.Before(st.respawnAt) {
				s.respawnVein(id, st, now)
			}
		}
	}
	if tick%editEveryTicks == 0 {
		for _, sess := range s.sessions {
			s.editInterest(sess)
		}
	}
}

func (s *Server) respawnVein(id uint64, st *veinState, now time.Time) {
	st.mined = false
	st.hp = st.maxHP
	st.hitters = map[uint32]time.Time{}
	ed := s.mine.byVein[id]
	if ed == nil {
		return
	}
	s.removeEdit(ed)
	if cw := s.caves(); cw != nil {
		cw.RemoveEdit(id)
	}
	// Tell clients: the same edit, expiring now (README "WorldEdits").
	ed.rec.ExpiresAt = s.serverTimeMs()
	s.broadcastEdit(ed)
	s.m.veinsRespawned.Add(1)
	s.log.Info("vein respawned", "vein", id, "edit", st.editID, "minedFor", now.Sub(st.minedAt).Round(time.Millisecond).String())
	if s.cfg.EditStore != nil && s.cfg.Queue != nil {
		store, world, eid := s.cfg.EditStore, s.cfg.WorldID, st.editID
		s.cfg.Queue.Enqueue(writebehind.Op{Key: "edit-del:" + itoa64(eid), Run: func(ctx context.Context) error {
			return store.DeleteEdit(ctx, world, eid)
		}})
	}
}

func (s *Server) addEdit(c caves.Edit, editID int64, respawnAt time.Time) *edit {
	s.mine.init()
	cx, cz := chunkOf(float64(c.X), float64(c.Z))
	params := make([]byte, 16)
	binary.LittleEndian.PutUint32(params[0:], math.Float32bits(c.X))
	binary.LittleEndian.PutUint32(params[4:], math.Float32bits(c.Y))
	binary.LittleEndian.PutUint32(params[8:], math.Float32bits(c.Z))
	binary.LittleEndian.PutUint32(params[12:], math.Float32bits(c.R))
	ed := &edit{cx: cx, cz: cz, carve: c, rec: proto.EditRecord{EditID: uint64(editID), Kind: proto.EditKindVeinMined, TargetID: c.VeinID,
		Params: params, Tick: s.tick, ExpiresAt: float64(respawnAt.UnixMicro()) / 1000}}
	k := [2]int32{cx, cz}
	s.mine.byChunk[k] = append(s.mine.byChunk[k], ed)
	s.mine.byVein[c.VeinID] = ed
	return ed
}

func (s *Server) removeEdit(ed *edit) {
	k := [2]int32{ed.cx, ed.cz}
	list := s.mine.byChunk[k]
	if i := slices.Index(list, ed); i >= 0 {
		s.mine.byChunk[k] = slices.Delete(list, i, i+1)
	}
	if len(s.mine.byChunk[k]) == 0 {
		delete(s.mine.byChunk, k)
	}
	delete(s.mine.byVein, ed.carve.VeinID)
}

// broadcastEdit sends a live delta to every client with the chunk in
// interest.
func (s *Server) broadcastEdit(ed *edit) {
	msg := proto.Encode(&proto.WorldEdits{Cx: ed.cx, Cz: ed.cz, Edits: []proto.EditRecord{ed.rec}})
	k := [2]int32{ed.cx, ed.cz}
	for _, sess := range s.sessions {
		if sess.editChunks[k] {
			_ = sess.conn.SendReliable(msg)
			s.m.editsSent.Add(1)
		}
	}
}

// editInterest sends a chunk's active edits when it enters a client's
// interest square (first interest), and forgets chunks that left it.
func (s *Server) editInterest(sess *session) {
	e := sess.ent
	if e == nil {
		return
	}
	if sess.editChunks == nil {
		sess.editChunks = map[[2]int32]bool{}
	}
	cx, cz := chunkOf(e.Move.Pos.X, e.Move.Pos.Z)
	for k := range sess.editChunks {
		if abs32(k[0]-cx) > editChunkRadius || abs32(k[1]-cz) > editChunkRadius {
			delete(sess.editChunks, k)
		}
	}
	for dz := int32(-editChunkRadius); dz <= editChunkRadius; dz++ {
		for dx := int32(-editChunkRadius); dx <= editChunkRadius; dx++ {
			k := [2]int32{cx + dx, cz + dz}
			if sess.editChunks[k] {
				continue
			}
			sess.editChunks[k] = true
			if list := s.mine.byChunk[k]; len(list) > 0 {
				recs := make([]proto.EditRecord, len(list))
				for i, ed := range list {
					recs[i] = ed.rec
				}
				_ = sess.conn.SendReliable(proto.Encode(&proto.WorldEdits{Cx: k[0], Cz: k[1], Edits: recs}))
				s.m.editsSent.Add(1)
			}
		}
	}
}

func abs32(v int32) int32 {
	if v < 0 {
		return -v
	}
	return v
}

// RestoreEdits re-applies persisted vein edits at startup (before Start):
// mined veins stay mined until their respawnAt, carves stay carved.
func (s *Server) RestoreEdits(ctx context.Context) (int, error) {
	cw := s.caves()
	if cw == nil || s.cfg.EditStore == nil {
		return 0, nil
	}
	rows, err := s.cfg.EditStore.LoadEdits(ctx, s.cfg.WorldID, s.cfg.Now())
	if err != nil {
		return 0, err
	}
	n := 0
	for _, r := range rows {
		if r.Kind != "vein_mined" {
			continue
		}
		_, st, ok := s.vein(cw, r.TargetID)
		if !ok {
			continue
		}
		st.mined = true
		st.editID = r.EditID
		st.respawnAt = r.ExpiresAt
		st.minedAt = s.cfg.Now()
		carve := caves.Edit{VeinID: r.TargetID, X: r.X, Y: r.Y, Z: r.Z, R: r.R}
		s.addEdit(carve, r.EditID, r.ExpiresAt)
		cw.SetEdit(carve)
		n++
	}
	return n, nil
}

// VeinStatus is a debug view of one vein (tests, /debug/mining).
type VeinStatus struct {
	ID        uint64    `json:"id"`
	HP        float64   `json:"hp"`
	Mined     bool      `json:"mined"`
	RespawnAt time.Time `json:"respawnAt"`
	EditID    int64     `json:"editId"`
}

// MiningStatus is a debug snapshot (taken on the tick goroutine via Do).
type MiningStatus struct {
	Mined      int64        `json:"minedTotal"`
	Active     int          `json:"activeEdits"`
	Veins      []VeinStatus `json:"veins"`
	PickupsOut int          `json:"pickups"`
}

func (s *Server) miningStatus() MiningStatus {
	st := MiningStatus{Mined: s.mine.mined, Active: len(s.mine.byVein)}
	for id, v := range s.mine.veins {
		st.Veins = append(st.Veins, VeinStatus{ID: id, HP: v.hp, Mined: v.mined, RespawnAt: v.respawnAt, EditID: v.editID})
	}
	slices.SortFunc(st.Veins, func(a, b VeinStatus) int {
		switch {
		case a.ID < b.ID:
			return -1
		case a.ID > b.ID:
			return 1
		}
		return 0
	})
	for _, e := range s.ents {
		if e.Kind == proto.EntityKindPickup {
			st.PickupsOut++
		}
	}
	return st
}
