package game

// Loot and item transfers (WP14): personal loot from kills, bosses (weekly
// lockout), containers and veins; pickups; dropping and taking items
// through TransferItem. See items.go for the overview.

import (
	"context"
	"encoding/binary"
	"fmt"
	"math"
	"strconv"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/items"
)

// bossWeek is the lockout period key (spec 8: "a weekly per-character
// lockout"): ISO year and week, UTC.
func bossWeek(now time.Time) string {
	y, w := now.UTC().ISOWeek()
	return fmt.Sprintf("%d-W%02d", y, w)
}

// themeFor picks a kill's loot theme from the world's themes by a seed.
func (s *Server) themeFor(seed uint64) string {
	t := s.itm.setup.Themes
	if len(t) == 0 {
		return ""
	}
	return t[seed%uint64(len(t))]
}

// tomesFor lists castable spells a player doesn't know (boss tomes).
func tomesFor(p *combat.Player) []string {
	var out []string
	for i := range combatdefs.D.Spells {
		sp := &combatdefs.D.Spells[i]
		if sp.Equippable() && (p == nil || !p.Profile.Knows(sp.Key)) {
			out = append(out, sp.Key)
		}
	}
	return out
}

// lootOnKill is combat's OnKill hook: every eligible player rolls their own
// loot (spec 8 personal loot), logged with its seed, and it pops out of the
// enemy as pickups only they see.
func (s *Server) lootOnKill(k combat.KillInfo) {
	en := k.Enemy
	if en == nil {
		return
	}
	now := s.cfg.Now()
	ground := movement.GroundAt(s.cfg.Ground, en.Pos.X, en.Pos.Y+1, en.Pos.Z)
	deep := s.cfg.Ground.HeightAt(en.Pos.X, en.Pos.Z)-en.Pos.Y > 160
	var groupSeed uint64
	bossKey := ""
	if en.Group != nil {
		groupSeed = en.Group.Seed
		if en.Boss != nil {
			bossKey = "boss:" + strconv.Itoa(en.Group.ID) + ":" + bossWeek(now)
		}
	} else {
		groupSeed = items.Mix64(uint64(en.ID))
	}
	el := en.Element
	if el >= combatdefs.Physical {
		el = -1
	}
	for _, pid := range k.Eligible {
		ent := s.entityByID(pid)
		if ent == nil || ent.Kind != proto.EntityKindPlayer {
			continue
		}
		sess := s.byChar[ent.CharacterID]
		if sess == nil || sess.items == nil {
			continue
		}
		ci := sess.items
		if bossKey != "" {
			if ci.markers[bossKey] {
				_, w := now.UTC().ISOWeek()
				s.sendEvent(sess, &proto.Event{Kind: EventBossLockout, EntityID: ent.ID, Value: int32(w), Data: []byte(en.Name)})
				continue
			}
			ci.markers[bossKey] = true
			if ci.persist == persistDB {
				s.enqueueItems(sess, &ItemOp{Char: ent.CharacterID, Epoch: ent.epoch, Grant: &GrantMark{Key: bossKey}, Note: "boss lockout"})
			} else if ci.persist == persistLocal {
				s.commitItems(sess, &items.Delta{}, nil, "boss lockout")
			}
		}
		seed := items.Mix64(s.itm.boot ^ uint64(en.ID)<<32 ^ uint64(k.Tick) ^ hashString(ent.CharacterID))
		gear := ci.inv.Gear(0)
		if ent.cbt != nil {
			gear = ci.inv.Gear(ent.cbt.Profile.Active)
		}
		luck := items.LuckFrom(gear)
		if deep {
			luck *= items.D.Loot.DeepCaveLuck
		}
		kc := items.KillContext{Family: en.Def.Family, Level: en.Level, Elite: en.Elite(), Boss: en.Boss != nil, Element: el,
			Theme: s.themeFor(groupSeed), Luck: luck, Deep: deep}
		if en.Boss != nil {
			kc.Tomes = tomesFor(ent.cbt)
		}
		loot := items.KillLoot(items.NewRNG(seed), kc)
		s.itm.loot++
		bases := make([]string, 0, len(loot))
		for i, it := range loot {
			it.Seed = int64(seed)
			it.Prov = []items.Prov{{Ev: "rolled", Char: ent.CharacterID, Name: ent.Name, Src: "kill:" + en.Def.Key, At: now.UnixMilli(), Local: ci.persist == persistLocal}}
			// Playtest 2 ground loot: scattered around the corpse (loot_ground.go).
			dx, dz := scatterOffset(i, len(loot), seed, 0.9, 2.1, 0, true)
			pos := s.groundSpot(en.Pos.X+dx, en.Pos.Z+dz, ground)
			key := fmt.Sprintf("kill:%x:%d:%d:%d", s.itm.boot, en.ID, k.Tick, i)
			s.spawnDrop(ent.ID, it, pos, &itemDrop{key: key, source: SourceKill, readyAt: now.Add(groundSettle)}, now.Add(constants.PickupDespawnS*time.Second))
			bases = append(bases, fmt.Sprintf("%s x%d (%s)", it.Base, it.Qty, items.D.Rarities[it.Rarity].Key))
			s.announceIfBitchin(sess, it)
		}
		s.log.Info("kill loot", "character", ent.CharacterID, "enemy", en.Def.Key, "level", en.Level, "elite", en.Elite(), "boss", en.Boss != nil,
			"rollSeed", seed, "luck", math.Round(luck*100)/100, "items", bases)
	}
}

