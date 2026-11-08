package items

import (
	"errors"
	"slices"
	"strconv"
	"strings"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/itemdefs"
)

// Pouch sizes. Spec 8 gives 40 inventory slots "plus a gem pouch and an ore
// pouch" without sizes; 30 stacks each holds every gem kind in every cut
// (30) and every ore and ingot (12) with room to spare.
const (
	GemPouchSlots = 30
	OrePouchSlots = 30
)

// Errors returned by inventory operations (the zone maps them to Event 403
// refusal codes, contracts/events.md).
var (
	ErrFull       = errors.New("inventory full")
	ErrNoItem     = errors.New("no such item")
	ErrNotAllowed = errors.New("not allowed")
	ErrMissing    = errors.New("missing ingredients")
	ErrBlueprint  = errors.New("blueprint required")
	ErrGold       = errors.New("not enough gold")
	ErrSocket     = errors.New("no such socket")
)

// Delta records what an operation changed, for the ordered DB journal:
// rows to insert (created this op), rows to update (full state), rows to
// delete. An item created and deleted in the same op never reaches it.
type Delta struct {
	created map[*Item]bool
	updated map[*Item]bool
	deleted map[string]bool
	order   []*Item
}

func (d *Delta) init() {
	if d.created == nil {
		d.created, d.updated, d.deleted = map[*Item]bool{}, map[*Item]bool{}, map[string]bool{}
	}
}

// Create marks a new row.
func (d *Delta) Create(it *Item) {
	d.init()
	if !d.created[it] {
		d.created[it] = true
		d.order = append(d.order, it)
	}
}

// Update marks a changed row.
func (d *Delta) Update(it *Item) {
	d.init()
	if !d.created[it] && !d.updated[it] {
		d.updated[it] = true
		d.order = append(d.order, it)
	}
}

// Delete marks a removed row.
func (d *Delta) Delete(it *Item) {
	d.init()
	if d.created[it] {
		delete(d.created, it) // never existed in the database
		i := slices.Index(d.order, it)
		d.order = slices.Delete(d.order, i, i+1)
		return
	}
	if d.updated[it] {
		delete(d.updated, it)
		i := slices.Index(d.order, it)
		d.order = slices.Delete(d.order, i, i+1)
	}
	d.deleted[it.ID] = true
}

// Empty reports no changes.
func (d *Delta) Empty() bool { return len(d.order) == 0 && len(d.deleted) == 0 }

// Rows returns snapshots: created and updated rows (in first-touch order)
// and deleted ids.
func (d *Delta) Rows() (created, updated []*Item, deleted []string) {
	for _, it := range d.order {
		if d.created[it] {
			created = append(created, it.Clone())
		} else if d.updated[it] {
			updated = append(updated, it.Clone())
		}
	}
	for id := range d.deleted {
		deleted = append(deleted, id)
	}
	slices.Sort(deleted)
	return
}

// Created reports whether it was created in this delta.
func (d *Delta) Created(it *Item) bool { return d.created[it] }

// Inventory is one character's items (tick-owned).
type Inventory struct {
	Items []*Item
	Alloc func() uint32 // wire handles
}

// ByHandle finds an item by wire handle.
func (inv *Inventory) ByHandle(h uint32) *Item {
	for _, it := range inv.Items {
		if it.H == h {
			return it
		}
	}
	return nil
}

// InSlot returns the item in a slot.
func (inv *Inventory) InSlot(slot string) *Item {
	for _, it := range inv.Items {
		if it.Slot == slot {
			return it
		}
	}
	return nil
}

func pouchSize(p string) int {
	switch p {
	case PouchGem:
		return GemPouchSlots
	case PouchOre:
		return OrePouchSlots
	case PouchInv:
		return constants.InventorySlots
	}
	return 0
}

func (inv *Inventory) freeSlot(pouch string) string {
	n := pouchSize(pouch)
	used := make([]bool, n)
	for _, it := range inv.Items {
		if p, i := SlotPouch(it.Slot); p == pouch && i >= 0 && i < n {
			used[i] = true
		}
	}
	for i, u := range used {
		if !u {
			return pouch + ":" + strconv.Itoa(i)
		}
	}
	return ""
}

