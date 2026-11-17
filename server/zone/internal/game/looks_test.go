package game

import (
	"context"
	"testing"
	"time"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// The same vectors as client/src/net/look.test.ts "packs like the zone".
var lookVectors = []struct {
	json string
	want uint32
}{
	{`{"v":1,"look":{"build":2,"skin":4,"hairStyle":5,"hairColor":8,"beard":3,"eyes":5}}`, 1<<18 | 2 | 4<<2 | 5<<5 | 8<<8 | 3<<12 | 5<<15},
	{`{"v":1,"look":{"build":1,"skin":2,"hairStyle":2,"hairColor":1,"beard":0,"eyes":0}}`, 1<<18 | 1 | 2<<2 | 2<<5 | 1<<8},
	{`{"v":1,"look":{"build":99,"skin":-4,"hairStyle":1}}`, 1<<18 | 2 | 0<<2 | 1<<5 | 1<<8}, // clamps; missing fields take the client default
	{`{}`, 0},
	{`{"hair":3}`, 0},
	{`not json at all`, 0},
	{``, 0},
}

func TestPackLook(t *testing.T) {
	for _, v := range lookVectors {
		if got := PackLook([]byte(v.json)); got != v.want {
			t.Errorf("PackLook(%s) = %#x, want %#x", v.json, got, v.want)
		}
	}
}

type lookStore struct {
	progressStore
	ap map[string]string
}

func (l *lookStore) LoadAppearance(_ context.Context, id string) ([]byte, error) {
	return []byte(l.ap[id]), nil
}

// A client asks for another player's look and gets Event 1900 alone; a player
// with no stored look, an unknown id and a non-player get nothing.
func TestLookReplication(t *testing.T) {
	st := &lookStore{ap: map[string]string{"look-a": lookVectors[0].json}}
	st.rows, st.saves, st.prog = map[string]movement.Vec3{}, map[string]movement.Vec3{}, map[string]ProgressSnapshot{}
	h := exploreHarness(t, func(c *Config) { c.Store = st })
	a := h.dial("?spawn=2048,0,2048")
	wa := a.join(h, "look-a", "Alder")
	b := h.dial("?spawn=2056,0,2048")
	wb := b.join(h, "look-b", "Birch")
	for _, c := range []*client{a, b} {
		c.pump(150 * time.Millisecond)
	}
	idA, idB := wa.EntityID, wb.EntityID
	b.send(&proto.Interact{TargetKind: InteractLook, TargetID: uint64(idA), Action: LookActAsk})
	b.send(&proto.Interact{TargetKind: InteractLook, TargetID: uint64(idB), Action: LookActAsk}) // no look stored
	b.send(&proto.Interact{TargetKind: InteractLook, TargetID: 999999, Action: LookActAsk})
	b.pump(200 * time.Millisecond)
	a.pump(50 * time.Millisecond)
	got := b.eventsOf(EventLook)
	if len(got) != 1 || got[0].EntityID != idA || uint32(got[0].Value) != lookVectors[0].want {
		t.Fatalf("asker got %+v, want one look for %d = %#x", got, idA, lookVectors[0].want)
	}
	if n := len(a.eventsOf(EventLook)); n != 0 {
		t.Fatalf("the player asked about heard %d look events", n)
	}
}

// The account path reads characters.appearance (real Postgres).
func TestLoadAppearancePG(t *testing.T) {
	pool, st, _, char := itemsDB(t)
	ap := `{"v":1,"look":{"build":0,"skin":5,"hairStyle":3,"hairColor":9,"beard":4,"eyes":2}}`
	if _, err := pool.Exec(context.Background(), `UPDATE characters SET appearance = $1::jsonb WHERE id = $2::uuid`, ap, char); err != nil {
		t.Fatal(err)
	}
	raw, err := st.LoadAppearance(context.Background(), char)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := PackLook(raw), uint32(1<<18|0|5<<2|3<<5|9<<8|4<<12|2<<15); got != want {
		t.Fatalf("pack %#x want %#x (raw %s)", got, want, raw)
	}
	if raw, err := st.LoadAppearance(context.Background(), "not-a-uuid"); err != nil || raw != nil {
		t.Fatalf("bad id: %v %v", raw, err)
	}
}