// spawnDrop makes a pickup entity carrying an item. owner 0 = public (a
// dropped item anyone can take).
func (s *Server) spawnDrop(owner uint32, it *items.Item, pos movement.Vec3, d *itemDrop, despawn time.Time) *Entity {
	d.item = it
	p := &Entity{ID: s.nextID, Kind: proto.EntityKindPickup, Name: it.Base, Level: uint8(min(it.Qty, 255)), TypeID: uint16(it.Rarity),
		Owner: owner, Item: it.Base, Qty: it.Qty, RollSeed: uint64(it.Seed), DespawnAt: despawn, drop: d}
	s.nextID++
	p.Move.Pos = pos
	p.prevValid = p.Move
	p.view = p.Move
	s.insertEntity(p)
	return p
}

// veinDrop attaches a WP09 vein drop's item to its pickup (mining.go calls
// it when no external Granter is configured): the pickup is then granted
// through the item system like any personal loot.
func (s *Server) veinDrop(item string, qty int, seed uint64, owner *Entity) *itemDrop {
	if s.cfg.Granter != nil || items.D.Item(item) == nil {
		return nil
	}
	it := items.Stack(item, qty)
	it.Seed = int64(seed)
	it.Prov = []items.Prov{{Ev: "rolled", Char: owner.CharacterID, Name: owner.Name, Src: "vein", At: s.cfg.Now().UnixMilli()}}
	return &itemDrop{item: it, key: "vein:" + strconv.FormatUint(seed, 16), source: SourceVein}
}

