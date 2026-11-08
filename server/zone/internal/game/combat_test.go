package game

import (
	"testing"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/combat"
)

// sendFrames sends frames (2 per packet) without stepping a local sim.
func (cl *client) sendFrames(flags ...uint16) {
	var frames []proto.InputFrame
	for _, f := range flags {
		cl.seq++
		frames = append(frames, proto.InputFrame{Seq: cl.seq, Flags: f})
	}
	cl.send(&proto.Input{AckTick: cl.dec.Latest(), Frames: frames})
}

func (cl *client) hitResult(timeout time.Duration) *proto.HitResult {
	return cl.next(proto.MsgHitResult, timeout).(*proto.HitResult)
}

// TestZonePvPImmunityAndEnemyHits runs the real session path: a camp
// placed by the dev knob shows up in snapshots as EntityKind enemy; a sword
// swing claimed on it is accepted and lowers its health; every claim naming
// the other player is refused with reason 1 and never changes their health.
func TestZonePvPImmunityAndEnemyHits(t *testing.T) {
	t.Setenv("LODESTONE_ZONE_DEBUG_CAMP", "1000,998,1,brute")
	h := newHarness(t, func(c *Config) { c.Combat = &CombatSetup{Dev: true} })
	a := h.dial("?spawn=1000,1000")
	a.join(h, "ca", "Alyssa")
	b := h.dial("?spawn=1045,1000") // out of the brute's reach: only A's claims could touch B
	wb := b.join(h, "cb", "Bruno")

	// Wait for the brute to appear in A's snapshots.
	var enemy uint32
	deadline := time.Now().Add(5 * time.Second)
	for enemy == 0 && time.Now().Before(deadline) {
		a.sendFrames(0, 0)
		a.drainFor(50 * time.Millisecond)
		if a.frame != nil {
			for _, e := range a.frame.Ents {
				if e.Kind == proto.EntityKindEnemy {
					enemy = e.ID
					if id, _, _ := combatdefs.UnpackTypeID(e.TypeID); id != combatdefs.D.EnemyByKey("brute").ID {
						t.Fatalf("enemy typeId %d is not a brute", e.TypeID)
					}
				}
			}
		}
	}
	if enemy == 0 {
		t.Fatal("no enemy in snapshots")
	}

	// A swings (yaw 0 faces -Z: the brute is 2 m ahead) and claims it.
	a.sendFrames(proto.InputFlagAttack, 0)
	swing := a.seq - 1
	sword := combatdefs.D.MoveOf(combatdefs.D.WeaponByKey("sword"), "light", 0)
	a.send(&proto.HitClaim{AttackSeq: swing, AttackID: uint16(sword.ID), TargetID: enemy, Tick: a.dec.Latest(), X: 100000, Z: 100000})
	if r := a.hitResult(3 * time.Second); !r.Accepted || r.Damage == 0 || r.TargetHealthPct >= 100 {
		t.Fatalf("hit on the brute: %+v", r)
	}

	// Every attack and spell id, claimed on player B: always refused.
	refused := 0
	// HitClaim is rate-limited (30 burst, 15/s): pace the sweep.
	for _, m := range combatdefs.D.Moves {
		time.Sleep(70 * time.Millisecond)
		a.sendFrames(0, proto.InputFlagAttack)
		a.send(&proto.HitClaim{AttackSeq: a.seq, AttackID: uint16(m.ID), TargetID: wb.EntityID, Tick: a.dec.Latest()})
		r := a.hitResult(3 * time.Second)
		if r.Accepted || r.Flags != combat.RefuseNotEnemy {
			t.Fatalf("claim %s on a player: %+v", m.Key, r)
		}
		refused++
	}
	for _, s := range combatdefs.D.Spells {
		time.Sleep(70 * time.Millisecond)
		a.send(&proto.HitClaim{AttackSeq: a.seq, AttackID: uint16(s.ID), TargetID: wb.EntityID, Tick: a.dec.Latest()})
		if r := a.hitResult(3 * time.Second); r.Accepted || r.Flags != combat.RefuseNotEnemy {
			t.Fatalf("spell claim %s on a player: %+v", s.Key, r)
		}
		refused++
	}
	b.sendFrames(0, 0)
	b.drainFor(200 * time.Millisecond)
	if b.frame == nil || b.frame.Self.Health != b.frame.Self.HealthMax {
		t.Fatalf("B lost health: %+v", b.frame.Self)
	}
	t.Logf("%d claims on a player refused (reason %d)", refused, combat.RefuseNotEnemy)
}
