package game

// Camp storage chests (CR 025): 16 slots per chest, locked to the owner or
// shared with their party. An item in a chest is an `items` row like a
// dropped one (owner NULL, world spot) that also names its chest
// (WorldSpot.Chest -> items.camp_piece_id, migration 0026); it never
// despawns and is never restored as a pickup. Putting an item in and taking
// it out are item-journal transactions, built like TransferItem's drop and
// take (loot.go): a take checks the row still lies in the chest (Take) and
// carries a take marker, so it lands exactly once.
//
//   - Account characters: one op per move, in order with their other item
//     changes.
//   - Memory-only characters (dev tickets, bots): moves stay in memory; a
//     persisted item they take is deleted first and joins them after the
//     delete committed (deferred, like deferredTake).
//   - Local profiles cannot put items in (their items live in the browser's
//     signed save; a copy in the world would race the next blob): refused
//     with RefuseLocal. They can take what their party left them (deferred).

import (
	"encoding/json"
	"strconv"

	"lodestone/server/pkg/camps"
	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/items"
)

type chestJSON struct {
	Piece  uint64            `json:"piece"`
	Lock   int               `json:"lock"`
	Owner  string            `json:"owner"`
	Mine   bool              `json:"mine"`
	Open   bool              `json:"open"` // false: you may not use it (any more)
	Slots  []*items.WireItem `json:"slots"`
	Label  string            `json:"label,omitempty"`
	Shared bool              `json:"shared"`
}

func (s *Server) sendChest(sess *session, p *campPiece) {
	e := sess.ent
	out := chestJSON{Piece: p.ID, Lock: p.Lock, Owner: p.OwnerName, Mine: p.Owner == e.CharacterID, Open: s.campCanUse(e, p), Label: p.Label, Shared: p.Lock == 1}
	out.Slots = make([]*items.WireItem, len(p.chest))
	if out.Open {
		for i, c := range p.chest {
			if c != nil {
				w := c.it.Wire()
				out.Slots[i] = &w
			}
		}
	}
	b, _ := json.Marshal(out)
	s.sendEvent(sess, &proto.Event{Kind: EventCampChest, EntityID: e.ID, Value: int32(len(p.chest)), Data: b})
}

// chestChanged re-sends the chest to everyone who has it open and the
// piece (its fill count) to the area.
func (s *Server) chestChanged(p *campPiece) {
	for _, o := range s.sessions {
		if o.ent != nil && o.camp != nil && o.camp.openChest == p.ID {
			s.sendChest(o, p)
		}
	}
	s.campNotify(p, 2, 0)
}

func (s *Server) chestSpot(p *campPiece) *WorldSpot {
	return &WorldSpot{WorldID: s.cfg.WorldID, X: p.X, Y: p.Y + 0.5, Z: p.Z, Chest: p.ID}
}

func (s *Server) chestPut(sess *session, p *campPiece, handle uint32, qty int) {
	e, ci := sess.ent, sess.items
	if p.chest == nil || ci == nil {
		s.campRefuse(sess, CampActPut, p.ID, camps.RefuseUnknown)
		return
	}
	if !s.campCanUse(e, p) {
		s.campRefuse(sess, CampActPut, p.ID, camps.RefuseLocked)
		return
	}
	if ci.persist == persistLocal {
		s.campRefuse(sess, CampActPut, p.ID, camps.RefuseLocal)
		return
	}
	it := ci.inv.ByHandle(handle)
	if it == nil || it.IsEquipped() {
		s.campRefuse(sess, CampActPut, p.ID, camps.RefuseUnknown)
		return
	}
	slot := -1
	for i, c := range p.chest {
		if c == nil {
			slot = i
			break
		}
	}
	if slot < 0 {
		s.campRefuse(sess, CampActPut, p.ID, camps.RefuseFull)
		return
	}
	var d items.Delta
	part := ci.inv.Take(it, qty, &d)
	part.H, part.Slot = 0, ""
	now := s.cfg.Now()
	part.Prov = append(part.Prov, items.Prov{Ev: "stored", Char: e.CharacterID, Name: e.Name, Src: "camp:" + strconv.FormatUint(p.ID, 10), At: now.UnixMilli()})
	ci.version++
	persisted := false
	if ci.persist == persistDB && s.itm.j != nil {
		op := &ItemOp{Char: e.CharacterID, Epoch: e.epoch, Note: "camp store " + part.Base}
		_, updated, _ := d.Rows()
		for _, u := range updated {
			op.Update = append(op.Update, ItemRow{Item: u, Owner: e.CharacterID})
		}
		if part == it {
			op.Update = append(op.Update, ItemRow{Item: part.Clone(), World: s.chestSpot(p)})
		} else {
			op.Upsert = append(op.Upsert, ItemRow{Item: part.Clone(), World: s.chestSpot(p)})
		}
		s.enqueueItems(sess, op)
		persisted = true
	}
	p.chest[slot] = &chestSlot{it: part, persisted: persisted}
	s.log.Info("camp chest store", "character", e.CharacterID, "piece", p.ID, "slot", slot, "item", part.ID, "base", part.Base, "qty", part.Qty, "persisted", persisted)
	s.sendInventory(sess)
	s.chestChanged(p)
}