// takeDrop is called when a player takes a pickup carrying an item
// (mining.go takePickup: auto-pickup of personal loot, or Interact).
func (s *Server) takeDrop(owner, p *Entity) {
	sess := s.byChar[owner.CharacterID]
	if sess == nil || sess.items == nil {
		return
	}
	now := s.cfg.Now()
	d := p.drop
	if now.Before(d.refused) {
		return
	}
	if d.world {
		if _, err := s.TransferItem(Holder{World: &WorldSpot{WorldID: s.cfg.WorldID}, Drop: p}, Holder{Sess: sess}, d.item, d.item.Qty, "picked_up"); err != nil {
			d.refused = now.Add(pickupRefuseGap)
			s.refuseItem(sess, InteractPickup, ActionUse, refusalOf(err))
		}
		return
	}
	ci := sess.items
	it := d.item
	var dl items.Delta
	before := it.Qty
	left := ci.inv.Add(it, &dl)
	if left == before {
		d.refused = now.Add(pickupRefuseGap)
		s.refuseItem(sess, InteractPickup, ActionUse, ItemRefuseFull)
		return
	}
	d.takes++
	key := d.key
	if d.takes > 1 || left > 0 {
		key = d.key + "#" + strconv.Itoa(d.takes) // a partial take: the rest is its own grant
	}
	got := it.Clone()
	got.Qty = before - left
	s.commitItems(sess, &dl, &GrantMark{Key: key, Seed: it.Seed}, "loot "+it.Base)
	s.sendGranted(sess, d.source, []*items.Item{got})
	if d.source == SourceVein {
		// WP09's grant event, kept for its clients and tests.
		s.sendEventTo(owner, &proto.Event{Kind: EventItemGranted, EntityID: owner.ID, TargetID: p.ID, Value: int32(got.Qty), Data: []byte(got.Base)})
		s.m.itemsGranted.Add(1)
	}
	s.log.Info("loot granted", "character", owner.CharacterID, "item", got.Base, "qty", got.Qty, "rarity", got.Rarity, "key", key, "rollSeed", it.Seed)
	if left > 0 {
		it.Qty = left
		p.Qty, p.Level = left, uint8(min(left, 255))
		d.refused = now.Add(pickupRefuseGap)
		return
	}
	s.removeEntity(p)
}

// takeWorldPickup: Interact 41 on a public pickup (a dropped item).
func (s *Server) takeWorldPickup(sess *session, id uint32, now time.Time) {
	p := s.entityByID(id)
	if p == nil {
		// Playtest 2: two players pressed E on the same dropped item in
		// the same tick (or nearly): the first took it, tell the other.
		if t, ok := s.itm.taken[id]; ok && t.by != sess.ent.ID && now.Sub(t.at) <= takenMemory {
			s.refuseItem(sess, InteractPickup, ActionUse, ItemRefuseNoItem)
		}
		return
	}
	if p.Kind != proto.EntityKindPickup || p.drop == nil || !p.drop.world {
		return // WP09 handles personal pickups (owner-only)
	}
	e := sess.ent
	eye := e.Move.Pos
	eye.Y += constants.PlayerHeight
	if dist3(eye, p.Move.Pos) > takeReachM+1 {
		s.refuseItem(sess, InteractPickup, ActionUse, ItemRefuseTooFar)
		return
	}
	p.drop.refused = time.Time{}
	s.takeDrop(e, p)
}

// Holder is one end of a TransferItem: an online character, or the world
// (a spot for drops; the pickup entity for takes).
type Holder struct {
	Sess  *session
	World *WorldSpot
	Drop  *Entity
}

// TransferItem moves qty of an item between holders (spec 8: "Drops already
// move items through one server path, TransferItem(from, to, reason),
// which trades will reuse"). Every move appends provenance; anything a
// local profile puts into the world is marked unverified and untradeable.
// Supported: character -> world (drop), world -> character (take),
// character -> character (trades, later; both online in this zone).
// Persistence is one journal op per transfer, so a crash either moved the
// item or didn't. Returns the item as it arrived.
func (s *Server) TransferItem(from, to Holder, it *items.Item, qty int, reason string) (*items.Item, error) {
	now := s.cfg.Now()
	switch {
	case from.Sess != nil && to.World != nil:
		return s.transferToWorld(from.Sess, to.World, it, qty, reason, now)
	case from.World != nil && from.Drop != nil && to.Sess != nil:
		return s.transferFromWorld(from.Drop, to.Sess, reason, now)
	case from.Sess != nil && to.Sess != nil:
		return s.transferBetween(from.Sess, to.Sess, it, qty, reason, now)
	}
	return nil, items.ErrNotAllowed
}

