package game

// Weapon looks (pt/ux "weapons don't look like weapons"): what the active
// loadout's weapon looks like rides in the player entity's snapshot typeId,
// so other players draw it in the avatar's hand with no protocol change:
//
//	bits 0-3   combat.yaml weapon id (0 none)
//	bits 4-7   material code: 0 ordinary, else 1 + index in items.yaml materials
//	bits 8-11  socketed gem element + 1 (0 none)
//
// (contracts/events.md "Player entities"; client/src/combat/weapons/look.ts.)
// It is recomputed only when the loadout or gear changes (sendCombatSync,
// applyGear), never per tick; snapshots delta-code it like any typeId. The
// same material codes, per loadout, end the combat_sync payload so the
// owner's first-person view matches what others see.

import (
	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/itemdefs"
	"lodestone/server/zone/internal/items"
)

// WeaponLook packs a weapon look into a player typeId.
func WeaponLook(weaponID int, material uint8, gem int) uint16 {
	g := 0
	if gem >= 0 && gem < 15 {
		g = gem + 1
	}
	return uint16(weaponID&0xf) | uint16(material&0xf)<<4 | uint16(g&0xf)<<8
}

// UnpackWeaponLook is WeaponLook's inverse.
func UnpackWeaponLook(t uint16) (weaponID int, material uint8, gem int) {
	return int(t & 0xf), uint8(t >> 4 & 0xf), int(t>>8&0xf) - 1
}

// LookMaterialCode is a material key's code: 1 + its index in items.yaml
// materials, 0 for "" or an unknown key (combat.yaml's iron/silver/sunsteel
// keys are items.yaml keys too).
func LookMaterialCode(key string) uint8 {
	if key == "" {
		return 0
	}
	for i, m := range itemdefs.D.Materials {
		if m.Key == key {
			return uint8(min(i+1, 15))
		}
	}
	return 0
}

// loadoutMaterial is the material of loadout l's weapon: the equipped
// item's (WP14) when the loadout holds it, else the loadout's own (dev
// Interact 50 action 6, WP15 Loadout.Material).
func loadoutMaterial(sess *session, l int) string {
	pr := sess.ent.cbt.Profile
	if ci := sess.items; ci != nil && ci.synced[l] != "" && pr.Loadouts[l].Weapon == ci.synced[l] {
		if it := ci.inv.InSlot(items.MainSlot(l)); it != nil {
			if d := it.Def(); d != nil && d.Material != "" {
				return d.Material
			}
		}
	}
	return pr.Loadouts[l].Material
}

// weaponLooks: the material code of each loadout's weapon and the active
// loadout's packed look.
func weaponLooks(sess *session) (mats [2]uint8, active uint16) {
	pr := sess.ent.cbt.Profile
	for l := range mats {
		mats[l] = LookMaterialCode(loadoutMaterial(sess, l))
	}
	lo := pr.Loadouts[pr.Active]
	id := 0
	if w := combatdefs.D.WeaponByKey(lo.Weapon); w != nil {
		id = w.ID
	}
	return mats, WeaponLook(id, mats[pr.Active], lo.Gem)
}
