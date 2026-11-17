package game

// CR 031 achievements in-process on the official world: the Tony Stark
// flight detected from a real held magma dash sent over the wire (and a
// short burst that never takes flight), the counters the other systems
// feed, a gold-tier announcement reaching a player nearby but not one far
// away, a pre-CR 031 character's catch-up, and the state through the store.

import (
	"encoding/json"
	"math"
	"testing"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/contentdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/content"
	"lodestone/server/zone/internal/explore"
)

// jet sends a magma dash looking up at pitch: the start frame, then held
// frames for holdS seconds (none: a burst), 60 frames a second in pairs.
func (cl *client) jet(variant int, pitch, holdS float64) {
	frame := func(flags uint16) proto.InputFrame {
		cl.seq++
		return proto.InputFrame{Seq: cl.seq, Flags: flags, Pitch: proto.PitchToI16(pitch), CastSlot: uint8(variant)}
	}
	cl.send(&proto.Input{AckTick: cl.dec.Latest(), Frames: []proto.InputFrame{frame(proto.InputFlagDodge), frame(proto.InputFlagChannel)}})
	cl.pump(33 * time.Millisecond)
	for i := 0; i < int(holdS*30); i++ {
		cl.send(&proto.Input{AckTick: cl.dec.Latest(), Frames: []proto.InputFrame{frame(proto.InputFlagChannel), frame(proto.InputFlagChannel)}})
		cl.pump(33 * time.Millisecond)
	}
	// Let go: fall back down (no keys).
	for i := 0; i < 90; i++ {
		cl.send(&proto.Input{AckTick: cl.dec.Latest(), Frames: []proto.InputFrame{frame(0), frame(0)}})
		cl.pump(33 * time.Millisecond)
	}
}

func equipMagma(t *testing.T, h *harness, char string) int {
	t.Helper()
	h.do(func() {
		p := h.srv.byChar[char].ent.cbt
		h.srv.devSetXP(h.srv.byChar[char], explore.XPForLevel(20)) // CR 048: the full magma dash is level 15+
		p.Profile.Grant("magma_dash")
		if !p.Profile.EquipSpell(p.Profile.Active, 0, "magma_dash") {
			t.Error("equip magma_dash")
		}
		p.Mana, p.ManaMax = 1000, 1000
	})
	return combatdefs.D.ResolveDash(combatdefs.D.SpellByKey("magma_dash").Dash, 20)
}

func achID(key string) uint32 { return uint32(contentdefs.D.Achievement(key).ID) }

// TestTonyStarkTakesFlight: a held magma jet looking up takes the player
// more than 6 m above the ground for over 2 s: "Tony Stark built this in a
// cave with scraps" (gold, hidden), its title, five iron ingots, Event 1002
// to the player, Event 1240 to a player 20 m away and not to one 400 m
// away. A short burst does not count; metres jetted and airtime do.
func TestTonyStarkTakesFlight(t *testing.T) {
	h, store := contentHarness(t, true)
	const tony = "77777777-4444-5555-6666-777777777771"
	tw := &h.contentWorld().Towns[0]
	x, z := tw.X+tw.Radius+60, tw.Z // open land outside the town
	store.rows[tony] = movement.Vec3{X: x, Y: h.srv.cfg.Ground.HeightAt(x, z) + 0.3, Z: z}
	a := h.dial("")
	a.join(h, tony, "Tony")
	h.teleport(tony, x, z)
	near := h.dial("")
	near.join(h, "c-near", "Pepper")
	far := h.dial("")
	far.join(h, "c-far", "Happy")
	h.teleport("c-near", x+20, z)
	h.teleport("c-far", x+400, z)
	v := equipMagma(t, h, tony)

	// A burst (no hold): up and down again, never a flight.
	a.jet(v, 1.2, 0)
	a.pump(1200 * time.Millisecond)
	var flights int
	h.do(func() { flights = h.srv.byChar[tony].cnt.st.Stat("magmaflight") })
	if flights != 0 {
		t.Fatalf("a burst counted as %d flights", flights)
	}

	// Held, looking up: flight.
	h.do(func() { h.srv.byChar[tony].ent.cbt.Mana = 1000 })
	a.jet(v, 1.2, 3.5)
	h.do(func() {
		sess := h.srv.byChar[tony]
		t.Logf("after the jet: stats %v acc %+v mana %.0f pos %+v ground %.1f", sess.cnt.st.Stats, sess.cnt.ach, sess.ent.cbt.Mana, sess.ent.Move.Pos, h.srv.achSurface(sess.ent.Move.Pos.X, sess.ent.Move.Pos.Z))
	})
	got := a.takeFor(EventFeatEarned, achID("tony_stark"), 4*time.Second)
	var j map[string]any
	if err := json.Unmarshal(got.Data, &j); err != nil || j["name"] != "Tony Stark built this in a cave with scraps" || j["title"] != "the Ironclad" || j["item"] != "ingot:iron" {
		t.Fatalf("earned %s", got.Data)
	}
	ann := near.takeFor(EventAchievementAnnounce, achID("tony_stark"), 3*time.Second)
	if string(ann.Data) != "Tony" || int(ann.Value) != contentdefs.D.Achievement("tony_stark").Tier {
		t.Fatalf("announce %+v", ann)
	}
	far.pump(300 * time.Millisecond)
	for _, e := range far.eventsOf(EventAchievementAnnounce) {
		t.Fatalf("a player 400 m away heard %+v", e)
	}
	a.pump(1500 * time.Millisecond) // the next once-a-second flush
	var st *content.State
	var iron int
	h.do(func() {
		sess := h.srv.byChar[tony]
		st = content.LoadState(sess.cnt.st.JSON())
		iron = sess.items.inv.Count("ingot:iron")
	})
	if st.Stat("magmaflight") != 1 || st.Stat("flight") < 2 || st.Stat("flighthigh") <= int(flightUpM) || st.Stat("dashm:magma_dash") < 50 || st.Stat("dashes") != 2 || st.EarnedAt("tony_stark") == 0 {
		t.Fatalf("stats %v", st.Stats)
	}
	if iron < 5 || !st.Has("zoom") || st.TitleText() == "" {
		t.Fatalf("iron %d, zoom %v, title %q", iron, st.Has("zoom"), st.TitleText())
	}
	// Choose the Ironclad title.
	a.send(&proto.Interact{TargetKind: InteractContent, TargetID: uint64(achID("tony_stark")), Action: ContentActTitle})
	deadline := time.Now().Add(3 * time.Second)
	for {
		var title string
		h.do(func() { title = h.srv.byChar[tony].cnt.st.TitleText() })
		if title == "the Ironclad" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("title %q", title)
		}
		a.pump(100 * time.Millisecond)
	}
	// The state reaches the store.
	deadline = time.Now().Add(8 * time.Second)
	for {
		if b := store.saved(tony); b != nil && content.LoadState(b).Has("tony_stark") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("never saved")
		}
		a.pump(200 * time.Millisecond)
	}
}