// stackable: plain stacks merge; anything rolled (affixes, sockets, a
// name) or a single-item category never does.
func stackable(it *Item, d *itemdefs.Item) bool {
	return d.Stack > 1 && len(it.Affixes) == 0 && len(it.Uniques) == 0 && len(it.Sockets) == 0 && it.Name == "" && it.Rarity == 0
}

func (inv *Inventory) handle(it *Item) {
	if it.H == 0 && inv.Alloc != nil {
		it.H = inv.Alloc()
	}
	if it.ID == "" {
		it.ID = NewID()
	}
}

// Place puts a loaded item into the inventory as stored (login).
func (inv *Inventory) Place(it *Item) {
	inv.handle(it)
	inv.Items = append(inv.Items, it)
}

// Add puts a new item into the inventory, merging stacks first. It returns
// how many units did not fit (the caller spills them as a pickup). The item
// passed in becomes the new row when it lands in a free slot whole.
func (inv *Inventory) Add(it *Item, d *Delta) int {
	def := it.Def()
	if def == nil || it.Qty <= 0 {
		return it.Qty
	}
	left := it.Qty
	if def.Pouch == PouchPurse {
		if p := inv.InSlot(PouchPurse); p != nil {
			p.Qty += left
			d.Update(p)
			return 0
		}
		it.Slot = PouchPurse
		inv.handle(it)
		inv.Items = append(inv.Items, it)
		d.Create(it)
		return 0
	}
	if stackable(it, def) {
		for _, s := range inv.Items {
			if left == 0 {
				break
			}
			if s.Base != it.Base || s.IsEquipped() || s.Verified != it.Verified || s.Tradeable != it.Tradeable || !stackable(s, def) || s.Qty >= def.Stack {
				continue
			}
			n := min(left, def.Stack-s.Qty)
			s.Qty += n
			s.Prov = MergeProv(s.Prov, it.Prov)
			left -= n
			d.Update(s)
		}
	}
	for left > 0 {
		slot := inv.freeSlot(def.Pouch)
		if slot == "" {
			break
		}
		n := min(left, max(1, def.Stack))
		part := it
		if n != it.Qty || it.Slot != "" || slices.Contains(inv.Items, it) {
			part = it.Clone()
			part.ID, part.H = "", 0
		}
		part.Qty = n
		part.Slot = slot
		inv.handle(part)
		inv.Items = append(inv.Items, part)
		d.Create(part)
		left -= n
	}
	return left
}

// maxProv bounds a merged stack's provenance: commodity stacks absorb the
// history of every stack merged into them, newest kept.
const maxProv = 32

// MergeProv appends incoming provenance to a stack's (bounded, newest kept).
func MergeProv(have, in []Prov) []Prov {
	out := append(have, in...)
	if len(out) > maxProv {
		out = append([]Prov(nil), out[len(out)-maxProv:]...)
	}
	return out
}

// CanFit reports whether qty of base would fit right now.
func (inv *Inventory) CanFit(base string, qty int) bool {
	def := D.Item(base)
	if def == nil {
		return false
	}
	if def.Pouch == PouchPurse {
		return true
	}
	room := 0
	probe := Stack(base, 1)
	if stackable(probe, def) {
		for _, s := range inv.Items {
			if s.Base == base && !s.IsEquipped() && s.Verified && s.Tradeable && stackable(s, def) {
				room += max(0, def.Stack-s.Qty)
			}
		}
	}
	free := 0
	n := pouchSize(def.Pouch)
	used := map[int]bool{}
	for _, it := range inv.Items {
		if p, i := SlotPouch(it.Slot); p == def.Pouch && i >= 0 {
			used[i] = true
		}
	}
	free = n - len(used)
	room += free * max(1, def.Stack)
	return room >= qty
}

