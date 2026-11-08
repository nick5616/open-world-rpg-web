package combatbot

import (
	"encoding/binary"
	"math"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// DecodeTelegraph reads a telegraph Event (kind 204; contracts/events.md):
// value = wind-up ms, x/y/z = area centre (cm), data = u8 shape | u16 yaw |
// u16 radius cm | u16 reach cm | u8 arc/2 | u16 width cm | u16 active ms.
func DecodeTelegraph(ev proto.Event) (Telegraph, bool) {
	d := ev.Data
	if len(d) < 12 {
		return Telegraph{}, false
	}
	le := binary.LittleEndian
	return Telegraph{
		Enemy:  ev.EntityID,
		Attack: int(ev.TargetID),
		Windup: int(math.Round(float64(ev.Value) * 60 / 1000)),
		Shape:  d[0],
		Center: movement.Vec3{X: proto.CmToMeters(ev.X), Y: proto.CmToMeters(ev.Y), Z: proto.CmToMeters(ev.Z)},
		Yaw:    proto.U16ToYaw(le.Uint16(d[1:])),
		Radius: float64(le.Uint16(d[3:])) / 100,
		Reach:  float64(le.Uint16(d[5:])) / 100,
		Arc:    float64(d[7]) * 2,
		Width:  float64(le.Uint16(d[8:])) / 100,
	}, true
}

// SeeProjectile turns an enemy projectile Event (kind 205: x/y/z origin cm,
// data = i16 vx, vy, vz (cm/s / 2) | u16 radius cm | u16 range cm) into a
// threat if it is headed at the bot: a small circle where the bot stands,
// striking when the projectile arrives.
func (b *Brain) SeeProjectile(ev proto.Event) {
	d := ev.Data
	if len(d) < 10 {
		return
	}
	le := binary.LittleEndian
	vx := float64(int16(le.Uint16(d[0:]))) / 50
	vz := float64(int16(le.Uint16(d[4:]))) / 50
	o := movement.Vec3{X: proto.CmToMeters(ev.X), Z: proto.CmToMeters(ev.Z)}
	sp := math.Hypot(vx, vz)
	if sp < 0.1 {
		return
	}
	dx, dz := b.State.Pos.X-o.X, b.State.Pos.Z-o.Z
	along := (dx*vx + dz*vz) / sp
	side := math.Abs(dx*vz-dz*vx) / sp
	if along <= 0 || side > 1.6 || along > float64(le.Uint16(d[8:]))/100 {
		return
	}
	b.SeeTelegraph(Telegraph{Enemy: ev.EntityID, Attack: int(ev.TargetID), Windup: int(along / sp * 60), Shape: 1, Center: b.State.Pos, Radius: 1.4})
}
