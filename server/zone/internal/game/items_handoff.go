package game

// Items across a zone handoff (WP16). The old owner serializes the live
// inventory (every item, the loot markers, the quick consumable, how it
// persists) into the handoff state as a HandoffField; the new owner adopts
// it before Welcome, so nothing waits on Postgres and nothing the old
// owner's journal hasn't written yet is lost from the live game.
//
// Durable state is fenced by the ownership epoch, like WP16's position and
// progress checkpoints: every item op carries its zone's epoch, and the
// transaction refuses an op older than the newest one that landed for the
// character (table item_epochs, migration 0014). The new owner's first op
// is a full sync (every row it holds, the rows it doesn't hold deleted,
// every marker inserted) at its newer epoch, so:
//
//   - the old owner's queued ops that land before the sync are overwritten
//     by it, those that land after are fenced out: a stale zone can never
//     grant, take or duplicate anything once the new owner has written;
//   - a grant the old owner rolled but hadn't committed is in the handed
//     inventory and its marker in the handed markers, so the sync writes
//     both: granted exactly once.

import (
	"encoding/json"

	"lodestone/server/zone/internal/items"
)

// handedItems is the HandoffField payload.
type handedItems struct {
	Persist int               `json:"persist"`
	Quick   string            `json:"quick,omitempty"`
	Markers []string          `json:"markers,omitempty"`
	Items   []json.RawMessage `json:"items"`
}

// itemJSON is an item's full state in a handoff (same columns as the row).
type itemJSON struct {
	ID        string          `json:"id"`
	Base      string          `json:"base"`
	Qty       int             `json:"qty"`
	Level     int             `json:"level"`
	Rarity    int             `json:"rarity"`
	Affixes   json.RawMessage `json:"affixes"`
	Sockets   json.RawMessage `json:"sockets"`
	Slot      string          `json:"slot"`
	Seed      int64           `json:"seed"`
	Tradeable bool            `json:"tradeable"`
	Verified  bool            `json:"verified"`
	Prov      json.RawMessage `json:"prov"`
	Name      string          `json:"name,omitempty"`
}

func encodeItem(it *items.Item) json.RawMessage {
	b, _ := json.Marshal(itemJSON{ID: it.ID, Base: it.Base, Qty: it.Qty, Level: it.Level, Rarity: it.Rarity, Affixes: it.AffixesJSON(),
		Sockets: it.SocketsJSON(), Slot: it.Slot, Seed: it.Seed, Tradeable: it.Tradeable, Verified: it.Verified, Prov: it.ProvJSON(), Name: it.Name})
	return b
}

func decodeItem(b json.RawMessage) *items.Item {
	var j itemJSON
	if json.Unmarshal(b, &j) != nil {
		return nil
	}
	it := &items.Item{ID: j.ID, Base: j.Base, Qty: max(1, j.Qty), Level: j.Level, Rarity: j.Rarity, Slot: j.Slot, Seed: j.Seed,
		Tradeable: j.Tradeable, Verified: j.Verified, Name: j.Name}
	it.SetAffixesJSON(j.Affixes)
	it.SetSocketsJSON(j.Sockets)
	it.SetProvJSON(j.Prov)
	if it.Def() == nil || it.ID == "" {
		return nil
	}
	return it
}

func init() {
	RegisterHandoffField(HandoffField{
		Name: "items",
		Save: func(s *Server, e *Entity) json.RawMessage {
			sess := s.byChar[e.CharacterID]
			if sess == nil || sess.items == nil {
				return nil
			}
			ci := sess.items
			h := handedItems{Persist: ci.persist, Quick: ci.quick}
			for k := range ci.markers {
				h.Markers = append(h.Markers, k)
			}
			for _, it := range ci.inv.Items {
				h.Items = append(h.Items, encodeItem(it))
			}
			b, _ := json.Marshal(h)
			return b
		},
		Load: func(s *Server, e *Entity, data json.RawMessage) {
			var h handedItems
			if json.Unmarshal(data, &h) != nil {
				return
			}
			if s.itm.handed == nil {
				s.itm.handed = map[string]*handedItems{}
			}
			s.itm.handed[e.CharacterID] = &h
		},
	})
}

// adoptHanded replaces a joining session's items with the handed-over ones
// (itemsJoin). Returns true when it did.
func (s *Server) adoptHanded(sess *session) bool {
	h := s.itm.handed[sess.ent.CharacterID]
	if h == nil {
		return false
	}
	delete(s.itm.handed, sess.ent.CharacterID)
	ci := &charItems{markers: map[string]bool{}, persist: h.Persist, quick: h.Quick}
	if ci.persist == persistDB && s.itm.j == nil {
		ci.persist = persistMemory // this zone has no database: memory only
	}
	for _, k := range h.Markers {
		ci.markers[k] = true
	}
	for _, b := range h.Items {
		if it := decodeItem(b); it != nil {
			ci.inv.Items = append(ci.inv.Items, it)
		}
	}
	sess.items = ci
	return true
}

// syncAll queues the full-state op a new owner writes first (see the
// header): every item it holds, rows it doesn't hold deleted, markers.
func (s *Server) syncAll(sess *session, note string) {
	ci := sess.items
	if ci.persist != persistDB || s.itm.j == nil {
		return
	}
	op := &ItemOp{Char: sess.ent.CharacterID, Epoch: sess.ent.epoch, Sync: true, Note: note}
	for _, it := range ci.inv.Items {
		op.Upsert = append(op.Upsert, ItemRow{Item: it.Clone(), Owner: op.Char})
	}
	for k := range ci.markers {
		op.Markers = append(op.Markers, k)
	}
	s.enqueueItems(sess, op)
}