func (s *Server) transferToWorld(sess *session, spot *WorldSpot, it *items.Item, qty int, reason string, now time.Time) (*items.Item, error) {
	ci, e := sess.items, sess.ent
	if it.IsEquipped() {
		return nil, items.ErrNotAllowed
	}
	var d items.Delta
	part := ci.inv.Take(it, qty, &d)
	local := ci.persist == persistLocal
	part.Prov = append(part.Prov, items.Prov{Ev: reason, Char: e.CharacterID, Name: e.Name, At: now.UnixMilli(), Local: local || sess.claims.IsLocalProfile})
	if local || sess.claims.IsLocalProfile {
		// Spec 8: items dropped by a local-profile player are marked
		// unverified and won't be tradeable.
		part.Verified, part.Tradeable = false, false
	}
	// In front of the player, on the ground.
	pos := e.Move.Pos
	pos.X += -math.Sin(e.Yaw) * 1.0
	pos.Z += -math.Cos(e.Yaw) * 1.0
	pos.Y = movement.GroundAt(s.cfg.Ground, pos.X, e.Move.Pos.Y+1.5, pos.Z) + 0.3
	spot.WorldID = s.cfg.WorldID
	spot.DespawnAt = now.Add(s.itm.setup.DropDespawn)
	spot.X, spot.Y, spot.Z = pos.X, pos.Y, pos.Z
	drop := &itemDrop{world: true, source: SourceDropped}
	ci.version++
	spawn := func() *Entity {
		p := s.spawnDrop(0, part, pos, drop, spot.DespawnAt)
		s.log.Info("item dropped", "character", e.CharacterID, "item", part.ID, "base", part.Base, "qty", part.Qty, "verified", part.Verified,
			"tradeable", part.Tradeable, "pickup", p.ID, "despawnAt", spot.DespawnAt.UTC().Format(time.RFC3339))
		return p
	}
	var p *Entity
	switch {
	case ci.persist == persistDB:
		op := &ItemOp{Char: e.CharacterID, Epoch: e.epoch, Note: "drop " + part.Base}
		_, updated, _ := d.Rows()
		for _, u := range updated {
			op.Update = append(op.Update, ItemRow{Item: u, Owner: e.CharacterID})
		}
		if part == it {
			op.Update = append(op.Update, ItemRow{Item: part.Clone(), World: spot})
		} else {
			op.Upsert = append(op.Upsert, ItemRow{Item: part.Clone(), World: spot})
		}
		drop.persisted = s.itm.j != nil
		s.enqueueItems(sess, op)
		p = spawn()
	case local && s.cfg.Saves != nil && s.cfg.Queue != nil && sess.x != nil && sess.x.local != nil:
		// Local profile: the signed blob WITHOUT the item must be issued
		// before the world copy exists, or a crash in between would leave
		// the item both in the browser's newest blob and on the ground.
		// The world row (and the pickup) follow the next local-save issue
		// for this character (flushLocalDrops); if the player leaves first,
		// no blob is issued, the browser's blob still holds the item and
		// the world copy is never made. Lose never, duplicate never.
		drop.persisted = s.itm.j != nil
		s.addLocalDrop(e.CharacterID, &ItemOp{Note: "local drop " + part.Base, Upsert: []ItemRow{{Item: part.Clone(), World: spot}}, Done: func() { spawn() }})
		sess.x.prog.MarkDirty()
		s.issueLocalSave(sess)
	default:
		// Memory-only characters (no row, no blob): nothing to keep in step.
		p = spawn()
	}
	pid := uint32(0)
	if p != nil {
		pid = p.ID
	}
	s.sendEvent(sess, &proto.Event{Kind: EventDropped, EntityID: pid, TargetID: e.ID, Value: int32(part.Qty), Data: []byte(part.Base)})
	s.sendInventory(sess)
	return part, nil
}

// addLocalDrop parks a local profile's drop until its blob is issued.
func (s *Server) addLocalDrop(char string, op *ItemOp) {
	s.itm.ldMu.Lock()
	if s.itm.localDrops == nil {
		s.itm.localDrops = map[string][]*ItemOp{}
	}
	s.itm.localDrops[char] = append(s.itm.localDrops[char], op)
	s.itm.ldMu.Unlock()
}

