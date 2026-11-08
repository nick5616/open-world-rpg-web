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
