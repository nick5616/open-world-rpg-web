package game

// Visible armor (playtest 2, CR 034): what a player wears is zone state,
// replicated as one u64 in the player entity's snapshot record
// (EntityRecord.appearance, protocol v6), so every client draws the same
// pieces:
//
//	per slot s (0 head, 1 body, 2 legs), at bit 17*s:
//	  bits 0-5   visual id: 1 + the piece's index among items.yaml armor (0 none)
//	  bits 6-9   material code (1 + index in items.yaml materials; the weapon look's code)
//	  bits 10-12 rarity (0 common .. 7 Bitchin')
//	  bits 13-16 gem: 1 + index in items.yaml gems of the first socketed gem (0 none)
//	bits 51-56 the light (CR 042, lights.go): a torch bit and the familiar id; the armor part
//	(bits 0-50) stays below 2^51, exact in JSON and JS numbers (Event 400 "ap" is armor only)
//
// It is recomputed from the inventory whenever items change (applyGear),
// never per tick; the snapshot's delta coding sends it on change and on
// first sight (a late joiner, a player walking into range, a ghost from the
// next zone), and nothing while it stays the same. A player wearing nothing
// is 0 and costs nothing (the G5 scale bots). Your own body reads the same
// number from the inventory event (Event 400 "ap"). The client's twin is
// client/src/combat/armor/appearance.ts.

import (
	"strings"

	"lodestone/server/pkg/itemdefs"
	"lodestone/server/zone/internal/items"
)

// ArmorSlots are the equipment slots in appearance order.
var ArmorSlots = [3]string{items.EqHead, items.EqBody, items.EqLegs}

// ArmorLook is one slot of an appearance.
type ArmorLook struct {
	Visual   int   // 1 + index among armor items, 0 none
	Material uint8 // LookMaterialCode
	Rarity   int   // 0..7
	Gem      int   // 1 + index in itemdefs gems, 0 none
}

const appearanceSlotBits = 17

// PackAppearance packs three slots.
func PackAppearance(s [3]ArmorLook) uint64 {
	var v uint64
	for i, l := range s {
		if l.Visual <= 0 {
			continue
		}
		w := uint64(l.Visual&0x3f) | uint64(l.Material&0xf)<<6 | uint64(l.Rarity&0x7)<<10 | uint64(l.Gem&0xf)<<13
		v |= w << (appearanceSlotBits * i)
	}
	return v
}

// UnpackAppearance is PackAppearance's inverse.
func UnpackAppearance(v uint64) [3]ArmorLook {
	var out [3]ArmorLook
	for i := range out {
		w := v >> (appearanceSlotBits * i)
		out[i] = ArmorLook{Visual: int(w & 0x3f), Material: uint8(w >> 6 & 0xf), Rarity: int(w >> 10 & 0x7), Gem: int(w >> 13 & 0xf)}
		if out[i].Visual == 0 {
			out[i] = ArmorLook{}
		}
	}
	return out
}

var armorVisuals = func() map[string]int {
	m := map[string]int{}
	n := 0
	for i := range itemdefs.D.Items {
		if it := &itemdefs.D.Items[i]; it.Kind == "armor" {
			n++
			m[it.Key] = n
		}
	}
	return m
}()

// ArmorVisualID is the appearance visual id of an armor key (0 = not armor).
func ArmorVisualID(key string) int { return armorVisuals[key] }

// gemCode is 1 + the gems index of a gem item key ("gem:ruby:cut"), 0 none.
func gemCode(key string) int {
	parts := strings.Split(key, ":")
	if len(parts) < 2 || parts[0] != "gem" {
		return 0
	}
	for i, g := range itemdefs.D.Gems {
		if g.Key == parts[1] {
			return min(i+1, 15)
		}
	}
	return 0
}

// ArmorLookOf is the appearance slot of one equipped armor item.
func ArmorLookOf(it *items.Item) ArmorLook {
	if it == nil {
		return ArmorLook{}
	}
	d := it.Def()
	if d == nil || d.Kind != "armor" {
		return ArmorLook{}
	}
	l := ArmorLook{Visual: ArmorVisualID(it.Base), Material: LookMaterialCode(d.Material), Rarity: min(max(it.Rarity, 0), 7)}
	for _, g := range it.Sockets {
		if g != "" {
			l.Gem = gemCode(g)
			break
		}
	}
	return l
}

// AppearanceOf is what an inventory's equipped armor looks like.
func AppearanceOf(inv *items.Inventory) uint64 {
	if inv == nil {
		return 0
	}
	var s [3]ArmorLook
	for i, slot := range ArmorSlots {
		s[i] = ArmorLookOf(inv.InSlot(slot))
	}
	return PackAppearance(s)
}