// Take detaches qty units of an item from the inventory. A whole item
// leaves the list (its slot cleared) and is returned as is; a partial take
// shrinks the stack (an update) and returns a new, unsaved item with a new
// id carrying the same flags and provenance.
func (inv *Inventory) Take(it *Item, qty int, d *Delta) *Item {
	if qty <= 0 || qty >= it.Qty {
		i := slices.Index(inv.Items, it)
		if i >= 0 {
			inv.Items = slices.Delete(inv.Items, i, i+1)
		}
		it.Slot = ""
		return it
	}
	it.Qty -= qty
	d.Update(it)
	part := it.Clone()
	part.ID, part.H, part.Slot = NewID(), 0, ""
	part.Qty = qty
	return part
}

// Count is the units of base held (not equipped).
func (inv *Inventory) Count(base string) int {
	n := 0
	for _, it := range inv.Items {
		if it.Base == base && !it.IsEquipped() {
			n += it.Qty
		}
	}
	return n
}

// Spend removes n units of base across stacks (smallest stacks first, so
// partial stacks are used up); false (and nothing changed) if short.
func (inv *Inventory) Spend(base string, n int, d *Delta) bool {
	if n <= 0 {
		return true
	}
	if inv.Count(base) < n {
		return false
	}
	var stacks []*Item
	for _, it := range inv.Items {
		if it.Base == base && !it.IsEquipped() {
			stacks = append(stacks, it)
		}
	}
	slices.SortStableFunc(stacks, func(a, b *Item) int { return a.Qty - b.Qty })
	for _, s := range stacks {
		if n == 0 {
			break
		}
		k := min(n, s.Qty)
		n -= k
		if k == s.Qty {
			inv.Take(s, s.Qty, d)
			d.Delete(s)
		} else {
			s.Qty -= k
			d.Update(s)
		}
	}
	return true
}

// Gold is the purse.
func (inv *Inventory) Gold() int { return inv.Count("currency:gold") }

// Move puts an item into another slot of its pouch (swapping with the
// occupant). Equipped items unequip into the slot.
func (inv *Inventory) Move(it *Item, slot string, d *Delta) error {
	def := it.Def()
	p, i := SlotPouch(slot)
	if def == nil || p != def.Pouch || i < 0 || i >= pouchSize(p) {
		return ErrNotAllowed
	}
	if o := inv.InSlot(slot); o != nil && o != it {
		if it.IsEquipped() && !equipFits(o, it.Slot) {
			return ErrNotAllowed
		}
		o.Slot = it.Slot
		d.Update(o)
	}
	it.Slot = slot
	d.Update(it)
	return nil
}

func equipFits(it *Item, slot string) bool {
	def := it.Def()
	if def == nil {
		return false
	}
	switch slot {
	case EqMain0, EqMain1:
		return def.Kind == "weapon"
	case EqHead:
		return def.Armor == "head"
	case EqBody:
		return def.Armor == "body"
	case EqLegs:
		return def.Armor == "legs"
	}
	return false
}

// ArmorSlot is the equipment slot of an armor piece.
func ArmorSlot(def *itemdefs.Item) string {
	switch def.Armor {
	case "head":
		return EqHead
	case "body":
		return EqBody
	case "legs":
		return EqLegs
	}
	return ""
}

// Equip puts a weapon into a loadout's main hand (slot EqMain0/1) or armor
// into its slot; the previous occupant takes the item's old slot.
func (inv *Inventory) Equip(it *Item, slot string, d *Delta) error {
	if it.Slot == slot {
		return nil
	}
	if !equipFits(it, slot) {
		return ErrNotAllowed
	}
	from := it.Slot
	if o := inv.InSlot(slot); o != nil {
		dest := from
		if from == "" || (strings.HasPrefix(from, "eq:") && !equipFits(o, from)) || (!strings.HasPrefix(from, "eq:") && !slotFitsPouch(o, from)) {
			dest = inv.freeSlot(PouchInv)
			if dest == "" {
				return ErrFull
			}
		}
		o.Slot = dest
		d.Update(o)
	}
	it.Slot = slot
	d.Update(it)
	return nil
}

func slotFitsPouch(it *Item, slot string) bool {
	p, _ := SlotPouch(slot)
	def := it.Def()
	return def != nil && def.Pouch == p
}

