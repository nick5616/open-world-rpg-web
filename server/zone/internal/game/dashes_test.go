package game

import (
	"context"
	"testing"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/chem"
)

// TestMagmaDashSetsGrassAlight (CR 021): a running magma dash schedules
// chem ignite ops along its path (server-side, like a spell impact) and
// every client in range gets them; a player who is not dashing schedules
// nothing.
func TestMagmaDashSetsGrassAlight(t *testing.T) {
	h, _ := nightHarness(t)
	a := h.dial("?spawn=300,300")
	a.join(h, "ca", "Ana")
	b := h.dial("?spawn=310,300")
	b.join(h, "cb", "Bo")
	var idle, dashing int
	_ = h.srv.Do(context.Background(), func() {
		sess := h.srv.byChar["ca"]
		count := func() int {
			n := 0
			for tk := uint32(1000); tk < 1000+dashChemTicks*3; tk++ {
				if d, ok := sess.ent.cbt.DashTrail(); ok && d.Trail.Chem == "ignite" && (tk+sess.ent.ID)%dashChemTicks == 0 {
					n++
				}
				h.srv.dashEnvTick(tk)
			}
			return n
		}
		idle = count()
		v := combatdefs.D.SpellByKey("magma_dash").Dash
		h.srv.combatFrame(sess, proto.InputFrame{Seq: sess.ent.LastSeq + 1, Flags: proto.InputFlagDodge, CastSlot: uint8(v)})
		dashing = count()
	})
	if idle != 0 || dashing == 0 {
		t.Fatalf("ops scheduled idle %d, dashing %d", idle, dashing)
	}
	ev := b.event(chem.EvIgnite, 3*time.Second)
	if op, err := chem.DecodeOp(ev); err != nil || op.Kind != chem.OpIgnite || op.Radius < 1 {
		t.Fatalf("trail op %+v %v", op, err)
	}
}