// flushLocalDrops runs after a local-save blob for char was issued (the
// write-behind worker, explore.go issueLocalSave): parked drops are now
// safe to put into the world. ok=false: the issue was skipped (the player
// left), the drops are abandoned (their items are still in the blob).
func (s *Server) flushLocalDrops(char string, ok bool) {
	s.itm.ldMu.Lock()
	ops := s.itm.localDrops[char]
	delete(s.itm.localDrops, char)
	s.itm.ldMu.Unlock()
	if !ok {
		if len(ops) > 0 {
			s.log.Info("local drops abandoned: the player left before the save was issued (the items stay in their blob)", "character", char, "n", len(ops))
		}
		return
	}
	for _, op := range ops {
		if s.itm.j != nil {
			s.itm.j.Enqueue(op)
		} else {
			s.itm.ldMu.Lock()
			s.itm.later = append(s.itm.later, op.Done)
			s.itm.ldMu.Unlock()
		}
	}
}

// deferredTake: a local profile or a memory-only character takes a dropped
// item that has a database row. The row is deleted first; the item joins
// the inventory (and the next blob) only once that committed, so a crash
// can lose it but never leave it both on the ground and in a blob.
func (s *Server) deferredTake(p *Entity, sess *session, reason string) (*items.Item, error) {
	it := p.drop.item
	s.removeEntity(p) // nobody else can take it meanwhile
	s.noteTaken(p.ID, sess.ent.ID, s.cfg.Now())
	char := sess.ent.CharacterID
	s.enqueueItems(nil, &ItemOp{Take: []string{it.ID}, Delete: []string{it.ID}, Note: "deferred take " + it.Base, Done: func() {
		cur := s.byChar[char]
		if cur == nil || cur.items == nil || cur.ent == nil {
			s.log.Warn("dropped item taken by a player who left before it arrived: lost", "character", char, "item", it.ID, "base", it.Base)
			return
		}
		ci, e := cur.items, cur.ent
		it.Prov = append(it.Prov, items.Prov{Ev: reason, Char: char, Name: e.Name, At: s.cfg.Now().UnixMilli(), Local: ci.persist == persistLocal})
		var d items.Delta
		if left := ci.inv.Add(it, &d); left > 0 {
			rest := it.Clone()
			rest.ID, rest.H, rest.Slot, rest.Qty = "", 0, "", left
			s.spawnDrop(e.ID, rest, e.Move.Pos, &itemDrop{key: "take:" + it.ID + ":spill", source: SourceDropped}, s.cfg.Now().Add(constants.PickupDespawnS*time.Second))
		}
		s.commitItems(cur, &d, nil, "take "+it.Base)
		s.log.Info("item taken", "character", char, "item", it.ID, "base", it.Base, "qty", it.Qty, "verified", it.Verified, "tradeable", it.Tradeable, "hands", len(it.Prov))
		s.sendEvent(cur, &proto.Event{Kind: EventItemTaken, EntityID: e.ID, TargetID: p.ID, Value: int32(it.Qty), Data: []byte(it.Base)})
		s.sendGranted(cur, SourceDropped, []*items.Item{it})
	}})
	return it, nil
}