func (s *Server) chestTake(sess *session, p *campPiece, slot int) {
	e, ci := sess.ent, sess.items
	if p.chest == nil || ci == nil || slot < 0 || slot >= len(p.chest) || p.chest[slot] == nil {
		s.campRefuse(sess, CampActTake, p.ID, camps.RefuseUnknown)
		return
	}
	if !s.campCanUse(e, p) {
		s.campRefuse(sess, CampActTake, p.ID, camps.RefuseLocked)
		return
	}
	c := p.chest[slot]
	it := c.it
	if !ci.inv.CanFit(it.Base, it.Qty) {
		s.campRefuse(sess, CampActTake, p.ID, camps.RefuseFull)
		return
	}
	now := s.cfg.Now()
	p.chest[slot] = nil
	if c.persisted && s.itm.j != nil && ci.persist != persistDB {
		// The row goes first; the item joins once that committed (a crash
		// can lose it, never leave it both in the chest and in a blob).
		char := e.CharacterID
		s.enqueueItems(nil, &ItemOp{Take: []string{it.ID}, Delete: []string{it.ID}, Note: "camp deferred take " + it.Base, Done: func() {
			cur := s.byChar[char]
			if cur == nil || cur.items == nil || cur.ent == nil {
				s.log.Warn("camp chest item taken by a player who left before it arrived: lost", "character", char, "item", it.ID, "base", it.Base)
				return
			}
			s.chestLand(cur, it, nil)
		}})
		s.chestChanged(p)
		return
	}
	it.Prov = append(it.Prov, items.Prov{Ev: "taken_from_camp", Char: e.CharacterID, Name: e.Name, Src: "camp:" + strconv.FormatUint(p.ID, 10), At: now.UnixMilli()})
	var d items.Delta
	if left := ci.inv.Add(it, &d); left > 0 {
		p.chest[slot] = c // CanFit said yes; cannot happen
		s.campRefuse(sess, CampActTake, p.ID, camps.RefuseFull)
		return
	}
	ci.version++
	if ci.persist == persistDB && s.itm.j != nil {
		op := &ItemOp{Char: e.CharacterID, Epoch: e.epoch, Note: "camp take " + it.Base}
		if c.persisted {
			op.Grant = &GrantMark{Key: "take:" + it.ID + ":" + strconv.FormatInt(now.UnixNano(), 36), Seed: it.Seed}
			op.Take = []string{it.ID}
		}
		created, updated, _ := d.Rows()
		landed := false
		for _, cr := range created {
			if cr.ID == it.ID {
				landed = true
			}
			op.Upsert = append(op.Upsert, ItemRow{Item: cr, Owner: e.CharacterID})
		}
		for _, u := range updated {
			op.Update = append(op.Update, ItemRow{Item: u, Owner: e.CharacterID})
		}
		if c.persisted && !landed {
			op.Delete = []string{it.ID} // merged into a stack: the chest row goes
		}
		s.enqueueItems(sess, op)
		s.sendInventory(sess)
	} else {
		s.commitItems(sess, &d, nil, "camp take "+it.Base)
	}
	s.log.Info("camp chest take", "character", e.CharacterID, "piece", p.ID, "slot", slot, "item", it.ID, "base", it.Base, "qty", it.Qty, "persisted", c.persisted)
	s.sendGranted(sess, SourceDropped, []*items.Item{it})
	s.chestChanged(p)
}

// chestLand adds a deferred take's item to a character (memory or local).
func (s *Server) chestLand(sess *session, it *items.Item, _ *campPiece) {
	ci, e := sess.items, sess.ent
	it.Prov = append(it.Prov, items.Prov{Ev: "taken_from_camp", Char: e.CharacterID, Name: e.Name, At: s.cfg.Now().UnixMilli(), Local: ci.persist == persistLocal})
	var d items.Delta
	if left := ci.inv.Add(it, &d); left > 0 {
		s.log.Warn("camp chest item did not fit after the take: lost", "character", e.CharacterID, "item", it.ID, "left", left)
	}
	s.commitItems(sess, &d, nil, "camp take "+it.Base)
	s.sendGranted(sess, SourceDropped, []*items.Item{it})
}

// campDropChest empties a decaying chest: its stored rows are deleted.
func (s *Server) campDropChest(p *campPiece) {
	var ids []string
	for i, c := range p.chest {
		if c != nil && c.persisted {
			ids = append(ids, c.it.ID)
		}
		p.chest[i] = nil
	}
	if len(ids) > 0 {
		s.enqueueItems(nil, &ItemOp{Delete: ids, Note: "camp decay"})
	}
}