// Unequip moves an equipped item into a free inventory slot.
func (inv *Inventory) Unequip(slot string, d *Delta) error {
	it := inv.InSlot(slot)
	if it == nil {
		return ErrNoItem
	}
	s := inv.freeSlot(PouchInv)
	if s == "" {
		return ErrFull
	}
	it.Slot = s
	d.Update(it)
	return nil
}

// Socket sets a gem from the gem pouch into an empty socket of a weapon
// (spec 8: socketing is free, anywhere).
func (inv *Inventory) Socket(weapon, gem *Item, idx int, d *Delta) error {
	gd := gem.Def()
	if gd == nil || gd.Kind != "gem" || weapon.Def() == nil || weapon.Def().Kind != "weapon" {
		return ErrNotAllowed
	}
	if idx < 0 || idx >= len(weapon.Sockets) || weapon.Sockets[idx] != "" {
		return ErrSocket
	}
	if gem.Qty <= 1 {
		inv.Take(gem, 1, d)
		d.Delete(gem)
	} else {
		gem.Qty--
		d.Update(gem)
	}
	weapon.Sockets[idx] = gem.Base
	d.Update(weapon)
	return nil
}

// Unsocket removes a gem: kept (back to the gem pouch) at a town
// blacksmith, destroyed anywhere else (spec 8). Returns the gem key.
func (inv *Inventory) Unsocket(weapon *Item, idx int, keep bool, d *Delta) (string, error) {
	if idx < 0 || idx >= len(weapon.Sockets) || weapon.Sockets[idx] == "" {
		return "", ErrSocket
	}
	g := weapon.Sockets[idx]
	if keep && !inv.CanFit(g, 1) {
		return "", ErrFull
	}
	weapon.Sockets[idx] = ""
	d.Update(weapon)
	if keep {
		inv.Add(Stack(g, 1), d)
	}
	return g, nil
}

// Combine turns CombineCount gems of one cut into one of the next cut
// (spec 7: at a waypoint; the caller checks the place).
func (inv *Inventory) Combine(gemBase string, d *Delta) (*Item, error) {
	gd := D.Item(gemBase)
	if gd == nil || gd.Kind != "gem" {
		return nil, ErrNotAllowed
	}
	next := D.CutAfter(gd.Cut)
	if next == nil {
		return nil, ErrNotAllowed
	}
	if inv.Count(gemBase) < D.CombineCount {
		return nil, ErrMissing
	}
	out := Stack("gem:"+gd.Gem+":"+next.Key, 1)
	inv.Spend(gemBase, D.CombineCount, d)
	if left := inv.Add(out, d); left > 0 {
		return nil, ErrFull // cannot happen: three units just left the pouch
	}
	return out, nil
}

// HasBlueprint reports a blueprint item in the inventory.
func (inv *Inventory) HasBlueprint(key string) bool { return key == "" || inv.Count(key) > 0 }

// Craft runs a recipe: checks the blueprint and inputs, spends the inputs
// and adds the output (an equipment output is a forge roll: rarity with
// luck 1 + Smithing/100, the recipe's guaranteed sockets). seed is the
// roll's logged seed.
func (inv *Inventory) Craft(rc *itemdefs.Recipe, smithing int, seed uint64, d *Delta) (*Item, error) {
	if !inv.HasBlueprint(rc.Blueprint) {
		return nil, ErrBlueprint
	}
	for _, in := range rc.Inputs {
		if inv.Count(in.Item) < in.Qty {
			return nil, ErrMissing
		}
	}
	od := D.Item(rc.Output)
	var out *Item
	if od.Kind == "weapon" || od.Kind == "armor" {
		out = RollEquipment(NewRNG(seed), Rolled{Level: od.Level, Base: od.Key, Luck: 1 + float64(smithing)/100, Forged: true, MinSock: rc.Sockets, Element: -1})
	} else {
		out = Stack(rc.Output, rc.Qty)
	}
	out.Seed = int64(seed)
	if !inv.CanFit(out.Base, out.Qty) {
		return nil, ErrFull
	}
	for _, in := range rc.Inputs {
		inv.Spend(in.Item, in.Qty, d)
	}
	if left := inv.Add(out, d); left > 0 {
		return nil, ErrFull
	}
	return out, nil
}