func (s *Server) transferFromWorld(p *Entity, sess *session, reason string, now time.Time) (*items.Item, error) {
	ci, e := sess.items, sess.ent
	it := p.drop.item
	if !ci.inv.CanFit(it.Base, it.Qty) {
		return nil, items.ErrFull
	}
	if p.drop.persisted && s.itm.j != nil && ci.persist != persistDB {
		return s.deferredTake(p, sess, reason)
	}
	it.Prov = append(it.Prov, items.Prov{Ev: reason, Char: e.CharacterID, Name: e.Name, At: now.UnixMilli(), Local: ci.persist == persistLocal})
	var d items.Delta
	if left := ci.inv.Add(it, &d); left > 0 {
		return nil, items.ErrFull // CanFit said yes; cannot happen
	}
	s.removeEntity(p)
	s.noteTaken(p.ID, e.ID, now)
	ci.version++
	persisted := p.drop.persisted && s.itm.j != nil
	switch ci.persist {
	case persistDB:
		op := &ItemOp{Char: e.CharacterID, Epoch: e.epoch, Note: "take " + it.Base}
		if persisted {
			op.Grant = &GrantMark{Key: "take:" + it.ID, Seed: it.Seed}
			op.Take = []string{it.ID}
		}
		created, updated, _ := d.Rows()
		landedWhole := false
		for _, c := range created {
			if c.ID == it.ID {
				landedWhole = true
			}
			op.Upsert = append(op.Upsert, ItemRow{Item: c, Owner: e.CharacterID})
		}
		for _, u := range updated {
			op.Update = append(op.Update, ItemRow{Item: u, Owner: e.CharacterID})
		}
		if persisted && !landedWhole {
			op.Delete = []string{it.ID} // merged into stacks: the world row goes
		}
		s.enqueueItems(sess, op)
	case persistLocal:
		if sess.x != nil && sess.x.prog != nil {
			sess.x.prog.MarkDirty()
			s.saveProgressSoon(sess, false)
		}
	}
	s.log.Info("item taken", "character", e.CharacterID, "item", it.ID, "base", it.Base, "qty", it.Qty, "verified", it.Verified, "tradeable", it.Tradeable, "hands", len(it.Prov))
	s.sendEvent(sess, &proto.Event{Kind: EventItemTaken, EntityID: e.ID, TargetID: p.ID, Value: int32(it.Qty), Data: []byte(it.Base)})
	s.sendGranted(sess, SourceDropped, []*items.Item{it})
	s.sendInventory(sess)
	return it, nil
}

// transferBetween hands an item from one online character to another (the
// path trades will use; no Interact exposes it in v1). Both sides change
// in one op; the receiver's marker makes it exactly-once.
func (s *Server) transferBetween(from, to *session, it *items.Item, qty int, reason string, now time.Time) (*items.Item, error) {
	if it.IsEquipped() || !it.Tradeable || !it.Verified {
		return nil, items.ErrNotAllowed
	}
	if from.items.persist != to.items.persist || from.items.persist == persistLocal {
		return nil, items.ErrNotAllowed // spec 11: local profiles can't trade
	}
	if !to.items.inv.CanFit(it.Base, max(1, min(qty, it.Qty))) {
		return nil, items.ErrFull
	}
	var d items.Delta
	part := from.items.inv.Take(it, qty, &d)
	part.Prov = append(part.Prov, items.Prov{Ev: reason, Char: to.ent.CharacterID, Name: to.ent.Name, Src: from.ent.CharacterID, At: now.UnixMilli()})
	var d2 items.Delta
	to.items.inv.Add(part, &d2)
	from.items.version++
	to.items.version++
	if from.items.persist == persistDB {
		op := &ItemOp{Char: to.ent.CharacterID, Epoch: to.ent.epoch, Grant: &GrantMark{Key: "take:" + part.ID + ":" + strconv.FormatInt(now.UnixNano(), 36)}, Note: "transfer " + part.Base}
		_, upd, _ := d.Rows()
		for _, u := range upd {
			op.Update = append(op.Update, ItemRow{Item: u, Owner: from.ent.CharacterID})
		}
		c2, u2, _ := d2.Rows()
		for _, c := range c2 {
			op.Upsert = append(op.Upsert, ItemRow{Item: c, Owner: to.ent.CharacterID})
		}
		for _, u := range u2 {
			op.Update = append(op.Update, ItemRow{Item: u, Owner: to.ent.CharacterID})
		}
		if part == it && !d2.Created(part) {
			op.Delete = append(op.Delete, part.ID) // merged into the receiver's stack
		}
		s.enqueueItems(to, op)
	}
	s.sendInventory(from)
	s.sendInventory(to)
	return part, nil
}

