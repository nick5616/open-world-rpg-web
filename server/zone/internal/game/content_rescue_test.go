package game

import (
	"testing"
	"time"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/content"
)

// CR 023 rescue: the lost villager is found at the camp, follows its
// rescuer home as an NPC entity, and the giver thanks you.
func TestSideQuestRescueFollowerHome(t *testing.T) {
	h, store := contentHarness(t, false)
	cw := h.contentWorld()
	tw, giver, o := findSide(t, cw, "rescue")
	camp := o.Quest.Steps[0].Obj
	const char = "77777777-4444-5555-6666-777777777777"
	sx, sz := npcStand(cw, tw, giver)
	store.rows[char] = movement.Vec3{X: sx, Y: h.srv.cfg.Ground.HeightAt(sx, sz) + 0.3, Z: sz}
	a := h.dial("")
	a.join(h, char, "Rescuer")
	nid := a.npcEntityID(h, giver)
	h.standByNPC(char, giver)
	a.pump(200 * time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(nid), Action: ActionTalk})
	a.takeFor(EventQuestOffer, o.Quest.ID, 3*time.Second)
	a.send(&proto.Interact{TargetKind: InteractQuest, TargetID: uint64(o.Quest.ID), Action: QuestActAccept})
	a.takeFor(EventQuestStarted, o.Quest.ID, 3*time.Second)
	// At the camp: the villager is found and speaks.
	h.teleport(char, camp.X+2, camp.Z+2)
	say := a.take(EventContentSay, 4*time.Second)
	name := content.RescueVillager(o.Quest)
	t.Logf("%s: %q", name, say.Data)
	var fe *Entity
	h.do(func() {
		if f := h.srv.cnt.follow[char]; f != nil {
			fe = f.ent
		}
	})
	if fe == nil || fe.Name != name || fe.Kind != proto.EntityKindNpc {
		t.Fatalf("follower %+v", fe)
	}
	// Home: the villager catches up; the escort step completes, then the
	// giver thanks you.
	h.teleport(char, tw.X+3, tw.Z+3)
	for s := a.takeFor(EventQuestStep, o.Quest.ID, 4*time.Second); s.Value != 2; s = a.takeFor(EventQuestStep, o.Quest.ID, 4*time.Second) {
	}
	nid = a.npcEntityID(h, giver)
	h.standByNPC(char, giver)
	a.pump(200 * time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(nid), Action: ActionTalk})
	a.takeFor(EventQuestCompleted, o.Quest.ID, 3*time.Second)
	a.pump(200 * time.Millisecond)
	h.do(func() {
		if h.srv.cnt.follow[char] != nil {
			t.Error("the villager still follows after the quest")
		}
	})
}
