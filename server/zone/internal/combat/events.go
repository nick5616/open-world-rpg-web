package combat

import (
	"encoding/binary"
	"math"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// Event kinds (contracts/events.md, WP13 range 200-399).
const (
	EvDamage       = 200 // an enemy took damage (observers; the attacker gets HitResult)
	EvEnemyDied    = 201
	EvPlayerHurt   = 202 // you took damage from an enemy
	EvPlayerDowned = 203
	EvTelegraph    = 204 // an enemy started a wind-up
	EvProjectile   = 205 // an enemy launched a projectile
	EvStatus       = 206
	EvEvaded       = 207 // an enemy strike missed you (dodge, parry, out of the area)
	EvBossPhase    = 208
	EvBossEngaged  = 209
	EvBossDefeated = 210
	EvCampCleared  = 211
	EvCombatSync   = 212 // your loadouts, known spells, skills (after join and every change)
	EvMana         = 213
	EvCast         = 214 // another player's attack/cast, for FX
	EvRefused      = 215 // your action was refused (cooldown, mana, illegal)
	EvSkillUp      = 216
	EvHeal         = 217
	EvConsumable   = 218
	EvShield       = 219
	EvBossReset    = 220
	EvRespawned    = 221
	EvStrikeHit    = 222 // an enemy strike landed on a player (observers: the hit flash)
)

// EvCast targetIds that are not attack/spell/form ids (CR 018).
const (
	// CastFXDash flags a mobility dash variant (targetId = variant | CastFXDash).
	CastFXDash = 0x8000
	// CastFXGuard: the secondary button went down on a sword, spear or bow
	// (parry stance, spear charge, bow draw), so other players can pose it.
	CastFXGuard = 0x4001
)

// Interact registry (contracts/events.md "Interact": targetKind 50 combat; 40/41 are WP09 mining).
const (
	InteractCombat = 50

	ActSwapLoadout = 1 // arg = loadout (0/1)
	ActEquipWeapon = 2 // arg = loadout | weapon id << 8
	ActEquipSpell  = 3 // arg = loadout | slot << 4 | spell id << 8 (spell id 0 clears)
	ActLearn       = 4 // arg = spell id
	ActSetGem      = 5 // arg = loadout | (element + 1) << 8 (0 = none); dev builds only (WP14 sockets)
	ActSetMaterial = 6 // WP15: arg = loadout | material id << 8 (0 = ordinary); dev builds only (WP14 equips forged items)
)

// Audience of an output Event.
type Audience struct {
	To     uint32        // one player's entity id (0 = area)
	Near   movement.Vec3 // area centre
	Radius float64
	Except uint32 // skip this player in an area send
}

// Out is one Event for the game layer to deliver.
type Out struct {
	Aud Audience
	Ev  proto.Event
}

func cm(v float64) int32 { return proto.MetersToCm(v) }

func ev(kind uint16, entity, target uint32, value int32, at movement.Vec3, data []byte) proto.Event {
	return proto.Event{Kind: kind, EntityID: entity, TargetID: target, Value: value, X: cm(at.X), Y: cm(at.Y), Z: cm(at.Z), Data: data}
}

// telegraphData: u8 shape (0 cone,1 circle,2 ground,3 line,4 projectile) |
// u16 yaw (u16 turn) | u16 radius cm | u16 reach cm | u8 arc deg/2 | u16
// width cm | u16 active ms.
func telegraphData(a *attackArea, activeMs int) []byte {
	b := make([]byte, 0, 12)
	b = append(b, a.shapeCode())
	b = binary.LittleEndian.AppendUint16(b, proto.YawToU16(a.yaw))
	b = binary.LittleEndian.AppendUint16(b, uint16(math.Min(65535, a.radius*100)))
	b = binary.LittleEndian.AppendUint16(b, uint16(math.Min(65535, a.reach*100)))
	b = append(b, uint8(math.Min(255, a.arc/2)))
	b = binary.LittleEndian.AppendUint16(b, uint16(math.Min(65535, a.width*100)))
	b = binary.LittleEndian.AppendUint16(b, uint16(min(65535, activeMs)))
	return b
}

// projectileData: i16 vx, vy, vz (cm/s / 2, so 650 m/s fits) | u16 radius cm
// | u16 range cm.
func projectileData(v movement.Vec3, radius, rng float64) []byte {
	b := make([]byte, 0, 10)
	q := func(x float64) uint16 { return uint16(int16(math.Max(-32767, math.Min(32767, x*50)))) }
	b = binary.LittleEndian.AppendUint16(b, q(v.X))
	b = binary.LittleEndian.AppendUint16(b, q(v.Y))
	b = binary.LittleEndian.AppendUint16(b, q(v.Z))
	b = binary.LittleEndian.AppendUint16(b, uint16(radius*100))
	b = binary.LittleEndian.AppendUint16(b, uint16(math.Min(65535, rng*100)))
	return b
}

// EncodeSync is the combat_sync payload: u8 version(1) | u8 active |
// 2 x loadout (u8 weapon id | 4 x u16 spell id (0 empty) | i8 gem element) |
// u16 nKnown + n x u16 spell id | u8 nSkills + n x (u8 skill id | u32 xp) |
// u16 mana max x10 | u8 charges | u16 skill points left | u8 level.
func EncodeSync(p *Player) []byte {
	pr := p.Profile
	b := []byte{1, uint8(pr.Active)}
	for _, lo := range pr.Loadouts {
		w := D.WeaponByKey(lo.Weapon)
		b = append(b, uint8(w.ID))
		for _, k := range lo.Spells {
			id := 0
			if s := D.SpellByKey(k); s != nil {
				id = s.ID
			}
			b = binary.LittleEndian.AppendUint16(b, uint16(id))
		}
		b = append(b, uint8(int8(lo.Gem)))
	}
	b = binary.LittleEndian.AppendUint16(b, uint16(len(pr.Known)))
	for _, k := range pr.Known {
		b = binary.LittleEndian.AppendUint16(b, uint16(D.SpellByKey(k).ID))
	}
	b = append(b, uint8(len(D.Skills.List)))
	for _, s := range D.Skills.List {
		b = append(b, uint8(s.ID))
		b = binary.LittleEndian.AppendUint32(b, uint32(min(pr.SkillXP[s.Key], math.MaxUint32)))
	}
	b = binary.LittleEndian.AppendUint16(b, uint16(p.ManaMax*10))
	b = append(b, uint8(p.Charges))
	b = binary.LittleEndian.AppendUint16(b, uint16(max(0, p.SkillPointsTotal()-pr.Spent())))
	b = append(b, uint8(min(255, p.Level)))
	return b
}