// dropItem: Interact 21/2 (qty 0 = the whole stack).
func (s *Server) dropItem(sess *session, it *items.Item, qty int) {
	if qty <= 0 || qty > it.Qty {
		qty = it.Qty
	}
	if _, err := s.TransferItem(Holder{Sess: sess}, Holder{World: &WorldSpot{}}, it, qty, "dropped"); err != nil {
		s.refuseItem(sess, InteractItem, ItemActDrop, refusalOf(err))
	}
}

// RestoreWorldItems brings back the items lying in the world after a
// restart (before Start), with their remaining despawn time; expired ones
// are deleted by the store.
func (s *Server) RestoreWorldItems(ctx context.Context) (int, error) {
	if s.itm.setup.Store == nil {
		return 0, nil
	}
	rows, err := s.itm.setup.Store.LoadWorldItems(ctx, s.cfg.WorldID, s.cfg.Now())
	if err != nil {
		return 0, err
	}
	n := 0
	for _, r := range rows {
		if r.Item.Def() == nil || r.World == nil {
			continue
		}
		s.spawnDrop(0, r.Item, movement.Vec3{X: r.World.X, Y: r.World.Y, Z: r.World.Z}, &itemDrop{world: true, persisted: true, source: SourceDropped}, r.World.DespawnAt)
		n++
	}
	return n, nil
}

// ---- containers ----

func (s *Server) sendContainers(sess *session, force bool) {
	ci, e := sess.items, sess.ent
	cx, cz := chunkOf(e.Move.Pos.X, e.Move.Pos.Z)
	k := [2]int32{cx, cz}
	list := s.itm.setup.Containers.ContainersNear(e.Move.Pos.X, e.Move.Pos.Z, containerListM)
	// G4: the list only holds chunks the terrain cache already generated; a
	// chunk finishing after we entered used to stay missing until the next
	// chunk border (a chest you walked up to never got its [E] prompt).
	// Resend whenever the set changes, not only on a new chunk.
	var sig uint64
	for _, c := range list {
		sig += c.ID*0x9e3779b97f4a7c15 + 1
	}
	if !force && ci.contSent && ci.contChunk == k && ci.contSig == sig {
		return
	}
	ci.contSig = sig
	b := []byte{1}
	b = binary.LittleEndian.AppendUint16(b, uint16(min(len(list), 65535)))
	for _, c := range list {
		b = binary.LittleEndian.AppendUint64(b, c.ID)
		b = binary.LittleEndian.AppendUint32(b, uint32(proto.MetersToCm(c.X)))
		b = binary.LittleEndian.AppendUint32(b, uint32(proto.MetersToCm(c.Y)))
		b = binary.LittleEndian.AppendUint32(b, uint32(proto.MetersToCm(c.Z)))
		opened := byte(0)
		if ci.markers["container:"+strconv.FormatUint(c.ID, 10)] {
			opened = 1
		}
		b = append(b, byte(c.Kind), opened)
	}
	ci.contSent, ci.contChunk = true, k
	s.sendEvent(sess, &proto.Event{Kind: EventContainers, EntityID: e.ID, Value: int32(len(list)), Data: b})
}