// TestAchievementCounters: the hooks the other systems call feed the right
// counters, and a pre-CR 031 character gets one catch-up event (not one
// toast per achievement) for what its old counters already earned.
func TestAchievementCounters(t *testing.T) {
	h, store := contentHarness(t, false)
	const old = "77777777-4444-5555-6666-777777777772"
	tw := &h.contentWorld().Towns[0]
	store.rows[old] = movement.Vec3{X: tw.X + tw.Radius + 60, Y: h.srv.cfg.Ground.HeightAt(tw.X+tw.Radius+60, tw.Z) + 0.3, Z: tw.Z}
	store.data[old] = []byte(`{"v":1,"feats":["first_steps"],"stats":{"kills":120,"duels":1},"tablets":[1,2]}`)
	a := h.dial("")
	a.join(h, old, "Oldtimer")
	caught := a.take(EventAchievementsCaught, 4*time.Second)
	var cj struct {
		Keys []string `json:"keys"`
		Gold int      `json:"gold"`
	}
	if err := json.Unmarshal(caught.Data, &cj); err != nil || int(caught.Value) != len(cj.Keys) || cj.Gold <= 0 {
		t.Fatalf("caught up %s", caught.Data)
	}
	has := map[string]bool{}
	for _, k := range cj.Keys {
		has[k] = true
	}
	if !has["getting_the_hang"] || !has["duelist"] || !has["light_reading"] || has["first_steps"] {
		t.Fatalf("caught up %v", cj.Keys)
	}
	for _, e := range a.eventsOf(EventFeatEarned) {
		t.Fatalf("catch-up sent a toast %s", e.Data)
	}

	h.do(func() {
		s := h.srv
		sess := s.byChar[old]
		for i := 0; i < 3; i++ {
			s.achAdd(sess, "emotes", 1)
		}
		s.achKill(sess, 0) // a fire creature
		s.achDusk(7)
		s.achDawn()
		s.achDawn() // a dawn without a dusk seen counts nothing
		sess.cnt.ach.gallopM = 1234.6
		sess.cnt.ach.dashM = map[string]float64{"glacier_step": 10.5}
		s.achFlush(sess)
	})
	h.do(func() {
		st := h.srv.byChar[old].cnt.st
		if st.Stat("emotes") != 3 || st.Stat("killel:fire") != 1 || st.Stat("nights") != 1 || st.Stat("gallop") != 1234 || st.Stat("dashm:glacier_step") != 10 {
			t.Errorf("counters %v", st.Stats)
		}
		if math.Abs(h.srv.byChar[old].cnt.ach.gallopM-0.6) > 1e-9 {
			t.Errorf("gallop remainder %v", h.srv.byChar[old].cnt.ach.gallopM)
		}
	})
	// A night seen through earns Night Owl as a toast now (a V 2 state).
	ev := a.takeFor(EventFeatEarned, achID("night_owl"), 3*time.Second)
	if int(ev.Value) <= 0 {
		t.Fatalf("points %d", ev.Value)
	}
}
