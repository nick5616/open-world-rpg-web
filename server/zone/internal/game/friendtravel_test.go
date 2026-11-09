package game

// Travel to a friend (playtest 2, CR 017): the channel, the move and every
// refusal.

import (
	"context"
	"math"
	"testing"
	"time"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

type friendsStore struct {
	fakeStore
	pairs map[[2]string]bool
}

func (f *friendsStore) AreFriends(_ context.Context, a, b string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.pairs[[2]string{a, b}] || f.pairs[[2]string{b, a}], nil
}

func TestFriendHashMatchesTheClient(t *testing.T) {
	// client/src/social/travel.test.ts checks the same vectors.
	if got := FriendHash(""); got != 0xcbf29ce484222325 {
		t.Fatalf("FNV-1a offset basis: %x", got)
	}
	if got := FriendHash("11111111-2222-3333-4444-555555555555"); got != 0x5ff56bf05c1d58f9 {
		t.Fatalf("hash %x", got)
	}
}

func TestTravelToFriend(t *testing.T) {
	store := &friendsStore{fakeStore: fakeStore{saves: map[string]movement.Vec3{}, rows: map[string]movement.Vec3{}}, pairs: map[[2]string]bool{{"ft-a", "ft-b"}: true}}
	h := newHarness(t, func(c *Config) { c.Store = store })
	a := h.dial(spawnAt(500, 500))
	a.join(h, "ft-a", "Ada")
	b := h.dial(spawnAt(800, 650))
	wb := b.join(h, "ft-b", "Bea")
	c := h.dial(spawnAt(520, 500))
	c.join(h, "ft-c", "Cid")
	a.pump(200 * time.Millisecond)

	travel := func(cl *client, friend string) {
		cl.interact(InteractFriend, FriendHash(friend), FriendActTravel, 0)
	}
	refusal := func(cl *client, want int32) {
		t.Helper()
		ev := cl.take(EventTravelRefused, 5*time.Second)
		if ev.Value != want {
			t.Fatalf("refusal %d, want %d (%s)", ev.Value, want, ev.Data)
		}
	}
	pos := func(char string) (p movement.Vec3) {
		_ = h.srv.Do(context.Background(), func() { p = h.srv.byChar[char].ent.Move.Pos })
		return
	}

	// Unknown / offline, yourself.
	travel(a, "nobody")
	refusal(a, TravelRefuseOffline)
	travel(a, "ft-a")
	refusal(a, TravelRefuseSelf)

	// Not friends: the channel starts, the check refuses it, nobody moves.
	travel(c, "ft-a")
	c.take(EventTravelChannel, 2*time.Second)
	refusal(c, TravelRefuseNotFriend)

	// Moving cancels the channel.
	travel(a, "ft-b")
	ch := a.take(EventTravelChannel, 2*time.Second)
	if ch.Value != 3000 || string(ch.Data) != "Bea" || ch.TargetID != wb.EntityID {
		t.Fatalf("channel %+v", ch)
	}
	_ = h.srv.Do(context.Background(), func() {
		e := h.srv.byChar["ft-a"].ent
		h.srv.Teleport(e, movement.Vec3{X: e.Move.Pos.X + 3, Z: e.Move.Pos.Z})
	})
	refusal(a, TravelRefuseMoved)

	// Taking damage cancels it.
	travel(a, "ft-b")
	a.take(EventTravelChannel, 2*time.Second)
	_ = h.srv.Do(context.Background(), func() { h.srv.byChar["ft-a"].ent.cbt.HP -= 5 })
	refusal(a, TravelRefuseHurt)

	// A downed friend can't be travelled to (set and asked within one tick:
	// combat's upkeep stands a downed player with no respawn timer back up).
	_ = h.srv.Do(context.Background(), func() {
		h.srv.byChar["ft-b"].ent.cbt.Downed = true
		h.srv.friendInteract(h.srv.byChar["ft-a"], &proto.Interact{TargetKind: InteractFriend, TargetID: FriendHash("ft-b"), Action: FriendActTravel}, time.Now())
		h.srv.byChar["ft-b"].ent.cbt.Downed = false
	})
	refusal(a, TravelRefuseFriendBusy)

	// The real thing: 3 s standing still, then A stands where B stands.
	start := time.Now()
	travel(a, "ft-b")
	a.take(EventTravelChannel, 2*time.Second)
	arr := a.take(EventTravelArrived, 6*time.Second)
	if took := time.Since(start); took < friendTravelChannel-100*time.Millisecond {
		t.Fatalf("arrived after %v, before the channel ended", took)
	}
	if string(arr.Data) != "Bea" {
		t.Fatalf("arrived %+v", arr)
	}
	pa, pb := pos("ft-a"), pos("ft-b")
	if d := math.Hypot(pa.X-pb.X, pa.Z-pb.Z); d > 1 {
		t.Fatalf("A at (%.1f, %.1f), B at (%.1f, %.1f): %.1f m apart", pa.X, pa.Z, pb.X, pb.Z, d)
	}
	a.lastEvent(EventTeleport, time.Second) // the client snaps (core teleport Event)

	// Cooldown.
	travel(a, "ft-b")
	refusal(a, TravelRefuseCooldown)

	// A friend on another zone (cluster presence feed): the channel names
	// no entity, the move goes to their reported spot (the WP16 handoff
	// takes over from there in a cluster).
	store.mu.Lock()
	store.pairs[[2]string{"ft-c", "ft-d"}] = true
	store.mu.Unlock()
	_ = h.srv.Do(context.Background(), func() {
		h.srv.cl.presenceChar = map[string]presenceSeen{"ft-d": {pos: movement.Vec3{X: 1200, Z: 900}, name: "Dee", t: h.srv.serverTimeMs()}}
	})
	travel(c, "ft-d")
	if ch := c.take(EventTravelChannel, 2*time.Second); ch.TargetID != 0 || string(ch.Data) != "Dee" {
		t.Fatalf("remote channel %+v", ch)
	}
	c.take(EventTravelArrived, 6*time.Second)
	if pc := pos("ft-c"); math.Hypot(pc.X-1200, pc.Z-900) > 1 {
		t.Fatalf("C at (%.1f, %.1f), want the remote friend's spot", pc.X, pc.Z)
	}
}