// openContainer: Interact 20/1. Spec 8: chests open once per character,
// every character rolls their own contents; the grant marks the container
// for the character in the same transaction (spec 11).
func (s *Server) openContainer(sess *session, id uint64, now time.Time) {
	e, ci := sess.ent, sess.items
	if s.itm.setup.Containers == nil {
		s.refuseItem(sess, InteractContainer, ActionUse, ItemRefuseNoItem)
		return
	}
	var c *ContainerInfo
	for _, x := range s.itm.setup.Containers.ContainersNear(e.Move.Pos.X, e.Move.Pos.Z, 16) {
		if x.ID == id {
			c = &x
			break
		}
	}
	if c == nil {
		s.refuseItem(sess, InteractContainer, ActionUse, ItemRefuseNoItem)
		return
	}
	if eyeDist(e, c.X, c.Y+0.4, c.Z) > itemReachM {
		s.refuseItem(sess, InteractContainer, ActionUse, ItemRefuseTooFar)
		return
	}
	key := "container:" + strconv.FormatUint(id, 10)
	if ci.markers[key] {
		s.refuseItem(sess, InteractContainer, ActionUse, ItemRefuseOpened)
		return
	}
	// The seed depends only on the world, the container and the character:
	// a roll lost to a crash rolls the same items again.
	seed := items.Mix64(s.cfg.Seed ^ items.Mix64(id) ^ hashString(e.CharacterID))
	luck := 1.0
	if e.cbt != nil {
		luck = items.LuckFrom(ci.inv.Gear(e.cbt.Profile.Active))
	}
	// Item level: the area's (playtest 1 discovery-stamped difficulty, the
	// level its enemies have), so the Haven's chests give starter loot and
	// harder areas better. Stamps never change, so a roll lost to a crash
	// still rolls the same items again.
	level := s.lootLevelAt(c.X, c.Z, c.Level)
	loot := items.ContainerLoot(items.NewRNG(seed), items.ContainerContext{Kind: c.Kind, Theme: c.Theme, Level: level, Element: c.Element, Luck: luck})
	var d items.Delta
	var got []*items.Item
	// Playtest 2 ground loot (loot_ground.go): gold into the purse with the
	// open marker; everything else pops out of the container onto the
	// ground around it, toward the opener, as personal pickups.
	var ground []*items.Item
	for _, it := range loot {
		it.Seed = int64(seed)
		it.Prov = []items.Prov{{Ev: "rolled", Char: e.CharacterID, Name: e.Name, Src: key, At: now.UnixMilli(), Local: ci.persist == persistLocal}}
		if def := it.Def(); def == nil || def.Kind != "currency" {
			ground = append(ground, it)
			s.announceIfBitchin(sess, it)
			continue
		}
		q := it.Qty
		left := ci.inv.Add(it, &d)
		if left < q {
			g := it.Clone()
			g.Qty = q - left
			got = append(got, g)
		}
		if left > 0 { // the purse has no cap today; kept for safety
			rest := it.Clone()
			rest.ID, rest.H, rest.Slot, rest.Qty = "", 0, "", left
			ground = append(ground, rest)
		}
	}
	toward := math.Atan2(e.Move.Pos.Z-c.Z, e.Move.Pos.X-c.X)
	for i, it := range ground {
		dx, dz := scatterOffset(i, len(ground), seed, 1.1, 1.9, toward, false)
		pos := s.groundSpot(c.X+dx, c.Z+dz, c.Y)
		s.spawnDrop(e.ID, it, pos, &itemDrop{key: key + ":" + strconv.Itoa(i), source: SourceContainer, readyAt: now.Add(groundSettle)}, now.Add(constants.PickupDespawnS*time.Second))
	}
	spill := len(ground)
	ci.markers[key] = true
	s.commitItems(sess, &d, &GrantMark{Key: key, Seed: int64(seed)}, "container")
	bases := make([]string, 0, len(loot))
	for _, it := range loot {
		bases = append(bases, fmt.Sprintf("%s x%d (%s)", it.Base, it.Qty, items.D.Rarities[it.Rarity].Key))
	}
	s.log.Info("container opened", "character", e.CharacterID, "container", id, "kind", items.ContainerKinds[min(max(c.Kind, 0), 3)], "level", level, "rollSeed", seed, "items", bases, "onGround", spill)
	s.sendEvent(sess, &proto.Event{Kind: EventContainerOpened, EntityID: e.ID, Value: int32(len(loot)), Data: binary.LittleEndian.AppendUint64(nil, id)})
	s.sendGranted(sess, SourceContainer, got)
	s.sendContainers(sess, true)
}
