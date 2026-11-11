package game

import (
	"math"
	"testing"
	"time"

	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/explore"
)

// Co-op polish: a party member's tower is lent for fast travel (Event 609
// lists it), and a player in a party respawns at the point nearest the
// friend who is still up; out of the party, at their own last waypoint.
func TestPartyLendsTowersAndRespawnsNearFriend(t *testing.T) {
	h := exploreHarness(t, nil)
	a := h.dial("?spawn=90,120")
	a.join(h, "pa", "Nell")
	b := h.dial("?spawn=300,140")
	b.join(h, "pb", "Rook")
	a.drainFor(100 * time.Millisecond)
	b.drainFor(100 * time.Millisecond)
	w := h.srv.cfg.Explore
	h.do(func() {
		ea, eb := h.srv.byChar["pa"].ent, h.srv.byChar["pb"].ent
		ea.x.prog.Towers.Set(0) // Nell climbed the tower (site 0)
		eb.x.prog.Waypoints.Set(1)
		eb.x.prog.LastWaypoint = 1 // Rook's own respawn: the waypoint stone
	})
	// Not in a party: the tower is Nell's alone.
	b.send(&proto.Interact{TargetKind: InteractSite, TargetID: 0, Action: ActionFastTravel})
	if d := b.nextEvent(EventFastTravelDenied, time.Second); d.Value != int32(explore.TravelLocked) {
		t.Fatalf("denied %+v", d.ToJSON())
	}
	var own, lent [2]float64
	h.do(func() {
		p := h.srv.RespawnPoint(h.srv.byChar["pb"].ent)
		own = [2]float64{p.X, p.Z}
		h.srv.setParty(h.srv.byChar["pa"].ent, "party-1")
		h.srv.setParty(h.srv.byChar["pb"].ent, "party-1")
		p = h.srv.RespawnPoint(h.srv.byChar["pb"].ent)
		lent = [2]float64{p.X, p.Z}
	})
	wp, _ := w.Destination(1)
	top, _ := w.Destination(0)
	if math.Hypot(own[0]-wp.X, own[1]-wp.Z) > 0.01 {
		t.Fatalf("solo respawn %v, want the waypoint %v", own, wp)
	}
	if math.Hypot(lent[0]-top.X, lent[1]-top.Z) > 0.01 {
		t.Fatalf("party respawn %v, want the tower top beside Nell %v", lent, top)
	}
	// Event 609 lends the tower; the request goes through.
	ev := b.nextEvent(EventPartyTowers, 3*time.Second)
	if ev.Value != 1 || len(ev.Data) < 3 || !explore.Bitset(ev.Data[3:]).Has(0) {
		t.Fatalf("party towers %+v", ev.ToJSON())
	}
	b.send(&proto.Interact{TargetKind: InteractSite, TargetID: 0, Action: ActionFastTravel})
	tp := b.nextEvent(EventTeleport, time.Second)
	if tp.X != proto.MetersToCm(top.X) || tp.Z != proto.MetersToCm(top.Z) {
		t.Fatalf("teleport %+v, want the tower top %v", tp.ToJSON(), top)
	}
	// A wipe: with nobody up, the nearest point to where Rook fell.
	h.do(func() {
		ea := h.srv.byChar["pa"].ent
		ea.cbt.Downed = true
		eb := h.srv.byChar["pb"].ent
		eb.Move.Pos.X, eb.Move.Pos.Z = 300, 110
		p := h.srv.RespawnPoint(eb)
		lent = [2]float64{p.X, p.Z}
		ea.cbt.Downed = false
	})
	if math.Hypot(lent[0]-wp.X, lent[1]-wp.Z) > 0.01 {
		t.Fatalf("wipe respawn %v, want the stone nearest where he fell %v", lent, wp)
	}
}
